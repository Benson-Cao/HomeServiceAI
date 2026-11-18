import { normalized } from './consolidator.js';
/** Provider A：按置信度裁决，低者归档待审；旧证据链保留，不覆盖、不删除。 */
export function confidenceConflict() {
    return {
        kind: 'confidence',
        detect({ incoming, existing }) {
            return normalized(incoming) !== normalized(existing);
        },
        revise({ keeper, loser }) {
            const a = keeper.provenance?.evidence.confidence ?? 0.5;
            const b = loser.provenance?.evidence.confidence ?? 0.5;
            const incomingWins = a >= b;
            return {
                winner: incomingWins ? 'incoming' : 'existing',
                keeperConfidence: Math.max(a, b),
                loserConfidence: Math.min(a, b),
                reason: 'conflict:revised-by-confidence',
            };
        },
    };
}
/** Provider B：按证据计数裁决（同一 seam、不同策略）。 */
export function proofCountConflict() {
    return {
        kind: 'proof-count',
        detect({ incoming, existing }) {
            return normalized(incoming) !== normalized(existing);
        },
        revise({ keeper, loser }) {
            const a = keeper.provenance?.evidence.proof_count ?? 1;
            const b = loser.provenance?.evidence.proof_count ?? 1;
            return {
                winner: a >= b ? 'incoming' : 'existing',
                keeperConfidence: Math.max(a, b) / (Math.max(a, b) + 1),
                loserConfidence: Math.min(a, b) / (Math.max(a, b) + 1),
                reason: 'conflict:revised-by-proof-count',
            };
        },
    };
}
