import type { PolicyProvider, AccessAttributes } from '../pipeline/types.js'

/**
 * L2 isolation-policy 的默认 provider（ABAC 简化版）。
 * 属性判定在这里，内核只做三元组校验 —— profile 不承载授权。
 */
export function simplePolicy(): PolicyProvider {
  return {
    evaluate({ principal, bank, operation }) {
      if (!principal || !bank) return false
      if (operation === 'reflect') return false // V0.5 不实现
      if (operation !== 'retain' && operation !== 'recall') return false
      if (bank === 'kid') {
        // kid 只读共享给家长：只有 parent 可写；child 可读
        if (operation === 'retain') return principal === 'parent'
        return principal === 'parent' || principal === 'child'
      }
      return true
    },
  }
}


export interface AbacConfig {
  /** principal → 角色；bank → 敏感度与属主；设备可信度默认值 */
  roles?: Record<string, string>
  bankSensitivity?: Record<string, 'public' | 'family' | 'private'>
  bankOwners?: Record<string, string>
  trustedDevices?: Record<string, boolean>
}

/**
 * ABAC 全量属性策略（L2 isolation-policy 执行点）。
 * 属性判定在策略 provider 内部，内核只做三元组校验；profile 只装配、不授权。
 * 四个属性维度：成员角色 / 数据敏感度 / 设备可信度 / 时间窗口。
 */
export function attributePolicy(config: AbacConfig = {}): PolicyProvider & {
  withAttributes(input: { principal: string; bank: string; operation: string; attributes?: AccessAttributes; at?: string }): boolean
} {
  const roles = config.roles ?? {}
  const sens = config.bankSensitivity ?? {}
  const owners = config.bankOwners ?? {}
  const devices = config.trustedDevices ?? {}

  function decide(input: { principal: string; bank: string; operation: string; attributes?: AccessAttributes; at?: string }): boolean {
    const { principal, bank, operation } = input
    if (!principal || !bank) return false
    if (operation !== 'retain' && operation !== 'recall') return false

    const a = input.attributes ?? {}
    const role = a.role ?? roles[principal] ?? 'member'
    const sensitivity = a.sensitivity ?? sens[bank] ?? 'family'
    const owner = owners[bank]
    const trusted = a.deviceTrusted ?? devices[principal] ?? true
    const now = input.at ? Date.parse(input.at) : Date.now()
    const inWindow = (!a.windowStart || now >= Date.parse(a.windowStart)) && (!a.windowEnd || now <= Date.parse(a.windowEnd))
    if (!inWindow || !trusted) return false

    // 私有域：仅属主可写，属主与 admin 可读
    if (sensitivity === 'private') {
      if (operation === 'retain') return principal === owner || role === 'admin'
      return principal === owner || role === 'admin'
    }
    // 家庭域：kid 对 child 只读（parent / admin 可写）
    if (bank === 'kid') {
      if (operation === 'retain') return role === 'parent' || role === 'admin' || principal === 'parent'
      return true
    }
    // 公共域：只读角色不得写
    if (operation === 'retain' && role === 'viewer') return false
    return true
  }

  return {
    evaluate(input) { return decide(input) },
    withAttributes(input) { return decide(input) },
  }
}
