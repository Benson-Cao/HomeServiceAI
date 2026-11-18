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

/** 第二实现：游标/指纹持久化到内存快照，可导出再恢复（断点续传）。 */
export function resumableSync(): SyncProvider & { snapshot(): string; restore(raw: string): void } {
  const base = inMemorySync()
  const state = { cursors: {} as Record<string, SyncCursorState>, seen: {} as Record<string, string[]>, buffers: {} as Record<string, Buffered[]> }
  return {
    kind: 'resumable-cursor',
    cursor: base.cursor,
    ingest(input) {
      const r = base.ingest(input)
      state.cursors[input.sourceId] = r.cursor
      state.seen[input.sourceId] = [...(state.seen[input.sourceId] ?? []), ...input.items.filter((i) => r.accepted > 0).map((i) => i.fingerprint)]
      state.buffers[input.sourceId] = (state.buffers[input.sourceId] ?? []).concat(
        input.items.map((i) => ({ ...i, watermark: input.watermark, at: Date.now() })),
      )
      return r
    },
    downstream: base.downstream,
    lagMs: base.lagMs,
    buffered: base.buffered,
    snapshot() { return JSON.stringify(state) },
    restore(raw) {
      const s = JSON.parse(raw)
      state.cursors = s.cursors ?? {}; state.seen = s.seen ?? {}; state.buffers = s.buffers ?? {}
    },
  }
}
