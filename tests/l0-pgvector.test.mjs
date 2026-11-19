import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  SCHEMA_SQL, EMBEDDING_DIM, UPSERT_RECORD_SQL, UPSERT_EMBEDDING_SQL,
  rowToRecord, recordParams,
} from '../build/src/providers/pgvector.js'
import { createL0Stack } from '../build/src/runtime/l0-stack.js'
import { profileA } from '../build/src/profiles/profile-a.js'
import { profileB } from '../build/src/profiles/profile-b.js'
import { createMockPgClient } from '../scripts/mock-pg.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function sampleRecord(overrides = {}) {
  const now = '2026-11-19T02:00:00.000Z'
  return {
    event_id: 'ev_l0_001',
    principal: 'parent',
    bank_id: 'home',
    occurred_at: now,
    recorded_at: now,
    valid_from: null,
    valid_to: null,
    content: '客厅灯晚上七点自动开',
    scene: null,
    raw_pointer: 'file:///nas/home/lights.txt',
    dedupe_fingerprint: 'fp001',
    state: 'pending',
    accepted_at: now,
    visible_at: null,
    provenance: {
      producer_plugin_id: 'scene.memory', pipeline_run_id: 'run_1', contract_version: '1.2.0',
      model_id: 'api-chat-stub', embedding_dim: 16, quantization_version: 'q1',
      evidence: { quotes: ['客厅灯'], proof_count: 1, confidence: 0.5, freshness: 'new', valid_time: { valid_from: null, valid_to: null } },
    },
    vector: null,
    archive_reason: null,
    mental_model: null,
    facts: ['客厅灯晚上七点自动开'],
    ...overrides,
  }
}

test('① DDL 唯一源：TS 常量与 initdb 文件逐字一致，维度与 EMBEDDING_DIM 对齐', () => {
  const file = readFileSync(join(ROOT, 'docker/initdb/01-schema.sql'), 'utf8').trim()
  assert.equal(SCHEMA_SQL.trim(), file)
  assert.match(file, /CREATE EXTENSION IF NOT EXISTS vector/)
  assert.match(file, /IF NOT EXISTS/g)
  assert.equal(EMBEDDING_DIM, 16)
  assert.match(file, new RegExp(`vector\\(${EMBEDDING_DIM}\\)`))
})

test('② ensureSchema 幂等：一次 simple query 执行全部 DDL', async () => {
  const { client, queries } = createMockPgClient()
  const stack = await createL0Stack(client)
  assert.equal(queries[0].sql, SCHEMA_SQL)
  assert.equal(queries[0].params.length, 0)
  assert.equal(stack.storage.all().length, 0)
  assert.equal(stack.vector.size(), 0)
  assert.equal(stack.contractVersion, '1.2.0')
})

test('③ profile-l0 只覆盖 storage/vector，seam 集合与 A/B 严格一致', async () => {
  const { client } = createMockPgClient()
  const l0 = await createL0Stack(client)
  assert.equal(l0.profile.name, 'profile-l0')
  const ids = (p) => p.providers.map((b) => b.seam).sort()
  assert.deepEqual(ids(l0.profile), ids(profileA))
  assert.deepEqual(ids(l0.profile), ids(profileB))
  const storageBinding = l0.profile.providers.find((b) => b.seam === 'storage')
  assert.equal(storageBinding.factory().kind, 'pgvector-storage')
  assert.equal(l0.profile.providers.find((b) => b.seam === 'vector').factory().kind, 'pgvector-index')
  // A/B 不得被 L0 污染
  assert.notEqual(profileA.providers.find((b) => b.seam === 'storage').factory().kind, 'pgvector-storage')
  assert.notEqual(profileB.providers.find((b) => b.seam === 'storage').factory().kind, 'pgvector-storage')
})

test('④ 落库往返：put → flush → 参数化 UPSERT，records/embeddings 各 1', async () => {
  const { client, records, embeddings, queries } = createMockPgClient()
  const stack = await createL0Stack(client)
  const r = sampleRecord()
  stack.storage.put(r)
  stack.storage.markVisible(r.event_id, '2026-11-19T02:00:01.000Z')
  stack.vector.upsert(r.event_id, new Array(EMBEDDING_DIM).fill(0.1))
  assert.equal(stack.pendingWrites(), 2)

  const n = await stack.flush()
  assert.equal(n, 2)
  assert.equal(stack.pendingWrites(), 0)
  assert.equal(records.size, 1)
  assert.equal(embeddings.size, 1)
  const writes = queries.filter((q) => q.sql === UPSERT_RECORD_SQL || q.sql === UPSERT_EMBEDDING_SQL)
  assert.equal(writes.length, 2)
  // records 必须先于 embeddings（外键）
  assert.equal(writes[0].sql, UPSERT_RECORD_SQL)
  assert.equal(writes[1].sql, UPSERT_EMBEDDING_SQL)
  assert.equal(writes[0].params[0], 'ev_l0_001')
  assert.equal(writes[0].params[11], 'visible')
  assert.equal(JSON.parse(writes[1].params[1]).length, EMBEDDING_DIM)
})

test('⑤ 二次 flush 不产生新写（幂等）', async () => {
  const { client, queries } = createMockPgClient()
  const stack = await createL0Stack(client)
  stack.storage.put(sampleRecord())
  await stack.flush()
  const before = queries.length
  assert.equal(await stack.flush(), 0)
  assert.equal(queries.length, before)
})

