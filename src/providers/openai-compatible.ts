import type { LlmProvider } from '../pipeline/types.js'

/**
 * 真模型 provider（填既有 `llm` seam，不改契约、不改场景插件）。
 *
 * 同步 seam 阻抗：`LlmProvider.complete()` 是同步的，HTTP 是异步的。
 * 这里采用与 L0「hydrate → 同步操作 → flush」同构的桥接：
 *   - 异步外环 `completeAsync()` / `prepare()` 真发网络；
 *   - `prepare()` 把结果放进「下一次 complete 的同步槽」；
 *   - 内核里的 `reflect()` 仍同步调用 `complete()`，从槽里取到真结果。
 * ③ 常驻端点落地时，这个外环编排会固化进 worker；场景插件一行都不用改。
 *
 * 双通道平级：同一份实现，`deepseekLlm()` 指云 API、`localGatewayLlm()` 指本地
 * OpenAI 兼容网关（Ollama / vLLM / LM Studio），由装配决定走向，不设默认通道。
 */

/** 官方 OpenAI 兼容端点。注意：base_url 不加 /v1，路径直接是 /chat/completions。 */
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'

/**
 * 默认模型名取自官方 quick start 的当期写法。
 * 注意：官方不同快照曾出现 `deepseek-v4-flash` 与 `deepseek-flash` 两种写法，
 * `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用。
 * 因此这里只是**默认值**，不锁死：调用方应显式传 model，或以 `/models` 当期返回为准。
 */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash'

export const LOCAL_GATEWAY_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions'

export type ThinkingMode = 'enabled' | 'disabled'

export interface LlmHttpResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText?: string
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
}

export type FetchLike = (url: string, init: {
  method: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}) => Promise<LlmHttpResponse>

export interface LlmUsage {
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
}

export interface LlmReply {
  text: string
  model: string
  reasoningChars: number
  usage: LlmUsage
  latencyMs: number
  retries: number
}

export interface LlmStats {
  requests: number
  succeeded: number
  failed: number
  retried429: number
  timeouts: number
  totalTokens: number
  lastError: string | null
}

export interface OpenAiCompatibleOptions {
  channel: 'api' | 'local'
  endpoint: string
  model: string
  apiKey?: string
  /** null = 不发送 thinking / reasoning_effort（本地网关通常不认这两个字段）。 */
  thinking?: ThinkingMode | null
  reasoningEffort?: 'low' | 'high' | 'max'
  systemPrompt?: string
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** 既有 LlmProvider 契约 + 异步真通道。额外方法只由外环编排消费，内核不感知。 */
export interface PreparedLlmProvider extends LlmProvider {
  completeAsync(prompt: string): Promise<LlmReply>
  /** 真调一次，并把结果放进「下一次 complete()」的同步槽。 */
  prepare(prompt: string): Promise<LlmReply>
  readonly stats: LlmStats
  cacheSize(): number
  hasPendingReply(): boolean
  readonly endpoint: string
}

export class LlmProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmProtocolError'
  }
}

const DEFAULT_SYSTEM = 'You are a memory synthesis assistant. Answer concisely using only the provided context.'
const FALLBACK_PREFIX = '[llm:offline]'

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parseReply(data: unknown): { text: string; reasoningChars: number; usage: LlmUsage } {
  if (!data || typeof data !== 'object') throw new LlmProtocolError('响应不是对象')
  const root = data as Record<string, unknown>
  const choices = root.choices
  if (!Array.isArray(choices) || choices.length === 0) throw new LlmProtocolError('响应缺少 choices')
  const first = choices[0] as Record<string, unknown>
  const message = first?.message
  if (!message || typeof message !== 'object') throw new LlmProtocolError('响应缺少 message')
  const msg = message as Record<string, unknown>
  const text = msg.content
  if (typeof text !== 'string') throw new LlmProtocolError('响应 content 不是字符串')
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : ''
  const u = (root.usage && typeof root.usage === 'object' ? root.usage : {}) as Record<string, unknown>
  return {
    text,
    reasoningChars: reasoning.length,
    usage: {
      prompt_tokens: num(u.prompt_tokens),
      completion_tokens: num(u.completion_tokens),
      total_tokens: num(u.total_tokens),
    },
  }
}

async function defaultFetch(url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal: AbortSignal
}): Promise<LlmHttpResponse> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  })
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: { get: (n) => res.headers.get(n) },
    json: () => res.json(),
    text: () => res.text(),
  }
}

