import type { RetrieverProvider, ScoredHit, MemoryRecord } from '../pipeline/types.js'

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

const termsOf = (t: string): string[] => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** 语义通道：向量余弦。 */
export function semanticRetriever(): RetrieverProvider {
  return {
    channel: 'semantic', kind: 'cosine',
    search({ vector, records, k }): ScoredHit[] {
      return records.filter((r) => r.vector)
        .map((r) => ({ fact_id: r.event_id, score: cosine(vector, r.vector as number[]), channel: 'semantic' as const }))
        .sort((a, b) => b.score - a.score).slice(0, k)
    },
  }
}

/** 语义通道第二实现：关键词重叠（同 seam、不同算法）。 */
export function overlapRetriever(): RetrieverProvider {
  return {
    channel: 'semantic', kind: 'overlap',
    search({ text, records, k }): ScoredHit[] {
      const ts = termsOf(text)
      return records.map((r) => {
        const body = new Set(termsOf(r.content))
        const hit = ts.reduce((n, t) => n + (body.has(t) ? 1 : 0), 0)
        return { fact_id: r.event_id, score: ts.length ? hit / ts.length : 0, channel: 'semantic' as const }
      }).filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, k)
    },
  }
}

/** BM25 通道：消费 fulltext seam 的倒排/词面结果。 */
export function bm25Retriever(): RetrieverProvider {
  return {
    channel: 'bm25', kind: 'bm25',
    search({ text, records, k, fulltext }): ScoredHit[] {
      const ts = termsOf(text)
      if (fulltext) fulltext.size() // 索引由采集链路维护；检索只读
      const allowed = new Set(records.map((r) => r.event_id))
      const hits = fulltext ? fulltext.search(ts) : []
      return hits.filter((h) => allowed.has(h.id))
        .map((h) => ({ fact_id: h.id, score: h.score, channel: 'bm25' as const }))
        .slice(0, k)
    },
  }
}

/** 图通道：沿实体邻接遍历，命中邻居即得分。 */
export function graphRetriever(): RetrieverProvider {
  return {
    channel: 'graph', kind: 'neighbor-walk',
    search({ text, records, k, graph }): ScoredHit[] {
      const byId = new Map(records.map((r) => [r.event_id, r]))
      const seeds = records.filter((r) => termsOf(text).some((t) => termsOf(r.content).includes(t)))
      const acc = new Map<string, number>()
      for (const s of seeds) {
        acc.set(s.event_id, (acc.get(s.event_id) ?? 0) + 1)
        if (!graph) continue
        for (const n of graph.neighbors(s.event_id)) {
          if (byId.has(n)) acc.set(n, (acc.get(n) ?? 0) + 0.5)
        }
      }
      return [...acc.entries()].map(([fact_id, score]) => ({ fact_id, score, channel: 'graph' as const }))
        .sort((a, b) => b.score - a.score).slice(0, k)
    },
  }
}

/** 时间通道：按 valid_at 与 occurred_at 的距离衰减，越近越高。 */
export function temporalRetriever(): RetrieverProvider {
  return {
    channel: 'temporal', kind: 'recency-decay',
    search({ records, k, validAt }): ScoredHit[] {
      const now = validAt ? Date.parse(validAt) : Date.now()
      return records.map((r: MemoryRecord) => {
        const t = Date.parse(r.occurred_at)
        const days = Number.isFinite(t) ? Math.max(0, (now - t) / 86_400_000) : 365
        return { fact_id: r.event_id, score: 1 / (1 + days), channel: 'temporal' as const }
      }).sort((a, b) => b.score - a.score).slice(0, k)
    },
  }
}

/** 时间通道第二实现：只按 valid time 区间命中，不衰减。 */
export function intervalRetriever(): RetrieverProvider {
  return {
    channel: 'temporal', kind: 'valid-interval',
    search({ records, k, validAt }): ScoredHit[] {
      const now = validAt ? Date.parse(validAt) : Date.now()
      return records.filter((r) => (!r.valid_from || now >= Date.parse(r.valid_from)) && (!r.valid_to || now <= Date.parse(r.valid_to)))
        .map((r) => ({ fact_id: r.event_id, score: 1, channel: 'temporal' as const }))
        .slice(0, k)
    },
  }
}
