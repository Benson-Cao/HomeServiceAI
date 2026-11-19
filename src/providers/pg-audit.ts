import type { AuditProvider } from '../pipeline/types.js'
import { CONTRACT_VERSION } from '../../seams/contract-version.js'
import { auditId } from '../runtime/identity.js'
import type { PgLikeClient } from './pgvector.js'

/**
 * ④ 审计持久化：填既有 `audit` seam，不改契约。
 *
 * 同步阻抗处理和 L0 同构：`record()` 是同步的，PG 是异步的。
 * 所以记录先进内存缓冲，由 daemon 的后台 worker 在 tick 里批量 INSERT。
 * 幂等靠 `ON CONFLICT (id) DO NOTHING`；flush 失败保留缓冲，下次重试。
 *
 * 隐私：审计**不记录记忆正文**。场景插件传的 payload 里若有 content/query/question，
 * 这里主动剔除；daemon 的 http.request 也只记 method/path/status，不记 body。
 */

export const INSERT_AUDIT_SQL = `INSERT INTO memory_audit_log (
  id, at, event, principal, bank_id, operation, request_id, payload, contract_version
) VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::jsonb, $9)
ON CONFLICT (id) DO NOTHING`

export const SELECT_AUDIT_SQL = `SELECT
  id, at, event, principal, bank_id, operation, request_id, payload, contract_version
FROM memory_audit_log`

export interface AuditRow {
  id: string
  at: string
  event: string
  principal: string | null
  bank_id: string | null
  operation: string | null
  request_id: string | null
  payload: unknown
  contract_version: string
}

export interface PgAuditProvider extends AuditProvider {
  flush(): Promise<number>
  pending(): number
  flushedCount(): number
  rows(): readonly AuditRow[]
  /** 测试/恢复用：注入已有行（不会写库）。 */
  hydrate(rows: readonly AuditRow[]): void
}

const SENSITIVE_KEYS = new Set([
  'content', 'query', 'question', 'text', 'body', 'raw',
  'password', 'secret', 'token', 'apiKey', 'api_key', 'authorization',
])

function sanitize(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k)) { out[k] = '[redacted]'; continue }
    out[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v
  }
  return out
}

function pick(payload: unknown, keys: string[]): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  for (const k of keys) {
    const v = p[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

export interface PgAuditOptions {
  client: PgLikeClient
  now?: () => string
  id?: () => string
}

export function pgAudit(options: PgAuditOptions): PgAuditProvider {
  const { client } = options
  const now = options.now ?? (() => new Date().toISOString())
  const genId = options.id ?? auditId
  const all: AuditRow[] = []
  let buffer: AuditRow[] = []
  let flushed = 0
  let inFlight: Promise<number> | null = null

  async function runFlush(): Promise<number> {
    if (buffer.length === 0) return 0
    const batch = buffer
    buffer = []
    try {
      for (const r of batch) {
        await client.query(INSERT_AUDIT_SQL, [
          r.id, r.at, r.event, r.principal, r.bank_id, r.operation, r.request_id,
          JSON.stringify(r.payload ?? {}), r.contract_version,
        ])
      }
      flushed += batch.length
      return batch.length
    } catch (err) {
      // 失败保留整批，下次 tick 重试（id 固定 → ON CONFLICT 幂等）。
      buffer = [...batch, ...buffer]
      throw err
    }
  }

  return {
    kind: 'pg-audit',
    record(event, payload) {
      const row: AuditRow = {
        id: genId(),
        at: now(),
        event,
        principal: pick(payload, ['principal', 'sub']),
        bank_id: pick(payload, ['bank_id', 'bank']),
        operation: pick(payload, ['operation', 'op']),
        request_id: pick(payload, ['request_id', 'requestId']),
        payload: sanitize(payload),
        contract_version: CONTRACT_VERSION,
      }
      all.push(row)
      buffer.push(row)
    },
    entries() { return all.map((r) => ({ event: r.event, payload: r.payload })) },
    flush(): Promise<number> {
      if (inFlight) return inFlight
      const p = runFlush().finally(() => { inFlight = null })
      inFlight = p
      return p
    },
    pending() { return buffer.length },
    flushedCount() { return flushed },
    rows() { return [...all] },
    hydrate(rows) {
      for (const r of rows) if (!all.some((x) => x.id === r.id)) all.push({ ...r })
    },
  }
}
