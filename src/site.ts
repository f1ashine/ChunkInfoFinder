import cheerio from 'cheerio';
import { parse } from '@babel/parser';
import * as types from "@babel/types";
import generator from '@babel/generator';
import traverse from '@babel/traverse';
import { URL } from 'url';
import { SingleBar } from 'cli-progress';
import pLimit from "p-limit";
import path from 'path';
import fs from 'fs';
import { Scanner } from './scanner';
import { Api, SensitiveInfo } from './entities';
import { getContent, Downloader } from './net_tool';
import { getRealPath, createDirectory, formatPath, getFileNamesFromDir, uniqueByPath } from './utils';
import log4js from './log4js.config';
import { SimpleSimHash } from './simhash';

interface ChunkPatterns {
    fileType: {
        js: RegExp;
        chunkJs: RegExp;
        css: RegExp;
        chunkCss: RegExp;
    };
    chunks: {
        numeric: RegExp;
        named: RegExp;
    };
}

interface PositionObject {
    [key: string]: number | undefined;
}

const logger = log4js.getLogger();
const pattern = /(?<!path:\s?)("|')(?!\?)(?:\/?[-@\d\w.]+\/){1,10}[-\w.?=]+\/?\1/g; // 提取出所有路径
const pattern2 = /(?<!path:\s?)('|")(?:\/[-@\d\w.?=]+)\/?\1/g;  // 提取出 只有一个 / 的路径
let { blockedFileNames, blockedPaths } = (()=>{
    let content = JSON.parse(fs.readFileSync(path.join(getRealPath(), "blacklist.json"), { encoding: "utf-8" }));
    return {
        blockedFileNames: new RegExp(content.fileNames.map(escapeRegExp).join('|')),
        blockedPaths: content.paths.map(escapeRegExp).join('|')
    }
})();
const datePattern = /\/(\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})/g;
blockedPaths = new RegExp(`${datePattern.source}|${blockedPaths}`, 'i');
const SENSITIVE_PATTERNS = {
    "Accesskey": /(?:accesskey(?:id|secret)|access[-_]?key)\s*[:=]\s*['"]?([0-9a-f\-_=]{6,128})['"]?/gi,
    "ChinesePhoneNumber": /(?<!\d)((?:\+86|0086)?1[3-9]\d{9})(?!\d)/g,
    "IdNumber": /(?<!\d)(?!0{6,}|1{6,})([1-6]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dxX])(?!\d)/g,
    "Password": /(?:['"]?[\w]{0,10}p(?:ass|wd|asswd|assword)[\w]{0,10}['"]?)\s*[:=]\s*(?:(['"])(.*?)\1|([^&"'=\s;,]+))/gi,
    "IntranetIpAddress": /(?<!\d)(?:127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?!\d)/g,
    "MD5": /\b(?!\d{32}\b)[a-fA-F0-9]{32}\b/g, // 可能是默认密码的hash，排除掉32位相同字符的情况
    "Email": /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})/g
}

const STATIC_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', 
    '.woff', '.woff2', '.ttf', 
    '.mp4', '.mp3', 
    '.tsx', '.scss', '.ts', '.vue', '.ejs', '.css', '.less'
]);
const chunkPatterns: ChunkPatterns = {
    fileType: {
        js: /\}\[\w\]\+"\.js"/,
        chunkJs: /\}\[\w\]\+"\.chunk\.js"/,
        css: /\}\[\w\]\+"\.css"/,
        chunkCss: /\}\[\w\]\+"\.chunk\.css"/
    },
    chunks: {
        numeric: /\d{1,3}:"[0-9a-z]{8,20}"/g,
        named: /("chunk-[\d\w]{8}"|\w+):"[\d\w]{8}"/g
    }
};

class Site {
    private url: string;
    private basheURL: string;
    private jsLinks: Set<string>;
    private paths: Api[];
    private need2ScanFiles: Set<string>;
    private packType: number;
    private hasLoadedChunk: boolean;
    private headers: Record<string, string>;
    private limitCount: number;
    private dirPath: string;
    private progressBar: SingleBar;
    private completeCount: number;
    private needVerifyApi: boolean = true;
    private sensitiveInfo: SensitiveInfo[];
    private mainPageSimHash: number = 0;

