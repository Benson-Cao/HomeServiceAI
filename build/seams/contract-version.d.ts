/** 单一版本源。对齐架构图 v1.2 / ADR v1.2。改动必须走 ADR + 换 provider 测试。 */
export declare const CONTRACT_VERSION: "1.2.0";
export type ContractVersion = typeof CONTRACT_VERSION;
/** schema 与运行时载荷的兼容性判定：MAJOR 不同即拒，避免静默降质。 */
export declare function isCompatible(payloadVersion: string, current?: string): boolean;
/** 向量维度/量化版本变更时，调用方必须先隔离或拒检旧向量。 */
export declare function isVectorCompatible(a: {
    embedding_dim: number;
    quantization_version: string;
}, b: {
    embedding_dim: number;
    quantization_version: string;
}): boolean;
