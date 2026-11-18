import type { RecallChannel, Freshness } from '../../seams/vocabulary.js';
export interface Evidence {
    quotes: string[];
    proof_count: number;
    confidence: number;
    freshness: Freshness;
    valid_time: {
        valid_from: string | null;
        valid_to: string | null;
    };
}
/** 每条记忆必带的 7 个溯源字段。 */
export interface Provenance {
    producer_plugin_id: string;
    pipeline_run_id: string;
    contract_version: string;
    model_id: string;
    embedding_dim: number;
    quantization_version: string;
    evidence: Evidence;
}
export interface MemoryRecord {
    event_id: string;
    principal: string;
    bank_id: string;
    occurred_at: string;
    recorded_at: string;
    valid_from: string | null;
    valid_to: string | null;
    content: string;
    scene: string | null;
    raw_pointer: string | null;
    dedupe_fingerprint: string;
    state: 'pending' | 'visible' | 'archived';
    accepted_at: string;
    visible_at: string | null;
    provenance: Provenance | null;
    vector: number[] | null;
    archive_reason: string | null;
    /** 心智模型预计算结果（V0.7 异步 precompute Job 产出）。 */
    mental_model?: string | null;
    /** 事实抽取结果（extractor seam 产出）。 */
    facts?: string[] | null;
}
export interface ScoredHit {
    fact_id: string;
    score: number;
    channel: RecallChannel;
}
export interface JobRecord {
    job_id: string;
    event_id: string;
    kind: 'extract' | 'consolidate' | 'precompute' | 'sync';
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead-letter';
    attempts: number;
    accepted_at: string;
    visible_at: string | null;
    contract_version: string;
}
export interface RetainInput {
    principal: string;
    bank_id: string;
    content: string;
    occurred_at?: string;
    scene?: string | null;
    raw_pointer?: string | null;
    valid_from?: string | null;
    valid_to?: string | null;
}
export interface RetainResult {
    accepted: boolean;
    job_id: string;
    event_id: string;
    reason?: string;
    provenance: Provenance | null;
}
export interface RecallInput {
    principal: string;
    bank_id: string;
    query: string;
    token_budget: number;
    valid_at?: string | null;
}
export interface RecallItem {
    fact_id: string;
    narrative: string;
    time: {
        occurred_at: string;
        recorded_at: string;
        valid_from: string | null;
        valid_to: string | null;
    };
    provenance: Provenance;
}
export interface RecallResult {
    items: RecallItem[];
    channel_hits: Partial<Record<RecallChannel, number>>;
    reranked: boolean;
    token_used: number;
    quarantined: string[];
    contract_version: string;
}
export interface StorageProvider {
    readonly kind: string;
    put(record: MemoryRecord): void;
    get(id: string): MemoryRecord | undefined;
    all(): MemoryRecord[];
    markVisible(id: string, at: string): void;
    archive(id: string, reason: string): void;
    snapshot(): string;
}
export interface EmbedderProvider {
    readonly dim: number;
    readonly quantizationVersion: string;
    readonly modelId: string;
    embed(text: string): number[];
}
export interface GraphStoreProvider {
    readonly kind: string;
    upsertNode(id: string, label: string): void;
    upsertEdge(from: string, to: string, weight?: number): void;
    neighbors(id: string): string[];
    size(): number;
}
export interface FulltextProvider {
    readonly kind: string;
    index(id: string, text: string): void;
    search(terms: string[]): Array<{
        id: string;
        score: number;
    }>;
    size(): number;
}
export interface RetrieverInput {
    text: string;
    vector: number[];
    records: MemoryRecord[];
    k: number;
    validAt?: string | null;
    graph?: GraphStoreProvider;
    fulltext?: FulltextProvider;
}
export interface RetrieverProvider {
    readonly channel: RecallChannel;
    readonly kind: string;
    search(input: RetrieverInput): ScoredHit[];
}
export interface LlmProvider {
    readonly channel: 'api' | 'local';
    readonly modelId: string;
    complete(prompt: string): string;
}
export interface QueueProvider {
    readonly maxSize: number;
    readonly concurrency: number;
    readonly backpressureCount: number;
    enqueue(job: JobRecord): {
        accepted: boolean;
        reason?: string;
    };
    dequeue(): JobRecord | undefined;
    size(): number;
}
/** 声明式融合计划：通道权重由装配层显式给出，不靠插件加载顺序隐式决定。 */
export interface FusionPlan {
    weights?: Partial<Record<RecallChannel, number>>;
    constant?: number;
}
export interface FusionProvider {
    readonly kind: string;
    fuse(lists: ScoredHit[][], k: number, plan?: FusionPlan): ScoredHit[];
}
export interface RankerProvider {
    readonly kind: string;
    rank(input: {
        query: string;
        candidates: ScoredHit[];
        records: MemoryRecord[];
        k: number;
    }): ScoredHit[];
}
export interface RerankerProvider {
    readonly kind: string;
    rerank(input: {
        query: string;
        candidates: ScoredHit[];
        records: MemoryRecord[];
        k: number;
    }): ScoredHit[];
}
export interface OcrProvider {
    readonly kind: string;
    read(pointer: string): string;
}
export interface SyncCursorState {
    source_id: string;
    watermark: string;
    fingerprint: string;
    last_synced_at: string;
    direction: 'ingest' | 'downstream' | 'bidirectional';
}
export interface SyncProvider {
    readonly kind: string;
    cursor(sourceId: string): SyncCursorState | null;
    ingest(input: {
        sourceId: string;
        watermark: string;
        items: Array<{
            fingerprint: string;
            content: string;
        }>;
    }): {
        accepted: number;
        duplicate: number;
        cursor: SyncCursorState;
    };
    downstream(input: {
        sourceId: string;
        since?: string;
    }): {
        items: Array<{
            fingerprint: string;
            content: string;
        }>;
        cursor: SyncCursorState | null;
    };
    lagMs(): number | null;
    buffered(): number;
}
export interface SourceProvider {
    readonly kind: string;
    collect(paths: string[]): Array<{
        pointer: string;
        content: string;
    }>;
}
export interface AgentAdapterProvider {
    readonly kind: string;
    handle(request: {
        operation: string;
        payload: unknown;
    }): {
        status: number;
        body: unknown;
    };
}
export interface UiProvider {
    readonly kind: string;
    render(view: string, data: unknown): string;
}
export interface TransportProvider {
    readonly kind: string;
    encode(payload: unknown): string;
    decode(raw: string): unknown;
}
export interface DefenseProvider {
    readonly kind: string;
    scan(text: string): {
        flagged: boolean;
        kinds: string[];
        redacted: string;
    };
}
export interface SchedulerProvider {
    readonly kind: string;
    inBatchWindow(now: string): boolean;
    nextWindow(now: string): string;
}
export interface ReflectInput {
    principal: string;
    bank_id: string;
    question: string;
    valid_at?: string | null;
}
export interface ReflectResult {
    synthesis: string;
    sources: string[];
    confidence: number;
    contract_version: string;
}
export interface VectorProvider {
    readonly kind: string;
    upsert(id: string, v: number[]): void;
    size(): number;
}
export interface ExtractorProvider {
    readonly kind: string;
    extract(text: string): string[];
}
export interface IngestProvider {
    readonly kind: string;
    accept(fingerprint: string): boolean;
}
export interface ModelRouterProvider {
    readonly kind: string;
    route(operation: string): string;
}
export interface WorkerProvider {
    readonly kind: string;
    run(job: JobRecord): JobRecord;
    processed(): number;
}
export interface AuditProvider {
    readonly kind: string;
    record(event: string, payload: unknown): void;
    entries(): Array<{
        event: string;
        payload: unknown;
    }>;
}
export interface BankPolicyProvider {
    readonly kind: string;
    retentionDays(bank: string): number | null;
    shareScope(bank: string): string;
}
export interface AccessAttributes {
    role?: string;
    sensitivity?: 'public' | 'family' | 'private';
    deviceTrusted?: boolean;
    windowStart?: string;
    windowEnd?: string;
}
export interface PolicyProvider {
    evaluate(input: {
        principal: string;
        bank: string;
        operation: string;
    }): boolean;
}
export type ConsolidationAction = 'new' | 'strengthened' | 'revised' | 'conflict';
export interface ConsolidationResult {
    action: ConsolidationAction;
    /** 被加强或保留的记录 id（strengthened 时不新建记录）。 */
    primaryId: string;
    /** 因矛盾被修正、进入归档待审的记录 id —— 不物理删除。 */
    revisedIds: string[];
    proofCount: number;
    confidence: number;
}
export interface ConsolidatorProvider {
    readonly kind: string;
    integrate(input: {
        record: MemoryRecord;
        existing: MemoryRecord[];
    }): ConsolidationResult;
}
export interface ConflictProvider {
    readonly kind: string;
    /** 同主题键但断言不同 → 视为矛盾；由 profile 装配决定判定策略。 */
    detect(input: {
        incoming: MemoryRecord;
        existing: MemoryRecord;
    }): boolean;
    revise(input: {
        keeper: MemoryRecord;
        loser: MemoryRecord;
    }): {
        winner: 'incoming' | 'existing';
        keeperConfidence: number;
        loserConfidence: number;
        reason: string;
    };
}
export interface ExpiryProvider {
    readonly kind: string;
    evaluate(input: {
        record: MemoryRecord;
        now: string;
    }): {
        freshness: Freshness;
        action: 'keep' | 'archive';
        reason: string;
    };
}
export interface MemoryServiceStats {
    quarantined: string[];
    archived: string[];
    lastVisibleLatencyMs: number | null;
    jobsSucceeded: number;
    jobsDeadLetter: number;
    /** 有界背压计数（可观测，V0.5 只验有界 + 计数，不验全量重试策略）。 */
    backpressureCount: number;
    deferredJobs: number;
    /** 同步 lag：V0.5 edge-buffer 留桩，字段存在但恒为 null（可观测、不验收）。 */
    syncLagMs: number | null;
    /** 治理计数：证据加强 / 矛盾检出 / 修正归档 / stale 归档 / valid time 过期（均可观测）。 */
    strengthened: number;
    conflictsDetected: number;
    revised: number;
    staleArchived: number;
    validTimeExpired: number;
    /** 同步与预计算可观测。 */
    syncAccepted: number;
    syncDuplicates: number;
    precomputed: number;
    /** 声明式融合的四路命中数。 */
    channelHits: Partial<Record<RecallChannel, number>>;
    /** 治理与批处理可观测。 */
    defenseFlagged: number;
    extractedFacts: number;
    batchWindow: boolean | null;
}
export interface MemoryService {
    readonly contractVersion: string;
    readonly stats: MemoryServiceStats;
    retain(input: RetainInput): RetainResult;
    recall(input: RecallInput): RecallResult;
    /** 显式驱动 worker，供确定性验收；运行时也会在 setImmediate 自动驱动。 */
    drain(): number;
    /** 把某条记忆标记为归档待审（不物理删除）。 */
    archive(id: string, reason: string): void;
    /** Reflect：跨记忆生成综合结论，带来源与置信度。 */
    reflect(input: ReflectInput): ReflectResult;
    /** 多源同步入口：端侧只缓冲不裁决，回服务端按既有治理裁决。 */
    sync(input: {
        sourceId: string;
        watermark: string;
        items: Array<{
            fingerprint: string;
            content: string;
        }>;
    }): {
        accepted: number;
        duplicate: number;
    };
    /** 心智模型预计算：显式驱动，供确定性验收。 */
    precompute(): number;
}