    constructor(url: string, basheURL: string = '', headers: Record<string, string> = {}, limitCount: number = 5, needVerifyApi: boolean = true) {
        this.url = url.length > 0 ? (url.endsWith('/') ? url.slice(0, -1) : url) : url;
        this.basheURL = basheURL.startsWith('/') ? basheURL.slice(1) : basheURL;
        this.jsLinks = new Set();
        this.paths = [];
        this.sensitiveInfo = [];
        this.need2ScanFiles = new Set();
        this.packType = 0; // 0: 未使用打包，1: webpack/rollup 2: vite
        this.hasLoadedChunk = false; // 是否已经加载过分包文件
        this.headers = headers;
        this.limitCount = limitCount;
        this.needVerifyApi = needVerifyApi;
        
        const dirPath = this.url ? createDirectory(this.url) : '';
        if (dirPath) {
            this.dirPath = dirPath;
        } else {
            this.dirPath = path.join(process.cwd(), 'default_output');
        }
        
        this.progressBar = new SingleBar({
            format: 'JS 文件扫描进度： |{bar}| {percentage}% || {value}/{total} Files',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            clearOnComplete: false,
            stopOnComplete: true,
            noTTYOutput: false 
        });
        
        this.completeCount = 0;
    }
    
    async loadMainPage(): Promise<void> {
        logger.info(`[+] 创建文件目录：${this.dirPath}， 相关文件都将保存在该目录下...`);
        logger.info("[+] 开始解析js");
        
        // 先处理首页的js
        const content = await getContent(this.url, this.headers);
        if(content === undefined || content.data.length === 0){
            logger.info(`[-] ${this.url} 不存在html内容，请自行验证！`);
            return;
        } 
        
        if(this.hasPackedMark(content.data)){
            this.packType = 1;
            logger.info("[+] 通过特征判断确认前端使用了chunk分包");
        }
        else if(content.data.includes('<script type="module"')){
            this.packType = 2;
            logger.info("[+] 通过特征判断确认前端使用了vite打包");
        }
        
        this.mainPageSimHash = SimpleSimHash.compute(content.data);
        this.getJSLinks(content.data);
        
        if(this.jsLinks.size === 0 && this.paths.length === 0){// 未解析到js 链接
            logger.error("[-] 未识别到JS链接或未识别到API！");
            return;
        }
        
        // 下载首页的js文件
        await this.downloadJSFiles();
        logger.info('[+] JS文件下载完成！');
        
        // 分类处理
        if(this.packType === 1 && !this.hasLoadedChunk){ // 未加载 chunk 分包文件
            logger.info("[+] 通过JS文件提取chunks文件...");
            let _link = [...this.jsLinks].pop();
            if (_link) {
                _link = _link.slice(0, _link.lastIndexOf('/') + 1);
                this.jsLinks.clear();
                for(let item of this.need2ScanFiles){
                    let content = fs.readFileSync(path.join(this.dirPath, item), {encoding: "utf-8"});
                    let links = this.getChunkLinks(content);
                    if(links.length == 0) continue; // 没获取到说明 chunk 文件分包在 其他js文件中
                    links.forEach(_item => {
                        if (_link) {
                            this.jsLinks.add(_link + _item);
                        }
                    });
                }
                await this.downloadJSFiles();
                logger.info('[+] JS文件下载完成！');
            }
        }
        
        
        if(this.packType === 2){
            //vite 打包一般html上就一个js文件
            logger.info("[+] 通过JS文件提取其他js依赖文件...")
            let _link = [...this.jsLinks].pop();
            if (_link) {
                _link = _link.slice(0, _link.lastIndexOf('/'));
                this.jsLinks.clear();
                let jsLinks: string[] = [];
                for(let item of this.need2ScanFiles){
                    let content = fs.readFileSync(path.join(this.dirPath, item), {encoding: "utf-8"});
                    const scannedPaths = this.scanPath(content);
                    jsLinks = jsLinks.concat(scannedPaths.map(api => api.path));
                }
                jsLinks = jsLinks.filter(item => !blockedFileNames.test(item));
                jsLinks = jsLinks.map(item => {
                    if(_link && !item.startsWith(_link)){
                        item = _link + item;
                    }
                    return item;
                });
                this.jsLinks = new Set(jsLinks);
                await this.downloadJSFiles();
                this.hasLoadedChunk = true;
            }
        }
        // 提取api并扫描验证
        await this.scanFiles();
        if(this.paths.length > 0){
            if(this.needVerifyApi){
                await this.verfiyApi();
            }
        } else {
            logger.info("[-] 从js文件中未提取到API path！");
        }
        this.output2Html();
    }

