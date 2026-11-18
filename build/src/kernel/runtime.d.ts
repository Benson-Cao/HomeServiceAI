/**
 * L1 微内核 · 唯一不可动部分（TypeScript 实现，编译产物被运行时消费）。
 *
 * 只做五件事：
 *   ① 插件生命周期（加载 / 热插拔 / 卸载）
 *   ② 声明式依赖（就绪才启动；缺失 = PENDING；依赖消失回 PENDING）
 *   ③ 类型化事件总线（事件名白名单，未声明即拒绝）
 *   ④ 可逆副作用（经 ctx 注册的一切，卸载时按逆序自动回滚）
 *   ⑤ 契约版本 + 强制鉴权（三元组校验，属性判定委托 L2 策略 seam）
 *
 * 版本源来自编译产物 seams/contract-version.js（TD-001 已消除），不再读 JSON、不再内联判定。
 */
import { CONTRACT_VERSION } from '../../seams/contract-version.js';
import type { KernelRuntime } from './types.js';
export { CONTRACT_VERSION };
export declare const EVENT_TYPES: readonly string[];
export interface KernelOptions {
    contractVersion?: string;
}
export declare function createKernel(options?: KernelOptions): KernelRuntime;
