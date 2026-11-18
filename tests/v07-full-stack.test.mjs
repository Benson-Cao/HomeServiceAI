/**
 * V0.7 全栈专项：32 个 L2 seam 全部真实实现后的行为验收。
 * 覆盖四路声明式融合、重排、ABAC 四维、defense、同步、Reflect、预计算、批处理、审计与外围接入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { profileA } from '../build/src/profiles/profile-a.js'
import { profileB } from '../build/src/profiles/profile-b.js'
import { assemble } from '../build/src/runtime/assemble.js'
import { attributePolicy } from '../build/src/providers/policy.js'
import { weightedRrf } from '../build/src/providers/fusion.js'
import { CHANNEL_WEIGHTS } from '../build/src/scenes/memory-scene.js'

const settle = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)) }
const retain = (svc, c, extra = {}) => svc.retain({ principal: 'u1', bank_id: 'b1', content: c, ...extra })

test('ⓐ 装配：A/B 各 32 个 seam 全部 active，场景插件就绪，无 PENDING', () => {
  for (const p of [profileA, profileB]) {
    const app = assemble(p)
    const tree = app.kernel.dumpTree()
    assert.equal(tree.length, 33, '32 provider + 1 场景插件')
    assert.ok(tree.every((f) => f.state === 'active'), `不应有 PENDING: ${JSON.stringify(tree.filter((f) => f.state !== 'active'))}`)
    assert.equal(app.kernel.services.length, 32)
    app.dispose()
  }
})

test('ⓑ 四路声明式融合：channel_hits 四路齐全，ranker/reranker 生效', async () => {
  for (const p of [profileA, profileB]) {
    const app = assemble(p)
    retain(app.service, '四路检索 alpha 项目')
    retain(app.service, '四路检索 beta 项目')
    await settle(); app.service.drain()
    const res = app.service.recall({ principal: 'u1', bank_id: 'b1', query: '四路检索 项目', token_budget: 512 })
    for (const ch of ['semantic', 'bm25', 'graph', 'temporal']) {
      assert.equal(typeof res.channel_hits[ch], 'number', `${ch} 通道缺失`)
    }
    assert.equal(res.reranked, true)
    assert.ok(res.items.length > 0)
    assert.deepEqual(Object.keys(CHANNEL_WEIGHTS).sort(), ['bm25', 'graph', 'semantic', 'temporal'])
    app.dispose()
  }
})

test('ⓒ 融合权重显式声明：不同权重改变名次（不靠加载顺序）', () => {
  // 非对称名次：semantic 偏好 a，temporal 偏好 c —— 权重应能翻转首位
  const lists = [
    [
      { fact_id: 'a', score: 1, channel: 'semantic' },
      { fact_id: 'b', score: 0.9, channel: 'semantic' },
      { fact_id: 'c', score: 0.8, channel: 'semantic' },
    ],
    [
      { fact_id: 'c', score: 1, channel: 'temporal' },
      { fact_id: 'b', score: 0.9, channel: 'temporal' },
      { fact_id: 'a', score: 0.8, channel: 'temporal' },
    ],
  ]
  const heavySemantic = weightedRrf().fuse(lists, 10, { weights: { semantic: 10, temporal: 0.01 } })
  const heavyTemporal = weightedRrf().fuse(lists, 10, { weights: { semantic: 0.01, temporal: 10 } })
  assert.equal(heavySemantic[0].fact_id, 'a')
  assert.equal(heavyTemporal[0].fact_id, 'c', '权重改变应翻转首位，而非靠加载顺序')
  const score = (list, id) => list.find((h) => h.fact_id === id).score
  assert.notEqual(score(heavySemantic, 'a'), score(heavyTemporal, 'a'), '同一 fact 的得分应随权重变化')
  assert.equal(heavySemantic[0].channel, 'semantic', 'channel 应保留贡献最大的一路')
  assert.equal(heavyTemporal[0].channel, 'temporal')
})

test('ⓓ ABAC 四维：角色 / 敏感度 / 设备可信度 / 时间窗口', () => {
  const p = attributePolicy({
    roles: { child: 'viewer', parent: 'parent', admin: 'admin' },
    bankSensitivity: { secret: 'private' }, bankOwners: { secret: 'u1' },
  })
  const base = { principal: 'u2', bank: 'secret', operation: 'recall' }
  assert.equal(p.withAttributes(base), false, 'private 域非属主')
  assert.equal(p.withAttributes({ ...base, principal: 'u1' }), true, '属主')
  assert.equal(p.withAttributes({ ...base, principal: 'u3', attributes: { role: 'admin' } }), true, 'admin 角色')
  assert.equal(p.withAttributes({ ...base, principal: 'u1', attributes: { deviceTrusted: false } }), false, '设备不可信')
  assert.equal(p.withAttributes({ ...base, principal: 'u1', attributes: { windowStart: '2099-01-01T00:00:00Z' } }), false, '窗口外')
  assert.equal(p.withAttributes({ ...base, principal: 'u1', attributes: { windowEnd: '2000-01-01T00:00:00Z' } }), false, '窗口已过')
  assert.equal(p.withAttributes({ principal: 'child', bank: 'kid', operation: 'retain' }), false, 'kid 对 child 只读')
  assert.equal(p.withAttributes({ principal: 'parent', bank: 'kid', operation: 'retain' }), true)
  assert.equal(p.evaluate({ principal: 'u1', bank: 'b1', operation: 'recall' }), true, '内核三元组路径仍可放行')
})

test('ⓔ defense：A 档 redact、B 档仅标记，均不改变可召回性', async () => {
  const secret = '联系 me@example.com 或 13800138000'
  const runs = []
  for (const p of [profileA, profileB]) {
    const app = assemble(p)
    const r = retain(app.service, secret)
    await settle(); app.service.drain()
    const rec = app.kernel.resolve('storage').get(r.event_id)
    runs.push({ rec, stats: app.service.stats, kind: app.kernel.resolve('defense').kind })
    app.dispose()
  }
  assert.notEqual(runs[0].kind, runs[1].kind)
  assert.ok(!runs[0].rec.content.includes('me@example.com'), 'A 应脱敏')
  assert.ok(runs[1].rec.content.includes('me@example.com'), 'B 仅标记不改写')
  assert.ok(runs[0].stats.defenseFlagged >= 1 && runs[1].stats.defenseFlagged >= 1)
})

test('ⓕ 同步：增量去重、水位线、断点续传、lag、审计', async () => {
  const app = assemble(profileA)
  const a = app.service.sync({ sourceId: 'tablet', watermark: 'w1', items: [
    { fingerprint: 't1', content: '端侧缓冲 alpha' }, { fingerprint: 't2', content: '端侧缓冲 beta' },
  ] })
  const b = app.service.sync({ sourceId: 'tablet', watermark: 'w2', items: [
    { fingerprint: 't1', content: '端侧缓冲 alpha' }, { fingerprint: 't3', content: '端侧缓冲 gamma' },
  ] })
  assert.deepEqual([a.accepted, a.duplicate, b.accepted, b.duplicate], [2, 0, 1, 1])
  const sync = app.kernel.resolve('sync')
  assert.equal(sync.cursor('tablet').watermark, 'w2')
  assert.equal(sync.downstream({ sourceId: 'tablet', since: 'w1' }).cursor.watermark, 'w2')
  assert.ok(app.service.stats.syncLagMs !== null)
  assert.ok(app.kernel.resolve('audit').entries().some((e) => e.event === 'sync'))
  await settle(); app.service.drain()
  app.dispose()
})

test('ⓖ Reflect：综合结论带来源与置信度，走 llm seam', async () => {
  const runs = []
  for (const p of [profileA, profileB]) {
    const app = assemble(p)
    retain(app.service, '综合结论 素材一')
    retain(app.service, '综合结论 素材二')
    await settle(); app.service.drain()
    const r = app.service.reflect({ principal: 'u1', bank_id: 'b1', question: '综合结论' })
    assert.ok(r.sources.length >= 1)
    assert.ok(r.synthesis.length > 0)
    assert.ok(r.confidence >= 0 && r.confidence <= 1)
    assert.equal(r.contract_version, '1.2.0')
    runs.push({ ch: app.kernel.resolve('llm').channel, synthesis: r.synthesis })
    app.dispose()
  }
  assert.notEqual(runs[0].ch, runs[1].ch, 'API 与本地通道各自闭环')
  assert.notEqual(runs[0].synthesis, runs[1].synthesis, '不同 llm provider 产出不同')
})

test('ⓗ 心智模型预计算：显式驱动 + 批处理窗口自动触发', async () => {
  const app = assemble(profileA) // alwaysOnScheduler
  retain(app.service, '预计算素材 one')
  retain(app.service, '预计算素材 two')
  await settle(); app.service.drain()
  const st = app.kernel.resolve('storage')
  assert.ok(st.all().filter((r) => r.mental_model).length >= 1, '窗口内自动触发')
  assert.ok(app.service.stats.precomputed >= 1)
  assert.equal(app.service.stats.batchWindow, true)
  assert.ok(app.kernel.resolve('worker').processed() >= 1)
  assert.equal(app.service.precompute(), 0, '已预计算的不再重复')
  app.dispose()

  const appB = assemble(profileB) // nightBatchScheduler
  retain(appB.service, '批处理窗口素材')
  await settle(); appB.service.drain()
  assert.equal(typeof appB.service.stats.batchWindow, 'boolean')
  assert.ok(appB.service.precompute() >= 1, '显式驱动不受窗口限制')
  appB.dispose()
})

test('ⓘ 外围 seam 全部可 resolve 且行为正确', () => {
  const app = assemble(profileA)
  const k = app.kernel
  assert.equal(k.resolve('source').collect(['x', 'y']).length, 2)
  assert.equal(k.resolve('agent-adapter').handle({ operation: 'recall', payload: {} }).status, 200)
  assert.ok(k.resolve('ui').render('v', { a: 1 }).length > 0)
  assert.deepEqual(k.resolve('transport').decode(k.resolve('transport').encode({ a: 1 })), { a: 1 })
  assert.ok(k.resolve('ocr').read('ocr:hello').includes('hello'))
  assert.equal(typeof k.resolve('model-router').route('reflect'), 'string')
  assert.ok(k.resolve('extractor').extract('甲。乙').length >= 1)
  assert.equal(k.resolve('ingest').accept('fp-unique'), true)
  assert.equal(k.resolve('ingest').accept('fp-unique'), false, '采集入口去重')
  assert.equal(k.resolve('vector').kind, 'memory-vector')
  assert.equal(k.resolve('bank-policy').shareScope('kid'), 'family-read')
  assert.ok(k.resolve('fulltext').size() >= 0)
  assert.ok(k.resolve('graph').size() >= 0)
  app.dispose()
})

test('ⓙ A/B 治理与接入实现异质，场景插件零改动', () => {
  const shapes = []
  for (const p of [profileA, profileB]) {
    const app = assemble(p)
    shapes.push([
      app.kernel.resolve('llm').channel,
      app.kernel.resolve('fusion').kind,
      app.kernel.resolve('sync').kind,
      app.kernel.resolve('defense').kind,
      app.kernel.resolve('isolation-policy').evaluate ? 'policy' : '?',
      app.kernel.resolve('scheduler').kind,
      app.kernel.resolve('agent-adapter').kind,
    ].join('|'))
    app.dispose()
  }
  assert.notEqual(shapes[0], shapes[1])
  assert.deepEqual(profileA.providers.map((x) => x.seam).sort(), profileB.providers.map((x) => x.seam).sort())
})

test('ⓚ 回归：静默降质拦截、归档不删、跨 bank 拒绝在全栈下仍成立', async () => {
  const app = assemble(profileA)
  const r = retain(app.service, '全栈回归断言')
  await settle(); app.service.drain()
  const st = app.kernel.resolve('storage')
  app.service.archive(r.event_id, 'expiry:pending-review')
  assert.equal(st.get(r.event_id).state, 'archived')
  assert.ok(st.get(r.event_id).provenance, '记录未删')
  assert.equal(app.service.recall({ principal: 'u1', bank_id: 'b2', query: '全栈', token_budget: 256 }).items.length, 0)
  assert.equal(app.kernel.authorize('u1', 'b1', 'reflect'), false, '内核仍只认三操作')
  assert.deepEqual(app.kernel.errors, [])
  app.dispose()
})
