import path from 'path';
import fs from 'fs';

const ALLOWED_EXTENSIONS = ['.js', '.ts', '.tsx', '.cjs', '.mjs']; //先不添加.vue文件，后续如果有其他情况再考虑
/* map文件中sources中存放源代码文件名，sourcesContent中存放对应的源代码文件内容 */
interface SourceMap {
    version: number;
    sources: string[];
    sourcesContent: string[];
    names: string[];
    mappings: string;
    file?: string;
    sourceRoot?: string;
}
/**
 * 去掉webpack：///
 * @param sourcePath 
 * @returns 
 */
function cleanSourcePath(sourcePath: string): string {
    let cleanedPath = sourcePath;
    cleanedPath = cleanedPath.replace(/^[^:]+:\/+/, '');
    cleanedPath = cleanedPath.replace(/^[\.\/]+/, '');
    return cleanedPath;
}

export function extractScources(content: string, outputDir: string) : void{
    const mapData: SourceMap = JSON.parse(content);
    if (!mapData.sourcesContent || mapData.sourcesContent.length > 0) {
        mapData.sources.forEach((sourcePath, index) => {
            let cleanPath = cleanSourcePath(sourcePath.split('?')[0]);
            if(cleanPath.indexOf('node_modules/') < 0){
                cleanPath = cleanPath.replace(/\//g, '_');
                const ext = path.extname(cleanPath).toLocaleLowerCase();
                if (ALLOWED_EXTENSIONS.includes(ext)) {
                    const fileContent = mapData.sourcesContent[index];
                    fs.writeFileSync(path.join(outputDir, cleanPath), fileContent, 'utf-8');
                }
            }
        });
    }
}