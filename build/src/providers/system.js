export function memoryVector() {
    const m = new Map();
    return { kind: 'memory-vector', upsert(id, v) { m.set(id, v); }, size() { return m.size; } };
}
export function sentenceExtractor() {
    return { kind: 'sentence', extract(text) { return text.split(/[。；\n]/).map((s) => s.trim()).filter(Boolean); } };
}
export function dedupeIngest() {
    const seen = new Set();
    return { kind: 'dedupe', accept(fingerprint) { if (seen.has(fingerprint))
            return false; seen.add(fingerprint); return true; } };
}
/** 双通道平级路由：不设默认通道，按 operation 返回通道标签，由装配决定实际 llm provider。 */
export function neutralModelRouter() {
    return { kind: 'neutral', route(operation) { return operation === 'reflect' ? 'synthesis' : 'chat'; } };
}
export function boundedWorker() {
    let n = 0;
    return {
        kind: 'bounded',
        run(job) { n++; return { ...job, state: 'succeeded' }; },
        processed() { return n; },
    };
}
export function inMemoryAudit() {
    const log = [];
    return {
        kind: 'memory-audit',
        record(event, payload) { log.push({ event, payload }); },
        entries() { return [...log]; },
    };
}
export function defaultBankPolicy() {
    return {
        kind: 'default',
        retentionDays(bank) { return bank === 'health' ? 3650 : null; },
        shareScope(bank) { return bank === 'kid' ? 'family-read' : 'private'; },
    };
}
