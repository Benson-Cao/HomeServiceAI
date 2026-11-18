export * from './contract-version.js'
export * from './vocabulary.js'

import type { Principal, BankId, IsolationLevel, Freshness, ConflictStrategy, JobState, RecallChannel, SyncDirection } from './vocabulary.js'

/** 三个时间戳 + 一个有效区间。更正事实不得丢弃旧证据链。 */
export interface TimeModel {
  occurred_at: string          // 事件发生（ISO-8601）
  recorded_at: string          // 入库（ISO-8601）
  valid_from: string | null    // 事实生效起
  valid_to: string | null      // 事实生效止，null = 未定
}

/** 每条记忆必带的 7 个溯源字段。 */
export interface Provenance {
  producer_plugin_id: string
  pipeline_run_id: string
  contract_version: string
  model_id: string
  embedding_dim: number
  quantization_version: string
  evidence: Evidence
}

export interface Evidence {
  quotes: string[]
  proof_count: number
  confidence: number            // [0,1]
  freshness: Freshness
  valid_time: Pick<TimeModel, 'valid_from' | 'valid_to'>
}

export interface IsolationScope {
  principal: Principal
  bank: BankId
  scene: string | null
  tag: string[]
  record: string | null
  level: IsolationLevel
}

export interface MemoryEvent {
  event_id: string
  principal: Principal
  occurred_at: string
  recorded_at: string
  source: string
  scene: string | null
  content: string
  raw_pointer: string | null   // 原件留在 NAS，不入库
  dedupe_fingerprint: string   // 幂等由词汇/运行时层保证，非内核原语
  sync_cursor: SyncCursor | null
  contract_version: string
}

export interface SyncCursor {
  source_id: string
  watermark: string
  fingerprint: string
  last_synced_at: string
  direction: SyncDirection
}

export interface Job {
  job_id: string
  kind: 'extract' | 'consolidate' | 'precompute' | 'sync'
  state: JobState
  attempts: number
  accepted_at: string
  visible_at: string | null    // accepted → visible 延迟可测
  contract_version: string
}

export interface RetainRequest {
  bank_id: BankId
  principal: Principal
  event: MemoryEvent
}
export interface RetainResult {
  accepted: boolean
  job_id: string
  provenance: Provenance
}

export interface RecallQuery {
  bank_id: BankId
  principal: Principal
  query: string
  token_budget: number
  valid_at: string | null
  channels?: RecallChannel[]
}
export interface RecallResult {
  items: Array<{ fact_id: string; narrative: string; time: TimeModel; provenance: Provenance }>
  channel_hits: Partial<Record<RecallChannel, number>>
  reranked: boolean
  token_used: number
  contract_version: string
}

/** V0.5 只定义契约、不实现。 */
export interface ReflectRequest {
  bank_id: BankId
  principal: Principal
  question: string
}
export interface ReflectResult {
  synthesis: string
  sources: string[]
  contract_version: string
}
