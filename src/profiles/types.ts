import type { SeamId } from '../../seams/vocabulary.js'

export interface ProviderBinding {
  id: string
  seam: SeamId
  factory: () => unknown
}

/** Profile 只声明装配清单；场景插件不写在 profile 里（由 assemble 统一挂载）。 */
export interface Profile {
  name: string
  providers: ProviderBinding[]
}
