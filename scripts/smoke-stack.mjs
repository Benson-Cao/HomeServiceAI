#!/usr/bin/env node
/**
 * L0 端到端自检：retain → drain → flush → 新 stack hydrate → recall 命中。
 *
 *   npm run smoke:stack -- --mock     # 离线，内存 mock，不需要 PG（沙盒自检用）
 *   npm run smoke:stack               # 真 PG，需 .env + docker compose up -d db
 *
 * 真 PG 模式会在 bank_id='l0-smoke' 写一条测试记录，结束前自动清理。
 * 不进 verify、不进 CI。
 */
import assert from 'node:assert/strict'
import { createL0Stack } from '../build/src/runtime/l0-stack.js'
import { assemble } from '../build/src/runtime/assemble.js'
import { loadDotEnv, resolveDsn, connectPg } from './pg-connect.mjs'
import { createMockPgClient } from './mock-pg.mjs'

const mock = process.argv.includes('--mock')
const TEXT = 'L0 smoke：客厅灯晚上七点自动开'
const BANK = 'l0-smoke'

loadDotEnv()

let eventId = ''
let client, secondClient, stack, revived
let cleanup = async () => {}

if (mock) {
  client = createMockPgClient().client
  secondClient = client
} else {
  const dsn = resolveDsn()
  client = await connectPg(dsn)
  secondClient = await connectPg(dsn)
  cleanup = async () => {
    if (!eventId) return
    await client.query('DELETE FROM memory_embeddings WHERE event_id = $1', [eventId]).catch(() => {})
    await client.query('DELETE FROM memory_records WHERE event_id = $1', [eventId]).catch(() => {})
  }
}

try {
  stack = await createL0Stack(client)
  const svc = assemble(stack.profile).service
  assert.ok(svc, '场景插件未就绪')

  const r = svc.retain({ principal: 'parent', bank_id: BANK, content: TEXT })
  assert.equal(r.accepted, true, `retain 被拒：${r.reason ?? ''}`)
  eventId = r.event_id
  svc.drain()
  const written = await stack.flush()
  assert.ok(written >= 2, `flush 应至少写 record + embedding，实际 ${written}`)

  // 新进程视角：重新 hydrate，不复用第一个 stack 的内存镜像。
  revived = await createL0Stack(secondClient)
  const rec = revived.storage.get(eventId)
  assert.ok(rec, 'hydrate 后找不到刚写入的记录')
  assert.equal(rec.state, 'visible')
  assert.equal(rec.bank_id, BANK)
  assert.ok(rec.vector && rec.vector.length === 16, 'vector 未随记录恢复')
  assert.equal(rec.provenance?.contract_version, '1.2.0')
  assert.equal(rec.provenance?.embedding_dim, 16)
  assert.ok(revived.vector.size() >= 1)
  assert.equal(revived.pendingWrites(), 0, 'hydrate 后不应有待写')

  const svc2 = assemble(revived.profile).service
  const hit = svc2.recall({ principal: 'parent', bank_id: BANK, query: '客厅灯', token_budget: 512 })
  assert.ok(hit.items.length >= 1, 'recall 未命中刚写入的记忆')
  assert.equal(hit.items[0].fact_id, eventId)
  assert.equal(hit.contract_version, '1.2.0')

  console.log(JSON.stringify({
    ok: true,
    mode: mock ? 'mock' : 'postgres',
    event_id: eventId,
    written,
    records: revived.storage.all().length,
    embeddings: revived.vector.size(),
    recall_items: hit.items.length,
    accepted_to_visible_ms: svc.stats.lastVisibleLatencyMs,
    contract_version: hit.contract_version,
  }, null, 2))
} catch (err) {
  console.error(`[smoke:stack] FAIL · ${err.message}`)
  process.exitCode = 1
} finally {
  // cleanup 必须在 client.end() 之前；close() 内部会 flush 并 end。
  await cleanup()
  await stack?.close?.().catch(() => {})
  await revived?.close?.().catch(() => {})
  if (!revived && secondClient !== client) await secondClient?.end?.().catch(() => {})
}
