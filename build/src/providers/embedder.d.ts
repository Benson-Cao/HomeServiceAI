import type { EmbedderProvider } from '../pipeline/types.js';
/** 确定性 hash 向量：零依赖、可复现；dim 与量化版本可配，用于静默降质验收。 */
export declare function hashEmbedder(options?: {
    dim?: number;
    quantizationVersion?: string;
    modelId?: string;
}): EmbedderProvider;
