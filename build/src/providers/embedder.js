import { createHash } from 'node:crypto';
/** 确定性 hash 向量：零依赖、可复现；dim 与量化版本可配，用于静默降质验收。 */
export function hashEmbedder(options = {}) {
    const dim = options.dim ?? 16;
    const quantizationVersion = options.quantizationVersion ?? 'q1';
    const modelId = options.modelId ?? 'hash-embedder';
    return {
        dim,
        quantizationVersion,
        modelId,
        embed(text) {
            const h = createHash('sha256').update(text).digest();
            const out = [];
            for (let i = 0; i < dim; i++)
                out.push((h[i % h.length] - 128) / 128);
            return out;
        },
    };
}
