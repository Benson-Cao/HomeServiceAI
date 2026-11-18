/** L1 稳定词汇表。比接口更先冻结；新增枚举值 = MINOR 版本变更。 */

export type Principal = string & { readonly __brand?: 'Principal' }
export type BankId = string & { readonly __brand?: 'BankId' }
export type Operation = 'retain' | 'recall' | 'reflect'

/** 四级隔离：principal → bank → scene/tag → record */
export type IsolationLevel = 'principal' | 'bank' | 'scene' | 'record'

/** 事实生效区间，与记录时间正交 */
export type Freshness = 'new' | 'strengthening' | 'stable' | 'weakening' | 'stale'

export type ConflictStrategy = 'confidence-revision' | 'evidence-count' | 'manual-review'

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead-letter'

export type RecallChannel = 'semantic' | 'bm25' | 'graph' | 'temporal'

export type SyncDirection = 'ingest' | 'downstream' | 'bidirectional'

/** L2 seam 名称。与 seams/seam-registry.json 保持一致。 */
export type SeamId =
  | 'llm' | 'embedder' | 'reranker' | 'ocr'
  | 'storage' | 'vector' | 'graph' | 'fulltext'
  | 'extractor' | 'consolidator'
  | 'retriever.semantic' | 'retriever.bm25' | 'retriever.graph' | 'retriever.temporal'
  | 'fusion' | 'ranker'
  | 'ingest' | 'sync' | 'source' | 'agent-adapter' | 'ui' | 'transport'
  | 'model-router' | 'queue' | 'worker'
  | 'isolation-policy' | 'conflict' | 'expiry' | 'bank-policy' | 'defense' | 'audit' | 'scheduler'

/** 内核 PR 禁止出现的分类，见 ci/forbidden-terms.json */
export type ForbiddenCategory =
  | 'scene' | 'model-provider-brand' | 'deployment-channel'
  | 'retrieval-strategy' | 'scene-auth-branch'
