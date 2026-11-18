import { inMemoryStorage } from '../providers/storage.js';
import { hashEmbedder } from '../providers/embedder.js';
import { apiLlm } from '../providers/llm.js';
import { cosineRetriever } from '../providers/retriever.js';
import { bm25Retriever, graphRetriever, temporalRetriever } from '../providers/retrievers.js';
import { boundedQueue } from '../providers/queue.js';
import { simpleRrf } from '../providers/fusion.js';
import { simplePolicy } from '../providers/policy.js';
import { evidenceCountConsolidator } from '../providers/consolidator.js';
import { confidenceConflict } from '../providers/conflict.js';
import { freshnessExpiry } from '../providers/expiry.js';
import { adjacencyGraph, invertedFulltext } from '../providers/graph.js';
import { lexicalRanker, pairwiseReranker } from '../providers/ranker.js';
import { inMemorySync } from '../providers/sync.js';
import { inlineSource, restAgentAdapter, jsonUi, jsonTransport, textOcr } from '../providers/access.js';
import { piiDefense } from '../providers/defense.js';
import { alwaysOnScheduler } from '../providers/scheduler.js';
import { memoryVector, sentenceExtractor, dedupeIngest, neutralModelRouter, boundedWorker, inMemoryAudit, defaultBankPolicy, } from '../providers/system.js';
/** 全部 L2 seam 的默认装配。A/B 只覆盖差异项，id 与 seam 集合严格一致。 */
const DEFAULTS = {
    'llm': () => apiLlm(),
    'embedder': () => hashEmbedder({ dim: 16, quantizationVersion: 'q1' }),
    'reranker': () => pairwiseReranker(),
    'ocr': () => textOcr(),
    'storage': () => inMemoryStorage(),
    'vector': () => memoryVector(),
    'graph': () => adjacencyGraph(),
    'fulltext': () => invertedFulltext(),
    'extractor': () => sentenceExtractor(),
    'consolidator': () => evidenceCountConsolidator(),
    'retriever.semantic': () => cosineRetriever(),
    'retriever.bm25': () => bm25Retriever(),
    'retriever.graph': () => graphRetriever(),
    'retriever.temporal': () => temporalRetriever(),
    'fusion': () => simpleRrf(),
    'ranker': () => lexicalRanker(),
    'ingest': () => dedupeIngest(),
    'sync': () => inMemorySync(),
    'source': () => inlineSource(),
    'agent-adapter': () => restAgentAdapter(),
    'ui': () => jsonUi(),
    'transport': () => jsonTransport(),
    'model-router': () => neutralModelRouter(),
    'queue': () => boundedQueue({ maxSize: 64, concurrency: 1 }),
    'worker': () => boundedWorker(),
    'isolation-policy': () => simplePolicy(),
    'conflict': () => confidenceConflict(),
    'expiry': () => freshnessExpiry(),
    'bank-policy': () => defaultBankPolicy(),
    'defense': () => piiDefense(),
    'audit': () => inMemoryAudit(),
    'scheduler': () => alwaysOnScheduler(),
};
export function bindings(overrides = {}) {
    return Object.keys(DEFAULTS).map((seam) => ({
        id: `provider.${seam}`,
        seam,
        factory: overrides[seam] ?? DEFAULTS[seam],
    }));
}
