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
import { CONTRACT_VERSION, isCompatible } from '../../seams/contract-version.js'
import type { Principal, BankId, Operation, SeamId } from '../../seams/vocabulary.js'
import type { KernelContext, KernelRuntime, KernelErrorRecord, PluginDefinition, FiberState, FiberRunState } from './types.js'

export { CONTRACT_VERSION }

export const EVENT_TYPES: readonly string[] = Object.freeze([
  'memory.retain.accepted',
  'memory.retain.rejected',
  'memory.recall.result',
  'memory.reflect.result',
  'memory.sync.cursor',
  'memory.job.state',
  'memory.authz.decided',
  'memory.vector.quarantined',
  'memory.consolidation.strengthened',
  'memory.conflict.revised',
  'memory.expiry.archived',
  'memory.defense.flagged',
  'memory.sync.accepted',
  'memory.precompute.done',
  'memory.batch.deferred',
  'kernel.plugin.loaded',
  'kernel.plugin.pending',
  'kernel.plugin.disposed',
  'kernel.seam.registered',
])

const OPERATIONS: readonly string[] = Object.freeze(['retain', 'recall', 'reflect'])
const EVENT_SET = new Set<string>(EVENT_TYPES)

function assertEvent(name: string): void {
  if (!EVENT_SET.has(name)) throw new Error(`kernel: 未声明的事件类型 ${name}`)
}

interface Fiber {
  id: string
  deps: string[]
  apply: (ctx: KernelContext) => void
  state: FiberRunState
  disposers: Array<() => void>
  ctx: KernelContext | null
  error: string | null
  activatedAt?: number
}

interface ServiceEntry { provider: unknown; owner: string }
interface ListenerRecord { fn: (payload: unknown) => void; owner: string }

interface PolicyLike {
  evaluate?: (input: { principal: Principal; bank: BankId; operation: Operation }) => boolean
}

export interface KernelOptions { contractVersion?: string }

