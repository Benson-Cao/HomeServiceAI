import type { MemoryService } from '../pipeline/types.js'

/**
 * ③ 真后台 worker：把「setImmediate 同步驱动」升级为常驻进程里的有界循环。
 *
 * 一个 tick = 一次 service.drain()（队列 → visible）+ 一次 L0 flush（内存镜像 → PG）。
 * 不做无限递归、不并发重叠、失败只记录不抛穿应用；stop() 会做最后一次 tick 再退出，
 * 保证关停前把待写全部落库。
 *
 * 场景插件一行未改：worker 只在外环编排，不进入内核。
 */

export interface WorkerTickResult {
  at: string
  drained: number
  flushed: number
  pendingWritesBefore: number
  pendingWritesAfter: number
  acceptedToVisibleMs: number | null
  failed: boolean
  error: string | null
}

export interface WorkerLoopStats {
  ticks: number
  drained: number
  flushed: number
  failures: number
  running: boolean
  startedAt: string | null
  lastTickAt: string | null
  lastError: string | null
  lastAcceptedToVisibleMs: number | null
}

export interface WorkerLoopOptions {
  service: MemoryService
  flush: () => Promise<number>
  pendingWrites?: () => number
  intervalMs?: number
  /** 默认 true；确定性测试传 false，手动调用 tick()。 */
  autoStart?: boolean
  now?: () => string
  onTick?: (result: WorkerTickResult) => void
}

export interface WorkerLoopHandle {
  /** 幂等地跑一个 tick；并发调用共享同一个 in-flight 结果，不重叠。 */
  tick(): Promise<WorkerTickResult>
  start(): void
  /** 停定时器 + 最后一次 tick + 标记停止。 */
  stop(): Promise<WorkerTickResult>
  readonly stats: WorkerLoopStats
  readonly running: boolean
  readonly intervalMs: number
}

export function createWorkerLoop(options: WorkerLoopOptions): WorkerLoopHandle {
  const {
    service, flush, pendingWrites = () => 0,
    intervalMs = 1000, autoStart = true,
    now = () => new Date().toISOString(), onTick,
  } = options

  const stats: WorkerLoopStats = {
    ticks: 0, drained: 0, flushed: 0, failures: 0,
    running: false, startedAt: null, lastTickAt: null,
    lastError: null, lastAcceptedToVisibleMs: null,
  }

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<WorkerTickResult> | null = null

  async function runTick(): Promise<WorkerTickResult> {
    const at = now()
    const pendingWritesBefore = pendingWrites()
    let drained = 0
    let flushed = 0
    let failed = false
    let error: string | null = null
    try {
      drained = service.drain()
      flushed = await flush()
    } catch (err) {
      failed = true
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    }
    const result: WorkerTickResult = {
      at, drained, flushed, pendingWritesBefore,
      pendingWritesAfter: pendingWrites(),
      acceptedToVisibleMs: service.stats.lastVisibleLatencyMs,
      failed, error,
    }
    stats.ticks++
    stats.drained += drained
    stats.flushed += flushed
    if (failed) { stats.failures++; stats.lastError = error }
    else stats.lastError = null
    stats.lastTickAt = at
    if (result.acceptedToVisibleMs !== null) stats.lastAcceptedToVisibleMs = result.acceptedToVisibleMs
    onTick?.(result)
    return result
  }

  function tick(): Promise<WorkerTickResult> {
    if (inFlight) return inFlight
    const p = runTick().finally(() => { inFlight = null })
    inFlight = p
    return p
  }

  function start(): void {
    if (timer) return
    stats.running = true
    stats.startedAt = now()
    timer = setInterval(() => { void tick() }, Math.max(1, intervalMs))
  }

  async function stop(): Promise<WorkerTickResult> {
    if (timer) { clearInterval(timer); timer = null }
    const last = await tick()
    stats.running = false
    return last
  }

  if (autoStart) start()

  return {
    tick, start, stop,
    get stats() { return { ...stats } },
    get running() { return stats.running },
    intervalMs,
  }
}