    private output2Html(): void {
         try {
            const templatePath = path.join(process.cwd(), "show.html");
            let htmlContent = fs.readFileSync(templatePath, { encoding: "utf-8" });
            const showResultHtml = path.join(this.dirPath, 'result', 'showResult.html');
            const apiJsonPath  = path.join(this.dirPath, 'result', "result.json");
            const sensitiveInfoJsonPath  = path.join(this.dirPath, 'result', "sensitive_info.json");
            if (fs.existsSync(sensitiveInfoJsonPath)) {
                const jsonContent = fs.readFileSync(sensitiveInfoJsonPath, { encoding: "utf-8" });
                htmlContent = htmlContent.replace(
                    'const sensitiveInfoResult = []', 
                    'const sensitiveInfoResult = ' + jsonContent
                );
            } else {
                logger.error(`${sensitiveInfoJsonPath}文件不存在`);
            }
            if(this.needVerifyApi && this.url.length > 0){ // 不扫描验证API时只输出敏感信息
                if (fs.existsSync(apiJsonPath)) {
                    const jsonContent = fs.readFileSync(apiJsonPath, { encoding: "utf-8" });
                    const _url = new URL(this.url);
                    const fullUrl = _url.protocol + "//" + _url.host + (this.basheURL && this.basheURL.length > 0 ? ('/' + this.basheURL) : '');
                    htmlContent = htmlContent.replace('const url = ""', `const url = "${fullUrl}"`);
                    htmlContent = htmlContent.replace(
                        'const apiScanResult = []', 
                        'const apiScanResult = ' + jsonContent
                    );
                } else {
                    logger.error(`${apiJsonPath}文件不存在`);
                }
            }
            fs.writeFileSync(showResultHtml, htmlContent, {encoding: "utf-8"});
            logger.info(`[+] 请打开文件 ${showResultHtml}查看扫描结果！`);
            console.timeEnd("程序运行耗时");
        } catch (err: any) {
            logger.error(`${err.message}`);
        }
    }

    async buildScanTask(dirPath: String): Promise<void> {
        this.dirPath = dirPath.toString();
        this.need2ScanFiles = new Set(getFileNamesFromDir(this.dirPath));
        await this.scanFiles();
        console.timeEnd("程序运行耗时");
    }

    private async verfiyApi(): Promise<void> {
        const _url = new URL(this.url);
        const scanner = new Scanner(_url.protocol + "//" + _url.host, this.basheURL, this.paths, this.headers, this.limitCount, this.mainPageSimHash);
        const paths = await scanner.startScan();
        const resultDir = path.join(this.dirPath, 'result');
        
        // 确保result目录存在
        if (!fs.existsSync(resultDir)) {
            fs.mkdirSync(resultDir, { recursive: true });
        }
        
        return new Promise((resolve, reject) => {
            const stream = fs.createWriteStream(path.join(resultDir, 'result.json'), { flags: 'w' });
            stream.write('[' + paths.map((item: Api) => item.toString()).join(',') + ']');
            stream.on('finish', () => resolve());
            stream.on('error', reject);
            stream.end();
        });
    }

    private async downloadJSFiles(): Promise<void> {
        const links = Array.from(this.jsLinks).map(item => this.url + formatPath(item));
        const downloader = new Downloader(this.mainPageSimHash);
        const result = await downloader.downloadAll(links, this.headers, this.dirPath, this.limitCount);
        
        result.forEach(file => this.need2ScanFiles.add(file));
    }

