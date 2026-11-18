import type { ConflictProvider } from '../pipeline/types.js';
/** Provider A：按置信度裁决，低者归档待审；旧证据链保留，不覆盖、不删除。 */
export declare function confidenceConflict(): ConflictProvider;
/** Provider B：按证据计数裁决（同一 seam、不同策略）。 */
export declare function proofCountConflict(): ConflictProvider;
