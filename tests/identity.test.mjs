import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  issueToken, verifyToken, parseDirectory, createIdentityGate, directoryPolicy, inWindow,
} from '../build/src/runtime/identity.js'
import { pgAudit, INSERT_AUDIT_SQL } from '../build/src/providers/pg-audit.js'
import { SCHEMA_SQL } from '../build/src/providers/pgvector.js'
import { createDaemon } from '../build/src/runtime/daemon.js'
import { createMockPgClient } from '../scripts/mock-pg.mjs'
import { profileA } from '../build/src/profiles/profile-a.js'
import { profileB } from '../build/src/profiles/profile-b.js'
import { daemonProfile } from '../build/src/runtime/daemon.js'

const SECRET = 'unit-test-secret-not-a-real-key-0123456789'
const NOW_S = 1_800_000_000 // 固定时刻，2027-01-15 附近
const NOW_ISO = '2027-01-15T12:00:00.000Z' // UTC 12:00

const RAW_DIR = {
  members: [
    { sub: 'parent', role: 'parent', banks: ['home', 'work', 'health', 'kid'], devices: ['laptop-parent'] },
    { sub: 'child', role: 'child', banks: ['home', 'kid'], devices: ['tablet-kid'] },
  ],
  banks: {
    home: { sensitivity: 'family', owner: 'parent' },
    work: { sensitivity: 'private', owner: 'parent' },
    health: { sensitivity: 'private', owner: 'parent' },
    kid: { sensitivity: 'family', owner: 'parent' },
  },
  trustedDevices: ['laptop-parent', 'tablet-kid'],
}

function dir() { return parseDirectory(RAW_DIR) }
function gate(overrides = {}) {
  return createIdentityGate({
    secret: SECRET, directory: dir(),
    nowSeconds: () => NOW_S,
    now: () => NOW_ISO,
    ...overrides,
  })
}
function token(sub = 'parent', device = 'laptop-parent', opts = {}) {
  return issueToken({ secret: SECRET, sub, device, role: opts.role, ttlSeconds: 86_400, nowSeconds: NOW_S })
}

async function withIdentity(fn, opts = {}) {
  const pg = createMockPgClient(opts.pg ?? {})
  const d = await createDaemon({
    client: pg.client,
    port: 0, host: '127.0.0.1',
    autoStartWorker: false, workerIntervalMs: 100_000,
    identity: opts.gate ?? gate(),
    directory: opts.directory ?? dir(),
    now: () => NOW_ISO,
    ...(opts.daemon ?? {}),
  })
  try { return await fn(d, pg) } finally { await d.stop() }
}

async function req(d, path, { method = 'GET', body, bearer, raw } = {}) {
  const headers = {}
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  const init = { method, headers }
  if (raw !== undefined) { headers['content-type'] = 'application/json'; init.body = raw }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
  const r = await fetch(d.url + path, init)
  const ct = r.headers.get('content-type') ?? ''
  let json = null, text = null
  if (ct.includes('json')) { try { json = await r.json() } catch { /* 留空 */ } }
  else text = await r.text()
  return { status: r.status, json, text }
}

// ── A. Token 密码学 ────────────────────────────────────────────

