import type { LlmProvider } from '../pipeline/types.js'

/** Provider A：API 通道（V0.5 为确定性桩，不真发网络）。 */
export function apiLlm(): LlmProvider {
  return {
    channel: 'api',
    modelId: 'api-chat-stub',
    complete(prompt: string): string {
      return `[api] ${prompt.length}:ok`
    },
  }
}

/** Provider B：本地大模型通道（V0.5 为确定性桩，与 API 通道平级）。 */
export function localLlm(): LlmProvider {
  return {
    channel: 'local',
    modelId: 'local-chat-stub',
    complete(prompt: string): string {
      return `[local] ${prompt.length}:ok`
    },
  }
}
