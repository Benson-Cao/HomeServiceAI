import { bindings } from '../profiles/bindings.js'
import type { Profile } from '../profiles/types.js'
import type { EmbedderProvider, StorageProvider, VectorProvider } from '../pipeline/types.js'
import {
  ensureSchema, pgVectorIndex, pgVectorStorage, EMBEDDING_DIM,
  UPSERT_RECORD_SQL, UPSERT_EMBEDDING_SQL,
  recordParams, embeddingParams,
  type PgLikeClient, type PgVectorStorageHandle, type PgVectorIndexHandle, type WriteOp,
} from '../providers/pgvector.js'
import { CONTRACT_VERSION } from '../../seams/contract-version.js'

export interface L0Stack {
  readonly profile: Profile
  readonly storage: PgVectorStorageHandle
  readonly vector: PgVectorIndexHandle
  readonly contractVersion: string
  /** 计算当前待写操作数（不执行、不改状态）。 */
  pendingWrites(): number
  /** 全量 diff → 参数化 UPSERT；失败时保留 baseline，重试幂等。 */
  flush(): Promise<number>
  /** flush 后关闭客户端。应用退出前必须 await。 */
  close(): Promise<void>
}

/** L0 装配清单：只覆盖 storage / vector 两个既有 seam，A/B 两份 profile 原样不动。 */
export function l0Profile(storage: StorageProvider, vector: VectorProvider): Profile {
  return {
    name: 'profile-l0',
    providers: bindings({
      'storage': () => storage,
      'vector': () => vector,
    }),
  }
}

function signature(value: unknown): string {
  return JSON.stringify(value)
}

export async function createL0Stack(client: PgLikeClient): Promise<L0Stack> {
  await ensureSchema(client)

  // 量化版本与装配层默认 embedder 同源，不硬编码。
  const embFactory = bindings().find((b) => b.seam === 'embedder')?.factory
  const emb = embFactory?.() as EmbedderProvider | undefined
  const quantizationVersion = emb?.quantizationVersion ?? 'q1'

  const storage = pgVectorStorage({ client })
  const vector = pgVectorIndex({ client, quantizationVersion })
  await storage.hydrate()
  await vector.hydrate()

  const baselineRecords = new Map<string, string>()
  const baselineEmbeddings = new Map<string, string>()
  for (const [id, r] of storage.entries()) baselineRecords.set(id, signature(r))
  for (const [id, v] of vector.entries()) baselineEmbeddings.set(id, signature([v, quantizationVersion, CONTRACT_VERSION]))

  function collectOps(): WriteOp[] {
    const ops: WriteOp[] = []
    // records 必须先写：memory_embeddings 对 memory_records 有外键。
    for (const [id, r] of storage.entries()) {
      const sig = signature(r)
      if (baselineRecords.get(id) === sig) continue
      ops.push({ sql: UPSERT_RECORD_SQL, params: recordParams(r), label: `record:${id}` })
    }
    for (const [id, v] of vector.entries()) {
      const sig = signature([v, quantizationVersion, CONTRACT_VERSION])
      if (baselineEmbeddings.get(id) === sig) continue
      ops.push({
        sql: UPSERT_EMBEDDING_SQL,
        params: embeddingParams(id, v.length === EMBEDDING_DIM ? v : null, v.length, quantizationVersion),
        label: `embedding:${id}`,
      })
    }
    return ops
  }

  async function flush(): Promise<number> {
    const ops = collectOps()
    for (const op of ops) await client.query(op.sql, op.params)
    // 全部成功后才推进 baseline；中途失败则下次重试（UPSERT 幂等）。
    for (const [id, r] of storage.entries()) baselineRecords.set(id, signature(r))
    for (const [id, v] of vector.entries()) {
      baselineEmbeddings.set(id, signature([v, quantizationVersion, CONTRACT_VERSION]))
    }
    return ops.length
  }

  return {
    profile: l0Profile(storage, vector),
    storage,
    vector,
    contractVersion: CONTRACT_VERSION,
    pendingWrites(): number { return collectOps().length },
    flush,
    async close(): Promise<void> {
      await flush()
      await client.end?.()
    },
  }
}
