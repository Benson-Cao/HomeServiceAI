import type { JobRecord, QueueProvider } from '../pipeline/types.js'

/** 有界队列：单并发、超限背压（宁可写入慢，不让 NAS 被拖死）。 */
export function boundedQueue(options: { maxSize?: number; concurrency?: number } = {}): QueueProvider & { items(): readonly JobRecord[] } {
  const maxSize = options.maxSize ?? 64
  const concurrency = options.concurrency ?? 1
  const q: JobRecord[] = []
  let backpressureCount = 0
  return {
    maxSize,
    concurrency,
    get backpressureCount() { return backpressureCount },
    enqueue(job) {
      if (q.length >= maxSize) { backpressureCount++; return { accepted: false, reason: 'backpressure' } }
      q.push(job)
      return { accepted: true }
    },
    dequeue() { return q.shift() },
    size() { return q.length },
    items() { return [...q] },
  }
}
