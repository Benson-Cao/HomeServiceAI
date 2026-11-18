import type { JobRecord, QueueProvider } from '../pipeline/types.js';
/** 有界队列：单并发、超限背压（宁可写入慢，不让 NAS 被拖死）。 */
export declare function boundedQueue(options?: {
    maxSize?: number;
    concurrency?: number;
}): QueueProvider & {
    items(): readonly JobRecord[];
};
