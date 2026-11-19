import type { MemoryRecord, Provenance, StorageProvider, VectorProvider } from '../pipeline/types.js'
import { CONTRACT_VERSION } from '../../seams/contract-version.js'

/**
 * L0 持久化 provider（填 storage / vector 两个既有 seam，不改契约）。
 *
 * 同步 seam 接口 ↔ 异步 PG 客户端的桥：
 *   - 读写都落在内存镜像上，保持与 inMemoryStorage 完全相同的同步语义；
 *   - 落库由 L0Stack.flush() 做「全量 diff → 参数化 UPSERT」，
 *     这样连 strengthened 分支对 provenance.evidence 的原地修改也不会漏写；
 *   - 同一时刻只允许一个写进程，避免多进程镜像分叉（见 docs/DEPLOY.md）。
 */

/** L0 固定向量维度。换 embedding 模型需要 DDL migration，属运维动作，不是契约变更。 */
export const EMBEDDING_DIM = 16

/** 唯一 DDL 源；docker/initdb/01-schema.sql 与本常量由测试断言字面一致。 */
export const SCHEMA_SQL = `CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_records (
  event_id            TEXT PRIMARY KEY,
  principal           TEXT NOT NULL,
  bank_id             TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ,
  recorded_at         TIMESTAMPTZ NOT NULL,
  valid_from          TIMESTAMPTZ,
  valid_to            TIMESTAMPTZ,
  content             TEXT NOT NULL,
  scene               TEXT,
  raw_pointer         TEXT,
  dedupe_fingerprint  TEXT NOT NULL,
  state               TEXT NOT NULL,
  accepted_at         TIMESTAMPTZ NOT NULL,
  visible_at          TIMESTAMPTZ,
  provenance          JSONB,
  vector              JSONB,
  archive_reason      TEXT,
  mental_model        TEXT,
  facts               JSONB,
  contract_version    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_records_bank_state
  ON memory_records (bank_id, state);

CREATE INDEX IF NOT EXISTS idx_memory_records_recorded_at
  ON memory_records (recorded_at DESC);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  event_id             TEXT PRIMARY KEY
                       REFERENCES memory_records(event_id) ON DELETE CASCADE,
  embedding            vector(16),
  dim                  INTEGER NOT NULL,
  quantization_version TEXT NOT NULL,
  contract_version     TEXT NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_audit_log (
  id               TEXT PRIMARY KEY,
  at               TIMESTAMPTZ NOT NULL,
  event            TEXT NOT NULL,
  principal        TEXT,
  bank_id          TEXT,
  operation        TEXT,
  request_id       TEXT,
  payload          JSONB,
  contract_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_audit_at
  ON memory_audit_log (at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_audit_principal_bank
  ON memory_audit_log (principal, bank_id, at DESC);
`

export const UPSERT_RECORD_SQL = `INSERT INTO memory_records (
  event_id, principal, bank_id, occurred_at, recorded_at, valid_from, valid_to,
  content, scene, raw_pointer, dedupe_fingerprint, state, accepted_at, visible_at,
  provenance, vector, archive_reason, mental_model, facts, contract_version
) VALUES (
  $1, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7::timestamptz,
  $8, $9, $10, $11, $12, $13::timestamptz, $14::timestamptz,
  $15::jsonb, $16::jsonb, $17, $18, $19::jsonb, $20
) ON CONFLICT (event_id) DO UPDATE SET
  state            = EXCLUDED.state,
  visible_at       = EXCLUDED.visible_at,
  provenance       = EXCLUDED.provenance,
  vector           = EXCLUDED.vector,
  archive_reason   = EXCLUDED.archive_reason,
  mental_model     = EXCLUDED.mental_model,
  facts            = EXCLUDED.facts,
  contract_version = EXCLUDED.contract_version`

export const UPSERT_EMBEDDING_SQL = `INSERT INTO memory_embeddings (
  event_id, embedding, dim, quantization_version, contract_version
) VALUES ($1, $2::vector, $3, $4, $5)
ON CONFLICT (event_id) DO UPDATE SET
  embedding            = EXCLUDED.embedding,
  dim                  = EXCLUDED.dim,
  quantization_version = EXCLUDED.quantization_version,
  contract_version     = EXCLUDED.contract_version,
  updated_at           = now()`

export const SELECT_RECORDS_SQL = `SELECT
  event_id, principal, bank_id, occurred_at, recorded_at, valid_from, valid_to,
  content, scene, raw_pointer, dedupe_fingerprint, state, accepted_at, visible_at,
  provenance, vector, archive_reason, mental_model, facts, contract_version
FROM memory_records`

export const SELECT_EMBEDDINGS_SQL = `SELECT
  event_id, embedding::text AS embedding_text, dim, quantization_version, contract_version
FROM memory_embeddings`

export interface PgQueryResult {
  rows: Array<Record<string, unknown>>
  rowCount?: number
}

/** 可注入的 PG 客户端契约：真实用 pg.Client，离线验收用 mock。 */
export interface PgLikeClient {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>
  end?(): Promise<void>
}

export interface WriteOp {
  sql: string
  params: unknown[]
  label: string
}

export async function ensureSchema(client: PgLikeClient): Promise<void> {
  // 无参数 → pg 走 simple query protocol，允许多语句；DDL 全部 IF NOT EXISTS，幂等。
  await client.query(SCHEMA_SQL)
}

function iso(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

function jsonValue<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T } catch { return fallback }
  }
  return v as T
}

