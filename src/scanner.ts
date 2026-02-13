import { SingleBar } from 'cli-progress';
import pLimit from "p-limit";
import { SimpleSimHash } from './simhash';
import { getRealPath } from './utils';
import { getContent, sleep } from './net_tool';
import log4js from './log4js.config';
import { Api } from './entities';

const logger = log4js.getLogger();

class Scanner {
    private url: string;
    private baseUrl: string;
    private paths: Api[];
    private headers: Record<string, string>;
    private limitCount: number;
    private mainPageSimHash: number;
    private completeCount: number;
    private progressBar: SingleBar;

    constructor(url: string, baseUrl: string, paths: Api[], headers: Record<string, string> = {}, limitCount: number, mainPageSimHash: number) {
        this.url = url;
        this.baseUrl = baseUrl;
        this.paths = paths;
        this.headers = headers;
        this.limitCount = limitCount;
        this.mainPageSimHash = mainPageSimHash;
        this.completeCount = 0;
        
        this.progressBar = new SingleBar({
            format: 'API扫描进度： |{bar}| {percentage}% || {value}/{total}',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            clearOnComplete: false,
            stopOnComplete: false,
            noTTYOutput: false 
        });
        
    }

    private updateBar(): void {
        this.completeCount += 1;
        this.progressBar.update(this.completeCount);
    }

    private async scan(api: Api): Promise<void> {
        let _path = api.path.toLowerCase();
        if(_path.indexOf("remove") >= 0 || _path.indexOf("delete") >= 0){
            api.responseContent = '接口中含有敏感词，不进行自动化请求！';
            this.updateBar();
            return;
        }
        _path = api.path.startsWith('/') ? api.path : '/' + api.path;
        const content = await getContent(this.url + (_path.startsWith(this.baseUrl) ? _path : this.baseUrl + _path), this.headers);
        sleep(Math.floor(Math.random() * 1500));
        if(content !== undefined){
            api.statusCode = content.status;
            api.responseLength = content.data.length;
            api.path = _path;
            const contentHash = SimpleSimHash.compute(content.data);
            const distance = SimpleSimHash.getDistance(this.mainPageSimHash, contentHash);
            if(content.data.length <= 500){
                api.responseContent = content.data.replace(/\n/g, '').replace(/\r/g, '');
            }else if(distance <= 3){
                api.responseContent = "接口响应内容与首页内容一致，可能有以下原因：1.接口缺少baseUrl; 2.接口是前端路由; 3.接口不存在。";
            }else{
                api.responseContent = "响应内容过长，请自行请求验证";
            }
        }
        this.updateBar();
    }

    private async scanAll(): Promise<void> {
        this.paths = this.paths.map(item => {
            if(!item.path.startsWith('/')){
                item.path = "/" + item.path;
            }
            return item;
        });
        const limit = pLimit(this.limitCount);
        this.progressBar.start(this.paths.length, 0);
        const promises = this.paths.map(api => limit(() => this.scan(api)));
        await Promise.allSettled(promises);
        this.progressBar.stop();
    }

    async startScan(): Promise<Api[]> {
        await this.scanAll();
        logger.info('[+] 所有API扫描完成!');
        return this.paths;
    }
}

export default Scanner;
export { Scanner };
