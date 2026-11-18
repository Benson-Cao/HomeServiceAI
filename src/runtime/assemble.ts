import { createKernel } from '../kernel/runtime.js'
import { createMemoryScene } from '../scenes/memory-scene.js'
import type { KernelRuntime } from '../kernel/types.js'
import type { MemoryService } from '../pipeline/types.js'
import type { Profile } from '../profiles/types.js'

export interface Assembled {
  readonly kernel: KernelRuntime
  readonly service: MemoryService | null
  readonly profileName: string
  dispose(): void
}

/** 同一份场景插件挂到任意 profile 上 —— 换 provider 不改场景代码。 */
export interface AssembleOptions { withStubs?: boolean }

export function assemble(profile: Profile, _options: AssembleOptions = {}): Assembled {
  const kernel = createKernel()
  const created: unknown[] = []

  for (const b of profile.providers) {
    kernel.plugin({
      id: b.id,
      apply: (ctx) => {
        const provider = b.factory()
        created.push(provider)
        ctx.registerSeam(b.seam, provider)
      },
    })
  }

  // V0.7：全部 L2 seam 已由 profile 装配真实 provider，V0.5 桩整体退役。

  let service: MemoryService | null = null
  kernel.plugin(createMemoryScene((s) => { service = s }))

  return {
    kernel,
    get service() { return service },
    profileName: profile.name,
    dispose(): void {
      kernel.dispose()
      for (const p of created) {
        const maybe = p as { dispose?: () => void } | null
        if (maybe && typeof maybe.dispose === 'function') maybe.dispose()
      }
    },
  }
}
