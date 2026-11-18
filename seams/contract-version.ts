/** 单一版本源。对齐架构图 v1.2 / ADR v1.2。改动必须走 ADR + 换 provider 测试。 */
export const CONTRACT_VERSION = '1.2.0' as const

export type ContractVersion = typeof CONTRACT_VERSION

/** schema 与运行时载荷的兼容性判定：MAJOR 不同即拒，避免静默降质。 */
export function isCompatible(payloadVersion: string, current: string = CONTRACT_VERSION): boolean {
  const a = payloadVersion.split('.')[0]
  const b = current.split('.')[0]
  return a === b
}

/** 向量维度/量化版本变更时，调用方必须先隔离或拒检旧向量。 */
export function isVectorCompatible(
  a: { embedding_dim: number; quantization_version: string },
  b: { embedding_dim: number; quantization_version: string },
): boolean {
  return a.embedding_dim === b.embedding_dim && a.quantization_version === b.quantization_version
}