    /**
     * 筛选出js chunks 的文件名数组
     */
    private getChunkLinks(content: string): string[] {
        try {
            // 获取各类型文件的位置
            const positions: PositionObject = {
                js: chunkPatterns.fileType.js.exec(content)?.index,
                chunkJs: chunkPatterns.fileType.chunkJs.exec(content)?.index,
                css: chunkPatterns.fileType.css.exec(content)?.index,
                chunkCss: chunkPatterns.fileType.chunkCss.exec(content)?.index
            };

            // 找到最早的JS文件定义位置
            const jsPositions = [positions.js, positions.chunkJs].filter(pos => pos !== undefined);
            if(jsPositions.length === 0) {
                return [];  // 如果没有找到任何JS文件位置，直接返回空数组
            }
            const jsPosition = Math.min(...jsPositions as number[]);

            // 找到最早的CSS文件定义位置
            const cssPositions = [positions.css, positions.chunkCss].filter(pos => pos !== undefined);
            const cssPosition = cssPositions.length > 0 ? Math.min(...cssPositions as number[]) : undefined;

            // 如果找到了有效的JS位置
            if (cssPosition !== undefined) {
                // 如果CSS在JS之前或没有CSS，使用全部内容
                // 否则只使用到CSS位置的内容
                if(cssPosition < jsPosition){
                    content = content.slice(cssPosition, jsPosition);
                }else{
                    content = content.slice(0, jsPosition);
                }
            }
            
            // 确定文件类型后缀
            const suffix = positions.chunkJs !== undefined ? "chunk.js" : "js";
            // 尝试匹配第一种模式: 0.c6856fab.chunk.js
            let chunkFiles = this.extractNumericChunks(content, chunkPatterns.chunks.numeric, suffix);
            // 如果第一种模式没有匹配到，尝试第二种模式。 例如 chunk-020425a5.229a5b89.js
            if (chunkFiles.length === 0) {
                chunkFiles = this.extractNamedChunks(content, chunkPatterns.chunks.named, suffix);
                if (chunkFiles.length > 0) {
                    this.hasLoadedChunk = true;
                }
            } else {
                this.hasLoadedChunk = true;
            }
            return chunkFiles;
        } catch (error: any) {
            logger.error(`[-] 解析webpack chunks失败: ${error.message}`);
            return [];
        }
    }