test('⑥ 关键回归：provenance.evidence 原地修改（strengthened）会被 diff 捕获', async () => {
  const { client, records } = createMockPgClient()
  const stack = await createL0Stack(client)
  const r = sampleRecord()
  stack.storage.put(r)
  await stack.flush()

  // 模拟 consolidate 的 strengthened 分支：直接改 get() 返回的对象，不调用任何 seam 方法。
  const primary = stack.storage.get(r.event_id)
  primary.provenance.evidence.proof_count = 3
  primary.provenance.evidence.confidence = 0.82
  primary.provenance.evidence.quotes.push('补充证据')

  assert.equal(stack.pendingWrites(), 1)
  assert.equal(await stack.flush(), 1)
  assert.equal(records.get(r.event_id).provenance.evidence.proof_count, 3)
  assert.equal(records.get(r.event_id).provenance.evidence.confidence, 0.82)
})

test('⑦ 重启 hydrate：字段完整还原（三时间戳 / 7 字段溯源 / vector / facts）', async () => {
  const { client } = createMockPgClient()
  const first = await createL0Stack(client)
  const r = sampleRecord({
    occurred_at: '2026-11-18T10:00:00.000Z',
    valid_from: '2026-11-18T00:00:00.000Z',
    valid_to: '2027-01-01T00:00:00.000Z',
    vector: new Array(16).fill(0.2),
  })
  first.storage.put(r)
  first.vector.upsert(r.event_id, r.vector)
  await first.flush()

  // 同一个 PG，新进程视角：全新 stack 重新 hydrate。
  const second = await createL0Stack(client)
  const got = second.storage.get('ev_l0_001')
  assert.ok(got)
  assert.equal(got.occurred_at, '2026-11-18T10:00:00.000Z')
  assert.notEqual(got.recorded_at, got.occurred_at)
  assert.equal(got.valid_from, '2026-11-18T00:00:00.000Z')
  assert.equal(got.valid_to, '2027-01-01T00:00:00.000Z')
  assert.equal(got.provenance.contract_version, '1.2.0')
  assert.equal(got.provenance.embedding_dim, 16)
  assert.equal(got.provenance.quantization_version, 'q1')
  assert.equal(got.provenance.evidence.proof_count, 1)
  assert.deepEqual(got.facts, ['客厅灯晚上七点自动开'])
  assert.equal(got.raw_pointer, 'file:///nas/home/lights.txt')
  assert.equal(second.vector.size(), 1)
  assert.equal(second.pendingWrites(), 0, 'hydrate 后不得重写全表')
})

test('⑧ archive 与 markVisible 状态持久化', async () => {
  const { client } = createMockPgClient()
  const stack = await createL0Stack(client)
  stack.storage.put(sampleRecord())
  await stack.flush()
  stack.storage.archive('ev_l0_001', 'valid-time:expired')
  await stack.flush()
  const revived = await createL0Stack(client)
  assert.equal(revived.storage.get('ev_l0_001').state, 'archived')
  assert.equal(revived.storage.get('ev_l0_001').archive_reason, 'valid-time:expired')
})

test('⑨ 维度不符：embedding 列写 NULL，dim 保留，quarantined 可观测', async () => {
  const { client, embeddings } = createMockPgClient()
  const stack = await createL0Stack(client)
  stack.storage.put(sampleRecord())
  stack.vector.upsert('ev_l0_001', [0.1, 0.2, 0.3])
  await stack.flush()
  assert.deepEqual(stack.vector.quarantined(), ['ev_l0_001'])
  assert.equal(embeddings.get('ev_l0_001').embedding_text, null)
  assert.equal(embeddings.get('ev_l0_001').dim, 3)
})

test('⑩ flush 失败不推进 baseline，重试幂等且不丢写', async () => {
  const { client, records } = createMockPgClient({ failNextWrite: true })
  const stack = await createL0Stack(client)
  stack.storage.put(sampleRecord())
  await assert.rejects(() => stack.flush(), /injected write failure/)
  assert.equal(records.size, 0)
  assert.equal(stack.pendingWrites(), 1)
  assert.equal(await stack.flush(), 1)
  assert.equal(records.size, 1)
  assert.equal(stack.pendingWrites(), 0)
})

test('⑪ rowToRecord 兼容 pg 的 Date 与字符串 JSONB 两种返回', () => {
  const r = sampleRecord()
  const params = recordParams(r)
  const row = {
    event_id: params[0], principal: params[1], bank_id: params[2],
    occurred_at: new Date(params[3]), recorded_at: params[4],
    valid_from: null, valid_to: null, content: params[7], scene: null,
    raw_pointer: params[9], dedupe_fingerprint: params[10], state: 'visible',
    accepted_at: new Date(params[12]), visible_at: null,
    provenance: params[14], vector: params[15], archive_reason: null,
    mental_model: null, facts: params[18], contract_version: params[19],
  }
  const got = rowToRecord(row)
  assert.equal(got.occurred_at, '2026-11-19T02:00:00.000Z')
  assert.equal(got.state, 'visible')
  assert.equal(got.provenance.evidence.proof_count, 1)
  assert.deepEqual(got.facts, r.facts)
})
