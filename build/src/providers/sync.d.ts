import type { SyncProvider } from '../pipeline/types.js';
/**
 * 端侧只缓冲、不裁决（ADR-003）：cursor 由服务端签发，多端冲突回服务端按既有治理裁决。
 * 去重指纹 + 水位线保证增量同步不丢、不重；buffer 支持断点续传。
 */
export declare function inMemorySync(): SyncProvider;
/** 第二实现：游标/指纹持久化到内存快照，可导出再恢复（断点续传）。 */
export declare function resumableSync(): SyncProvider & {
    snapshot(): string;
    restore(raw: string): void;
};
