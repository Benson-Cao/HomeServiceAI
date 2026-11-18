import type { RankerProvider, RerankerProvider } from '../pipeline/types.js';
/** ranker：融合后二次排序（本地、确定性、零模型依赖）。 */
export declare function lexicalRanker(): RankerProvider;
/** ranker 第二实现：按证据置信度加成。 */
export declare function provenanceRanker(): RankerProvider;
/** reranker：Cross-Encoder 风格的确定性查询-文档交互打分（V0.7 本地轻量实现）。 */
export declare function pairwiseReranker(): RerankerProvider;
/** reranker 第二实现：保持融合名次，仅做截断（可互换验证）。 */
export declare function identityReranker(): RerankerProvider;