export function createKernel(options: KernelOptions = {}): KernelRuntime {
  const expected = options.contractVersion ?? CONTRACT_VERSION
  if (!isCompatible(expected)) {
    throw new Error(`kernel: 契约主版本不匹配（期望 ${CONTRACT_VERSION}，收到 ${expected}）`)
  }

  const fibers = new Map<string, Fiber>()
  const services = new Map<string, ServiceEntry>()
  const listeners = new Map<string, Set<ListenerRecord>>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const activationOrder: string[] = []
  const lastErrors: KernelErrorRecord[] = []
  let reconciling = false
  let dirty = false
  let disposed = false

  function emitInternal(event: string, payload: unknown): number {
    const set = listeners.get(event)
    if (!set) return 0
    let delivered = 0
    for (const rec of [...set]) {
      try {
        rec.fn(payload)
        delivered++
      } catch (err) {
        lastErrors.push({ event, owner: rec.owner, error: String((err as Error)?.message ?? err) })
      }
    }
    return delivered
  }

  function disposeFiber(f: Fiber): void {
    // ④ 可逆副作用：逆序回滚。批量 undo 期间抑制重入，由外层统一重算一次。
    const prev = reconciling
    reconciling = true
    try {
      for (let i = f.disposers.length - 1; i >= 0; i--) {
        try { f.disposers[i]() } catch { /* 卸载不阻断其余回滚 */ }
      }
    } finally {
      reconciling = prev
    }
    f.disposers.length = 0
  }

  function missing(f: Fiber): string[] {
    return f.deps.filter((d) => !services.has(d))
  }

  function deactivate(f: Fiber): void {
    disposeFiber(f)
    f.ctx = null
    f.state = 'pending'
    emitInternal('kernel.plugin.pending', { id: f.id, missingDeps: missing(f) })
  }

  function activate(f: Fiber): void {
    const ctx = makeContext(f)
    f.ctx = ctx
    try {
      f.apply(ctx)
      f.state = 'active'
      f.activatedAt = Date.now()
      activationOrder.push(f.id)
      emitInternal('kernel.plugin.loaded', { id: f.id, deps: [...f.deps] })
    } catch (err) {
      disposeFiber(f)
      f.ctx = null
      f.state = 'failed'
      f.error = String((err as Error)?.message ?? err)
      requestReconcile()
      // 插件自身抛错不让进程崩，状态可经 dumpTree 观测
    }
  }

  function requestReconcile(): void {
    dirty = true
    if (reconciling || disposed) return
    reconciling = true
    try {
      const maxPasses = Math.max(16, fibers.size * 6)
      let passes = 0
      while (dirty && passes < maxPasses) {
        dirty = false
        passes++
        for (const f of fibers.values()) {
          if (f.state === 'active' && missing(f).length) {
            deactivate(f)
            dirty = true
          }
        }
        for (const f of fibers.values()) {
          if (f.state === 'pending' && missing(f).length === 0) {
            activate(f)
            dirty = true
          }
        }
      }
      if (dirty) throw new Error('kernel: 依赖图无法收敛（疑似循环注册或抖动）')
    } finally {
      reconciling = false
    }
  }

  /** ⑤ 强制鉴权：内核只校验三元组与操作合法性，属性判定一律委托 L2 策略 seam。fail-closed。 */
  function authorize(principal: Principal, bank: BankId, operation: Operation): boolean {
    if (!principal || !bank || !operation || !OPERATIONS.includes(operation)) {
      emitInternal('memory.authz.decided', { principal, bank, operation, allowed: false, reason: 'invalid-tuple' })
      return false
    }
    const policy = services.get('isolation-policy')
    if (!policy) {
      emitInternal('memory.authz.decided', { principal, bank, operation, allowed: false, reason: 'policy-missing' })
      return false
    }
    let allowed = false
    try {
      const p = policy.provider as PolicyLike | ((i: unknown) => boolean) | null
      allowed = Boolean(typeof p === 'function'
        ? p({ principal, bank, operation })
        : p?.evaluate?.({ principal, bank, operation }))
    } catch {
      allowed = false
    }
    emitInternal('memory.authz.decided', { principal, bank, operation, allowed })
    return allowed
  }

  function makeContext(f: Fiber): KernelContext {
    const ctx: KernelContext = {
      contractVersion: CONTRACT_VERSION,
      pluginId: f.id,

      registerSeam(id: SeamId, provider: unknown): () => void {
        const entry: ServiceEntry = { provider, owner: f.id }
        services.set(id, entry)
        const undo = (): void => {
          // 仅删除自己那一次注册，避免误删后来覆盖者；并触发依赖重算（含手动调用路径）。
          if (services.get(id) === entry) {
            services.delete(id)
            requestReconcile()
          }
        }
        f.disposers.push(undo)
        emitInternal('kernel.seam.registered', { id, owner: f.id })
        requestReconcile()
        return undo
      },

      seam(id: SeamId, provider: unknown): () => void {
        return ctx.registerSeam(id, provider)
      },

      use<T = unknown>(id: SeamId): T | undefined {
        return services.get(id)?.provider as T | undefined
      },

      onDispose(fn: () => void): () => void {
        const undo = (): void => {
          const i = f.disposers.indexOf(fn)
          if (i >= 0) f.disposers.splice(i, 1)
        }
        f.disposers.push(fn)
        return undo
      },

      on(event: string, handler: (payload: unknown) => void): () => void {
        assertEvent(event)
        if (!listeners.has(event)) listeners.set(event, new Set())
        const rec: ListenerRecord = { fn: handler, owner: f.id }
        listeners.get(event)!.add(rec)
        const undo = (): void => { listeners.get(event)?.delete(rec) }
        f.disposers.push(undo)
        return undo
      },

      every(ms: number, handler: () => void): () => void {
        const t = setInterval(handler, ms)
        if (typeof t.unref === 'function') t.unref()
        timers.add(t)
        const undo = (): void => { clearInterval(t); timers.delete(t) }
        f.disposers.push(undo)
        return undo
      },

      emit(event: string, payload: unknown): number {
        assertEvent(event)
        return emitInternal(event, payload)
      },

      authorize(principal: Principal, bank: BankId, operation: Operation): boolean {
        return authorize(principal, bank, operation)
      },
    }
    return ctx
  }

  function plugin(def: PluginDefinition): () => void {
    if (disposed) throw new Error('kernel: 已 dispose')
    if (!def || typeof def.id !== 'string' || !def.id) throw new Error('kernel: 插件缺少 id')
    if (fibers.has(def.id)) throw new Error(`kernel: 插件 id 重复 ${def.id}（profile 层须先卸载再覆盖）`)
    const f: Fiber = {
      id: def.id,
      deps: [...(def.inject ?? [])],
      apply: def.apply,
      state: 'pending',
      disposers: [],
      ctx: null,
      error: null,
    }
    fibers.set(f.id, f)
    requestReconcile()
    return () => unload(f.id)
  }

  function unload(id: string): boolean {
    const f = fibers.get(id)
    if (!f) return false
    disposeFiber(f)
    f.state = 'disposed'
    fibers.delete(id)
    const i = activationOrder.lastIndexOf(id)
    if (i >= 0) activationOrder.splice(i, 1)
    emitInternal('kernel.plugin.disposed', { id })
    requestReconcile()
    return true
  }

  function dumpTree(): FiberState[] {
    return [...fibers.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((f) => ({
        id: f.id,
        state: f.state,
        deps: [...f.deps],
        missingDeps: missing(f),
        ...(f.error ? { error: f.error } : {}),
      }))
  }

  function dispose(): void {
    for (const id of [...activationOrder].reverse()) {
      const f = fibers.get(id)
      if (f) disposeFiber(f)
    }
    activationOrder.length = 0
    for (const t of timers) clearInterval(t)
    timers.clear()
    listeners.clear()
    services.clear()
    fibers.clear()
    disposed = true
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    plugin,
    unload,
    dumpTree,
    dispose,
    emit(event: string, payload: unknown): number { assertEvent(event); return emitInternal(event, payload) },
    authorize,
    get services(): readonly string[] { return [...services.keys()].sort() },
    resolve<T = unknown>(id: SeamId): T | undefined {
      return services.get(id)?.provider as T | undefined
    },
    get errors(): readonly KernelErrorRecord[] { return [...lastErrors] },
  })
}
