import type { DefenseProvider } from '../pipeline/types.js';
/** PII / 密钥扫描：默认开启，命中即 redact 并给出可观测类别。 */
export declare function piiDefense(): DefenseProvider;
/** 第二实现：只标记不改写（可互换验证）。 */
export declare function detectOnlyDefense(): DefenseProvider;
