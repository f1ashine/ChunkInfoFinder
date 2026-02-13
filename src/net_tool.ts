import got from "got";
import pLimit from "p-limit";
import path from 'path';
import { Buffer } from 'buffer';
import { createWriteStream, promises as ps } from 'fs';
import fs from 'fs';
import { SingleBar } from 'cli-progress';
import log4js from './log4js.config';
import { SimpleSimHash } from './simhash';
import { extractScources } from './extract_map';

const logger = log4js.getLogger();

interface HttpResponse {
    status: number;
    data: string;
}

interface GotOptions {
    url: string;
    headers: Record<string, string>;
    timeout: {
        socket: number;
    };
    https: {
        rejectUnauthorized: boolean;
    };
    followRedirect: boolean;
    method?: string;
    hooks?: {
        beforeRetry?: Array<(error: any, retryCount: number) => void>;
    };
}

const uas: string[] = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.100 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15"
];
const options: GotOptions = {
    url: '',
    headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    },
    timeout: {
        socket: 5000
    },
    https: {
        rejectUnauthorized: false // 忽略https证书错误
    },
    followRedirect: true,
    hooks: {
        beforeRetry: [ // 默认最多重试 2次
        (error: any, retryCount: number) => {
            if(error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
            logger.info(`\n[-] ${options.url} 连接超时或断开，正在重试... (${retryCount}/2)`);
            }
        }
        ],
    }
};

