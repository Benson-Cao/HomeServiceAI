/**
 * 最小可跑插件树（演示/诊断用，位于 src/examples，不参与内核纯度扫描）。
 * 故意留一个 PENDING 插件，用于验证「缺失依赖不崩溃、可诊断」。
 */
import type { KernelRuntime } from '../kernel/types.js';
export declare function mountMinimalTree(kernel: KernelRuntime): () => void;
