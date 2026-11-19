import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createDaemon, daemonProfile } from '../build/src/runtime/daemon.js'
import { createWorkerLoop } from '../build/src/runtime/worker-loop.js'
import { deepseekLlm, DEFAULT_DEEPSEEK_MODEL } from '../build/src/providers/openai-compatible.js'
import { createMockPgClient } from '../scripts/mock-pg.mjs'
import { profileA } from '../build/src/profiles/profile-a.js'
import { profileB } from '../build/src/profiles/profile-b.js'

const REPLY_TEXT = '常驻服务综合结论：记忆可被多端调用且证据链完整。'

function okFetch() {
  return async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => null },
    json: async () => ({
      choices: [{ message: { content: REPLY_TEXT, reasoning_content: '' } }],
      usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
    }),
    text: async () => '',
  })
}

async function withDaemon(fn, opts = {}) {
  const pg = createMockPgClient(opts.pg ?? {})
  const d = await createDaemon({
    client: pg.client,
    port: 0,
    host: '127.0.0.1',
    autoStartWorker: false,
    workerIntervalMs: 100_000,
    ...(opts.daemon ?? {}),
  })
  try { return await fn(d, pg) } finally { await d.stop() }
}

async function req(d, path, { method = 'GET', body, token, raw } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const init = { method, headers }
  if (raw !== undefined) { headers['content-type'] = 'application/json'; init.body = raw }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
  const r = await fetch(d.url + path, init)
  const ct = r.headers.get('content-type') ?? ''
  let json = null
  let text = null
  if (ct.includes('json')) {
    try { json = await r.json() } catch { /* 留空 */ }
  } else {
    text = await r.text()
  }
  return { status: r.status, json, text, headers: r.headers }
}

const RETAIN = { principal: 'u1', bank_id: 'b1', content: '客厅灯晚上七点自动开' }

test('① 只读端点：/health /stats /tree / 全部 200，契约版本与插件树可观测', async () => {
  await withDaemon(async (d) => {
    const health = await req(d, '/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, true)
    assert.equal(health.json.profile, 'profile-daemon')
    assert.equal(health.json.contract_version, '1.2.0')
    assert.ok(health.headers.get('x-request-id'))
    assert.equal(health.headers.get('x-contract-version'), '1.2.0')
    assert.equal(health.json.worker.running, false, '测试里手动 tick，不自动起定时器')

    const stats = await req(d, '/stats')
    assert.equal(stats.status, 200)
    assert.equal(typeof stats.json.service.jobsSucceeded, 'number')
    assert.equal(typeof stats.json.pending_writes, 'number')
    assert.equal(stats.json.contract_version, '1.2.0')

    const tree = await req(d, '/tree')
    assert.equal(tree.status, 200)
    assert.ok(tree.json.tree.length >= 32)
    assert.equal(tree.json.tree.every((f) => f.state === 'active'), true, '无 PENDING')

    const root = await req(d, '/')
    assert.equal(root.status, 200)
    assert.match(root.text, /POST \/retain/)
  })
})

test('② retain 202 → worker.tick 落库 → recall 命中：accepted→visible 延迟可测', async () => {
  await withDaemon(async (d, pg) => {
    const r = await req(d, '/retain', { method: 'POST', body: RETAIN })
    assert.equal(r.status, 202, '202 Accepted，不是 200 同步可见')
    assert.ok(r.json.event_id.startsWith('ev_'))
    assert.ok(r.json.job_id.startsWith('job_'))
    assert.deepEqual(Object.keys(r.json.provenance).sort(), [
      'contract_version', 'embedding_dim', 'evidence', 'model_id',
      'pipeline_run_id', 'producer_plugin_id', 'quantization_version',
    ].sort())
    assert.equal(pg.records.size, 0, '还只在内存镜像里，未落库')

    const tick = await d.worker.tick()
    assert.equal(tick.failed, false)
    assert.ok(tick.flushed >= 2, 'record + embedding 都应落库')
    assert.equal(pg.records.size, 1)
    assert.equal(pg.embeddings.size, 1)
    assert.equal(typeof d.worker.stats.lastAcceptedToVisibleMs, 'number')
    assert.equal(pg.records.get(r.json.event_id).state, 'visible')

    const recall = await req(d, '/recall', { method: 'POST', body: { principal: 'u1', bank_id: 'b1', query: '客厅灯' } })
    assert.equal(recall.status, 200)
    assert.ok(recall.json.items.length >= 1)
    assert.equal(recall.json.items[0].fact_id, r.json.event_id)
    assert.equal(recall.json.contract_version, '1.2.0')
  })
})

test('③ 授权仍在内核：child 写 kid → 403；缺字段 → 400', async () => {
  await withDaemon(async (d) => {
    const denied = await req(d, '/retain', { method: 'POST', body: { principal: 'child', bank_id: 'kid', content: 'x' } })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.accepted, false)
    assert.equal(denied.json.reason, 'denied')

    for (const bad of [
      { bank_id: 'b1', content: 'x' },
      { principal: 'u1', content: 'x' },
      { principal: 'u1', bank_id: 'b1' },
      { principal: '', bank_id: 'b1', content: 'x' },
    ]) {
      const r = await req(d, '/retain', { method: 'POST', body: bad })
      assert.equal(r.status, 400, JSON.stringify(bad))
    }
  })
})

