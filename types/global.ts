// 全局类型声明文件

declare module 'cli-progress' {
    export class SingleBar {
        constructor(options?: any, preset?: any);
        start(total: number, startValue: number): void;
        update(current: number): void;
        stop(): void;
    }
}

declare module '@babel/traverse' {
    const traverse: any;
    export default traverse;
}

declare module '@babel/generator' {
    interface GeneratorOptions {
        auxiliaryCommentBefore?: string;
        auxiliaryCommentAfter?: string;
        shouldPrintComment?: (comment: string) => boolean;
        retainLines?: boolean;
        retainFunctionParens?: boolean;
        comments?: boolean;
        compact?: boolean | "auto";
        minified?: boolean;
        concise?: boolean;
        jsescOption?: {
            quotes?: "single" | "double" | "bracket";
            wrap?: boolean;
            minimal?: boolean;
            json?: boolean;
        };
        sourceMaps?: boolean;
        sourceRoot?: string;
        filename?: string;
        tokens?: boolean;
        topicToken?: string;
        importAttributesKeyword?: string;
        experimental_preserveFormat?: boolean;
        decoratorsBeforeExport?: boolean;
        jsonCompatibleStrings?: boolean;
        recordAndTupleSyntaxType?: string;
    }

    interface GeneratorResult {
        code: string;
        map?: object;
    }

    function generate(ast: object, opts?: GeneratorOptions, code?: string): GeneratorResult;
    
    class CodeGenerator {
        constructor(ast: object, opts?: GeneratorOptions, code?: string);
        generate(): GeneratorResult;
    }

    export { generate, CodeGenerator, GeneratorOptions, GeneratorResult };
    export default generate;
}

declare module '@babel/parser' {
    import { File } from '@babel/types';

    interface ParserOptions {
        sourceType?: "script" | "module" | "unambiguous";
        sourceFilename?: string;
        startLine?: number;
        allowAwaitOutsideFunction?: boolean;
        allowReturnOutsideFunction?: boolean;
        allowImportExportEverywhere?: boolean;
        allowSuperOutsideMethod?: boolean;
        allowUndeclaredExports?: boolean;
        plugins?: string[];
        strictMode?: boolean;
        ranges?: boolean;
        tokens?: boolean;
        createParenthesizedExpressions?: boolean;
        errorRecovery?: boolean;
    }

    function parse(input: string, options?: ParserOptions): File;
    
    export { parse, ParserOptions };
}
