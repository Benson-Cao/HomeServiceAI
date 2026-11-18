import type { GraphStoreProvider, FulltextProvider } from '../pipeline/types.js'

/** 实体图（邻接表）。V0.7 轻量实现：节点 + 带权边，供 graph retriever 遍历。 */
export function adjacencyGraph(): GraphStoreProvider {
  const nodes = new Map<string, string>()
  const edges = new Map<string, Map<string, number>>()
  return {
    kind: 'adjacency',
    upsertNode(id, label) { nodes.set(id, label) },
    upsertEdge(from, to, weight = 1) {
      if (!edges.has(from)) edges.set(from, new Map())
      edges.get(from)!.set(to, weight)
    },
    neighbors(id) {
      const m = edges.get(id)
      return m ? [...m.entries()].sort((a, b) => b[1] - a[1]).map(([to]) => to) : []
    },
    size() { return nodes.size },
  }
}

/** 倒排索引 fulltext。词项 → 文档命中计数，供 bm25 retriever 使用。 */
export function invertedFulltext(): FulltextProvider {
  const postings = new Map<string, Map<string, number>>()
  const docs = new Map<string, string[]>()
  const tokenize = (t: string): string[] => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return {
    kind: 'inverted',
    index(id, text) {
      const ts = tokenize(text)
      docs.set(id, ts)
      for (const t of ts) {
        if (!postings.has(t)) postings.set(t, new Map())
        const m = postings.get(t)!
        m.set(id, (m.get(id) ?? 0) + 1)
      }
    },
    search(terms) {
      const acc = new Map<string, number>()
      for (const raw of terms) {
        for (const t of tokenize(raw)) {
          const m = postings.get(t)
          if (!m) continue
          const df = m.size
          const N = Math.max(1, docs.size)
          const idf = Math.log(1 + N / (1 + df))
          for (const [id, tf] of m) acc.set(id, (acc.get(id) ?? 0) + tf * idf)
        }
      }
      return [...acc.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
    },
    size() { return docs.size },
  }
}

/** 第二实现：无状态词面匹配 fulltext（可互换验证）。 */
export function literalFulltext(): FulltextProvider {
  const docs = new Map<string, string>()
  return {
    kind: 'literal',
    index(id, text) { docs.set(id, text.toLowerCase()) },
    search(terms) {
      const out: Array<{ id: string; score: number }> = []
      for (const [id, body] of docs) {
        let score = 0
        for (const raw of terms) for (const t of raw.toLowerCase().split(/\s+/).filter(Boolean)) {
          if (body.includes(t)) score += 1
        }
        if (score > 0) out.push({ id, score })
      }
      return out.sort((a, b) => b.score - a.score)
    },
    size() { return docs.size },
  }
}