export function openAiCompatibleLlm(options: OpenAiCompatibleOptions): PreparedLlmProvider {
  const {
    channel, endpoint, model, apiKey,
    thinking = 'disabled',
    reasoningEffort = 'high',
    systemPrompt = DEFAULT_SYSTEM,
    timeoutMs = 20_000,
    maxRetries = 2,
    retryDelayMs = 500,
    fetch: injectedFetch = defaultFetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = options

  const stats: LlmStats = {
    requests: 0, succeeded: 0, failed: 0, retried429: 0,
    timeouts: 0, totalTokens: 0, lastError: null,
  }
  const cache = new Map<string, string>()
  let nextReply: string | null = null

  function recordFailure(err: unknown): void {
    stats.failed++
    const name = err instanceof Error ? err.name : 'Error'
    const msg = err instanceof Error ? err.message : String(err)
    if (name === 'AbortError' || /abort/i.test(msg)) stats.timeouts++
    stats.lastError = `${name}: ${msg}`
  }

  async function completeAsync(prompt: string): Promise<LlmReply> {
    const started = now()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      stream: false,
    }
    if (thinking !== null) {
      body.thinking = { type: thinking }
      if (thinking === 'enabled') body.reasoning_effort = reasoningEffort
    }

    let retries = 0
    let lastErr: unknown = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      stats.requests++
      try {
        const res = await injectedFetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })

        if (res.status === 429 && attempt < maxRetries) {
          stats.retried429++
          retries++
          const raw = res.headers.get('Retry-After')
          const seconds = raw === null ? Number.NaN : Number(raw)
          const delay = Number.isFinite(seconds) ? seconds * 1000 : retryDelayMs * (2 ** attempt)
          await sleep(Math.max(0, delay))
          continue
        }
        if (!res.ok) {
          let detail = ''
          try { detail = (await res.text()).slice(0, 200) } catch { /* ignore */ }
          throw new LlmProtocolError(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${detail ? ` · ${detail}` : ''}`)
        }

        const parsed = parseReply(await res.json())
        const reply: LlmReply = {
          text: parsed.text,
          model,
          reasoningChars: parsed.reasoningChars,
          usage: parsed.usage,
          latencyMs: Math.max(0, now() - started),
          retries,
        }
        stats.succeeded++
        stats.totalTokens += parsed.usage.total_tokens ?? 0
        cache.set(prompt, reply.text)
        return reply
      } catch (err) {
        lastErr = err
        recordFailure(err)
        break
      } finally {
        clearTimeout(timer)
      }
    }

    throw lastErr instanceof Error ? lastErr : new LlmProtocolError('LLM 调用失败')
  }

  const provider: PreparedLlmProvider = {
    channel,
    modelId: model,
    endpoint,
    stats,
    /** 同步契约：绝不抛错、绝不发网络。缓存 → 预取槽 → 确定性降级。 */
    complete(prompt: string): string {
      const cached = cache.get(prompt)
      if (cached !== undefined) return cached
      if (nextReply !== null) {
        const text = nextReply
        nextReply = null
        return text
      }
      return `${FALLBACK_PREFIX} ${prompt.length}:fallback`
    },
    async prepare(prompt: string): Promise<LlmReply> {
      const reply = await completeAsync(prompt)
      nextReply = reply.text
      return reply
    },
    completeAsync,
    cacheSize(): number { return cache.size },
    hasPendingReply(): boolean { return nextReply !== null },
  }
  return provider
}

export interface DeepseekOptions {
  apiKey?: string
  model?: string
  endpoint?: string
  thinking?: ThinkingMode | null
  reasoningEffort?: 'low' | 'high' | 'max'
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** API 通道：默认指 DeepSeek 云 API。密钥由调用方注入，provider 自身不读环境变量。 */
export function deepseekLlm(options: DeepseekOptions = {}): PreparedLlmProvider {
  return openAiCompatibleLlm({
    channel: 'api',
    endpoint: options.endpoint || DEEPSEEK_ENDPOINT,
    // 用 || 而非 ??：.env 里留空的 MODEL= 会解析成空串，也必须回落到默认值。
    model: options.model || DEFAULT_DEEPSEEK_MODEL,
    apiKey: options.apiKey,
    // 显式关闭思考模式：默认开启会静默产生 reasoning_content 与额外 token。
    thinking: options.thinking === undefined ? 'disabled' : options.thinking,
    reasoningEffort: options.reasoningEffort,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
    fetch: options.fetch,
    sleep: options.sleep,
    now: options.now,
  })
}

export interface LocalGatewayOptions extends DeepseekOptions {
  /** 本地模型名按你实际部署传，不锁品牌。 */
  model?: string
}

/** 本地通道：与 API 通道同一份实现、平级，由 profile 装配决定走向。 */
export function localGatewayLlm(options: LocalGatewayOptions = {}): PreparedLlmProvider {
  return openAiCompatibleLlm({
    channel: 'local',
    endpoint: options.endpoint || LOCAL_GATEWAY_ENDPOINT,
    model: options.model || 'local-model',
    apiKey: options.apiKey,
    // 本地网关通常不认 thinking / reasoning_effort，默认不发送。
    thinking: options.thinking === undefined ? null : options.thinking,
    reasoningEffort: options.reasoningEffort,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
    fetch: options.fetch,
    sleep: options.sleep,
    now: options.now,
  })
}