test('④ reflect 走真模型：prepare 外环 → 同步槽 → synthesis 是模型输出', async () => {
  const llm = deepseekLlm({ apiKey: 'sk-unit-test-placeholder', fetch: okFetch(), sleep: async () => {} })
  await withDaemon(async (d) => {
    await req(d, '/retain', { method: 'POST', body: RETAIN })
    await d.worker.tick()
    const r = await req(d, '/reflect', { method: 'POST', body: { principal: 'u1', bank_id: 'b1', question: '照明习惯' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.synthesis, REPLY_TEXT, '必须是真模型输出，不是确定性桩')
    assert.ok(r.json.sources.length >= 1)
    assert.equal(r.json.model_reply.model, DEFAULT_DEEPSEEK_MODEL)
    assert.equal(r.json.model_reply.usage.total_tokens, 15)
    assert.equal(llm.hasPendingReply(), false, '同步槽已被 reflect 消费')
  }, { daemon: { llm } })
})

test('⑤ 不挂真模型时 reflect 仍可用（确定性桩），不发网络', async () => {
  await withDaemon(async (d) => {
    await req(d, '/retain', { method: 'POST', body: RETAIN })
    await d.worker.tick()
    const r = await req(d, '/reflect', { method: 'POST', body: { principal: 'u1', bank_id: 'b1', question: 'x' } })
    assert.equal(r.status, 200)
    assert.match(r.json.synthesis, /^\[api\]/)
    assert.equal(r.json.model_reply, undefined)
  })
})

test('⑥ /sync 与 /archive：增量同步入口可用，归档只改状态不删除', async () => {
  await withDaemon(async (d, pg) => {
    const sync = await req(d, '/sync', { method: 'POST', body: {
      sourceId: 'phone', watermark: 'w1',
      items: [{ fingerprint: 'fp1', content: '手机端缓冲的记忆' }],
    } })
    assert.equal(sync.status, 200)
    assert.equal(sync.json.accepted, 1)

    const r = await req(d, '/retain', { method: 'POST', body: RETAIN })
    await d.worker.tick()
    const arc = await req(d, '/archive', { method: 'POST', body: { event_id: r.json.event_id, reason: 'manual-review' } })
    assert.equal(arc.status, 200)
    await d.worker.tick()
    assert.equal(pg.records.get(r.json.event_id).state, 'archived')
    assert.equal(pg.records.get(r.json.event_id).archive_reason, 'manual-review')
    assert.equal(pg.records.has(r.json.event_id), true, '归档不等于删除')
  })
})

test('⑦ 错误路径：坏 JSON / 非对象 / 未知路径 / 方法不符 / 超大 body', async () => {
  await withDaemon(async (d) => {
    assert.equal((await req(d, '/retain', { method: 'POST', raw: '{bad' })).status, 400)
    assert.equal((await req(d, '/retain', { method: 'POST', raw: '[]' })).status, 400)
    assert.equal((await req(d, '/nope')).status, 404)
    assert.equal((await req(d, '/health', { method: 'POST', body: {} })).status, 405)
    assert.equal((await req(d, '/retain')).status, 405)
  })
  await withDaemon(async (d) => {
    const r = await req(d, '/retain', { method: 'POST', body: { ...RETAIN, content: 'x'.repeat(500) } })
    assert.equal(r.status, 413)
    assert.equal(r.json.error, 'payload-too-large')
  }, { daemon: { maxBodyBytes: 64 } })
})

test('⑧ 可选 Bearer token：/health 豁免，其余端点 401', async () => {
  await withDaemon(async (d) => {
    assert.equal((await req(d, '/health')).status, 200)
    assert.equal((await req(d, '/stats')).status, 401)
    assert.equal((await req(d, '/stats', { token: 'wrong' })).status, 401)
    assert.equal((await req(d, '/stats', { token: 'secret' })).status, 200)
    assert.equal((await req(d, '/retain', { method: 'POST', body: RETAIN, token: 'secret' })).status, 202)
  }, { daemon: { token: 'secret' } })
})

test('⑨ 自动 worker 循环：不手动 tick 也会 drain + flush，stop 前做最后一次', async () => {
  await withDaemon(async (d, pg) => {
    const r = await req(d, '/retain', { method: 'POST', body: RETAIN })
    assert.equal(r.status, 202)
    const deadline = Date.now() + 3000
    while (pg.records.size === 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 20))
    }
    assert.equal(pg.records.size, 1, '后台循环应自动落库')
    assert.ok(d.worker.stats.ticks >= 1)
    assert.equal(d.worker.running, true)
  }, { daemon: { autoStartWorker: true, workerIntervalMs: 20 } })
})

