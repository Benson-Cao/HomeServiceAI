#!/usr/bin/env node
/**
 * 真模型连通性自检（独立脚本，不进 verify、不进 CI）。
 *
 *   npm run smoke:llm -- --mock   # 离线：fake fetch 跑通完整链路，不需要密钥/网络
 *   DEEPSEEK_API_KEY=sk-xxx npm run smoke:llm
 *   npm run smoke:llm -- --local  # 本地 OpenAI 兼容网关，无需云密钥
 *
 * 步骤：
 *   1. 先 GET /models 打印当期可用模型名 —— 官方模型名有过版本漂移，不靠硬编码猜；
 *   2. retain 一条本地记忆（让 recall 有命中）；
 *   3. 真调一次 /chat/completions，经同步槽注入 reflect，打印 synthesis / usage / latency。
 *
 * 密钥只从环境变量读，不打印、不落盘、不写日志。
 */
import assert from 'node:assert/strict'
import { loadDotEnv } from './pg-connect.mjs'
import {
  deepseekLlm, localGatewayLlm, DEFAULT_DEEPSEEK_MODEL,
} from '../build/src/providers/openai-compatible.js'
import { cloudProfile, localGatewayProfile, reflectWithModel } from '../build/src/runtime/llm-gateway.js'
import { assemble } from '../build/src/runtime/assemble.js'

const useLocal = process.argv.includes('--local')
const mock = process.argv.includes('--mock')
loadDotEnv()

// 用 || 而非 ??：.env 里 `KEY=` 会解析成空串，空串不是有效的显式值。
const key = process.env.DEEPSEEK_API_KEY ?? ''
const model = process.env.DEEPSEEK_MODEL || undefined
const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 20_000) || 20_000
const localEndpoint = process.env.LLM_LOCAL_ENDPOINT || undefined
const localModel = process.env.LLM_LOCAL_MODEL || undefined

const MOCK_TEXT = 'MOCK 综合结论：证据链与有效区间让记忆可审计、可修正。'

function mockFetch() {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => ({
      choices: [{ message: { content: MOCK_TEXT, reasoning_content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 18, completion_tokens: 11, total_tokens: 29 },
      model: DEFAULT_DEEPSEEK_MODEL,
    }),
    text: async () => '',
  })
}

if (!mock && !useLocal && !key) {
  console.error('[smoke:llm] SKIP · 未设置 DEEPSEEK_API_KEY。')
  console.error('  用法：DEEPSEEK_API_KEY=sk-xxx npm run smoke:llm')
  console.error('  离线自检：npm run smoke:llm -- --mock')
  console.error('  本地网关：npm run smoke:llm -- --local（可设 LLM_LOCAL_ENDPOINT / LLM_LOCAL_MODEL）')
  process.exit(2)
}

async function listModels(url, headers) {
  const res = await fetch(`${url.replace(/\/$/, '')}/models`, { headers })
  if (!res.ok) return { ok: false, status: res.status }
  const data = await res.json()
  const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : []
  return { ok: true, ids }
}

try {
  if (mock) {
    console.log(JSON.stringify({
      step: 'models', ok: true, ids: [DEFAULT_DEEPSEEK_MODEL],
      note: 'mock 模式：跳过真实 /models，模型名以厂商控制台为准',
    }, null, 2))
  } else {
    const headers = key ? { Authorization: `Bearer ${key}` } : {}
    const modelsUrl = useLocal
      ? (localEndpoint ?? 'http://127.0.0.1:11434/v1').replace(/\/chat\/completions$/, '')
      : baseUrl
    const models = await listModels(modelsUrl, headers).catch((e) => ({ ok: false, status: e.message }))
    const defaultVisible = models.ok && models.ids.includes(DEFAULT_DEEPSEEK_MODEL)
    console.log(JSON.stringify({
      step: 'models',
      ok: models.ok,
      ids: models.ok ? models.ids : [],
      note: models.ok
        ? (defaultVisible
          ? `默认模型 ${DEFAULT_DEEPSEEK_MODEL} 在当期列表中`
          : `当期列表不含默认名 ${DEFAULT_DEEPSEEK_MODEL}，请用 DEEPSEEK_MODEL 显式指定其中之一`)
        : `/models 不可用（${models.status}），不影响下一步；模型名以厂商控制台为准`,
    }, null, 2))
  }

  // 刻意不自动选 /models 第一个：不同型号价差可达数倍，选错不会报错、只会悄悄变贵。
  const shared = { model, timeoutMs, maxRetries: 2 }
  const provider = useLocal
    ? localGatewayLlm({ ...shared, model: localModel, endpoint: localEndpoint, fetch: mock ? mockFetch() : undefined })
    : deepseekLlm({
      ...shared,
      apiKey: key,
      endpoint: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
      fetch: mock ? mockFetch() : undefined,
    })

  const app = assemble(useLocal ? localGatewayProfile(provider) : cloudProfile(provider))
  if (!app.service) throw new Error('场景插件未就绪')

  // 让 recall 有命中，reflect 才会真的调用 complete() 并消费同步槽。
  app.service.retain({
    principal: 'smoke', bank_id: 'smoke',
    content: '记忆基础设施把证据链、时间语义和冲突治理沉淀为可验收的契约',
  })
  app.service.drain()

  const result = await reflectWithModel(app, provider, {
    principal: 'smoke', bank_id: 'smoke', question: '用一句话说明持久化记忆系统的价值',
  })

  if (mock) {
    assert.equal(result.model_reply !== null, true, 'mock 模式必须真调（走 fake fetch）')
    assert.equal(result.synthesis, MOCK_TEXT, 'synthesis 必须来自模型输出，不是确定性桩')
    assert.equal(provider.hasPendingReply(), false, '同步槽必须被 reflect 消费')
    assert.ok(result.sources.length >= 1, 'recall 应有命中')
    assert.equal(provider.stats.totalTokens, 29)
  }

  console.log(JSON.stringify({
    step: 'chat',
    ok: result.model_reply !== null && result.synthesis.length > 0,
    mode: mock ? 'mock' : (useLocal ? 'local' : 'api'),
    endpoint: provider.endpoint,
    model: provider.modelId,
    channel: provider.channel,
    synthesis: result.synthesis,
    sources: result.sources.length,
    model_reply: result.model_reply,
    stats: provider.stats,
    last_error: provider.stats.lastError,
  }, null, 2))

  if (result.model_reply === null || result.synthesis.length === 0) {
    console.error(`[smoke:llm] FAIL · ${provider.stats.lastError ?? '模型未产出 synthesis'}`)
    process.exitCode = 1
  } else if (provider.hasPendingReply()) {
    console.error('[smoke:llm] FAIL · 同步槽未被 reflect 消费')
    process.exitCode = 1
  }
  app.dispose()
} catch (err) {
  console.error(`[smoke:llm] FAIL · ${err.message}`)
  process.exitCode = 1
}
