export class SimpleSimHash {
    /**
     * 计算文本的 SimHash 指纹 (32-bit Signed Integer)
     */
    static compute(text: string): number {
        const tokens = text.split(/\W+/).filter(t => t.length > 0);
        const v = new Array(32).fill(0);
        for (const token of tokens) {
            const hash = this._stringHash(token);
            for (let i = 0; i < 32; i++) {
                // 如果该位是 1，则权重 +1，否则 -1
                const bit = (hash & (1 << i)) ? 1 : -1;
                v[i] += bit;
            }
        }

        let fingerprint = 0;
        for (let i = 0; i < 32; i++) {
            // 如果权重和 > 0，则该位设为 1
            if (v[i] > 0) fingerprint |= (1 << i);
        }
        return fingerprint;
    }

    /**
     * 计算两个指纹的海明距离 (Hamming Distance)
     */
    static getDistance(hashA: number, hashB: number): number {
        let xor = hashA ^ hashB;
        let distance = 0;
        while (xor !== 0) {
            distance++;
            xor &= (xor - 1);
        }
        return distance;
    }

    /**
     * 内部简单的字符串 Hash 函数 (类似 Java String.hashCode)
     */
    static _stringHash(str: string): number {
        let hash = 0;
        if (str.length === 0) return hash;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash | 0;
        }
        return hash;
    }
}