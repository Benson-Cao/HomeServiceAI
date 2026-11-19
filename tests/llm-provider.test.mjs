import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  deepseekLlm, localGatewayLlm, openAiCompatibleLlm,
  DEEPSEEK_ENDPOINT, LOCAL_GATEWAY_ENDPOINT, DEFAULT_DEEPSEEK_MODEL,
  LlmProtocolError,
} from '../build/src/providers/openai-compatible.js'
import { cloudProfile, localGatewayProfile, reflectWithModel } from '../build/src/runtime/llm-gateway.js'
import { assemble } from '../build/src/runtime/assemble.js'
import { profileA } from '../build/src/profiles/profile-a.js'
import { profileB } from '../build/src/profiles/profile-b.js'

const REPLY_TEXT = '综合结论：客厅灯每晚七点自动开。'

function okBody(overrides = {}) {
  return {
    choices: [{ message: { content: REPLY_TEXT, reasoning_content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    model: 'deepseek-flash',
    ...overrides,
  }
}

function response(status, body, headers = {}) {
  const text = JSON.stringify(body)
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 429 ? 'Too Many Requests' : status === 500 ? 'Internal Server Error' : 'OK',
    headers: { get: (n) => lower[n.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => text,
  }
}

/** 可控 fetch：handlers 按顺序消费；记录每次请求形状。 */
function fakeFetch(handlers) {
  const calls = []
  const queue = [...handlers]
  const fn = async (url, init) => {
    calls.push({ url, init })
    const h = queue.length ? queue.shift() : { status: 200, body: okBody() }
    if (h instanceof Error) throw h
    if (typeof h === 'function') return h(init)
    return response(h.status ?? 200, h.body ?? okBody(), h.headers ?? {})
  }
  return { fn, calls }
}

const noSleep = async () => {}
const fixedNow = (() => { let t = 1000; return () => (t += 5) })()

function base(overrides = {}) {
  return {
    apiKey: 'sk-unit-test-placeholder',
    fetch: fakeFetch([{ status: 200, body: okBody() }]).fn,
    sleep: noSleep,
    now: fixedNow,
    ...overrides,
  }
}

test('① 端点与请求形状：base_url 不带 /v1、Authorization、thinking 默认关闭、stream=false', async () => {
  const f = fakeFetch([{ status: 200, body: okBody() }])
  const p = deepseekLlm({ ...base(), fetch: f.fn })
  const reply = await p.completeAsync('你好')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, DEEPSEEK_ENDPOINT)
  assert.ok(!f.calls[0].url.includes('/v1/'))
  assert.equal(f.calls[0].init.method, 'POST')
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer sk-unit-test-placeholder')
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json')
  assert.ok(f.calls[0].init.signal instanceof AbortSignal)

  const body = JSON.parse(f.calls[0].init.body)
  assert.equal(body.model, DEFAULT_DEEPSEEK_MODEL)
  assert.deepEqual(body.thinking, { type: 'disabled' }, '默认显式关闭思考，避免静默产生 reasoning_content')
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.stream, false)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].content, '你好')

  assert.equal(reply.text, REPLY_TEXT)
  assert.equal(reply.usage.total_tokens, 20)
  assert.equal(reply.retries, 0)
  assert.equal(p.stats.succeeded, 1)
  assert.equal(p.stats.totalTokens, 20)
})

test('② 模型名可覆盖，不锁死官方快照写法', async () => {
  const f = fakeFetch([{ status: 200, body: okBody() }])
  const p = deepseekLlm({ ...base(), fetch: f.fn, model: 'deepseek-v4-pro', thinking: 'enabled', reasoningEffort: 'low' })
  await p.completeAsync('x')
  const body = JSON.parse(f.calls[0].init.body)
  assert.equal(body.model, 'deepseek-v4-pro')
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.reasoning_effort, 'low')
  assert.equal(p.modelId, 'deepseek-v4-pro')
})

test('③ 本地通道平级：同一实现、channel=local、不发 thinking 字段', async () => {
  const f = fakeFetch([{ status: 200, body: okBody() }])
  const p = localGatewayLlm({ ...base(), fetch: f.fn, model: 'qwen-local' })
  assert.equal(p.channel, 'local')
  assert.equal(p.endpoint, LOCAL_GATEWAY_ENDPOINT)
  await p.completeAsync('x')
  const body = JSON.parse(f.calls[0].init.body)
  assert.equal(body.thinking, undefined)
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.model, 'qwen-local')
  // 两条通道由装配决定，不存在默认偏好
  assert.equal(deepseekLlm(base()).channel, 'api')
  assert.equal(localGatewayLlm(base()).channel, 'local')
})

