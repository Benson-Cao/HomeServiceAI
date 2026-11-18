import type { FusionProvider, FusionPlan, ScoredHit } from '../pipeline/types.js'
import type { RecallChannel } from '../../seams/vocabulary.js'

/**
 * 声明式 RRF：通道权重由 plan 显式给出，不由插件加载顺序隐式决定。
 * 每个通道内部按名次给分，再乘权重累加；同 id 跨通道合并。
 */
export function weightedRrf(): FusionProvider {
  return {
    kind: 'weighted-rrf',
    fuse(lists: ScoredHit[][], k: number, plan: FusionPlan = {}): ScoredHit[] {
      const c = plan.constant ?? 60
      const w = plan.weights ?? {}
      const acc = new Map<string, { score: number; channel: RecallChannel; best: number }>()
      for (const list of lists) {
        list.forEach((h, rank) => {
          const weight = w[h.channel] ?? 1
          const add = weight / (c + rank + 1)
          const prev = acc.get(h.fact_id)
          const dominant = add > (prev?.best ?? 0)
          acc.set(h.fact_id, {
            score: (prev?.score ?? 0) + add,
            channel: dominant ? h.channel : (prev?.channel ?? h.channel),
            best: Math.max(prev?.best ?? 0, add),
          })
        })
      }
      return [...acc.entries()]
        .map(([fact_id, v]) => ({ fact_id, score: v.score, channel: v.channel }))
        .sort((a, b) => b.score - a.score || a.fact_id.localeCompare(b.fact_id))
        .slice(0, k)
    },
  }
}

/** 兼容别名：V0.5 的简单 RRF 仍可作为可互换实现。 */
export function simpleRrf(constant = 60): FusionProvider {
  return {
    kind: 'rrf',
    fuse(lists: ScoredHit[][], k: number, plan: FusionPlan = {}): ScoredHit[] {
      return weightedRrf().fuse(lists, k, { constant, weights: plan.weights })
    },
  }
}
