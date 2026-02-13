import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { Api } from './entities';

export function getRealPath(): string {
    const exePath = (process.env.CURRENT === 'node' ? process.cwd() : process.execPath); // 如果将js文件编译为可执行文件执行后的所在
    if (exePath.indexOf('node.exe') > 0 || exePath.indexOf('node') > 0) {
        return path.join(__dirname, '/');
    }else {
        return exePath.slice(0, exePath.lastIndexOf(path.sep) + 1);
    }
}

/**
 * 创建工作目录
 * @param urlString 
 * @returns 
 */
export function createDirectory(urlString: string): string | undefined {
    if (!urlString.startsWith("http://") && !urlString.startsWith("https://")) {
        return undefined;
    }
    
    const url = new URL(urlString);
    const _url = url.host.replace(':', '_') + url.pathname.replace(/\//g, '_') + '_' + Date.now(); // 将域名和路径中的/替换为_
    const dirPath = path.join(process.cwd(), _url);
    
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    
    return dirPath;
}

/**
 * 针对Api数组根据path去重
 * @param apiArray 
 * @returns 
 */
export function uniqueByPath(apiArray: Api[]): Api[] {
    const seen = new Set<string>();
    return apiArray.filter(api => {
        if (seen.has(api.path)) {
            return false;
        }
        seen.add(api.path);
        return true;
    });
}

export function formatPath(item: string): string {
    if(item.endsWith('/')){
        item = item.slice(0, -1);
    }
    if(item.startsWith('./')){
        item = item.slice(1, item.length);
    }
    if(!item.startsWith('/')){
        item = '/' + item;
    }
    return item;
}


export function getFileNamesFromDir(dirPath: string): string[] {
    let files = fs.readdirSync(dirPath, { recursive: true }) as string[];
    return files
        .filter(item => item.endsWith('.js'));
}