/**
 * 最小可跑插件树（演示/诊断用，位于 src/examples，不参与内核纯度扫描）。
 * 故意留一个 PENDING 插件，用于验证「缺失依赖不崩溃、可诊断」。
 */
import type { KernelRuntime } from '../kernel/types.js'

export function mountMinimalTree(kernel: KernelRuntime): () => void {
  const defs = [
    { id: 'storage.primary', apply: (ctx: any) => ctx.registerSeam('storage', { kind: 'in-memory' }) },
    { id: 'embedder.primary', apply: (ctx: any) => ctx.registerSeam('embedder', { dim: 8 }) },
    { id: 'llm.primary', apply: (ctx: any) => ctx.registerSeam('llm', { mode: 'dual-channel' }) },
    { id: 'queue.primary', apply: (ctx: any) => ctx.registerSeam('queue', { bounded: true }) },
    { id: 'policy.primary', apply: (ctx: any) => ctx.registerSeam('isolation-policy', {
      evaluate: ({ principal, bank, operation }: any) => Boolean(principal && bank && operation === 'recall'),
    }) },
    { id: 'retriever.semantic', inject: ['storage', 'embedder'], apply: (ctx: any) => ctx.registerSeam('retriever.semantic', { owner: ctx.pluginId }) },
    { id: 'agent.entry', inject: ['llm', 'storage', 'retriever.semantic', 'queue'], apply: (ctx: any) => ctx.on('memory.retain.accepted', () => {}) },
    { id: 'reflect.worker', inject: ['consolidator'], apply: () => {} },
  ]
  const unloads = defs.map((d) => kernel.plugin(d))
  return () => { for (const u of unloads.reverse()) u() }
}