/** PG row → MemoryRecord。兼容 mock（string）与 pg（Date / 已解析 JSONB）两种返回。 */
export function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const state = row.state
  return {
    event_id: String(row.event_id),
    principal: String(row.principal),
    bank_id: String(row.bank_id),
    occurred_at: iso(row.occurred_at) ?? '',
    recorded_at: iso(row.recorded_at) ?? '',
    valid_from: iso(row.valid_from),
    valid_to: iso(row.valid_to),
    content: String(row.content),
    scene: row.scene == null ? null : String(row.scene),
    raw_pointer: row.raw_pointer == null ? null : String(row.raw_pointer),
    dedupe_fingerprint: String(row.dedupe_fingerprint),
    state: state === 'visible' || state === 'archived' ? state : 'pending',
    accepted_at: iso(row.accepted_at) ?? '',
    visible_at: iso(row.visible_at),
    provenance: jsonValue<Provenance | null>(row.provenance, null),
    vector: jsonValue<number[] | null>(row.vector, null),
    archive_reason: row.archive_reason == null ? null : String(row.archive_reason),
    mental_model: row.mental_model == null ? null : String(row.mental_model),
    facts: jsonValue<string[] | null>(row.facts, null),
  }
}

export function recordParams(r: MemoryRecord): unknown[] {
  return [
    r.event_id, r.principal, r.bank_id,
    r.occurred_at, r.recorded_at, r.valid_from, r.valid_to,
    r.content, r.scene, r.raw_pointer, r.dedupe_fingerprint, r.state,
    r.accepted_at, r.visible_at,
    JSON.stringify(r.provenance), JSON.stringify(r.vector),
    r.archive_reason, r.mental_model, JSON.stringify(r.facts ?? null),
    r.provenance?.contract_version ?? CONTRACT_VERSION,
  ]
}

export function embeddingParams(
  eventId: string,
  vec: number[] | null,
  dim: number,
  quantizationVersion: string,
): unknown[] {
  // pgvector 接受 '[1,2,3]' 字符串字面量；维度不匹配时写 NULL 并保留元数据（可观测隔离）。
  const literal = vec && vec.length === EMBEDDING_DIM ? `[${vec.join(',')}]` : null
  return [eventId, literal, dim, quantizationVersion, CONTRACT_VERSION]
}

export interface PgVectorStorageHandle extends StorageProvider {
  hydrate(): Promise<number>
  /** 只读迭代，供 flush 做 diff；不暴露内部可变引用的写权限。 */
  entries(): Iterable<[string, MemoryRecord]>
  /** 离线验收用：把一批 row 直接装进镜像。 */
  replaceAll(rows: Array<Record<string, unknown>>): number
}

export function pgVectorStorage(options: { client: PgLikeClient }): PgVectorStorageHandle {
  const { client } = options
  const map = new Map<string, MemoryRecord>()
  return {
    kind: 'pgvector-storage',
    put(r) { map.set(r.event_id, r) },
    get(id) { return map.get(id) },
    all() { return [...map.values()] },
    markVisible(id, at) {
      const r = map.get(id)
      if (r) { r.state = 'visible'; r.visible_at = at }
    },
    archive(id, reason) {
      const r = map.get(id)
      if (r) { r.state = 'archived'; r.archive_reason = reason }
    },
    snapshot() { return JSON.stringify([...map.values()]) },
    entries() { return map.entries() },
    replaceAll(rows) {
      map.clear()
      for (const row of rows) {
        const r = rowToRecord(row)
        map.set(r.event_id, r)
      }
      return map.size
    },
    async hydrate() {
      const res = await client.query(SELECT_RECORDS_SQL)
      return this.replaceAll(res.rows)
    },
  }
}

export interface PgVectorIndexHandle extends VectorProvider {
  hydrate(): Promise<number>
  entries(): Iterable<[string, number[]]>
  /** 维度与 EMBEDDING_DIM 不符、被拒写 embedding 列的 event_id。 */
  quarantined(): string[]
  /** 每条向量的量化版本，由装配层注入。 */
  readonly quantizationVersion: string
}

export function pgVectorIndex(options: {
  client: PgLikeClient
  quantizationVersion: string
}): PgVectorIndexHandle {
  const { client, quantizationVersion } = options
  const map = new Map<string, number[]>()
  const rejected: string[] = []
  return {
    kind: 'pgvector-index',
    quantizationVersion,
    upsert(id, v) {
      map.set(id, v)
      if (v.length !== EMBEDDING_DIM && !rejected.includes(id)) rejected.push(id)
      if (v.length === EMBEDDING_DIM && rejected.includes(id)) {
        rejected.splice(rejected.indexOf(id), 1)
      }
    },
    size() { return map.size },
    entries() { return map.entries() },
    quarantined() { return [...rejected] },
    async hydrate() {
      const res = await client.query(SELECT_EMBEDDINGS_SQL)
      map.clear()
      rejected.length = 0
      for (const row of res.rows) {
        const id = String(row.event_id)
        const text = row.embedding_text == null ? null : String(row.embedding_text)
        const dim = Number(row.dim)
        if (!text || text === '') { rejected.push(id); continue }
        const v = text.replace(/^\[|\]$/g, '').split(',').map(Number).filter(Number.isFinite)
        if (v.length === EMBEDDING_DIM) map.set(id, v)
        else { map.set(id, new Array(dim).fill(0)); rejected.push(id) }
      }
      return map.size
    },
  }
}