function getRandomUa(): Record<string, string> {
    return {"User-Agent": uas[Math.floor(Math.random() * (uas.length))]};
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getContent(url: string, defineHeaders: Record<string, string>): Promise<HttpResponse | undefined> {
    let _options: any = {...options};
    Object.assign(_options.headers, getRandomUa());
    _options.method = 'GET';
    _options.url = url;
    if(Object.keys(defineHeaders).length > 0){
        Object.assign(_options.headers, defineHeaders);
    }
    try{
        const response = await got(_options);
        return {"status": response.statusCode, "data": response.body};
    }catch(err: any){
        if(err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
            logger.error(`\n[-] 请求失败 ${url}, 错误原因: ${err.message}`);
            return undefined;
        }
        // 其他情况返回响应状态
        return {
            "status": err.response?.statusCode || 0,
            "data": err.response?.body || ""
        };
    }
}

export class Downloader {
    private aliveScripts: string[];
    private options: GotOptions;
    private completeCount: number;
    private progressBar: SingleBar;
    private contentHash: number;
    private total: number;

    constructor(contentHash:number) {
        this.aliveScripts = [];
        this.options = {...options};
        this.completeCount = 0;
        this.total = 0;
        this.contentHash = contentHash;
        this.progressBar = new SingleBar({
            format: 'JS 文件下载进度： |{bar}| {percentage}% || {value}/{total} Files',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            clearOnComplete: false, // 进度条结束后关闭显示
            stopOnComplete: false,
            noTTYOutput: false 
        });
    }

    private updateBar(): void {
        this.completeCount += 1;
        this.progressBar.update(this.completeCount);
    }

    /**
     * 下载单个文件
     * @param urlString 文件URL
     * @param defineHeader 自定义请求头
     * @param dirName 保存目录
     * @returns Promise<{body: string, filePath: string} | null> 成功返回响应体和文件路径，失败返回null
     */
    public async downloadSingleFile(urlString: string, defineHeader: Record<string, string>, dirName: string): Promise<{body: string, filePath: string} | null> {
        // 解析URL以生成唯一的文件名，避免不同目录下同名文件被覆盖
        const urlObj = new URL(urlString);
        const fileName = urlObj.pathname.replace(/\//g, '_').slice(1);
        const filePath = path.join(dirName, fileName);
        // 创建新的选项对象，避免修改共享的options
        const requestOptions: GotOptions = {...this.options};
        Object.assign(requestOptions.headers, getRandomUa());
        requestOptions.url = urlString;
        if(Object.keys(defineHeader).length > 0){
            Object.assign(requestOptions.headers, defineHeader);
        }

        try {
            const response = await got(requestOptions as any);
            await sleep(Math.floor(Math.random() * 1500)); 
            if(response.statusCode === 200){
                const contentHash = SimpleSimHash.compute(response.body);
                const distance = SimpleSimHash.getDistance(this.contentHash, contentHash);
                if(distance > 3){
                    await fs.writeFile(filePath, response.body, 'utf-8', (err) => {
                        if(err) logger.error("[-] 文件写入失败 " + filePath + "，错误详情: " + (err?.message || err));
                    });
                    return { body: response.body, filePath: fileName};
                } else {
                    logger.warn("[-] 文件不存在" + urlString);
                }
            }
            return null;
        } catch(err: any){
            if(err?.response?.statusCode === 404){
                logger.warn("[-] 文件未找到: " + urlString);
            }else{
                logger.error("[-] 文件下载失败 " + urlString + "，错误详情: " + (err?.message || err));
            }
            return null;
        }
    }

    /**
     * 下载单个JS文件（用于批量下载）
     * @param urlString 文件URL
     * @param defineHeader 自定义请求头
     * @param dirName 保存目录
     * @returns Promise<void>
     */
    private async downloadJSFile(urlString: string, defineHeader: Record<string, string>, dirName: string): Promise<void> {
        // 解析URL以生成唯一的文件名，避免不同目录下同名文件被覆盖
        const urlObj = new URL(urlString);
        // 将路径中的"/"替换为下划线，生成唯一文件名
        const fileName = urlObj.pathname.replace(/\//g, '_').slice(1);
        const filePath = path.join(dirName, fileName);
        // 创建新的选项对象，避免修改共享的options
        const requestOptions: GotOptions = {...this.options};
        Object.assign(requestOptions.headers, getRandomUa());
        requestOptions.url = urlString;
        if(Object.keys(defineHeader).length > 0){
            Object.assign(requestOptions.headers, defineHeader);
        }

        try {// 使用流式下载文件更快
            const stream = got.stream(requestOptions as any);
            const response: any = await new Promise((resolve: (value: any) => void, reject: (reason?: any) => void) => {
                stream.once('response', resolve);
                stream.once('error', reject);
            });

            await sleep(Math.floor(Math.random() * 1500));
            if(response.statusCode === 200){
                const tempFilePath = `${filePath}.tmp`;
                const writeStream = createWriteStream(tempFilePath);
                const MAX_TAIL_SIZE = 512;
                let tailBuffer = Buffer.alloc(0);
                for await (const chunk of stream) {
                    // 写入临时文件
                    if (!writeStream.write(chunk)) {
                        await new Promise((resolve: (value?: unknown) => void) => writeStream.once('drain', resolve));
                    }
                    tailBuffer = Buffer.concat([tailBuffer, chunk]);
                    if (tailBuffer.length > MAX_TAIL_SIZE) {
                        tailBuffer = tailBuffer.subarray(tailBuffer.length - MAX_TAIL_SIZE);
                    }
                }
                writeStream.end();
                await new Promise((resolve: (value?: unknown) => void) => writeStream.on('finish', resolve));
                const tailString = tailBuffer.toString('utf-8');
                const mapMatch = tailString.match(/[\/#][@#]\s*sourceMappingURL=([^\s]+)/);
                if (mapMatch && mapMatch[1]) {
                    this.progressBar.stop();
                    const mapFileName = mapMatch[1].trim();
                    const mapUrl = urlString.slice(0, urlString.lastIndexOf('/')+1) + mapFileName;
                    logger.info('[+] 发现source map文件，尝试下载并提取源代码： ' + mapUrl);
                    this.progressBar.start(this.total, this.completeCount);
                    const mapDir = path.join(dirName, 'src');
                    if(!fs.existsSync(mapDir)){
                        fs.mkdir(mapDir, err => {
                            if(err) logger.error(`创建目录失败，错误原因：${err}`);
                        });
                    }
                    this.aliveScripts.push(fileName); // 标记存活
                    let res = await getContent(mapUrl, defineHeader);
                    this.progressBar.stop();
                    if(res && res.status === 200){
                        const contentHash = SimpleSimHash.compute(res.data);
                        const distance = SimpleSimHash.getDistance(this.contentHash, contentHash);
                        if(distance > 3){
                            extractScources(res.data, mapDir);
                            logger.info(`[+] source map文件 ${mapUrl} 提取完成。`);
                        }else{
                            logger.warn(`[+] source map文件 ${mapUrl} 不存在。`);
                        }
                    }else{
                        logger.warn(`[+] source map文件${mapUrl} 不存在。`);
                    }
                    this.progressBar.start(this.total, this.completeCount);
                
                }
                await ps.rename(tempFilePath, filePath);
                this.aliveScripts.push(fileName);
            } else{
                stream.resume();
            }
            
            this.updateBar();
        } catch(err: any){
            this.updateBar();
            if(err?.response?.statusCode === 404){
                logger.warn("[-] 文件未找到: " + urlString);
            }else{
                logger.error("[-] 文件下载失败 " + urlString + "，错误详情: " + (err?.message || err));
            }
            throw err;
        }
    }

    /**
     * 下载多个文件
     * @param urls 文件URL数组
     * @param defineHeader 自定义请求头
     * @param dirName 保存目录
     * @param threadCount 并发线程数
     * @returns Promise<string[]> 成功下载的文件路径数组
     */
    async downloadAll(urls: string[], defineHeader: Record<string, string>, dirName: string, threadCount: number): Promise<string[]> {
        const limit = pLimit(threadCount);
        this.total = urls.length;
        this.progressBar.start(urls.length, 0);
        const promises = urls.map(url => limit(() => this.downloadJSFile(url, defineHeader, dirName)));
        await Promise.allSettled(promises);
        this.progressBar.stop();
        return this.aliveScripts;
    }
}
