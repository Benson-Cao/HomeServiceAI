import type { SyncProvider, SyncCursorState } from '../pipeline/types.js'

interface Buffered { fingerprint: string; content: string; watermark: string; at: number }

function makeCursor(sourceId: string, watermark: string, fingerprint: string, at: number): SyncCursorState {
  return {
    source_id: sourceId, watermark, fingerprint,
    last_synced_at: new Date(at).toISOString(), direction: 'bidirectional',
  }
}

/**
 * 端侧只缓冲、不裁决（ADR-003）：cursor 由服务端签发，多端冲突回服务端按既有治理裁决。
 * 去重指纹 + 水位线保证增量同步不丢、不重；buffer 支持断点续传。
 */
export function inMemorySync(): SyncProvider {
  const cursors = new Map<string, SyncCursorState>()
  const seen = new Map<string, Set<string>>()
  const buffers = new Map<string, Buffered[]>()
  let lastAt = 0
  return {
    kind: 'memory-cursor',
    cursor(sourceId) { return cursors.get(sourceId) ?? null },
    ingest({ sourceId, watermark, items }) {
      const set = seen.get(sourceId) ?? new Set<string>()
      let accepted = 0, duplicate = 0
      const buf = buffers.get(sourceId) ?? []
      for (const item of items) {
        if (set.has(item.fingerprint)) { duplicate++; continue }
        set.add(item.fingerprint)
        buf.push({ ...item, watermark, at: Date.now() })
        accepted++
      }
      seen.set(sourceId, set); buffers.set(sourceId, buf)
      lastAt = Date.now()
      const cursor = makeCursor(sourceId, watermark, items.at(-1)?.fingerprint ?? '', lastAt)
      cursors.set(sourceId, cursor)
      return { accepted, duplicate, cursor }
    },
    downstream({ sourceId, since }) {
      const all = buffers.get(sourceId) ?? []
      const items = since ? all.filter((b) => b.watermark > since) : all
      return { items: items.map((b) => ({ fingerprint: b.fingerprint, content: b.content })), cursor: cursors.get(sourceId) ?? null }
    },
    lagMs() { return lastAt ? Math.max(0, Date.now() - lastAt) : null },
    buffered() { return [...buffers.values()].reduce((n, b) => n + b.length, 0) },
  }
}

/**
 * 第二实现：自包含状态 + 可序列化快照（真·断点续传）。
 *
 * 修复记录：旧版把 cursor / downstream / buffered / lagMs 委托给 inMemorySync 的闭包，
 * restore() 只改了本地 state 对象，恢复后读到的仍是空状态；且按整批 accepted>0
 * 判断会把 duplicate 项也写进快照。现在全部状态由本实现持有，逐条按指纹去重。
 */
export function resumableSync(): SyncProvider & { snapshot(): string; restore(raw: string): void } {
  let cursors = new Map<string, SyncCursorState>()
  let seen = new Map<string, Set<string>>()
  let buffers = new Map<string, Buffered[]>()
  let lastAt = 0

  return {
    kind: 'resumable-cursor',
    cursor(sourceId) { return cursors.get(sourceId) ?? null },
    ingest({ sourceId, watermark, items }) {
      const set = seen.get(sourceId) ?? new Set<string>()
      const buf = buffers.get(sourceId) ?? []
      let accepted = 0, duplicate = 0
      let lastFingerprint = ''
      for (const item of items) {
        if (set.has(item.fingerprint)) { duplicate++; continue }
        set.add(item.fingerprint)
        buf.push({ fingerprint: item.fingerprint, content: item.content, watermark, at: Date.now() })
        lastFingerprint = item.fingerprint
        accepted++
      }
      seen.set(sourceId, set)
      buffers.set(sourceId, buf)
      lastAt = Date.now()
      const cursor = makeCursor(sourceId, watermark, lastFingerprint, lastAt)
      cursors.set(sourceId, cursor)
      return { accepted, duplicate, cursor }
    },
    downstream({ sourceId, since }) {
      const all = buffers.get(sourceId) ?? []
      const items = since ? all.filter((b) => b.watermark > since) : all
      return {
        items: items.map((b) => ({ fingerprint: b.fingerprint, content: b.content })),
        cursor: cursors.get(sourceId) ?? null,
      }
    },
    lagMs() { return lastAt ? Math.max(0, Date.now() - lastAt) : null },
    buffered() { return [...buffers.values()].reduce((n, b) => n + b.length, 0) },

    snapshot() {
      return JSON.stringify({
        cursors: Object.fromEntries(cursors),
        seen: Object.fromEntries([...seen].map(([k, v]) => [k, [...v]])),
        buffers: Object.fromEntries(buffers),
        lastAt,
      })
    },
    restore(raw) {
      const s = JSON.parse(raw) as {
        cursors?: Record<string, SyncCursorState>
        seen?: Record<string, string[]>
        buffers?: Record<string, Buffered[]>
        lastAt?: number
      }
      cursors = new Map(Object.entries(s.cursors ?? {}) as Array<[string, SyncCursorState]>)
      seen = new Map(Object.entries(s.seen ?? {}).map(([k, v]) => [k, new Set<string>(v)]))
      buffers = new Map(Object.entries(s.buffers ?? {}) as Array<[string, Buffered[]]>)
      lastAt = s.lastAt ?? 0
    },
  }
}
