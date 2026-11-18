import type { StorageProvider } from '../pipeline/types.js';
/** Provider A：Map 内存存储。 */
export declare function inMemoryStorage(): StorageProvider;
/** Provider B：JSON 文件存储（每次写入落盘，可互换验证）。 */
export declare function fileJsonStorage(baseDir?: string): StorageProvider & {
    dispose(): void;
};
