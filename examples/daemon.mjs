#!/usr/bin/env node
/**
 * ④ 常驻服务入口（容器 CMD / 宿主机直接跑）。
 *
 *   docker compose up -d          # 容器内监听 0.0.0.0:8080
 *   node examples/daemon.mjs      # 宿主机，需 .env + npm install
 *   node examples/daemon.mjs --local   # 强制走本地 OpenAI 兼容网关
 *
 * 身份模式：MH_IDENTITY_SECRET + 成员目录 → 成员 token（principal 由签名派生）。
 * 兼容模式：只填 MH_HTTP_TOKEN → 共享 Bearer；都不填 → 无鉴权（仅内网）。
 * 两者互斥；填了 secret 却缺目录会**启动失败**，不静默降级成裸奔。
 *
 * 优雅关停：SIGTERM / SIGINT → worker 最后一次 tick（drain + flush records + audit）
 * → 关闭监听 → 关闭 PG。刻意不调用 assemble().dispose()。
 */
import { loadDotEnv, resolveDsn, connectPg } from '../scripts/pg-connect.mjs'
import { loadMembersFromEnv } from '../scripts/load-members.mjs'
import { createDaemon } from '../build/src/runtime/daemon.js'
import { createIdentityGate } from '../build/src/runtime/identity.js'
import { deepseekLlm, localGatewayLlm } from '../build/src/providers/openai-compatible.js'

loadDotEnv()

const useLocal = process.argv.includes('--local')
const host = process.env.MH_HTTP_HOST || '0.0.0.0'
const port = Number(process.env.MH_HTTP_PORT || 8080) || 8080
const workerIntervalMs = Number(process.env.MH_WORKER_INTERVAL_MS || 1000) || 1000

// ── ④ 身份：优先成员 token ─────────────────────────────────
const secret = process.env.MH_IDENTITY_SECRET || ''
const sharedToken = process.env.MH_HTTP_TOKEN || ''
let identity
let token
let directoryInfo = null
let memberDirectory
if (secret) {
  if (sharedToken) throw new Error('MH_IDENTITY_SECRET 与 MH_HTTP_TOKEN 互斥，请只留一个')
  const loaded = loadMembersFromEnv({ required: true })
  if (!loaded) throw new Error('成员目录未加载')
  memberDirectory = loaded.directory
  directoryInfo = { members: loaded.memberCount, source: loaded.source }
  identity = createIdentityGate({ secret, directory: memberDirectory })
} else {
  token = sharedToken || undefined
}

// ── ② 真模型：只有显式配了端点/密钥才挂，否则确定性桩、不发网络 ──
const key = process.env.DEEPSEEK_API_KEY || ''
const model = process.env.DEEPSEEK_MODEL || undefined
const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 20_000) || 20_000
const localEndpoint = process.env.LLM_LOCAL_ENDPOINT || undefined
const localModel = process.env.LLM_LOCAL_MODEL || undefined

let llm
let llmNote = 'stub (no network)'
if (useLocal || localEndpoint) {
  llm = localGatewayLlm({ endpoint: localEndpoint, model: localModel, timeoutMs })
  llmNote = `local gateway ${llm.endpoint}`
} else if (key) {
  llm = deepseekLlm({
    apiKey: key, model,
    endpoint: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    timeoutMs,
  })
  llmNote = `api ${llm.modelId}`
}

const client = await connectPg(resolveDsn())
const daemon = await createDaemon({
  client, llm, host, port, token, identity,
  directory: memberDirectory,
  workerIntervalMs,
})

console.log(JSON.stringify({
  event: 'listening',
  url: daemon.url,
  profile: daemon.profile.name,
  contract_version: daemon.stack.contractVersion,
  llm: llmNote,
  worker_interval_ms: workerIntervalMs,
  auth: identity ? 'member-token (signed)' : (token ? 'shared-bearer' : 'none'),
  identity: directoryInfo,
  pid: process.pid,
}, null, 2))

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  console.log(JSON.stringify({ event: 'shutdown', signal }))
  try {
    await daemon.stop()
    console.log(JSON.stringify({ event: 'stopped', ok: true }))
    process.exit(0)
  } catch (err) {
    console.error(JSON.stringify({ event: 'stopped', ok: false, error: String(err) }))
    process.exit(1)
  }
}
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
