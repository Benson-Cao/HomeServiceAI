#!/usr/bin/env node
/**
 * 离线 PG mock：实现 PgLikeClient 契约，行为对齐真实 PG 的返回形态
 * （JSONB 返回已解析对象、TIMESTAMPTZ 返回字符串、vector::text 返回 '[..]'）。
 * 供 tests/l0-pgvector.test.mjs、tests/identity.test.mjs、tests/daemon.test.mjs
 * 与各 smoke --mock 共用。不进任何真实网络路径。
 */
import {
  SCHEMA_SQL, SELECT_RECORDS_SQL, SELECT_EMBEDDINGS_SQL,
  UPSERT_RECORD_SQL, UPSERT_EMBEDDING_SQL,
} from '../build/src/providers/pgvector.js'
import { INSERT_AUDIT_SQL, SELECT_AUDIT_SQL } from '../build/src/providers/pg-audit.js'

const RECORD_COLUMNS = [
  'event_id', 'principal', 'bank_id', 'occurred_at', 'recorded_at',
  'valid_from', 'valid_to', 'content', 'scene', 'raw_pointer',
  'dedupe_fingerprint', 'state', 'accepted_at', 'visible_at',
  'provenance', 'vector', 'archive_reason', 'mental_model', 'facts',
  'contract_version',
]

const AUDIT_COLUMNS = [
  'id', 'at', 'event', 'principal', 'bank_id', 'operation', 'request_id',
  'payload', 'contract_version',
]

function parseJson(v, fallback = null) {
  if (v == null) return fallback
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return fallback }
}

export function createMockPgClient(options = {}) {
  const records = new Map()
  const embeddings = new Map()
  const auditRows = new Map()
  const queries = []
  let failNextWrite = options.failNextWrite ?? false
  let failNextAuditWrite = options.failNextAuditWrite ?? false

  function maybeFail() {
    if (failNextWrite) { failNextWrite = false; throw new Error('mock: injected write failure') }
  }

  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params })
      if (sql === SCHEMA_SQL) return { rows: [], rowCount: 0 }
      if (sql === SELECT_RECORDS_SQL) return { rows: [...records.values()], rowCount: records.size }
      if (sql === SELECT_EMBEDDINGS_SQL) return { rows: [...embeddings.values()], rowCount: embeddings.size }
      if (sql === SELECT_AUDIT_SQL) return { rows: [...auditRows.values()], rowCount: auditRows.size }
      if (sql === UPSERT_RECORD_SQL) {
        maybeFail()
        const row = {}
        RECORD_COLUMNS.forEach((col, i) => { row[col] = params[i] })
        row.provenance = parseJson(row.provenance)
        row.vector = parseJson(row.vector)
        row.facts = parseJson(row.facts)
        records.set(row.event_id, row)
        return { rows: [], rowCount: 1 }
      }
      if (sql === UPSERT_EMBEDDING_SQL) {
        maybeFail()
        const [event_id, literal, dim, quantization_version, contract_version] = params
        embeddings.set(event_id, {
          event_id,
          embedding_text: literal,
          dim,
          quantization_version,
          contract_version,
        })
        return { rows: [], rowCount: 1 }
      }
      if (sql === INSERT_AUDIT_SQL) {
        if (failNextAuditWrite) { failNextAuditWrite = false; throw new Error('mock: injected audit write failure') }
        const row = {}
        AUDIT_COLUMNS.forEach((col, i) => { row[col] = params[i] })
        row.payload = parseJson(row.payload, {})
        auditRows.set(row.id, row)
        return { rows: [], rowCount: 1 }
      }
      // 允许 ad-hoc 审计查询（audit:recent 脚本的 WHERE / LIMIT）
      if (/^\s*SELECT[\s\S]*FROM memory_audit_log/i.test(sql)) {
        let rows = [...auditRows.values()]
        const pm = /principal\s*=\s*\$(\d+)/i.exec(sql)
        const bm = /bank_id\s*=\s*\$(\d+)/i.exec(sql)
        const lm = /LIMIT\s+(\d+)/i.exec(sql)
        if (pm) rows = rows.filter((r) => r.principal === params[Number(pm[1]) - 1])
        if (bm) rows = rows.filter((r) => r.bank_id === params[Number(bm[1]) - 1])
        rows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
        if (lm) rows = rows.slice(0, Number(lm[1]))
        return { rows, rowCount: rows.length }
      }
      throw new Error(`mock: 未预期的 SQL: ${sql.slice(0, 80)}`)
    },
    async end() { /* no-op */ },
  }

  return { client, records, embeddings, auditRows, queries }
}
