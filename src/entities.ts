export class Api {
    public path: string;
    public fileName: string;
    public statusCode: number;
    public responseContent: string;
    public responseLength?: number;

    constructor(path: string, fileName: string) {
        this.path = path;
        this.fileName = fileName;
        this.statusCode = 0;
        this.responseContent = '';
        this.responseLength = 0;
    }

    toString(): string {
        const buff = Buffer.from(this.responseContent, 'utf-8').toString('base64');
        return `{"Path": "${this.path}", "StatusCode":${this.statusCode}, "ResponseContent": "${buff}", "ResponseLength": ${this.responseLength}, "FileName":"${this.fileName.replace(/\\/g, '\\\\')}"}`;
    }
}

export class SensitiveInfo {
    public fileName: string;
    public category: string;
    public matchedText: string;
    public lineNumber: number;
    public highlightedContext: string;

    constructor(fileName: string, category: string, match: string, lineNumber: number, highlightedContext: string) {
        this.fileName = fileName;
        this.category = category;
        this.matchedText = match;
        this.lineNumber = lineNumber;
        this.highlightedContext = highlightedContext;
    }
    toString(): string {
        const buff = Buffer.from(this.highlightedContext, 'utf-8').toString('base64');
        const matchedBuff = Buffer.from(this.matchedText, 'utf-8').toString('base64');
        return `{"FileName":"${this.fileName.replace(/\\/g, '\\\\')}", "Category":"${this.category}", "MatchedText":"${matchedBuff}", "LineNumber":${this.lineNumber}, "HighlightedContext":"${buff}"}`;
    }
}