test('⑩ 优雅关停：最后一次 tick 落库，且不触发 dispose 归档语义', async () => {
  const pg = createMockPgClient()
  const d = await createDaemon({ client: pg.client, port: 0, autoStartWorker: false })
  const r = await req(d, '/retain', { method: 'POST', body: RETAIN })
  assert.equal(pg.records.size, 0)
  await d.stop()
  assert.equal(pg.records.size, 1, 'stop 前必须把待写落库')
  assert.equal(pg.records.get(r.json.event_id).state, 'visible')
  assert.notEqual(pg.records.get(r.json.event_id).archive_reason, 'plugin-disposed:pending-review')
  assert.equal(d.worker.running, false)
})

test('⑪ flush 失败不抛穿应用，下次 tick 自动重试成功', async () => {
  await withDaemon(async (d, pg) => {
    await req(d, '/retain', { method: 'POST', body: RETAIN })
    const t1 = await d.worker.tick()
    assert.equal(t1.failed, true)
    assert.match(d.worker.stats.lastError, /injected write failure/)
    assert.equal(pg.records.size, 0)
    const t2 = await d.worker.tick()
    assert.equal(t2.failed, false)
    assert.equal(pg.records.size, 1)
    assert.equal(d.worker.stats.failures, 1)
  }, { pg: { failNextWrite: true } })
})

test('⑫ tick 不重叠：并发两次调用共享同一结果，只计一次', async () => {
  await withDaemon(async (d) => {
    await req(d, '/retain', { method: 'POST', body: RETAIN })
    const [a, b] = await Promise.all([d.worker.tick(), d.worker.tick()])
    assert.equal(a, b)
    assert.equal(d.worker.stats.ticks, 1)
  })
})

test('⑬ worker 单元：flush 抛错只记录，绝不 throw；start/stop 幂等', async () => {
  let calls = 0
  const fakeService = { stats: { lastVisibleLatencyMs: 7 }, drain: () => 2 }
  const w = createWorkerLoop({
    service: fakeService,
    flush: async () => { calls++; throw new Error('boom') },
    pendingWrites: () => 3,
    intervalMs: 100_000,
    autoStart: false,
  })
  const r = await w.tick()
  assert.equal(r.failed, true)
  assert.equal(r.drained, 2)
  assert.equal(w.stats.failures, 1)
  w.start(); w.start()
  assert.equal(w.running, true)
  const last = await w.stop()
  assert.equal(last.failed, true)
  assert.equal(w.running, false)
  assert.equal(calls, 2)
})

test('⑭ A 档边界：daemon profile seam 集合与 A/B 一致，场景插件与内核零改动', async () => {
  const ids = (p) => p.providers.map((b) => b.seam).sort()
  assert.deepEqual(ids(daemonProfile()), ids(profileA))
  assert.deepEqual(ids(daemonProfile()), ids(profileB))
  assert.notEqual(profileA.providers.find((b) => b.seam === 'llm').factory().modelId, DEFAULT_DEEPSEEK_MODEL)
  assert.notEqual(profileB.providers.find((b) => b.seam === 'llm').factory().modelId, DEFAULT_DEEPSEEK_MODEL)

  const files = ['src/scenes/memory-scene.ts', 'src/runtime/assemble.ts', 'src/kernel/runtime.ts']
  const forbidden = [
    'createDaemon', 'daemonProfile', 'createWorkerLoop', 'reflectWithModel',
    'deepseekLlm', 'node:http', 'createServer', 'profile-daemon',
  ]
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    const hit = forbidden.filter((w) => src.includes(w))
    assert.deepEqual(hit, [], `${f} 不应知道常驻服务实现：${hit.join(', ')}`)
  }
})

test('⑮ adapter seam 生效：注入拒绝型 adapter → retain 返回 400', async () => {
  await withDaemon(async (d) => {
    const r = await req(d, '/retain', { method: 'POST', body: RETAIN })
    assert.equal(r.status, 400)
    assert.equal(r.json.error, 'unsupported-operation')
  }, { daemon: {
    adapter: { kind: 'deny', handle: () => ({ status: 400, body: { error: 'blocked' } }) },
  } })
})
