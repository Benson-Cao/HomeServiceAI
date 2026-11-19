#!/usr/bin/env node
/**
 * ④ 查审计日志。
 *
 *   npm run audit:recent -- --limit=20
 *   npm run audit:recent -- --principal=parent --bank=work
 *   npm run audit:recent -- --mock          # 离线：mock client，无真实数据
 *
 * 只读 memory_audit_log，不写任何记忆；不打印 token / 记忆正文（审计里本来就没有）。
 */
import { loadDotEnv, resolveDsn, connectPg } from './pg-connect.mjs'
import { createMockPgClient } from './mock-pg.mjs'
import { SELECT_AUDIT_SQL } from '../build/src/providers/pg-audit.js'

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=')
      return [k, v.length ? v.join('=') : true]
    }),
)

loadDotEnv()
const limit = Math.min(500, Math.max(1, Number(args.limit ?? 20) || 20))
const principal = typeof args.principal === 'string' ? args.principal : null
const bank = typeof args.bank === 'string' ? args.bank : null
const useMock = Boolean(args.mock)

let client
let close = async () => {}
try {
  if (useMock) {
    client = createMockPgClient().client
  } else {
    client = await connectPg(resolveDsn())
    close = async () => { await client.end?.() }
  }

  const where = []
  const params = []
  if (principal) { params.push(principal); where.push(`principal = $${params.length}`) }
  if (bank) { params.push(bank); where.push(`bank_id = $${params.length}`) }
  params.push(limit)
  const sql = `${SELECT_AUDIT_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT $${params.length}`

  const result = await client.query(sql, params)
  const rows = (result.rows ?? []).map((r) => ({
    at: r.at,
    event: r.event,
    principal: r.principal,
    bank_id: r.bank_id,
    operation: r.operation,
    request_id: r.request_id,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload || '{}') : (r.payload ?? {}),
  }))
  console.log(JSON.stringify({
    ok: true, mode: useMock ? 'mock' : 'pg', count: rows.length,
    filters: { principal, bank, limit }, rows,
  }, null, 2))
} catch (err) {
  console.error(`[audit:recent] FAIL · ${err.message}`)
  process.exitCode = 1
} finally {
  await close()
}