test('④ 同步槽桥接：prepare → 内核 reflect 拿到真模型文本，场景插件零改动', async () => {
  const f = fakeFetch([{ status: 200, body: okBody() }])
  const p = deepseekLlm({ ...base(), fetch: f.fn })
  const app = assemble(cloudProfile(p))
  assert.ok(app.service)
  const r = app.service.retain({ principal: 'u1', bank_id: 'b1', content: '客厅灯晚上七点自动开' })
  assert.equal(r.accepted, true)
  app.service.drain()

  const result = await reflectWithModel(app, p, { principal: 'u1', bank_id: 'b1', question: '照明习惯' })
  assert.equal(result.synthesis, REPLY_TEXT, 'synthesis 必须是真模型输出，不是确定性桩')
  assert.ok(result.sources.length >= 1)
  assert.ok(result.confidence > 0)
  assert.equal(result.contract_version, '1.2.0')
  assert.equal(result.model_reply.model, DEFAULT_DEEPSEEK_MODEL)
  assert.equal(result.model_reply.usage.total_tokens, 20)
  assert.equal(result.model_reply.retries, 0)
  assert.equal(p.hasPendingReply(), false, '槽被消费后应清空')
  app.dispose()
})

test('⑤ 精确缓存命中：同 prompt 直接返回，不再发请求', async () => {
  const f = fakeFetch([{ status: 200, body: okBody() }])
  const p = deepseekLlm({ ...base(), fetch: f.fn })
  await p.completeAsync('同一问题')
  assert.equal(p.complete('同一问题'), REPLY_TEXT)
  assert.equal(f.calls.length, 1)
  assert.equal(p.cacheSize(), 1)
})

test('⑥ 未预取时 complete 确定性降级：绝不抛错、绝不发网络', () => {
  let touched = false
  const p = deepseekLlm({ ...base(), fetch: async () => { touched = true; throw new Error('不该发网络') } })
  const a = p.complete('abc')
  const b = p.complete('abc')
  assert.equal(a, b)
  assert.match(a, /^\[llm:offline\] 3:fallback$/)
  assert.equal(touched, false)
  assert.equal(p.stats.requests, 0)
})

test('⑦ 429 退避：尊重 Retry-After，重试后成功，计数可观测', async () => {
  const f = fakeFetch([
    { status: 429, body: { error: 'rate limited' }, headers: { 'Retry-After': '0' } },
    { status: 429, body: { error: 'rate limited' }, headers: { 'Retry-After': '0' } },
    { status: 200, body: okBody() },
  ])
  const p = deepseekLlm({ ...base({ maxRetries: 2 }), fetch: f.fn })
  const reply = await p.completeAsync('x')
  assert.equal(reply.text, REPLY_TEXT)
  assert.equal(reply.retries, 2)
  assert.equal(p.stats.retried429, 2)
  assert.equal(p.stats.succeeded, 1)
  assert.equal(f.calls.length, 3)
})

test('⑧ 429 耗尽 / HTTP 500 / 畸形响应：抛协议错，但 complete 不抛穿内核', async () => {
  const cases = [
    { name: '429耗尽', handlers: [{ status: 429, body: {} }, { status: 429, body: {} }], opts: { maxRetries: 1 }, match: /HTTP 429/ },
    { name: '500', handlers: [{ status: 500, body: { error: 'boom' } }], opts: {}, match: /HTTP 500/ },
    { name: '缺choices', handlers: [{ status: 200, body: { usage: {} } }], opts: {}, match: /choices/ },
    { name: 'content非字符串', handlers: [{ status: 200, body: { choices: [{ message: { content: 42 } }] } }], opts: {}, match: /content/ },
  ]
  for (const c of cases) {
    const f = fakeFetch(c.handlers)
    const p = deepseekLlm({ ...base({ ...c.opts }), fetch: f.fn })
    await assert.rejects(() => p.completeAsync('x'), c.match, c.name)
    assert.ok(p.stats.lastError, `${c.name} 应记录错误`)
    assert.equal(typeof p.complete('x'), 'string', `${c.name} 时 complete 仍必须返回字符串`)
  }
})

test('⑨ 网络异常与超时：错误可观测，timeouts 计数，不抛穿', async () => {
  const netErr = new Error('ECONNRESET')
  const p1 = deepseekLlm({ ...base(), fetch: async () => { throw netErr } })
  await assert.rejects(() => p1.completeAsync('x'), /ECONNRESET/)
  assert.match(p1.stats.lastError, /ECONNRESET/)
  assert.equal(typeof p1.complete('x'), 'string')

  const aborting = async (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      reject(e)
    })
  })
  const p2 = deepseekLlm({ ...base(), fetch: aborting, timeoutMs: 10, maxRetries: 0 })
  await assert.rejects(() => p2.completeAsync('x'), /aborted/i)
  assert.equal(p2.stats.timeouts, 1)
  assert.equal(typeof p2.complete('x'), 'string')
})

