import type { ExpiryProvider } from '../pipeline/types.js';
import type { Freshness } from '../../seams/vocabulary.js';
declare const ORDER: Freshness[];
/** Provider A：freshness 衰减 + valid time 区间；过期动作一律「归档待审」，不物理删除。 */
export declare function freshnessExpiry(options?: {
    windowMs?: number;
}): ExpiryProvider;
/** Provider B：保守策略，只按 valid time 裁决，不做时间衰减（可互换验证）。 */
export declare function conservativeExpiry(): ExpiryProvider;
export { ORDER as FRESHNESS_ORDER };
