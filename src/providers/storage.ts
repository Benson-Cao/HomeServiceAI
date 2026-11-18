import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryRecord, StorageProvider } from '../pipeline/types.js'

/** Provider A：Map 内存存储。 */
export function inMemoryStorage(): StorageProvider {
  const map = new Map<string, MemoryRecord>()
  return {
    kind: 'map',
    put(r) { map.set(r.event_id, r) },
    get(id) { return map.get(id) },
    all() { return [...map.values()] },
    markVisible(id, at) { const r = map.get(id); if (r) { r.state = 'visible'; r.visible_at = at } },
    archive(id, reason) { const r = map.get(id); if (r) { r.state = 'archived'; r.archive_reason = reason } },
    snapshot() { return JSON.stringify([...map.values()]) },
  }
}

/** Provider B：JSON 文件存储（每次写入落盘，可互换验证）。 */
export function fileJsonStorage(baseDir?: string): StorageProvider & { dispose(): void } {
  const base = baseDir ?? mkdtempSync(join(tmpdir(), 'mh-storage-'))
  mkdirSync(base, { recursive: true })
  const file = join(base, 'records.json')
  const map = new Map<string, MemoryRecord>()
  if (existsSync(file)) {
    for (const r of JSON.parse(readFileSync(file, 'utf8')) as MemoryRecord[]) map.set(r.event_id, r)
  }
  const flush = (): void => writeFileSync(file, JSON.stringify([...map.values()], null, 2))
  return {
    kind: 'file-json',
    put(r) { map.set(r.event_id, r); flush() },
    get(id) { return map.get(id) },
    all() { return [...map.values()] },
    markVisible(id, at) { const r = map.get(id); if (r) { r.state = 'visible'; r.visible_at = at; flush() } },
    archive(id, reason) { const r = map.get(id); if (r) { r.state = 'archived'; r.archive_reason = reason; flush() } },
    snapshot() { return JSON.stringify([...map.values()]) },
    dispose() { if (!baseDir) rmSync(base, { recursive: true, force: true }) },
  }
}
