import type { Principal, BankId, Operation, SeamId } from '../../seams/vocabulary.js'

/** 经 ctx 注册的一切，卸载时按逆序自动回滚。 */
export interface KernelContext {
  readonly contractVersion: string
  readonly pluginId: string
  /** 注册 seam provider；返回可手动调用的 disposer。后注册覆盖前注册（按 id 整行替换）。 */
  registerSeam(id: SeamId, provider: unknown): () => void
  /** registerSeam 的简写别名。 */
  seam(id: SeamId, provider: unknown): () => void
  /** 读取已就绪的 seam provider；声明式依赖保证就绪，这里是消费侧注入口。 */
  use<T = unknown>(id: SeamId): T | undefined
  on(event: string, handler: (payload: unknown) => void): () => void
  every(ms: number, handler: () => void): () => void
  /** 注册任意可逆副作用；卸载时按逆序执行，是「归档待审、不物理删除」的落点。 */
  onDispose(fn: () => void): () => void
  emit(event: string, payload: unknown): number
  /** 内核强制三元组校验；属性判定委托 L2 策略 seam，无策略时 fail-closed。 */
  authorize(principal: Principal, bank: BankId, operation: Operation): boolean
}

export interface PluginDefinition {
  id: string
  inject?: readonly string[]
  apply: (ctx: KernelContext) => void
}

export type FiberRunState = 'active' | 'pending' | 'failed' | 'disposed'

export interface FiberState {
  id: string
  state: FiberRunState
  deps: string[]
  missingDeps: string[]
  error?: string
}

export interface KernelErrorRecord {
  event: string
  owner: string
  error: string
}

export interface KernelRuntime {
  readonly contractVersion: string
  plugin(def: PluginDefinition): () => void
  unload(id: string): boolean
  dumpTree(): FiberState[]
  dispose(): void
  emit(event: string, payload: unknown): number
  authorize(principal: Principal, bank: BankId, operation: Operation): boolean
  readonly services: readonly string[]
  /** 只读解析，供装配层取回插件注册的服务，不暴露可变引用。 */
  resolve<T = unknown>(id: SeamId): T | undefined
  readonly errors: readonly KernelErrorRecord[]
}
