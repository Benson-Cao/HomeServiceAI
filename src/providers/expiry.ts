import type { ExpiryProvider, MemoryRecord } from '../pipeline/types.js'
import type { Freshness } from '../../seams/vocabulary.js'

const ORDER: Freshness[] = ['new', 'strengthening', 'stable', 'weakening', 'stale']

function decay(record: MemoryRecord, now: string, windowMs: number): Freshness {
  const age = Math.max(0, Date.parse(now) - Date.parse(record.recorded_at))
  const proof = record.provenance?.evidence.proof_count ?? 1
  // 证据越多衰减越慢；窗口内恒为 new/strengthening
  const effective = age / Math.max(1, proof)
  const idx = Math.min(ORDER.length - 1, Math.floor(effective / windowMs))
  return ORDER[idx]
}

/** Provider A：freshness 衰减 + valid time 区间；过期动作一律「归档待审」，不物理删除。 */
export function freshnessExpiry(options: { windowMs?: number } = {}): ExpiryProvider {
  const windowMs = options.windowMs ?? 7 * 24 * 3600 * 1000
  return {
    kind: 'freshness-decay',
    evaluate({ record, now }) {
      if (record.valid_to && Date.parse(now) > Date.parse(record.valid_to)) {
        return { freshness: 'stale', action: 'archive', reason: 'valid-time:expired' }
      }
      if (record.valid_from && Date.parse(now) < Date.parse(record.valid_from)) {
        return { freshness: 'new', action: 'archive', reason: 'valid-time:not-yet-effective' }
      }
      const freshness = decay(record, now, windowMs)
      if (freshness === 'stale') {
        return { freshness, action: 'archive', reason: 'freshness:stale' }
      }
      return { freshness, action: 'keep', reason: 'active' }
    },
  }
}

/** Provider B：保守策略，只按 valid time 裁决，不做时间衰减（可互换验证）。 */
export function conservativeExpiry(): ExpiryProvider {
  return {
    kind: 'valid-time-only',
    evaluate({ record, now }) {
      if (record.valid_to && Date.parse(now) > Date.parse(record.valid_to)) {
        return { freshness: 'stale', action: 'archive', reason: 'valid-time:expired' }
      }
      if (record.valid_from && Date.parse(now) < Date.parse(record.valid_from)) {
        return { freshness: 'new', action: 'archive', reason: 'valid-time:not-yet-effective' }
      }
      return { freshness: 'stable', action: 'keep', reason: 'active' }
    },
  }
}

export { ORDER as FRESHNESS_ORDER }
