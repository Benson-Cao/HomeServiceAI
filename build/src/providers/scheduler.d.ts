import type { SchedulerProvider } from '../pipeline/types.js';
/** 夜间批处理窗口：低峰期才跑重活，队列有界、单并发（ADR-001 纯私有化 profile）。 */
export declare function nightBatchScheduler(options?: {
    startHour?: number;
    endHour?: number;
}): SchedulerProvider;
/** 第二实现：始终允许（云 API 通道，由限流与成本约束而非时间窗）。 */
export declare function alwaysOnScheduler(): SchedulerProvider;
