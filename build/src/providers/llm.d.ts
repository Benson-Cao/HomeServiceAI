import type { LlmProvider } from '../pipeline/types.js';
/** Provider A：API 通道（V0.5 为确定性桩，不真发网络）。 */
export declare function apiLlm(): LlmProvider;
/** Provider B：本地大模型通道（V0.5 为确定性桩，与 API 通道平级）。 */
export declare function localLlm(): LlmProvider;
