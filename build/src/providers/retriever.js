function cosine(a, b) {
    const n = Math.min(a.length, b.length);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < n; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (!na || !nb)
        return 0;
    return dot / Math.sqrt(na * nb);
}
/** Provider A：向量余弦。 */
export function cosineRetriever() {
    return {
        channel: 'semantic',
        kind: 'cosine',
        search({ vector, records, k }) {
            return records
                .filter((r) => r.vector)
                .map((r) => ({ fact_id: r.event_id, score: cosine(vector, r.vector), channel: 'semantic' }))
                .sort((a, b) => b.score - a.score)
                .slice(0, k);
        },
    };
}
/** Provider B：关键词重叠（同一 seam、不同算法，验证可互换）。 */
export function keywordRetriever() {
    return {
        channel: 'semantic',
        kind: 'keyword',
        search({ text, records, k }) {
            const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
            return records
                .map((r) => {
                const body = r.content.toLowerCase();
                const hit = terms.reduce((n, t) => n + (body.includes(t) ? 1 : 0), 0);
                return { fact_id: r.event_id, score: terms.length ? hit / terms.length : 0, channel: 'semantic' };
            })
                .filter((h) => h.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, k);
        },
    };
}
