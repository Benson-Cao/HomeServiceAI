/**
 * V0.6 治理专项：冲突与过期从 V0.5 桩升级为真实实现后的行为验收。
 * A/B 两份 profile 用不同治理 provider，场景插件零改动 —— 同时验证可互换。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { profileA } from '../build/src/profiles/profile-a.js'
import { profileB } from '../build/src/profiles/profile-b.js'
import { freshnessExpiry } from '../build/src/providers/expiry.js'
import { assemble } from '../build/src/runtime/assemble.js'

const settle = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)) }
const retain = (svc, content, extra = {}) => svc.retain({ principal: 'u1', bank_id: 'b1', content, ...extra })

test('⒠ 两 profile 治理 seam 接口同构、实现异质（换 provider 零改动）', () => {
  const shapes = []
  for (const p of [profileA, profileB]) {
    const app = assemble(p)
    const cons = app.kernel.resolve('consolidator')
    const cf = app.kernel.resolve('conflict')
    const exp = app.kernel.resolve('expiry')
    assert.equal(typeof cons.integrate, 'function')
    assert.equal(typeof cf.detect, 'function')
    assert.equal(typeof cf.revise, 'function')
    assert.equal(typeof exp.evaluate, 'function')
    shapes.push([cons.kind, cf.kind, exp.kind].join('|'))
    assert.ok(app.kernel.dumpTree().find((f) => f.id === 'scene.memory')?.state === 'active')
    app.dispose()
  }
  assert.notEqual(shapes[0], shapes[1], 'A/B 用不同策略实现')
})

test('⒡ 证据累积：相同断言加强同一条，proof_count / confidence 单调不降', async () => {
  for (const p of [profileA, profileB]) {
    const app = assemble(p)
    const a = retain(app.service, '累积断言 alpha')
    const b = retain(app.service, '累积断言 alpha')
    assert.equal(b.event_id, a.event_id, '不新建记录')
    await settle(); app.service.drain()
    const st = app.kernel.resolve('storage')
    const e = st.get(a.event_id).provenance.evidence
    assert.equal(e.proof_count, 2)
    assert.ok(e.confidence > 0.5 && e.confidence <= 1)
    assert.equal(e.freshness, 'new')
    assert.ok(app.service.stats.strengthened >= 1)
    assert.equal(st.all().filter((r) => r.state !== 'archived').length, 1, '未覆盖出新记录')
    app.dispose()
  }
})

test('⒢ 矛盾裁决：恰好一方归档待审，双方记录与证据链都在', async () => {
  for (const p of [profileA, profileB]) {
    const app = assemble(p)
    const a = retain(app.service, '结论是 A')
    await settle(); app.service.drain()
    const b = retain(app.service, '结论是 B')
    await settle(); app.service.drain()
    const st = app.kernel.resolve('storage')
    const pair = [st.get(a.event_id), st.get(b.event_id)]
    assert.ok(pair.every(Boolean), '未物理删除')
    assert.equal(pair.filter((r) => r.state === 'archived').length, 1)
    assert.match(pair.find((r) => r.state === 'archived').archive_reason, /conflict/)
    assert.ok(pair.every((r) => r.provenance.evidence.quotes.length >= 1), '旧证据链保留')
    assert.ok(app.service.stats.conflictsDetected >= 1 && app.service.stats.revised >= 1)
    app.dispose()
  }
})

test('⒣ 过期：valid_to 已过 / valid_from 未到，均归档待审且不删', async () => {
  const app = assemble(profileA)
  const past = new Date(Date.now() - 7200_000).toISOString()
  const until = new Date(Date.now() - 3600_000).toISOString()
  const r = retain(app.service, '过期断言', { valid_from: past, valid_to: until })
  await settle(); app.service.drain()
  const st = app.kernel.resolve('storage')
  assert.equal(st.get(r.event_id).state, 'visible')
  app.service.recall({ principal: 'u1', bank_id: 'b1', query: '过期', token_budget: 256 })
  const rec = st.get(r.event_id)
  assert.equal(rec.state, 'archived')
  assert.match(rec.archive_reason, /valid-time/)
  assert.ok(rec.provenance && rec.provenance.evidence.quotes.length > 0)
  assert.ok(app.service.stats.validTimeExpired >= 1)

  const future = retain(app.service, '尚未生效', { valid_from: new Date(Date.now() + 7200_000).toISOString() })
  await settle(); app.service.drain()
  app.service.recall({ principal: 'u1', bank_id: 'b1', query: '尚未', token_budget: 256 })
  const f = st.get(future.event_id)
  assert.equal(f.state, 'archived')
  assert.match(f.archive_reason, /not-yet-effective/)
  app.dispose()
})

test('⒤ freshness 衰减到 stale → 归档待审（模拟未来时刻），保守策略不衰减', () => {
  const record = {
    event_id: 'x', bank_id: 'b1', principal: 'u1', scene: null, content: 'x',
    state: 'visible', dedupe_fingerprint: 'x', recorded_at: '2026-01-01T00:00:00Z',
    valid_from: null, valid_to: null,
    provenance: { evidence: { quotes: ['x'], proof_count: 1, confidence: 0.5, freshness: 'new', valid_time: { valid_from: null, valid_to: null } } },
  }
  const now = '2026-01-01T02:00:00Z'
  const a = freshnessExpiry({ windowMs: 1000 }).evaluate({ record, now })
  assert.equal(a.action, 'archive')
  assert.equal(a.freshness, 'stale')
  assert.equal(a.reason, 'freshness:stale')
  const appB = assemble(profileB)
  const b = appB.kernel.resolve('expiry').evaluate({ record, now })
  appB.dispose()
  assert.equal(b.action, 'keep', '保守策略只按 valid time 裁决')
})

test('⒥ 治理事件可观测：strengthened / conflict.revised / expiry.archived 均为白名单事件', async () => {
  const app = assemble(profileA)
  const seen = []
  app.kernel.plugin({
    id: 'probe.governance',
    apply: (ctx) => {
      ctx.on('memory.consolidation.strengthened', (p) => seen.push(['strengthened', p.event_id]))
      ctx.on('memory.conflict.revised', (p) => seen.push(['conflict', p.reason]))
      ctx.on('memory.expiry.archived', (p) => seen.push(['expiry', p.reason]))
    },
  })
  retain(app.service, '事件断言 one')
  retain(app.service, '事件断言 one')
  await settle(); app.service.drain()
  retain(app.service, '事件断言 two')
  await settle(); app.service.drain()
  const until = new Date(Date.now() - 3600_000).toISOString()
  // 独立 subjectKey：避免写入阶段先被矛盾裁决归档，才能走到 recall 的 expiry 链路
  retain(app.service, '事件断言 expired', { valid_to: until, scene: 'expiry-probe' })
  await settle(); app.service.drain()
  app.service.recall({ principal: 'u1', bank_id: 'b1', query: '事件', token_budget: 512 })

  assert.ok(seen.some((x) => x[0] === 'strengthened'))
  assert.ok(seen.some((x) => x[0] === 'conflict'))
  assert.ok(seen.some((x) => x[0] === 'expiry'))
  assert.deepEqual(app.kernel.errors, [], '事件投递不应产生错误')
  app.dispose()
})

test('⒦ 归档不等于删除：所有归档记录仍可 get，provenance 7 字段完整', async () => {
  const app = assemble(profileA)
  const a = retain(app.service, '归档完整性 one')
  await settle(); app.service.drain()
  retain(app.service, '归档完整性 two')
  await settle(); app.service.drain()
  const st = app.kernel.resolve('storage')
  const archived = st.all().filter((r) => r.state === 'archived')
  assert.ok(archived.length >= 1)
  for (const r of archived) {
    assert.ok(st.get(r.event_id), '记录仍在')
    assert.ok(r.archive_reason)
    const p = r.provenance
    assert.deepEqual(Object.keys(p).sort(), [
      'contract_version', 'embedding_dim', 'evidence', 'model_id',
      'pipeline_run_id', 'producer_plugin_id', 'quantization_version',
    ].sort())
  }
  app.dispose()
})