test('⑩ gateway 失败降级：真调用挂了 reflect 仍返回，model_reply=null，错误留在 stats', async () => {
  const p = deepseekLlm({ ...base(), fetch: async () => { throw new Error('offline') }, maxRetries: 0 })
  const app = assemble(cloudProfile(p))
  const r = await reflectWithModel(app, p, { principal: 'u1', bank_id: 'b1', question: 'x' })
  assert.equal(typeof r.synthesis, 'string')
  assert.equal(r.model_reply, null)
  assert.match(p.stats.lastError, /offline/)
  app.dispose()
})

test('⑪ 显式装配不污染 A/B：seam 集合一致，默认 profile 仍无真 provider', () => {
  const f = fakeFetch([{ status: 200, body: okBody() }])
  const p = deepseekLlm({ ...base(), fetch: f.fn })
  const ids = (x) => x.providers.map((b) => b.seam).sort()
  assert.deepEqual(ids(cloudProfile(p)), ids(profileA))
  assert.deepEqual(ids(localGatewayProfile(p)), ids(profileB))
  assert.notEqual(profileA.providers.find((b) => b.seam === 'llm').factory().modelId, DEFAULT_DEEPSEEK_MODEL)
  assert.notEqual(profileB.providers.find((b) => b.seam === 'llm').factory().modelId, DEFAULT_DEEPSEEK_MODEL)
  assert.equal(f.calls.length, 0, '构造装配本身不得发网络')
})

test('⑫ 静态证明：场景插件 / 装配层 / 内核源码不含任何真模型实现名', () => {
  const files = [
    'src/scenes/memory-scene.ts',
    'src/runtime/assemble.ts',
    'src/kernel/runtime.ts',
  ]
  const forbidden = [
    'deepseekLlm', 'localGatewayLlm', 'openAiCompatibleLlm', 'DeepSeek',
    'DEEPSEEK_ENDPOINT', 'deepseek-flash', 'cloudProfile', 'reflectWithModel',
  ]
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    const hit = forbidden.filter((w) => src.includes(w))
    assert.deepEqual(hit, [], `${f} 不应知道具体实现：${hit.join(', ')}`)
  }
})

test('⑬ 绝不真发网络：注入守卫，所有请求必须落在 fake fetch', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => { throw new Error('测试触达了真实网络') }
  try {
    const f = fakeFetch([{ status: 200, body: okBody() }])
    const p = deepseekLlm({ ...base(), fetch: f.fn })
    await p.completeAsync('x')
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].url, DEEPSEEK_ENDPOINT)
  } finally {
    globalThis.fetch = original
  }
})

test('⑭ LlmProtocolError 可判别，且 openAiCompatibleLlm 允许完全自定义端点', async () => {
  const f = fakeFetch([{ status: 200, body: okBody() }])
  const p = openAiCompatibleLlm({
    channel: 'api', endpoint: 'http://example.invalid/v1/chat/completions',
    model: 'custom', fetch: f.fn, sleep: noSleep, now: fixedNow,
  })
  await p.completeAsync('x')
  assert.equal(f.calls[0].url, 'http://example.invalid/v1/chat/completions')
  assert.equal(p.endpoint, 'http://example.invalid/v1/chat/completions')
  assert.ok(new LlmProtocolError('x') instanceof Error)
})

test('⑮ 回归：.env 里 `MODEL=` 解析成空串时，必须回落到默认模型名', async () => {
  const f = fakeFetch([{ status: 200, body: okBody() }])
  const cloud = deepseekLlm({ ...base(), fetch: f.fn, model: '' })
  assert.equal(cloud.modelId, DEFAULT_DEEPSEEK_MODEL)
  await cloud.completeAsync('x')
  assert.equal(JSON.parse(f.calls[0].init.body).model, DEFAULT_DEEPSEEK_MODEL)

  const f2 = fakeFetch([{ status: 200, body: okBody() }])
  const local = localGatewayLlm({ ...base(), fetch: f2.fn, model: '' })
  await local.completeAsync('x')
  assert.equal(JSON.parse(f2.calls[0].init.body).model, 'local-model')
  assert.equal(local.endpoint, LOCAL_GATEWAY_ENDPOINT)
})
