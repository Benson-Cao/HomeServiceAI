import type { FusionProvider } from '../pipeline/types.js';
/**
 * 声明式 RRF：通道权重由 plan 显式给出，不由插件加载顺序隐式决定。
 * 每个通道内部按名次给分，再乘权重累加；同 id 跨通道合并。
 */
export declare function weightedRrf(): FusionProvider;
/** 兼容别名：V0.5 的简单 RRF 仍可作为可互换实现。 */
export declare function simpleRrf(constant?: number): FusionProvider;
