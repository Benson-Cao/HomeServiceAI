import { bindings } from './bindings.js'
import type { Profile } from './types.js'

/** 装配清单 A：默认 provider 候选。具体产品名只出现在 profile 层。 */
export const profileA: Profile = {
  name: 'profile-a',
  providers: bindings(),
}
