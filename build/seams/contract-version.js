/** 单一版本源。对齐架构图 v1.2 / ADR v1.2。改动必须走 ADR + 换 provider 测试。 */
export const CONTRACT_VERSION = '1.2.0';
/** schema 与运行时载荷的兼容性判定：MAJOR 不同即拒，避免静默降质。 */
export function isCompatible(payloadVersion, current = CONTRACT_VERSION) {
    const a = payloadVersion.split('.')[0];
    const b = current.split('.')[0];
    return a === b;
}
/** 向量维度/量化版本变更时，调用方必须先隔离或拒检旧向量。 */
export function isVectorCompatible(a, b) {
    return a.embedding_dim === b.embedding_dim && a.quantization_version === b.quantization_version;
}
