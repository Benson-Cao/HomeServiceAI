/**
 * V0.5 横切验收（脚本化）。
 * 覆盖：ADR v1.2 运行时语义 8 条 + V0.5 降级验收集必验 4 条。
 * 降级项只验「seam/桩存在、状态可观测」，不验行为、不计入未完成。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTRACT_VERSION } from '../build/seams/contract-version.js'
import { profileA } from '../build/src/profiles/profile-a.js'
import { profileB } from '../build/src/profiles/profile-b.js'
import { fileJsonStorage } from '../build/src/providers/storage.js'
import { hashEmbedder } from '../build/src/providers/embedder.js'
import { assemble } from '../build/src/runtime/assemble.js'

const settle = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)) }
const clone = (p, over) => ({
  ...p, name: `${p.name}-variant`,
  providers: p.providers.map((b) => (over[b.seam] ? { ...b, factory: over[b.seam] } : b)),
})

test('ⓐ 契约版本单一源：TS 编译产物 ↔ JSON Schema ↔ registry 一致', () => {
  const reg = JSON.parse(readFileSync(new URL('../build/seams/seam-registry.json', import.meta.url), 'utf8'))
  assert.equal(CONTRACT_VERSION, '1.2.0')
  assert.equal(reg.contract_version, CONTRACT_VERSION)
  const schemas = ['provenance', 'memory-event', 'time-model', 'recall', 'sync', 'bank', 'isolation', 'evidence', 'operations']
  for (const n of schemas) {
    const d = JSON.parse(readFileSync(new URL(`../build/seams/${n}.schema.json`, import.meta.url), 'utf8'))
    assert.equal(d.contract_version, CONTRACT_VERSION, `${n} 版本漂移`)
  }
})

test('ⓑ 语义① 增量同步：水位线 + 去重 + 断点续传 + lag 可观测', async () => {
  const app = assemble(profileA)
  const provider = app.kernel.resolve('sync')
  assert.equal(typeof provider.ingest, 'function', 'V0.7 起为真实实现')

  const first = app.service.sync({
    sourceId: 'phone-1', watermark: 'w1',
    items: [{ fingerprint: 'f1', content: '同步事实 alpha' }, { fingerprint: 'f2', content: '同步事实 beta' }],
  })
  assert.equal(first.accepted, 2)
  assert.equal(first.duplicate, 0)
  assert.equal(provider.cursor('phone-1').watermark, 'w1')
  assert.equal(provider.buffered(), 2)

  const retry = app.service.sync({
    sourceId: 'phone-1', watermark: 'w2',
    items: [{ fingerprint: 'f1', content: '同步事实 alpha' }],
  })
  assert.equal(retry.duplicate, 1, '断点续传按指纹去重')
  assert.equal(provider.cursor('phone-1').watermark, 'w2')
  assert.ok(provider.lagMs() !== null, 'lag 可观测')
  assert.ok(app.service.stats.syncAccepted >= 2 && app.service.stats.syncDuplicates >= 1)

  await settle(); app.service.drain()
  const res = app.service.recall({ principal: 'sync', bank_id: 'default', query: '同步事实', token_budget: 256 })
  assert.ok(res.items.length > 0, '同步进来的事实可召回')
  assert.ok(app.service.stats.syncLagMs !== null)
  app.dispose()
})

test('ⓒ 语义② 跨 bank 检索被拒；kid 只读生效（不降级，内核原语）', async () => {
  const app = assemble(profileA)
  app.service.retain({ principal: 'u1', bank_id: 'b1', content: 'bank-one secret' })
  await settle(); app.service.drain()

  const other = app.service.recall({ principal: 'u1', bank_id: 'b2', query: 'secret', token_budget: 256 })
  assert.equal(other.items.length, 0, '跨 bank 不得召回')

  const childWrite = app.service.retain({ principal: 'child', bank_id: 'kid', content: 'child write' })
  assert.equal(childWrite.accepted, false, 'kid 对 child 只读')
  assert.equal(childWrite.reason, 'denied')
  const parentWrite = app.service.retain({ principal: 'parent', bank_id: 'kid', content: 'parent note' })
  assert.equal(parentWrite.accepted, true, 'kid 对 parent 可写')
  await settle(); app.service.drain()
  const childRead = app.service.recall({ principal: 'child', bank_id: 'kid', query: 'note', token_budget: 256 })
  assert.ok(childRead.items.length > 0, 'kid 只读共享可读')

  assert.equal(app.kernel.authorize('', 'b1', 'recall'), false)
  assert.equal(app.kernel.authorize('u1', 'b1', 'reflect'), false, 'V0.5 不实现 reflect')
  app.dispose()
})

test('ⓓ 语义③ 证据累积 + 矛盾修正：不覆盖、不删除，旧证据链可回溯', async () => {
  const app = assemble(profileA)
  const impl = app.kernel.resolve('consolidator')
  assert.equal(typeof impl.integrate, 'function', 'V0.6 起不再是桩')

  // 相同断言 → 加强同一条记录，不新建、不覆盖
  const a = app.service.retain({ principal: 'u1', bank_id: 'b1', content: '同一事实 v1' })
  const a2 = app.service.retain({ principal: 'u1', bank_id: 'b1', content: '同一事实 v1' })
  assert.equal(a2.event_id, a.event_id, '相同断言应累积到同一条')
  await settle(); app.service.drain()
  const st = app.kernel.resolve('storage')
  const rec = st.get(a.event_id)
  assert.equal(rec.provenance.evidence.proof_count, 2)
  assert.ok(rec.provenance.evidence.confidence > 0.5)
  assert.ok(app.service.stats.strengthened >= 1)

  // 不同断言 → 矛盾裁决，落败方归档待审，双方记录都在
  const b = app.service.retain({ principal: 'u1', bank_id: 'b1', content: '同一事实 v2（相反断言）' })
  await settle(); app.service.drain()
  const pair = [st.get(a.event_id), st.get(b.event_id)]
  assert.ok(pair.every(Boolean), '两条记录都在，未物理删除')
  const archived = pair.filter((r) => r.state === 'archived')
  assert.equal(archived.length, 1, '恰好一方归档待审')
  assert.match(archived[0].archive_reason, /conflict/)
  const survivor = pair.find((r) => r.state !== 'archived')
  assert.ok(survivor.provenance.evidence.quotes.length >= 1, '证据链保留')
  assert.ok(app.service.stats.conflictsDetected >= 1 && app.service.stats.revised >= 1)
  app.dispose()
})

test('ⓔ 语义④ valid-time 过期 → 归档待审、证据可回溯、不物理删除', async () => {
  const app = assemble(profileA)
  assert.equal(typeof app.kernel.resolve('expiry').evaluate, 'function', 'V0.6 起不再是桩')
  const past = new Date(Date.now() - 3600_000).toISOString()
  const until = new Date(Date.now() - 1800_000).toISOString()
  const r = app.service.retain({
    principal: 'u1', bank_id: 'b1', content: 'expiry candidate',
    valid_from: past, valid_to: until,
  })
  await settle(); app.service.drain()
  const st = app.kernel.resolve('storage')
  assert.equal(st.get(r.event_id).state, 'visible', '写入时尚可见')

  const res = app.service.recall({ principal: 'u1', bank_id: 'b1', query: 'expiry', token_budget: 256 })
  const rec = st.get(r.event_id)
  assert.equal(rec.state, 'archived', '过期的正确动作是归档待审')
  assert.match(rec.archive_reason, /valid-time/)
  assert.ok(rec.provenance.evidence.quotes.length > 0, '证据链仍在')
  assert.ok(rec.provenance, '记录未物理删除')
  assert.ok(app.service.stats.validTimeExpired >= 1, '过期计数可观测')
  assert.ok(app.service.stats.archived.includes(r.event_id))
  assert.equal(res.items.some((i) => i.fact_id === r.event_id), false, '已归档不得参与召回')
  app.dispose()
})

test('ⓕ 语义⑤ + 必验② accepted → visible 延迟可测', async () => {
  const app = assemble(profileA)
  const r = app.service.retain({ principal: 'u1', bank_id: 'b1', content: 'latency probe' })
  assert.equal(r.accepted, true)
  assert.equal(app.kernel.resolve('storage').get(r.event_id).state, 'pending', 'accepted ≠ visible')
  await settle(); app.service.drain()
  const rec = app.kernel.resolve('storage').get(r.event_id)
  assert.equal(rec.state, 'visible')
  assert.ok(rec.visible_at)
  assert.ok(app.service.stats.lastVisibleLatencyMs !== null)
  assert.ok(app.service.stats.lastVisibleLatencyMs >= 0)
  assert.equal(app.service.stats.jobsSucceeded >= 1, true)
  app.dispose()
})

test('ⓖ 语义⑥ worker 重试/死信/成本上限：V0.5 降级，验有界 + 计数 + token 裁剪', async () => {
  const app = assemble(profileA)
  const q = app.kernel.resolve('queue')
  assert.equal(q.concurrency, 1)
  assert.ok(q.maxSize > 0 && q.maxSize < Infinity, '队列有界')
  assert.equal(typeof q.backpressureCount, 'number')
  assert.equal(app.service.stats.jobsDeadLetter, 0)
  const long = 'x'.repeat(400)
  app.service.retain({ principal: 'u1', bank_id: 'b1', content: long })
  await settle(); app.service.drain()
  const res = app.service.recall({ principal: 'u1', bank_id: 'b1', query: 'x', token_budget: 5 })
  assert.ok(res.token_used <= 5, `token 预算生效：${res.token_used}`)
  app.dispose()
})

test('ⓗ 语义⑦ API 与本地大模型两通道各自独立完成 retain/recall 闭环', async () => {
  for (const p of [profileA, profileB]) {
    const app = assemble(p)
    const ch = app.kernel.resolve('llm').channel
    assert.ok(['api', 'local'].includes(ch))
    const r = app.service.retain({ principal: 'u1', bank_id: 'b1', content: `channel ${ch} probe` })
    assert.equal(r.accepted, true)
    await settle(); app.service.drain()
    const res = app.service.recall({ principal: 'u1', bank_id: 'b1', query: 'channel', token_budget: 256 })
    assert.ok(res.items.length > 0, `${ch} 通道闭环失败`)
    assert.equal(res.contract_version, CONTRACT_VERSION)
    app.dispose()
  }
})

test('ⓘ 语义⑧ + 必验④ 换 embedding_dim 后旧向量隔离/拒检且可观测', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-accept-legacy-'))
  try {
    const oldApp = assemble(clone(profileA, {
      storage: () => fileJsonStorage(dir),
      embedder: () => hashEmbedder({ dim: 16, quantizationVersion: 'q1' }),
    }))
    const old = oldApp.service.retain({ principal: 'u1', bank_id: 'b1', content: 'legacy vector record' })
    await settle(); oldApp.service.drain()

    const fresh = assemble(clone(profileA, {
      storage: () => fileJsonStorage(dir),
      embedder: () => hashEmbedder({ dim: 32, quantizationVersion: 'q2' }),
    }))
    let observed = 0
    fresh.kernel.plugin({ id: 'probe.quarantine', apply: (ctx) => ctx.on('memory.vector.quarantined', () => { observed++ }) })
    const res = fresh.service.recall({ principal: 'u1', bank_id: 'b1', query: 'legacy', token_budget: 256 })
    assert.ok(res.quarantined.includes(old.event_id), '旧向量被隔离')
    assert.ok(observed >= 1, '隔离事件可观测')
    assert.equal(res.items.some((i) => i.fact_id === old.event_id), false, '旧向量不得参与召回')
    assert.equal(fresh.kernel.resolve('storage').get(old.event_id).state, 'visible', '隔离 ≠ 删除')
    fresh.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ⓙ 必验① 换 provider 零改动：场景插件源码不含任何实现名', () => {
  const src = readFileSync(new URL('../src/scenes/memory-scene.ts', import.meta.url), 'utf8')
  const names = ['inMemoryStorage', 'fileJsonStorage', 'apiLlm', 'localLlm', 'cosineRetriever',
    'keywordRetriever', 'hashEmbedder', 'boundedQueue', 'simpleRrf', 'simplePolicy',
    'Hindsight', 'pgvector', 'Ollama', 'health', 'kid']
  assert.deepEqual(names.filter((n) => src.includes(n)), [])
  assert.deepEqual(profileA.providers.map((p) => p.seam).sort(), profileB.providers.map((p) => p.seam).sort())
})

test('ⓚ 必验③ 卸载插件后能力回收、记忆归档待审、不物理删除', async () => {
  const app = assemble(profileA)
  const r = app.service.retain({ principal: 'u1', bank_id: 'b1', content: 'unload probe' })
  await settle(); app.service.drain()
  const st = app.kernel.resolve('storage')
  assert.equal(st.get(r.event_id).state, 'visible')
  app.dispose()
  assert.deepEqual(app.kernel.dumpTree(), [], '插件树清空')
  assert.deepEqual(app.kernel.services, [], 'seam 全部回收')
  const rec = st.get(r.event_id)
  assert.equal(rec.state, 'archived', '归档待审')
  assert.ok(rec.provenance, '记录未物理删除')
})

test('ⓛ 范围：全部 32 个 L2 seam 已实现，无 stub / deferred 残留', () => {
  const reg = JSON.parse(readFileSync(new URL('../build/seams/seam-registry.json', import.meta.url), 'utf8'))
  const all = Object.values(reg.groups).flat()
  const by = Object.fromEntries(all.map((x) => [x.id, x.v05_status]))
  assert.equal(all.length, 32, 'L2 seam 总数')
  assert.ok(all.every((x) => x.v05_status === 'implemented'), '不应再有 stub / deferred')
  for (const id of ['retriever.bm25', 'retriever.graph', 'retriever.temporal', 'ranker', 'reranker',
    'graph', 'fulltext', 'sync', 'source', 'agent-adapter', 'ui', 'transport', 'ocr', 'defense', 'scheduler']) {
    assert.equal(by[id], 'implemented', `${id} 应为真实实现`)
  }
  assert.equal(reg.note.includes('V0.7'), true)
})
