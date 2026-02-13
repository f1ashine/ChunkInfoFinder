#!/usr/bin/env node

import { Command } from 'commander';
import Site from './site';
import log4js from './log4js.config';

const program = new Command();
const logger = log4js.getLogger();

interface CliOptions {
    url?: string;
    baseUrl?: string;
    limitCount?: string;
    cookies?: string;
    header?: string[];
    dir?: string;
    doNotVerify?: boolean;
}
console.time("程序运行耗时");
program
    .name('ChunkInfoFinder')
    .description('CLI to collect api in js files')
    .version('1.0.0', '-v, --version', "输出当前版本信息")
    .option('-u, --url <url>', '输入目标url', stripQuotes)
    .option('-b, --base-url <path>', '设置接口根路径', stripQuotes)
    .option('-l, --limit-count <number>', '设置并发数量', '5')
    .option('-c, --cookies <cookie-string>', '设置cookies', stripQuotes)
    .option('-H, --header <values...>', '配置Header', stripQuotes)
    .option('-d, --dir <dirPath>', '用于传入需要扫描的js文件夹路径', stripQuotes)
    .option('-D, --do-not-verify', '标记不验证API')
    .action((options: CliOptions) => {
        if (options.url !== undefined) {
            const headers: Record<string, string> = {};
            
            if (options.cookies !== undefined) {
                headers['Cookie'] = options.cookies;
            }
            
            if (options.header !== undefined) {
                options.header.forEach(item => {
                const index = item.indexOf(':');
                if (index !== -1) {
                    const key = item.slice(0, index).trim();
                    const value = item.slice(index + 1).trim();
                    headers[key] = value;
                }
                });
            }
        
            const limitCount = parseInt(options.limitCount || '5', 10);
            const site = new Site(options.url, options.baseUrl || '', headers, limitCount, options.doNotVerify ? false : true);
            site.loadMainPage().catch(console.error);
        } else { //未设置 url 时要求传入 dir 参数
            if(options.dir === undefined){
                logger.error("请传入需要扫描的js文件夹路径！");
                process.exit(1);
            }
            const site = new Site('', '', {}, 5, options.doNotVerify ? false : true);
            site.buildScanTask(options.dir);
        }
    });

program.parse(process.argv);

/**
 * 去掉参数自带的引号，防止数据干扰
 */
function stripQuotes(value: string): string {
    return value.replace(/^['"]|['"]$/g, '');
}
