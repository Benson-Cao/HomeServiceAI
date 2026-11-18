function lexicalBoost(query, content) {
    const qs = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!qs.length)
        return 0;
    const body = content.toLowerCase();
    return qs.reduce((n, q) => n + (body.includes(q) ? 1 : 0), 0) / qs.length;
}
/** ranker：融合后二次排序（本地、确定性、零模型依赖）。 */
export function lexicalRanker() {
    return {
        kind: 'lexical',
        rank({ query, candidates, records, k }) {
            const by = new Map(records.map((r) => [r.event_id, r.content]));
            return candidates.map((h) => ({ ...h, score: h.score + 0.5 * lexicalBoost(query, by.get(h.fact_id) ?? '') }))
                .sort((a, b) => b.score - a.score).slice(0, k);
        },
    };
}
/** ranker 第二实现：按证据置信度加成。 */
export function provenanceRanker() {
    return {
        kind: 'provenance',
        rank({ candidates, records, k }) {
            const by = new Map(records.map((r) => [r.event_id, r.provenance?.evidence.confidence ?? 0.5]));
            return candidates.map((h) => ({ ...h, score: h.score + (by.get(h.fact_id) ?? 0.5) }))
                .sort((a, b) => b.score - a.score).slice(0, k);
        },
    };
}
/** reranker：Cross-Encoder 风格的确定性查询-文档交互打分（V0.7 本地轻量实现）。 */
export function pairwiseReranker() {
    return {
        kind: 'pairwise',
        rerank({ query, candidates, records, k }) {
            const by = new Map(records.map((r) => [r.event_id, r.content]));
            return candidates.map((h) => {
                const inter = lexicalBoost(query, by.get(h.fact_id) ?? '');
                return { ...h, score: 0.6 * h.score + 0.4 * inter };
            }).sort((a, b) => b.score - a.score).slice(0, k);
        },
    };
}
/** reranker 第二实现：保持融合名次，仅做截断（可互换验证）。 */
export function identityReranker() {
    return {
        kind: 'identity',
        rerank({ candidates, k }) {
            return candidates.slice(0, k);
        },
    };
}