    /**
     * 从HTML中获取js链接 <script src="">
     * @param content 
     */
    private getJSLinks(content: string): void {
        const $ = cheerio.load(content, { xmlMode: true } as any);
        // 筛选出带有src的script标签
        const linksTag = $('script[src]'); 
        let _link = '';
        linksTag.each((i: number, elem: any) => {
            const link = elem.attribs.src; 
            if(link !== undefined && !blockedFileNames.test(link)){ // 只针对src 中的链接筛除黑名单中的库文件
                this.jsLinks.add(link);
            }
            if(link && !link.startsWith('http')){ // 非跨域加载
                _link = link;
            }
        });
        
        // 筛选出不带有src的script标签
        const inlineScriptTags = $('script:not([src])'); 
        inlineScriptTags.each((i: number, elem: any) => {
            const text = $(elem).first().html()?.replace(/"/g,'"') || '';
            if(this.packType === 1){ // 获取webpack 的文件名
                const links = this.getChunkLinks(text);
                if(links.length === 0) return; // 没获取到说明 chunks 文件分组在 其他js文件中
                _link = _link.slice(0, _link.lastIndexOf('/') + 1);
                links.forEach(item => {
                    if (_link) {
                        this.jsLinks.add(_link + item);
                    }
                });
            }else{
                this.scanPath(text).forEach(api => this.paths.push(api));
                this.scanSensitiveInfo(text, "DefaultPage").forEach(info => this.sensitiveInfo.push(info));
            }
        });
    }

    private scanSensitiveInfo(content: string, fileName: string): SensitiveInfo[] {
        let sensitiveInfo: SensitiveInfo[] = [];
        for (const [category, pattern] of Object.entries(SENSITIVE_PATTERNS)) {
            const info = this.highlightRegexMatches(content, category, pattern, fileName);
            sensitiveInfo.push(...info);
        }
        return sensitiveInfo;
    }

    private highlightRegexMatches(text: string, category: string, regex: RegExp, fileName: string, contextLength = 100): SensitiveInfo[] {
        const results: SensitiveInfo[] = [];
        const lines = text.split('\n');
        const lineStartPositions = this.calculateLineStartPositions(lines);
        const globalRegex = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
        
        let match;
        while ((match = globalRegex.exec(text)) !== null) {
            const matchIndex = match.index;
            const matchText = match[0];
            const lineNumber = this.findLineNumber(matchIndex, lineStartPositions);
            const lineText = lines[lineNumber - 1];
            const matchInLineIndex = matchIndex - lineStartPositions[lineNumber - 1];
            
            // 计算上下文
            const startContext = Math.max(0, matchInLineIndex - contextLength);
            const endContext = Math.min(lineText.length, matchInLineIndex + matchText.length + contextLength);
            const context = lineText.substring(startContext, endContext);
            
            // 高亮匹配的部分（在上下文中）
            const highlightedMatchStart = matchInLineIndex - startContext;
            const highlightedMatchEnd = highlightedMatchStart + matchText.length;
            
            const beforeMatch = context.substring(0, highlightedMatchStart);
            const matchedPart = context.substring(highlightedMatchStart, highlightedMatchEnd);
            const afterMatch = context.substring(highlightedMatchEnd);
            const highlightedContext = `${beforeMatch}§${matchedPart}§${afterMatch}`;
            results.push(new SensitiveInfo(fileName, category, matchText, lineNumber, highlightedContext));
        }
        return results;
    }
    /**
     * 从js文件中提取出api path
     */
    private scanPath(content: string, fileName?: string): Api[] {
        const code = this.parseWithBabel(content);
        let paths = [...code.matchAll(pattern)].map(item => formatPath(item[0].slice(1, -1))); // 从js文件中正则提取出 path
        paths = paths.concat([...code.matchAll(pattern2)].map(item => formatPath(item[0].slice(1, -1))));
        paths = [...new Set(paths)];
        paths = paths.filter((item) => !(this.hasStaticExt(item) || this.hasIllegalPaths(item))); // 去掉静态资源文件 和 黑名单中的文件名
        let result: Api[] = [];
        if(paths.length > 0){
            for(let item of paths){
                result.push(new Api(item, fileName ? fileName : this.url));
            }
        }
        return result;
    }


    private parseWithBabel(content: string): string {
        if(content.length > 10 * 1024 * 1024){
            return content; // 避免堆内存溢出报错
        }
        let ast: any = '';
        try{
            ast = parse(content, {sourceType: "unambiguous", tokens: false, errorRecovery: true});
        }catch(error){
            return content;
        }
        const visitor = {
            "BinaryExpression|CallExpression"(path: any) {
                const { node } = path;
                // 检查是否是 .concat() 调用
                const isConcat = path.isCallExpression() &&
                    types.isMemberExpression(node.callee) &&
                    types.isIdentifier(node.callee.property, { name: 'concat' });

                // 检查是否是 '+' 运算符
                const isPlus = path.isBinaryExpression({ operator: '+' });
                if (isConcat || isPlus) {
                    const { confident, value } = path.evaluate();
                    if (confident) {
                        path.replaceWith(types.valueToNode(value));
                    }
                }
            },
            "TemplateLiteral"(path: any) { // 处理模板字符串
                if (!path.parentPath.isTaggedTemplateExpression()) {
                    const wholeEvaluated = path.evaluate();
                    if (wholeEvaluated.confident) {
                        path.replaceWith(types.valueToNode(wholeEvaluated.value));
                        return;
                    }
                }

                const expressions = path.get('expressions');
                for (const exprPath of expressions) {
                    const evaluated = exprPath.evaluate();
                    if (evaluated.confident) {
                        exprPath.replaceWith(types.valueToNode(evaluated.value));
                        continue;
                    }

                    // 处理特殊的 let a; a = 'a'; 场景
                    if (exprPath.isIdentifier()) {
                        const binding = exprPath.scope.getBinding(exprPath.node.name);
                        if (binding && !binding.constant && binding.constantViolations.length === 1) {
                            const violationPath = binding.constantViolations[0];
                            if (violationPath.scope === binding.scope &&
                                violationPath.isAssignmentExpression() && 
                                violationPath.node.operator === '=' &&
                                types.isStringLiteral(violationPath.node.right)
                            ) {
                                const assignmentEnd = violationPath.node.end;
                                const currentStart = exprPath.node.start;
                                if (typeof assignmentEnd === 'number' && typeof currentStart === 'number' && assignmentEnd < currentStart) {
                                    exprPath.replaceWith(types.stringLiteral(violationPath.node.right.value));
                                }
                            } else if (violationPath.isIdentifier() && violationPath.scope === binding.scope) {
                                const assignmentPath = violationPath.parentPath;
                                if (
                                    assignmentPath.isAssignmentExpression() &&
                                    assignmentPath.node.operator === '=' &&
                                    assignmentPath.node.left === violationPath.node &&
                                    types.isStringLiteral(assignmentPath.node.right)
                                ) {
                                    const assignmentEnd = assignmentPath.node.end;
                                    const currentStart = exprPath.node.start;
                                    if (typeof assignmentEnd === 'number' && typeof currentStart === 'number' && assignmentEnd < currentStart) {
                                        exprPath.replaceWith(types.stringLiteral(assignmentPath.node.right.value));
                                    }
                                }
                            }
                        }
                    }
                }

                // 合并相邻的字符串 (Quasis 处理)
                const node = path.node;
                for (let i = node.expressions.length - 1; i >= 0; i--) {
                    const expr = node.expressions[i];
                    if (types.isStringLiteral(expr)) {
                        const nextQuasi = node.quasis[i + 1];
                        const currentQuasi = node.quasis[i];
                        if (currentQuasi && nextQuasi) {
                            currentQuasi.value.raw += (expr.value + nextQuasi.value.raw);
                            currentQuasi.value.cooked += (expr.value + nextQuasi.value.cooked);
                            node.quasis.splice(i + 1, 1);
                            node.expressions.splice(i, 1);
                        }
                    }
                }

                if (node.expressions.length === 0 && node.quasis.length === 1) {
                    if (path.parentPath.isTaggedTemplateExpression()) {
                        return; 
                    }
                    path.replaceWith(types.stringLiteral(node.quasis[0].value.cooked || ""));
                }
            }
        };
        traverse(ast, visitor);
        let {code} = generator(ast, {jsescOption:{"minimal":true}});
        return code;
    }

    private async scan(fileName: string): Promise<void> {
        try{
            const content = await fs.promises.readFile(path.join(this.dirPath, fileName), {encoding: "utf-8"});
            const result = this.scanPath(content, fileName);
            result.forEach(item => this.paths.push(item));
            const info = this.scanSensitiveInfo(content, fileName);
            info.forEach(item => this.sensitiveInfo.push(item));
            this.completeCount += 1;
            this.progressBar.update(this.completeCount);
        }catch(error){
            console.log(error);
        }
    }

    private async scanFiles(): Promise<void> {
        const limit = pLimit(this.limitCount);
        const sourceMapDir = path.join(this.dirPath, 'src');
        if(fs.existsSync(sourceMapDir)){
           const files = fs.readdirSync(sourceMapDir) as string[];
           files.forEach(item => this.need2ScanFiles.add(path.join('src', item)));
        }
        
        logger.info("[+] 开始扫描js");
        this.progressBar.start(this.need2ScanFiles.size, 0);
        const promises = Array.from(this.need2ScanFiles).map(fileName => limit(() => this.scan(fileName)));
        await Promise.allSettled(promises);
        
        this.progressBar.stop();
        this.paths = uniqueByPath(this.paths);
        
        if(this.url !== ''){
            await this.deepScan(this.paths);
        }
        
        this.paths = this.paths.filter(item => item.path.indexOf('.js') < 0);
        
        // 确保result目录存在
        const resultDir = path.join(this.dirPath, 'result');
        fs.mkdirSync(resultDir, { recursive: true });
        
        // 写入paths.txt
        const _stream = fs.createWriteStream(path.join(resultDir, 'paths.txt'), { flags: 'a' });
        this.paths.forEach(item => _stream.write(item.path + '\n'));
        _stream.end();
        
        logger.info(`[+] API path 扫描完成，共提取到 ${this.paths.length} 个API，已保存到文件paths.txt中！`);
        const sensitiveInfoJson = '[' + this.sensitiveInfo.map((item: SensitiveInfo) => item.toString()).join(',') + ']';
        fs.writeFileSync(path.join(resultDir, 'sensitive_info.json'), sensitiveInfoJson);
        
        logger.info(`[+] 敏感信息扫描完成，共提取到 ${this.sensitiveInfo.length} 条敏感信息，已保存到文件sensitive_info.json中！`);
        logger.info('[+] 所有文件扫描完成!');
    }
    /**
     * 从json中扫描API、js文件
     */
    private async deepScan(paths: Api[]): Promise<void> {
        const jsPaths: string[] = [];
        paths.forEach(element => {
            const ext = path.extname(element.path).toLowerCase();
            if(ext.indexOf('.js') === 0) {
                jsPaths.push(element.path);
            }
        });
        
        if(jsPaths.length > 0){
            const promises: Promise<void>[] = [];
            
            for(const item of jsPaths){
                const itemLower = item.toLowerCase();
                
                if(itemLower.includes('.json')){
                    logger.log(`[+] 发现路径中存在json文件 ${item} ，尝试扫描API...`);
                    const rep = await getContent(this.url + this.basheURL + item, this.headers);
                    if(rep?.status === 200){
                        await this.deepScan(this.scanPath(rep.data, item));
                        logger.log(`[+] json文件 ${item} 扫描完成`);
                    } else {
                        logger.warn(`[-] json文件加载失败，状态码：${rep?.status || 'unknown'}`);
                    }
                    continue;
                }
                
                if(itemLower.includes('.js') && !this.need2ScanFiles.has(item) && !blockedFileNames.test(item)){
                    logger.log(`[+] 发现API路径中存在js文件 ${item} ，尝试下载并扫描API...`);
                    const downloader = new Downloader(this.mainPageSimHash);
                    const promise = downloader.downloadSingleFile(this.url + item, this.headers, this.dirPath)
                        .then(result => {
                            if(result !== null){
                                this.need2ScanFiles.add(result.filePath);
                                this.scanPath(result.body, result.filePath).forEach(api => this.paths.push(api));
                                logger.log(`[+] js文件 ${item} 扫描完成`);
                            }
                        });
                    promises.push(promise);
                }
            }
            // 等待所有异步操作完成
            await Promise.allSettled(promises);
        }
    }

    //***********工具函数***********

    /**
     * 提取数字类型的js文件名
     */
    private extractNumericChunks(content: string, pattern: RegExp, suffix: string): string[] {
        return [...content.matchAll(pattern)].map(item => {
            const [id, hash] = item[0].split(':');
            return [id, hash.slice(1, -1), suffix].join('.');
        });
    }

    /**
     * 提取带有chunk的js文件名
     */
    private extractNamedChunks(content: string, pattern: RegExp, suffix: string): string[] {
        return [...content.matchAll(pattern)].map(item => {
            const [chunkName, hash] = item[0].split(':')
                .map(part => part.replace(/"/g, ''));
            return [chunkName, hash, suffix].join('.');
        });
    }

    /**
     * 判断前端是否有chunk分包特征
     * @param content 
     * @returns 
     */
    private hasPackedMark(content: string): boolean {
        const rules = [
            /app\.[a-z0-9]{8,20}(\.chunk)?\.js/,
            /runtime\.[a-z0-9]{8,20}(\.chunk)?\.js/,
            /scripts\.[a-z0-9]{8,20}(\.chunk)?\.js/,
            /main\.[a-z0-9]{8,20}(\.chunk)?\.js/,
        ];
        return rules.some(rule => rule.test(content));
    }

    private hasIllegalPaths(path: string | null): boolean {
        if (path === null) return true;
        return blockedPaths.test(path.toLowerCase()) || 
                path.startsWith('/@') || 
                path.startsWith('/modules/') || 
                path.startsWith('/node_modules/') || 
                path.startsWith('/views') ||
                path.endsWith('.');
    }

    private hasStaticExt(apiPath: string): boolean {
        const ext = path.extname(apiPath).toLowerCase();
        const hasStaticExt = STATIC_EXTENSIONS.has(ext);
        
        switch (this.packType) {
            case 1: // webpack 打包
                return hasStaticExt;
            case 2: // vite 打包
                return this.hasLoadedChunk ? (hasStaticExt || ext === '.js') : ext !== '.js';
            default:
                return hasStaticExt || ext === '.js';
        }
    }

    /**
     * 计算每行的起始位置
     */
    private calculateLineStartPositions(lines: string[]): number[] {
        const lineStartPositions: number[] = [];
        let position = 0;
        for (let i = 0; i < lines.length; i++) {
            lineStartPositions[i] = position;
            position += lines[i].length + 1;
        }
        return lineStartPositions;
    }

    private findLineNumber(matchIndex: number, lineStartPositions: number[]): number {
        let left = 0;
        let right = lineStartPositions.length - 1;
        
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (matchIndex >= lineStartPositions[mid] && 
                (mid === lineStartPositions.length - 1 || matchIndex < lineStartPositions[mid + 1])) {
                return mid + 1;
            } else if (matchIndex < lineStartPositions[mid]) {
                right = mid - 1;
            } else {
                left = mid + 1;
            }
        }
        return lineStartPositions.length;
    }

}

function escapeRegExp(expr: string): string {
    return expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
}


export default Site;