import type { MemoryRecord, ConsolidatorProvider } from '../pipeline/types.js';
/** 主题键：同 bank + principal + scene 视为同一事实域；内容指纹相同即同一断言。 */
export declare function subjectKey(r: MemoryRecord): string;
export declare function normalized(r: MemoryRecord): string;
/** Provider A：证据计数优先。相同断言累积证据、不覆盖；不同断言交由 conflict seam 裁决。 */
export declare function evidenceCountConsolidator(): ConsolidatorProvider;
/** Provider B：置信度修正优先。相同断言同样累积，但提升幅度不同（可互换验证）。 */
export declare function confidenceRevisionConsolidator(): ConsolidatorProvider;
