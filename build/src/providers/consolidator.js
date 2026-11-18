/** 主题键：同 bank + principal + scene 视为同一事实域；内容指纹相同即同一断言。 */
export function subjectKey(r) {
    return `${r.bank_id}|${r.principal}|${r.scene ?? ''}`;
}
export function normalized(r) {
    return r.content.trim().toLowerCase().replace(/\s+/g, ' ');
}
/** Provider A：证据计数优先。相同断言累积证据、不覆盖；不同断言交由 conflict seam 裁决。 */
export function evidenceCountConsolidator() {
    return {
        kind: 'evidence-count',
        integrate({ record, existing }) {
            const peers = existing.filter((r) => r.state !== 'archived' && subjectKey(r) === subjectKey(record));
            const identical = peers.find((r) => r.dedupe_fingerprint === record.dedupe_fingerprint);
            if (identical) {
                const e = identical.provenance?.evidence;
                const proofCount = (e?.proof_count ?? 0) + 1;
                const confidence = Math.min(1, (e?.confidence ?? 0.5) + 0.15 * (1 - (e?.confidence ?? 0.5)));
                return { action: 'strengthened', primaryId: identical.event_id, revisedIds: [], proofCount, confidence };
            }
            const conflicting = peers.filter((r) => normalized(r) !== normalized(record));
            if (conflicting.length) {
                return {
                    action: 'conflict', primaryId: record.event_id,
                    revisedIds: conflicting.map((r) => r.event_id),
                    proofCount: 1, confidence: record.provenance?.evidence.confidence ?? 0.5,
                };
            }
            return { action: 'new', primaryId: record.event_id, revisedIds: [], proofCount: 1, confidence: 0.5 };
        },
    };
}
/** Provider B：置信度修正优先。相同断言同样累积，但提升幅度不同（可互换验证）。 */
export function confidenceRevisionConsolidator() {
    return {
        kind: 'confidence-revision',
        integrate({ record, existing }) {
            const peers = existing.filter((r) => r.state !== 'archived' && subjectKey(r) === subjectKey(record));
            const identical = peers.find((r) => r.dedupe_fingerprint === record.dedupe_fingerprint);
            if (identical) {
                const e = identical.provenance?.evidence;
                const proofCount = (e?.proof_count ?? 0) + 1;
                const confidence = Math.min(1, (e?.confidence ?? 0.5) + 0.25 * (1 - (e?.confidence ?? 0.5)));
                return { action: 'strengthened', primaryId: identical.event_id, revisedIds: [], proofCount, confidence };
            }
            const conflicting = peers.filter((r) => normalized(r) !== normalized(record));
            if (conflicting.length) {
                return {
                    action: 'conflict', primaryId: record.event_id,
                    revisedIds: conflicting.map((r) => r.event_id),
                    proofCount: 1, confidence: record.provenance?.evidence.confidence ?? 0.5,
                };
            }
            return { action: 'new', primaryId: record.event_id, revisedIds: [], proofCount: 1, confidence: 0.5 };
        },
    };
}
