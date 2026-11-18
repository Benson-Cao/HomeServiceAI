/**
 * 场景插件（唯一一份，两个 profile 共用）。
 *
 * 硬约束：本文件只认 seam id，**不 import 任何 provider 实现、不出现任何产品名/场景名**。
 * 「换 provider 零改动」由 provider-swap 测试静态校验本文件源码证明。
 *
 * V0.7：32 个 L2 seam 全部接入主链路 —— 四路声明式融合、ranker/reranker、
 * 增量同步、defense、审计、批处理窗口、Reflect 与心智模型预计算。
 */
import { CONTRACT_VERSION } from '../../seams/contract-version.js'
import type { RecallChannel } from '../../seams/vocabulary.js'
import type { PluginDefinition } from '../kernel/types.js'
import { fingerprint, makeProvenance } from '../pipeline/provenance.js'
import type {
  StorageProvider, EmbedderProvider, RetrieverProvider, LlmProvider, QueueProvider, FusionProvider,
  ConsolidatorProvider, ConflictProvider, ExpiryProvider, GraphStoreProvider, FulltextProvider,
  RankerProvider, RerankerProvider, SyncProvider, DefenseProvider, SchedulerProvider,
  ExtractorProvider, IngestProvider, VectorProvider, AuditProvider, BankPolicyProvider, WorkerProvider,
  MemoryService, MemoryServiceStats, MemoryRecord, JobRecord, ScoredHit,
  RetainInput, RetainResult, RecallInput, RecallResult, RecallItem, ReflectInput, ReflectResult,
} from '../pipeline/types.js'

export const MEMORY_SCENE_ID = 'scene.memory'

/** 声明式通道权重：合并语义显式给出，不靠插件加载顺序隐式决定。 */
export const CHANNEL_WEIGHTS: Readonly<Partial<Record<RecallChannel, number>>> = Object.freeze({
  semantic: 1,
  bm25: 0.8,
  graph: 0.6,
  temporal: 0.4,
})

const SEAMS = [
  'storage', 'embedder', 'retriever.semantic', 'retriever.bm25', 'retriever.graph', 'retriever.temporal',
  'llm', 'queue', 'fusion', 'ranker', 'reranker', 'isolation-policy', 'consolidator', 'conflict', 'expiry',
  'graph', 'fulltext', 'vector', 'extractor', 'ingest', 'sync', 'defense', 'scheduler', 'audit',
  'bank-policy', 'worker', 'model-router', 'source', 'agent-adapter', 'ui', 'transport', 'ocr',
] as const

