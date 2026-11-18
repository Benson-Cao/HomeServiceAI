import type { KernelRuntime } from '../kernel/types.js';
import type { MemoryService } from '../pipeline/types.js';
import type { Profile } from '../profiles/types.js';
export interface Assembled {
    readonly kernel: KernelRuntime;
    readonly service: MemoryService | null;
    readonly profileName: string;
    dispose(): void;
}
/** 同一份场景插件挂到任意 profile 上 —— 换 provider 不改场景代码。 */
export interface AssembleOptions {
    withStubs?: boolean;
}
export declare function assemble(profile: Profile, _options?: AssembleOptions): Assembled;
