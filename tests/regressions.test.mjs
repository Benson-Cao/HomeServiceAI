/**
 * 评审回归：外部实测发现的缺陷，逐条固化为可执行断言。
 * 不改任何契约，纯实现修复 + 测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { piiDefense, detectOnlyDefense } from '../build/src/providers/defense.js'
import { resumableSync, inMemorySync } from '../build/src/providers/sync.js'
import { evidenceCountConsolidator, confidenceRevisionConsolidator } from '../build/src/providers/consolidator.js'
import { nightBatchScheduler, alwaysOnScheduler } from '../build/src/providers/scheduler.js'

const mk = (id, content, fp = content) => ({
  event_id: id, bank_id: 'b1', principal: 'u1', scene: null, content,
  state: 'visible', dedupe_fingerprint: fp,
  recorded_at: '2026-01-01T00:00:00Z', valid_from: null, valid_to: null,
  provenance: { evidence: { quotes: [content], proof_count: 1, confidence: 0.5, freshness: 'new', valid_time: { valid_from: null, valid_to: null } } },
})

test('R1 defense：连续扫描同一 PII 不漏检（/g lastIndex 回归）', () => {
  const email = '联系 me@example.com 归档'
  const phone = '或 13800138000'
  for (const d of [piiDefense(), detectOnlyDefense()]) {
    for (let i = 0; i < 5; i++) {
      assert.equal(d.scan(email).flagged, true, `${d.kind} 第 ${i + 1} 次扫描邮箱漏检`)
      assert.equal(d.scan(phone).flagged, true, `${d.kind} 第 ${i + 1} 次扫描手机号漏检`)
    }
    const kinds = d.scan('me@example.com 13800138000 sk-abcdefgh12345678').kinds
    assert.ok(kinds.includes('email') && kinds.includes('phone-cn') && kinds.includes('api-key'))
  }
  const a = piiDefense()
  const r1 = a.scan('me@example.com')
  const r2 = a.scan('me@example.com')
  assert.equal(r1.redacted, r2.redacted, '多次 redact 结果必须一致')
  assert.ok(!r1.redacted.includes('me@example.com'))
  const b = detectOnlyDefense()
  assert.equal(b.scan('me@example.com').redacted, 'me@example.com', '仅标记不改写')
})

test('R2 路径：fileURLToPath 不产生 Windows 双盘符，且能读到契约目录', () => {
  // 模拟 Windows file URL（Linux 上也能验证「不再用 dir.pathname」这一修复）
  const win = fileURLToPath(new URL('file:///D:/Data/HomeServiceAI/.review_tmp/seams/'))
  assert.ok(!win.includes('D:\\D:\\'), `出现双盘符: ${win}`)
  assert.ok(win.endsWith('seams') || win.endsWith('seams\\') || win.endsWith('seams/'))
  // 真实目录：fileURLToPath + join 可枚举
  const dir = fileURLToPath(new URL('../seams/', import.meta.url))
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.ok(files.length >= 10)
  assert.ok(files.every((f) => existsSync(join(dir, f))))
})

test('R3 sync：restore 后 cursor / buffered / downstream / lagMs 全部真恢复', () => {
  const a = resumableSync()
  const first = a.ingest({ sourceId: 'tablet', watermark: 'w1', items: [
    { fingerprint: 'f1', content: 'alpha' }, { fingerprint: 'f2', content: 'beta' },
  ] })
  assert.deepEqual([first.accepted, first.duplicate], [2, 0])

  const second = a.ingest({ sourceId: 'tablet', watermark: 'w2', items: [
    { fingerprint: 'f1', content: 'alpha' },   // 重复，不应进快照
    { fingerprint: 'f3', content: 'gamma' },
  ] })
  assert.deepEqual([second.accepted, second.duplicate], [1, 1])
  assert.equal(a.buffered(), 3, '只有 3 条 accepted 进缓冲')

  const snapshot = a.snapshot()
  const b = resumableSync()
  b.restore(snapshot)

  assert.equal(b.cursor('tablet')?.watermark, 'w2', 'cursor 恢复')
  assert.equal(b.cursor('tablet')?.fingerprint, 'f3', 'cursor 指纹应取最后一条 accepted')
  assert.equal(b.buffered(), 3, 'buffered 恢复')
  assert.ok(b.lagMs() !== null, 'lagMs 恢复')
  const down = b.downstream({ sourceId: 'tablet' })
  assert.equal(down.items.length, 3, 'downstream 恢复')
  assert.equal(down.cursor?.watermark, 'w2', 'downstream 带 cursor')
  assert.equal(b.downstream({ sourceId: 'tablet', since: 'w1' }).items.length, 1, '增量水位线恢复')

  // 恢复后 seen 必须生效：重复指纹仍判为 duplicate
  const third = b.ingest({ sourceId: 'tablet', watermark: 'w3', items: [
    { fingerprint: 'f1', content: 'alpha' }, { fingerprint: 'f4', content: 'delta' },
  ] })
  assert.deepEqual([third.accepted, third.duplicate], [1, 1])
  assert.equal(b.cursor('tablet')?.watermark, 'w3')
  assert.equal(b.buffered(), 4)
})

test('R4 sync：A/B 两实现同构，空实例与快照恢复都不漂移', () => {
  for (const s of [inMemorySync(), resumableSync()]) {
    assert.equal(s.cursor('none'), null)
    assert.equal(s.buffered(), 0)
    assert.equal(s.lagMs(), null)
    const r = s.ingest({ sourceId: 'x', watermark: 'w', items: [{ fingerprint: 'f', content: 'c' }] })
    assert.deepEqual([r.accepted, r.duplicate], [1, 0])
    assert.equal(s.downstream({ sourceId: 'x' }).cursor?.watermark, 'w')
  }
})

test('R5 consolidator：大小写/空白差异应累积证据，不产生重复记忆', () => {
  for (const c of [evidenceCountConsolidator(), confidenceRevisionConsolidator()]) {
    const old = mk('a', 'Hello  World', 'fp-raw-A')
    const incoming = mk('b', 'hello world', 'fp-raw-B') // 指纹不同，语义相同
    const r = c.integrate({ record: incoming, existing: [old] })
    assert.equal(r.action, 'strengthened', `${c.kind} 应判为同一断言`)
    assert.equal(r.primaryId, 'a', '加强旧记录，不新建')
    assert.equal(r.proofCount, 2)
    assert.ok(r.confidence > 0.5)

    // 不同断言仍走矛盾裁决
    const conflict = c.integrate({ record: mk('c', '完全相反的结论'), existing: [old] })
    assert.equal(conflict.action, 'conflict')
    assert.deepEqual(conflict.revisedIds, ['a'])
  }
})

test('R6 consolidator：归档记录不参与证据累积，全新断言判 new', () => {
  const c = evidenceCountConsolidator()
  const archived = { ...mk('a', '同一断言'), state: 'archived' }
  const r = c.integrate({ record: mk('b', '同一断言'), existing: [archived] })
  assert.equal(r.action, 'new')
  assert.equal(c.integrate({ record: mk('c', '全新'), existing: [] }).action, 'new')
})

test('R7 scheduler：固定时刻判定，不依赖真实时钟', () => {
  const n = nightBatchScheduler()
  assert.equal(n.inBatchWindow('2026-11-18T03:00:00Z'), true, '窗口内')
  assert.equal(n.inBatchWindow('2026-11-18T12:00:00Z'), false, '窗口外')
  assert.equal(n.inBatchWindow('2026-11-18T05:00:00Z'), false, '右开边界')
  assert.ok(n.nextWindow('2026-11-18T12:00:00Z').endsWith('Z'))
  const a = alwaysOnScheduler()
  assert.equal(a.inBatchWindow('2026-11-18T03:00:00Z'), true)
  assert.equal(a.inBatchWindow('2026-11-18T12:00:00Z'), true)
})
