import type { RetrieverProvider } from '../pipeline/types.js';
/** Provider A：向量余弦。 */
export declare function cosineRetriever(): RetrieverProvider;
/** Provider B：关键词重叠（同一 seam、不同算法，验证可互换）。 */
export declare function keywordRetriever(): RetrieverProvider;
