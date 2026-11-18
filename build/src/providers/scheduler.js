/** 夜间批处理窗口：低峰期才跑重活，队列有界、单并发（ADR-001 纯私有化 profile）。 */
export function nightBatchScheduler(options = {}) {
    const start = options.startHour ?? 1;
    const end = options.endHour ?? 5;
    return {
        kind: 'night-window',
        inBatchWindow(now) {
            const h = new Date(now).getUTCHours();
            return start <= end ? h >= start && h < end : h >= start || h < end;
        },
        nextWindow(now) {
            const d = new Date(now);
            d.setUTCHours(start, 0, 0, 0);
            if (d.getTime() <= Date.parse(now))
                d.setUTCDate(d.getUTCDate() + 1);
            return d.toISOString();
        },
    };
}
/** 第二实现：始终允许（云 API 通道，由限流与成本约束而非时间窗）。 */
export function alwaysOnScheduler() {
    return {
        kind: 'always-on',
        inBatchWindow() { return true; },
        nextWindow(now) { return now; },
    };
}
