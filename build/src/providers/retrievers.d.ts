import type { RetrieverProvider } from '../pipeline/types.js';
/** 语义通道：向量余弦。 */
export declare function semanticRetriever(): RetrieverProvider;
/** 语义通道第二实现：关键词重叠（同 seam、不同算法）。 */
export declare function overlapRetriever(): RetrieverProvider;
/** BM25 通道：消费 fulltext seam 的倒排/词面结果。 */
export declare function bm25Retriever(): RetrieverProvider;
/** 图通道：沿实体邻接遍历，命中邻居即得分。 */
export declare function graphRetriever(): RetrieverProvider;
/** 时间通道：按 valid_at 与 occurred_at 的距离衰减，越近越高。 */
export declare function temporalRetriever(): RetrieverProvider;
/** 时间通道第二实现：只按 valid time 区间命中，不衰减。 */
export declare function intervalRetriever(): RetrieverProvider;