test('① 签发与校验：HMAC 自洽，payload 字段完整', () => {
  const t = token()
  const p = verifyToken({ secret: SECRET, token: t, nowSeconds: NOW_S })
  assert.ok(p)
  assert.equal(p.sub, 'parent')
  assert.equal(p.dev, 'laptop-parent')
  assert.equal(p.exp, NOW_S + 86_400)
  assert.equal(p.v, 1)
  assert.match(t, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
})

test('② 篡改 / 错密钥 / 格式错 / 过期 / 未来签发一律拒绝，且不抛错', () => {
  const t = token()
  const parts = t.split('.')
  assert.equal(verifyToken({ secret: SECRET, token: `${parts[0]}.${parts[1]}.AAAA`, nowSeconds: NOW_S }), null)
  assert.equal(verifyToken({ secret: 'another-secret', token: t, nowSeconds: NOW_S }), null)
  assert.equal(verifyToken({ secret: SECRET, token: 'garbage', nowSeconds: NOW_S }), null)
  assert.equal(verifyToken({ secret: SECRET, token: 'v2.aaa.bbb', nowSeconds: NOW_S }), null)
  assert.equal(verifyToken({ secret: SECRET, token: t, nowSeconds: NOW_S + 86_400 + 1 }), null)
  const future = issueToken({ secret: SECRET, sub: 'parent', device: 'laptop-parent', nowSeconds: NOW_S + 3600 })
  assert.equal(verifyToken({ secret: SECRET, token: future, nowSeconds: NOW_S }), null)
  assert.equal(verifyToken({ secret: SECRET, token: undefined, nowSeconds: NOW_S }), null)
})

test('③ issueToken 参数校验：空 secret / 空 sub / 非正 ttl 明确报错', () => {
  assert.throws(() => issueToken({ secret: '', sub: 'parent' }), /secret/)
  assert.throws(() => issueToken({ secret: SECRET, sub: '  ' }), /sub/)
  assert.throws(() => issueToken({ secret: SECRET, sub: 'parent', ttlSeconds: 0 }), /ttlSeconds/)
})

// ── B. 目录与 ABAC ─────────────────────────────────────────────

test('④ parseDirectory 严格：非法配置启动即暴露，不静默放行', () => {
  assert.throws(() => parseDirectory(null), /members/)
  assert.throws(() => parseDirectory({ members: [] }), /不能为空/)
  assert.throws(() => parseDirectory({ members: [{ sub: 'x' }] }), /role/)
  assert.throws(() => parseDirectory({ ...RAW_DIR, banks: { work: { sensitivity: 'secret' } } }), /sensitivity/)
  const d = dir()
  assert.equal(d.members.size, 2)
  assert.equal(d.banks.get('work')?.sensitivity, 'private')
  assert.equal(d.trustedDevices.has('tablet-kid'), true)
})

test('⑤ gate：目录外 sub / 不可信设备 / 缺 Bearer 一律 401', () => {
  const g = gate()
  assert.equal(g.authenticate(`Bearer ${token('intruder')}`), null)
  assert.equal(g.authenticate(`Bearer ${token('parent', 'unknown-device')}`), null)
  assert.equal(g.authenticate(undefined), null)
  assert.equal(g.authenticate('Basic abc'), null)
  const ok = g.authenticate(`Bearer ${token('child', 'tablet-kid')}`)
  assert.equal(ok?.principal, 'child')
  assert.equal(ok?.deviceTrusted, true)
})

test('⑥ 目录策略：child 读不到 work/health，写不了 kid；parent 可读写私有域', () => {
  const p = directoryPolicy(dir(), { now: () => NOW_ISO })
  assert.equal(p.evaluate({ principal: 'child', bank: 'work', operation: 'recall' }), false)
  assert.equal(p.evaluate({ principal: 'child', bank: 'health', operation: 'recall' }), false)
  assert.equal(p.evaluate({ principal: 'child', bank: 'kid', operation: 'retain' }), false)
  assert.equal(p.evaluate({ principal: 'child', bank: 'kid', operation: 'recall' }), true)
  assert.equal(p.evaluate({ principal: 'child', bank: 'home', operation: 'retain' }), true)
  assert.equal(p.evaluate({ principal: 'parent', bank: 'work', operation: 'retain' }), true)
  assert.equal(p.evaluate({ principal: 'parent', bank: 'health', operation: 'recall' }), true)
  assert.equal(p.evaluate({ principal: 'ghost', bank: 'home', operation: 'recall' }), false)
  assert.equal(p.evaluate({ principal: 'parent', bank: 'home', operation: 'reflect' }), false)
})

test('⑦ 时间窗：UTC 判定 + 跨午夜窗口都成立', () => {
  assert.equal(inWindow('2027-01-15T12:00:00Z', '06:00', '18:00'), true)
  assert.equal(inWindow('2027-01-15T05:59:00Z', '06:00', '18:00'), false)
  assert.equal(inWindow('2027-01-15T23:00:00Z', '22:00', '06:00'), true)
  assert.equal(inWindow('2027-01-15T12:00:00Z', '22:00', '06:00'), false)
  assert.equal(inWindow('2027-01-15T12:00:00Z'), true)

  const timed = parseDirectory({ ...RAW_DIR, banks: { ...RAW_DIR.banks, kid: { sensitivity: 'family', owner: 'parent', windowStart: '06:00', windowEnd: '18:00' } } })
  const p = directoryPolicy(timed, { now: () => '2027-01-15T19:00:00.000Z' })
  assert.equal(p.evaluate({ principal: 'parent', bank: 'kid', operation: 'recall' }), false)
  assert.equal(p.evaluate({ principal: 'parent', bank: 'home', operation: 'recall' }), true)
})

// ── C. 审计落库 ───────────────────────────────────────────────

test('⑧ pgAudit：同步 record → 缓冲 → flush 落库；幂等不重复', async () => {
  const pg = createMockPgClient()
  const a = pgAudit({ client: pg.client, now: () => NOW_ISO })
  a.record('retain.accepted', { event_id: 'ev_1', bank_id: 'home', principal: 'parent', request_id: 'req_1' })
  a.record('recall', { bank_id: 'home', principal: 'parent' })
  assert.equal(a.pending(), 2)
  assert.equal(pg.auditRows.size, 0, 'record 是同步的，不能直接写库')
  const n = await a.flush()
  assert.equal(n, 2)
  assert.equal(pg.auditRows.size, 2)
  assert.equal(await a.flush(), 0, '二次 flush 不重复写')
  assert.equal(a.flushedCount(), 2)
  assert.equal(pg.queries.filter((q) => q.sql === INSERT_AUDIT_SQL).length, 2)
  const row = [...pg.auditRows.values()][0]
  assert.equal(row.principal, 'parent')
  assert.equal(row.bank_id, 'home')
  assert.equal(row.request_id, 'req_1')
  assert.equal(row.contract_version, '1.2.0')
})

test('⑨ pgAudit：正文/密钥一律脱敏，审计里不留记忆内容', async () => {
  const pg = createMockPgClient()
  const a = pgAudit({ client: pg.client, now: () => NOW_ISO })
  a.record('http.request', { content: '血压 120/80 是隐私', query: '体检', token: 'sk-secret', note: 'x'.repeat(300) })
  await a.flush()
  const row = [...pg.auditRows.values()][0]
  const payload = row.payload
  assert.equal(payload.content, '[redacted]')
  assert.equal(payload.query, '[redacted]')
  assert.equal(payload.token, '[redacted]')
  assert.equal(JSON.stringify(row).includes('血压'), false)
  assert.equal(payload.note.length, 201)
})

test('⑩ pgAudit：flush 失败保留缓冲，下次 tick 重试成功', async () => {
  const pg = createMockPgClient({ failNextAuditWrite: true })
  const a = pgAudit({ client: pg.client, now: () => NOW_ISO })
  a.record('retain.accepted', { event_id: 'ev_1' })
  await assert.rejects(() => a.flush(), /injected audit write failure/)
  assert.equal(a.pending(), 1)
  assert.equal(pg.auditRows.size, 0)
  assert.equal(await a.flush(), 1)
  assert.equal(pg.auditRows.size, 1)
  assert.equal(a.pending(), 0)
})

test('⑪ DDL 同源：审计表在 SCHEMA_SQL 与 initdb 里逐字一致', () => {
  const initdb = readFileSync(new URL('../docker/initdb/01-schema.sql', import.meta.url), 'utf8')
  assert.equal(SCHEMA_SQL, initdb)
  assert.match(initdb, /CREATE TABLE IF NOT EXISTS memory_audit_log/)
  assert.match(initdb, /idx_memory_audit_principal_bank/)
})

// ── D. daemon 身份集成 ────────────────────────────────────────

test('⑫ 认证边界：/health 豁免，其余无 token 401；有效 token 放行', async () => {
  await withIdentity(async (d) => {
    const h = await req(d, '/health')
    assert.equal(h.status, 200)
    assert.equal(h.json.identity, 'member-token')
    assert.equal((await req(d, '/stats')).status, 401)
    assert.equal((await req(d, '/stats', { bearer: 'bad' })).status, 401)
    assert.equal((await req(d, '/stats', { bearer: token() })).status, 200)
  })
})

test('⑬ principal 来自 token 而非请求体自报；伪造身份 400', async () => {
  await withIdentity(async (d, pg) => {
    const t = token('child', 'tablet-kid')
    const ok = await req(d, '/retain', {
      method: 'POST', bearer: t,
      body: { bank_id: 'home', content: '孩子写的家庭记忆' },
    })
    assert.equal(ok.status, 202)
    await d.worker.tick()
    assert.equal(pg.records.get(ok.json.event_id).principal, 'child', '记录的属主是 token 的 sub')

    const fake = await req(d, '/retain', {
      method: 'POST', bearer: t,
      body: { principal: 'parent', bank_id: 'work', content: '冒充家长写工作机密' },
    })
    assert.equal(fake.status, 400)
    assert.equal(fake.json.error, 'principal-mismatch')
    assert.equal(pg.records.size, 1, '伪造请求没有写入任何记录')
  })
})

test('⑭ 目录隔离在 HTTP 层生效：child 读 work 403，parent 读 work 200', async () => {
  await withIdentity(async (d) => {
    const child = token('child', 'tablet-kid')
    const parent = token('parent', 'laptop-parent')
    const denied = await req(d, '/recall', {
      method: 'POST', bearer: child,
      body: { bank_id: 'work', query: '项目' },
    })
    assert.equal(denied.status, 200, 'recall 被拒时返回空结果而非抛错')
    assert.equal(denied.json.items.length, 0)
    const written = await req(d, '/retain', {
      method: 'POST', bearer: child,
      body: { bank_id: 'work', content: '不该被写入' },
    })
    assert.equal(written.status, 403, '目录白名单挡住 child 写 work')
    const allowed = await req(d, '/retain', {
      method: 'POST', bearer: parent,
      body: { bank_id: 'work', content: '家长的项目机密' },
    })
    assert.equal(allowed.status, 202)
  })
})

test('⑮ 审计真实落库：http.request / http.response / retain.accepted 全在，且不含正文', async () => {
  await withIdentity(async (d, pg) => {
    const t = token()
    await req(d, '/stats', { bearer: t })
    const r = await req(d, '/retain', {
      method: 'POST', bearer: t,
      body: { bank_id: 'home', content: '客厅灯晚上七点自动开' },
    })
    assert.equal(r.status, 202)
    assert.equal(pg.auditRows.size, 0, '审计还在缓冲里')
    await d.worker.tick()
    assert.ok(pg.auditRows.size >= 5)
    const events = [...pg.auditRows.values()].map((x) => x.event)
    assert.ok(events.includes('http.request'))
    assert.ok(events.includes('http.response'))
    assert.ok(events.includes('retain.accepted'))
    const all = JSON.stringify([...pg.auditRows.values()])
    assert.equal(all.includes('客厅灯'), false, '审计不记录记忆正文')
    assert.equal(all.includes(SECRET), false)
    assert.ok([...pg.auditRows.values()].every((x) => x.contract_version === '1.2.0'))
    const stats = await req(d, '/stats', { bearer: t })
    assert.ok(stats.json.audit.rows >= 5)
    assert.ok(Number.isFinite(stats.json.audit.pending))
    // 真实语义：/stats 自身也是一次 HTTP 请求，会再产生 2 条审计缓冲。
    // 所以「pending 归零」永远比观测晚一个 tick —— 再跑一次 tick 应全部落库。
    await d.worker.tick()
    assert.ok(pg.auditRows.size >= 7, '连 /stats 自身产生的审计也一起落库')
  })
})

test('⑯ 认证失败也记安全审计，不静默丢弃', async () => {
  await withIdentity(async (d, pg) => {
    await req(d, '/stats')
    await req(d, '/stats', { bearer: 'tampered' })
    await d.worker.tick()
    const events = [...pg.auditRows.values()].map((x) => x.event)
    assert.equal(events.filter((e) => e === 'http.auth_failed').length, 2)
  })
})

test('⑰ 身份与共享 Bearer 互斥：同时配置直接启动失败', async () => {
  const pg = createMockPgClient()
  await assert.rejects(
    () => createDaemon({ client: pg.client, port: 0, identity: gate(), token: 'shared' }),
    /互斥/,
  )
})

test('⑱ 关停前审计缓冲也落库，且不触发 dispose 归档语义', async () => {
  const pg = createMockPgClient()
  const d = await createDaemon({
    client: pg.client, port: 0, autoStartWorker: false,
    identity: gate(), directory: dir(), now: () => NOW_ISO,
  })
  const t = token()
  const r = await req(d, '/retain', {
    method: 'POST', bearer: t,
    body: { bank_id: 'home', content: '关停前落库' },
  })
  assert.equal(pg.auditRows.size, 0)
  await d.stop()
  assert.equal(pg.records.get(r.json.event_id).state, 'visible')
  assert.ok(pg.auditRows.size >= 3)
  assert.notEqual(pg.records.get(r.json.event_id).archive_reason, 'plugin-disposed:pending-review')
})

// ── E. A 档边界 ───────────────────────────────────────────────

test('⑲ A 档：seam 集合与 A/B 一致，场景插件 / 内核零改动，禁用词覆盖 ④', () => {
  const ids = (p) => p.providers.map((b) => b.seam).sort()
  assert.deepEqual(ids(daemonProfile()), ids(profileA))
  assert.deepEqual(ids(daemonProfile()), ids(profileB))
  assert.deepEqual(ids(daemonProfile({ audit: pgAudit({ client: createMockPgClient().client }), policy: directoryPolicy(dir()) })), ids(profileA))

  const files = ['src/scenes/memory-scene.ts', 'src/runtime/assemble.ts', 'src/kernel/runtime.ts']
  const forbidden = [
    'createIdentityGate', 'directoryPolicy', 'issueToken', 'pgAudit',
    'MH_IDENTITY_SECRET', 'member-token', 'memory_audit_log', 'Hmac',
  ]
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    const hit = forbidden.filter((w) => src.includes(w))
    assert.deepEqual(hit, [], `${f} 不应知道身份实现：${hit.join(', ')}`)
  }
})
