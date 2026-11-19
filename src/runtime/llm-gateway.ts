import { bindings } from '../profiles/bindings.js'
import type { Profile } from '../profiles/types.js'
import type { LlmProvider, ReflectInput, ReflectResult } from '../pipeline/types.js'
import type { Assembled } from './assemble.js'
import type { LlmReply, PreparedLlmProvider } from '../providers/openai-compatible.js'

/**
 * 真模型装配与外环编排。
 *
 * 不新增 profile 文件、不改 bindings、不改场景插件：沿用 `l0Profile()` 的
 * 「运行时生成一份装配」模式，只覆盖 `llm` 一个 seam。默认 A/B 两份 profile
 * 完全不挂真模型 —— 云 API / 本地网关都只在**显式装配**时才生效（双通道平级）。
 */

export function cloudProfile(provider: LlmProvider): Profile {
  return {
    name: 'profile-cloud',
    providers: bindings({ 'llm': () => provider }),
  }
}

export function localGatewayProfile(provider: LlmProvider): Profile {
  return {
    name: 'profile-local-gateway',
    providers: bindings({ 'llm': () => provider }),
  }
}

export interface ModelReflectResult extends ReflectResult {
  /** 真模型调用的可观测元数据；离线装配下也保留字段形状。 */
  model_reply: {
    model: string
    latencyMs: number
    retries: number
    usage: LlmReply['usage']
    reasoningChars: number
  } | null
}

/**
 * 异步外环 + 同步内核：
 *   1. `prepare()` 真发一次网络，把结果放进 provider 的同步槽；
 *   2. `service.reflect()` 仍是原来的同步调用，内部 `complete()` 从槽里取到真结果；
 *   3. 场景插件源码一行未改，`ReflectResult.synthesis` 因此是真模型输出。
 *
 * 失败时不抛穿应用：返回带 `model_reply: null` 的 ReflectResult，
 * 内核走 provider 的确定性降级串，错误留在 `provider.stats.lastError` 可观测。
 */
export async function reflectWithModel(
  app: Assembled,
  provider: PreparedLlmProvider,
  input: ReflectInput,
): Promise<ModelReflectResult> {
  if (!app.service) throw new Error('场景插件未就绪')
  let reply: LlmReply | null = null
  try {
    reply = await provider.prepare(input.question)
  } catch {
    // 真调用失败 → 不抛穿内核；错误已记入 provider.stats。
  }
  const result = app.service.reflect(input)
  return {
    ...result,
    model_reply: reply ? {
      model: reply.model,
      latencyMs: reply.latencyMs,
      retries: reply.retries,
      usage: reply.usage,
      reasoningChars: reply.reasoningChars,
    } : null,
  }
}
