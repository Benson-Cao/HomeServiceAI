#!/usr/bin/env node
/**
 * 常驻服务自检（独立脚本，不进 verify / CI）。
 *
 *   npm run smoke:daemon -- --mock       # 离线：mock PG + fake 模型 + 真实 HTTP
 *   npm run smoke:daemon -- --identity   # 离线：再加成员 token 鉴权 + 目录 ABAC + 审计落库
 *   npm run smoke:daemon                 # 探测已运行服务（MH_HTTP_URL，默认 127.0.0.1:8080）
 *
 * 探测模式会写一条 bank_id=smoke 的测试记录，随后归档（不物理删除）。
 * 密钥/token 只从环境变量读，不打印、不落盘。
 */
import assert from 'node:assert/strict'
import { loadDotEnv } from './pg-connect.mjs'
import { createMockPgClient } from './mock-pg.mjs'
import { createDaemon } from '../build/src/runtime/daemon.js'
import { deepseekLlm } from '../build/src/providers/openai-compatible.js'
import { parseDirectory, createIdentityGate, issueToken } from '../build/src/runtime/identity.js'

const mock = process.argv.includes('--mock')
const identityMode = process.argv.includes('--identity')
loadDotEnv()

const envToken = process.env.MH_HTTP_TOKEN || undefined
const MODEL_TEXT = '常驻模型结论：证据链与有效区间让记忆可审计。'
const TEXT = 'daemon smoke：客厅灯晚上七点自动开'

const IDENTITY_SECRET = 'smoke-only-secret-not-for-production'
const IDENTITY_DIR = {
  members: [{ sub: 'parent', role: 'parent', banks: ['smoke', 'home'], devices: ['smoke-laptop'] }],
  banks: { smoke: { sensitivity: 'family', owner: 'parent' }, home: { sensitivity: 'family', owner: 'parent' } },
  trustedDevices: ['smoke-laptop'],
}

function fakeFetch() {
  return async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => null },
    json: async () => ({
      choices: [{ message: { content: MODEL_TEXT, reasoning_content: '' } }],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    }),
    text: async () => '',
  })
}

function headersFor(bearer) {
  const h = { 'content-type': 'application/json' }
  if (bearer) h.Authorization = `Bearer ${bearer}`
  else if (envToken) h.Authorization = `Bearer ${envToken}`
  return h
}

async function call(base, path, body, bearer) {
  const r = await fetch(base + path, {
    method: 'POST', headers: headersFor(bearer), body: JSON.stringify(body),
  })
  let json = null
  try { json = await r.json() } catch { /* 留空 */ }
  return { status: r.status, json }
}

async function runSequence(base, bearer) {
  const health = await (await fetch(base + '/health')).json()
  assert.equal(health.ok, true, 'health 应可用')
  assert.equal(health.contract_version, '1.2.0')

  // 无 token 时应被挡（身份模式）
  if (bearer) {
    const denied = await fetch(base + '/stats')
    assert.equal(denied.status, 401, '身份模式下无 token 应 401')
  }

  const retained = await call(base, '/retain', {
    principal: bearer ? 'parent' : 'smoke',
    bank_id: bearer ? 'smoke' : 'smoke',
    content: TEXT,
  }, bearer)
  assert.equal(retained.status, 202, 'retain 应返回 202 Accepted')
  const eventId = retained.json.event_id

  const deadline = Date.now() + 5000
  let hits = 0
  while (Date.now() < deadline) {
    const recall = await call(base, '/recall', {
      principal: bearer ? 'parent' : 'smoke', bank_id: 'smoke', query: '客厅灯',
    }, bearer)
    hits = recall.json.items?.length ?? 0
    if (hits > 0) break
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(hits > 0, 'worker 应在超时前把记录变为 visible')

  const reflect = await call(base, '/reflect', {
    principal: bearer ? 'parent' : 'smoke', bank_id: 'smoke', question: '照明习惯',
  }, bearer)
  assert.equal(reflect.status, 200)
  assert.equal(typeof reflect.json.synthesis, 'string')

  const archived = await call(base, '/archive', { event_id: eventId, reason: 'smoke:cleanup' }, bearer)
  assert.equal(archived.status, 200)

  const statsRes = await fetch(base + '/stats', { headers: headersFor(bearer) })
  const stats = await statsRes.json()
  return {
    ok: true,
    contract_version: health.contract_version,
    event_id: eventId,
    recall_items: hits,
    reflect_synthesis: reflect.json.synthesis,
    model_reply: reflect.json.model_reply ?? null,
    worker_ticks: stats.worker?.ticks ?? null,
    pending_writes: stats.pending_writes ?? null,
    audit: stats.audit ?? null,
    identity_mode: Boolean(bearer),
  }
}

try {
  let result
  if (mock || identityMode) {
    const pg = createMockPgClient()
    const llm = deepseekLlm({ apiKey: 'sk-unit-test-placeholder', fetch: fakeFetch(), sleep: async () => {} })
    let identity, directory, bearer
    if (identityMode) {
      directory = parseDirectory(IDENTITY_DIR)
      identity = createIdentityGate({ secret: IDENTITY_SECRET, directory })
      bearer = issueToken({ secret: IDENTITY_SECRET, sub: 'parent', device: 'smoke-laptop', ttlSeconds: 3600 })
    }
    const d = await createDaemon({
      client: pg.client, llm, port: 0, host: '127.0.0.1',
      autoStartWorker: true, workerIntervalMs: 20,
      identity, directory,
    })
    try {
      result = await runSequence(d.url, bearer)
      result.mode = identityMode ? 'identity-mock' : 'mock'
      result.pg_records = pg.records.size
      result.pg_embeddings = pg.embeddings.size
      result.pg_audit_rows = pg.auditRows.size
      assert.equal(result.reflect_synthesis, MODEL_TEXT, 'synthesis 应来自 fake 模型')
      assert.ok(result.model_reply, '应有模型元数据')
      if (identityMode) {
        assert.ok(pg.auditRows.size >= 5, '身份模式下审计应落库')
        const allAudit = JSON.stringify([...pg.auditRows.values()])
        assert.equal(allAudit.includes(TEXT), false, '审计不记录记忆正文')
        assert.equal(allAudit.includes(IDENTITY_SECRET), false, '审计不记录密钥')
      }
    } finally {
      await d.stop()
    }
  } else {
    const base = (process.env.MH_HTTP_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
    try {
      result = await runSequence(base, undefined)
      result.mode = 'probe'
      result.target = base
    } catch (err) {
      if (/fetch failed|ECONNREFUSED/i.test(String(err))) {
        console.error(`[smoke:daemon] SKIP · 未发现运行中的服务 ${base}`)
        console.error('  先执行：docker compose up -d；或离线自检：npm run smoke:daemon -- --identity')
        process.exit(2)
      }
      throw err
    }
  }
  console.log(JSON.stringify(result, null, 2))
} catch (err) {
  console.error(`[smoke:daemon] FAIL · ${err.message}`)
  process.exitCode = 1
}