export function createMemoryScene(onReady: (service: MemoryService) => void): PluginDefinition {
  return {
    id: MEMORY_SCENE_ID,
    inject: [...SEAMS],
    apply(ctx) {
      const store = ctx.use<StorageProvider>('storage')
      const emb = ctx.use<EmbedderProvider>('embedder')
      const model = ctx.use<LlmProvider>('llm')
      const q = ctx.use<QueueProvider>('queue')
      const fuse = ctx.use<FusionProvider>('fusion')
      const cons = ctx.use<ConsolidatorProvider>('consolidator')
      const cf = ctx.use<ConflictProvider>('conflict')
      const exp = ctx.use<ExpiryProvider>('expiry')
      if (!store || !emb || !model || !q || !fuse || !cons || !cf || !exp) return
      // strict 模式下让嵌套闭包保留收窄（依赖已由内核保证就绪）
      const storeRef = store, embRef = emb, modelRef = model, qRef = q, fuseRef = fuse
      const consRef = cons, cfRef = cf, expRef = exp

      const retrievers: RetrieverProvider[] = (['retriever.semantic', 'retriever.bm25', 'retriever.graph', 'retriever.temporal'] as const)
        .map((id) => ctx.use<RetrieverProvider>(id))
        .filter((r): r is RetrieverProvider => Boolean(r))
      const ranker = ctx.use<RankerProvider>('ranker')
      const reranker = ctx.use<RerankerProvider>('reranker')
      const graph = ctx.use<GraphStoreProvider>('graph')
      const fulltext = ctx.use<FulltextProvider>('fulltext')
      const vector = ctx.use<VectorProvider>('vector')
      const extractor = ctx.use<ExtractorProvider>('extractor')
      const ingest = ctx.use<IngestProvider>('ingest')
      const sync = ctx.use<SyncProvider>('sync')
      const defense = ctx.use<DefenseProvider>('defense')
      const scheduler = ctx.use<SchedulerProvider>('scheduler')
      const audit = ctx.use<AuditProvider>('audit')
      const worker = ctx.use<WorkerProvider>('worker')
      const bankPolicy = ctx.use<BankPolicyProvider>('bank-policy')

      const owned = new Set<string>()
      const deferred: JobRecord[] = []
      const stats: MemoryServiceStats = {
        quarantined: [], archived: [], lastVisibleLatencyMs: null,
        jobsSucceeded: 0, jobsDeadLetter: 0, backpressureCount: 0, deferredJobs: 0, syncLagMs: null,
        strengthened: 0, conflictsDetected: 0, revised: 0, staleArchived: 0, validTimeExpired: 0,
        syncAccepted: 0, syncDuplicates: 0, precomputed: 0, channelHits: {},
        defenseFlagged: 0, extractedFacts: 0, batchWindow: null,
      }
      let counter = 0
      let running = false

      const emptyResult = (): RecallResult => ({
        items: [], channel_hits: {}, reranked: false, token_used: 0,
        quarantined: [...stats.quarantined], contract_version: CONTRACT_VERSION,
      })

      function precomputeInternal(): number {
        let n = 0
        for (const r of storeRef.all()) {
          if (r.state !== 'visible' || r.mental_model) continue
          const parts = r.facts?.length ? r.facts : [r.content]
          r.mental_model = parts.join('；').slice(0, 240)
          n++
        }
        stats.precomputed += n
        if (n > 0) ctx.emit('memory.precompute.done', { count: n, total: stats.precomputed })
        return n
      }

      function drain(): number {
        if (running) return 0
        running = true
        let done = 0
        try {
          while (deferred.length && qRef.size() < qRef.maxSize) qRef.enqueue(deferred.shift() as JobRecord)
          stats.deferredJobs = deferred.length
          while (qRef.size() > 0) {
            const job = qRef.dequeue() as JobRecord
            job.state = 'running'
            const rec = storeRef.get(job.event_id)
            if (!rec) { job.state = 'failed'; ctx.emit('memory.job.state', { job_id: job.job_id, state: 'failed' }); continue }
            try {
              const v = embRef.embed(rec.content)
              rec.vector = v
              vector?.upsert(rec.event_id, v)
              const visibleAt = new Date().toISOString()
              storeRef.markVisible(rec.event_id, visibleAt)
              job.visible_at = visibleAt
              job.state = 'succeeded'
              worker?.run(job)
              stats.jobsSucceeded++
              stats.lastVisibleLatencyMs = Date.parse(visibleAt) - Date.parse(rec.accepted_at)
              ctx.emit('memory.job.state', { job_id: job.job_id, state: 'succeeded', latencyMs: stats.lastVisibleLatencyMs })
            } catch (err) {
              job.attempts++
              job.state = job.attempts >= 3 ? 'dead-letter' : 'failed'
              if (job.state === 'dead-letter') stats.jobsDeadLetter++
              ctx.emit('memory.job.state', { job_id: job.job_id, state: job.state, error: String(err) })
            }
            done++
          }
          // 重活只在批处理窗口自动触发；retain 抽取永远立即执行（ADR-001 有界队列）
          const inWindow = scheduler ? scheduler.inBatchWindow(new Date().toISOString()) : true
          stats.batchWindow = inWindow
          if (inWindow) precomputeInternal()
          else ctx.emit('memory.batch.deferred', { reason: 'outside-batch-window' })
        } finally {
          running = false
        }
        return done
      }

      const service: MemoryService = {
        contractVersion: CONTRACT_VERSION,
        stats,
        drain,

        retain(input: RetainInput): RetainResult {
          if (!ctx.authorize(input.principal, input.bank_id, 'retain')) {
            ctx.emit('memory.retain.rejected', { principal: input.principal, bank_id: input.bank_id })
            audit?.record('retain.rejected', { principal: input.principal, bank_id: input.bank_id })
            return { accepted: false, job_id: '', event_id: '', reason: 'denied', provenance: null }
          }
          const now = new Date().toISOString()
          const scan = defense?.scan(input.content) ?? { flagged: false, kinds: [], redacted: input.content }
          if (scan.flagged) {
            stats.defenseFlagged++
            ctx.emit('memory.defense.flagged', { kinds: scan.kinds })
          }
          const content = scan.redacted
          const facts = extractor?.extract(content) ?? null
          if (facts?.length) stats.extractedFacts += facts.length

          const eventId = `ev_${fingerprint(`${content}|${now}|${counter++}`).slice(0, 16)}`
          const jobId = `job_${fingerprint(eventId).slice(0, 12)}`
          const runId = `run_${fingerprint(`${eventId}:${jobId}`).slice(0, 12)}`
          const provenance = makeProvenance({
            pluginId: ctx.pluginId, runId, modelId: modelRef.modelId,
            embeddingDim: embRef.dim, quantizationVersion: embRef.quantizationVersion,
            quotes: [content.slice(0, 80)],
            validFrom: input.valid_from ?? null, validTo: input.valid_to ?? null,
          })
          const record: MemoryRecord = {
            event_id: eventId, principal: input.principal, bank_id: input.bank_id,
            occurred_at: input.occurred_at ?? now, recorded_at: now,
            valid_from: input.valid_from ?? null, valid_to: input.valid_to ?? null,
            content, scene: input.scene ?? null, raw_pointer: input.raw_pointer ?? null,
            dedupe_fingerprint: fingerprint(content), state: 'pending',
            accepted_at: now, visible_at: null, provenance, vector: null,
            archive_reason: null, mental_model: null, facts,
          }

          const decision = consRef.integrate({ record, existing: storeRef.all() })
          if (decision.action === 'strengthened') {
            const primary = storeRef.get(decision.primaryId)
            if (primary?.provenance) {
              const e = primary.provenance.evidence
              const quote = content.slice(0, 80)
              if (!e.quotes.includes(quote)) e.quotes.push(quote)
              e.proof_count = decision.proofCount
              e.confidence = decision.confidence
              e.freshness = 'new'
              stats.strengthened++
              ctx.emit('memory.consolidation.strengthened', { event_id: primary.event_id, proof_count: e.proof_count })
              ctx.emit('memory.retain.accepted', { event_id: primary.event_id, job_id: '', strengthened: true })
              audit?.record('retain.strengthened', { event_id: primary.event_id })
              return { accepted: true, job_id: '', event_id: primary.event_id, provenance: primary.provenance }
            }
          }

          let incomingWon = true
          const reasons: string[] = []
          if (decision.action === 'conflict') {
            stats.conflictsDetected++
            for (const id of decision.revisedIds) {
              const loser = storeRef.get(id)
              if (!loser) continue
              const verdict = cfRef.revise({ keeper: record, loser })
              reasons.push(verdict.reason)
              if (verdict.winner !== 'incoming') incomingWon = false
              stats.revised++
            }
            const reason = reasons[0] ?? 'conflict:revised'
            if (incomingWon) {
              for (const id of decision.revisedIds) {
                storeRef.archive(id, reason)
                if (!stats.archived.includes(id)) stats.archived.push(id)
                ctx.emit('memory.conflict.revised', { winner: 'incoming', revised_id: id, reason })
              }
            } else {
              record.state = 'archived'
              record.archive_reason = reason
              ctx.emit('memory.conflict.revised', { winner: 'existing', revised_id: record.event_id, reason })
            }
          }

          storeRef.put(record)
          owned.add(eventId)
          fulltext?.index(eventId, content)
          graph?.upsertNode(eventId, content.slice(0, 60))
          for (const peer of storeRef.all()) {
            if (peer.event_id !== eventId && peer.state !== 'archived' && peer.bank_id === record.bank_id && peer.principal === record.principal) {
              graph?.upsertEdge(peer.event_id, eventId)
            }
          }
          audit?.record('retain.accepted', { event_id: eventId, bank_id: input.bank_id, retention: bankPolicy?.retentionDays(input.bank_id) ?? null })

          if (!incomingWon) {
            ctx.emit('memory.retain.accepted', { event_id: eventId, job_id: '', revised: true })
            return { accepted: true, job_id: '', event_id: eventId, provenance }
          }

          const job: JobRecord = {
            job_id: jobId, event_id: eventId, kind: 'extract', state: 'queued',
            attempts: 0, accepted_at: now, visible_at: null, contract_version: CONTRACT_VERSION,
          }
          const enq = qRef.enqueue(job)
          if (!enq.accepted) {
            deferred.push(job)
            stats.backpressureCount = qRef.backpressureCount
            stats.deferredJobs = deferred.length
          }
          ctx.emit('memory.retain.accepted', { event_id: eventId, job_id: jobId, backpressure: !enq.accepted })
          setImmediate(() => { drain() })
          return { accepted: true, job_id: jobId, event_id: eventId, provenance }
        },

        recall(input: RecallInput): RecallResult {
          if (!ctx.authorize(input.principal, input.bank_id, 'recall')) return emptyResult()
          const validAt = input.valid_at ?? new Date().toISOString()
          const candidates = storeRef.all().filter((r) => r.state === 'visible' && r.bank_id === input.bank_id)

          const compatible: MemoryRecord[] = []
          for (const r of candidates) {
            const verdict = expRef.evaluate({ record: r, now: validAt })
            if (verdict.action === 'archive') {
              storeRef.archive(r.event_id, verdict.reason)
              if (verdict.reason.startsWith('valid-time')) stats.validTimeExpired++
              else stats.staleArchived++
              if (!stats.archived.includes(r.event_id)) stats.archived.push(r.event_id)
              ctx.emit('memory.expiry.archived', { event_id: r.event_id, reason: verdict.reason, freshness: verdict.freshness })
              continue
            }
            const p = r.provenance
            if (p && (p.embedding_dim !== embRef.dim || p.quantization_version !== embRef.quantizationVersion)) {
              if (!stats.quarantined.includes(r.event_id)) stats.quarantined.push(r.event_id)
              ctx.emit('memory.vector.quarantined', {
                event_id: r.event_id,
                expected: { dim: embRef.dim, quantization: embRef.quantizationVersion },
                got: { dim: p.embedding_dim, quantization: p.quantization_version },
              })
              continue
            }
            compatible.push(r)
          }

          const queryVector = embRef.embed(input.query)
          const base = { text: input.query, vector: queryVector, records: compatible, k: 10, validAt, graph, fulltext }
          const lists: ScoredHit[][] = []
          const hits: Partial<Record<RecallChannel, number>> = {}
          for (const r of retrievers) {
            const out = r.search(base)
            lists.push(out)
            hits[r.channel] = (hits[r.channel] ?? 0) + out.length
          }
          stats.channelHits = { ...hits }

          let fused = fuseRef.fuse(lists, 10, { weights: CHANNEL_WEIGHTS })
          if (ranker) fused = ranker.rank({ query: input.query, candidates: fused, records: compatible, k: 10 })
          if (reranker) fused = reranker.rerank({ query: input.query, candidates: fused, records: compatible, k: 10 })

          const items: RecallItem[] = []
          let tokenUsed = 0
          for (const h of fused) {
            const r = storeRef.get(h.fact_id)
            if (!r || !r.provenance) continue
            const cost = Math.ceil(r.content.length / 4)
            if (tokenUsed + cost > input.token_budget) break
            tokenUsed += cost
            items.push({
              fact_id: r.event_id, narrative: r.content,
              time: { occurred_at: r.occurred_at, recorded_at: r.recorded_at, valid_from: r.valid_from, valid_to: r.valid_to },
              provenance: r.provenance,
            })
          }
          const result: RecallResult = {
            items, channel_hits: hits, reranked: Boolean(ranker || reranker), token_used: tokenUsed,
            quarantined: [...stats.quarantined], contract_version: CONTRACT_VERSION,
          }
          ctx.emit('memory.recall.result', { count: items.length, quarantined: stats.quarantined.length, channels: hits })
          audit?.record('recall', { bank_id: input.bank_id, count: items.length })
          return result
        },

        reflect(input: ReflectInput): ReflectResult {
          const hits = service.recall({
            principal: input.principal, bank_id: input.bank_id,
            query: input.question, token_budget: 1024, valid_at: input.valid_at ?? null,
          })
          const sources = hits.items.map((i) => i.fact_id)
          const confidence = sources.length
            ? hits.items.reduce((n, i) => n + i.provenance.evidence.confidence, 0) / sources.length : 0
          const synthesis = sources.length ? modelRef.complete(`${input.question}｜${hits.items.map((i) => i.narrative).join('；')}`) : ''
          ctx.emit('memory.reflect.result', { count: sources.length, confidence })
          audit?.record('reflect', { bank_id: input.bank_id, count: sources.length })
          return { synthesis, sources, confidence, contract_version: CONTRACT_VERSION }
        },

        sync(input): { accepted: number; duplicate: number } {
          const result = sync
            ? sync.ingest({ sourceId: input.sourceId, watermark: input.watermark, items: input.items })
            : { accepted: input.items.length, duplicate: 0, cursor: null }
          for (const item of input.items) {
            if (!ingest?.accept(item.fingerprint)) continue
            service.retain({
              principal: 'sync', bank_id: 'default', content: item.content,
              occurred_at: new Date().toISOString(),
            })
          }
          stats.syncAccepted += result.accepted
          stats.syncDuplicates += result.duplicate
          stats.syncLagMs = sync?.lagMs() ?? null
          ctx.emit('memory.sync.cursor', { source_id: input.sourceId, watermark: input.watermark })
          ctx.emit('memory.sync.accepted', { accepted: result.accepted, duplicate: result.duplicate })
          audit?.record('sync', { source_id: input.sourceId, ...result })
          return { accepted: result.accepted, duplicate: result.duplicate }
        },

        precompute(): number {
          return precomputeInternal()
        },

        archive(id: string, reason: string): void {
          storeRef.archive(id, reason)
          if (!stats.archived.includes(id)) stats.archived.push(id)
        },
      }

      onReady(service)

      // 卸载语义：本插件写入的记忆进入「归档待审」，不物理删除。
      ctx.onDispose(() => {
        for (const id of owned) {
          storeRef.archive(id, 'plugin-disposed:pending-review')
          if (!stats.archived.includes(id)) stats.archived.push(id)
        }
      })
    },
  }
}
