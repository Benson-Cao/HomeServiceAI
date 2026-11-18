import type { GraphStoreProvider, FulltextProvider } from '../pipeline/types.js';
/** 实体图（邻接表）。V0.7 轻量实现：节点 + 带权边，供 graph retriever 遍历。 */
export declare function adjacencyGraph(): GraphStoreProvider;
/** 倒排索引 fulltext。词项 → 文档命中计数，供 bm25 retriever 使用。 */
export declare function invertedFulltext(): FulltextProvider;
/** 第二实现：无状态词面匹配 fulltext（可互换验证）。 */
export declare function literalFulltext(): FulltextProvider;
