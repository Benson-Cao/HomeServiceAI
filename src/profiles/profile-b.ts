import { bindings } from './bindings.js'
import type { Profile } from './types.js'
import { fileJsonStorage } from '../providers/storage.js'
import { localLlm } from '../providers/llm.js'
import { overlapRetriever, intervalRetriever } from '../providers/retrievers.js'
import { keywordRetriever } from '../providers/retriever.js'
import { literalFulltext } from '../providers/graph.js'
import { weightedRrf } from '../providers/fusion.js'
import { provenanceRanker, identityReranker } from '../providers/ranker.js'
import { confidenceRevisionConsolidator } from '../providers/consolidator.js'
import { proofCountConflict } from '../providers/conflict.js'
import { conservativeExpiry } from '../providers/expiry.js'
import { resumableSync } from '../providers/sync.js'
import { fileSource, mcpAgentAdapter, textUi } from '../providers/access.js'
import { detectOnlyDefense } from '../providers/defense.js'
import { nightBatchScheduler } from '../providers/scheduler.js'
import { attributePolicy } from '../providers/policy.js'

/** 装配清单 B：与 A 的 id / seam 集合完全一致，只换 factory 实现。场景插件一行不改。 */
export const profileB: Profile = {
  name: 'profile-b',
  providers: bindings({
    'storage': () => fileJsonStorage(),
    'llm': () => localLlm(),
    'retriever.semantic': () => keywordRetriever(),
    'retriever.temporal': () => intervalRetriever(),
    'fulltext': () => literalFulltext(),
    'fusion': () => weightedRrf(),
    'ranker': () => provenanceRanker(),
    'reranker': () => identityReranker(),
    'consolidator': () => confidenceRevisionConsolidator(),
    'conflict': () => proofCountConflict(),
    'expiry': () => conservativeExpiry(),
    'sync': () => resumableSync(),
    'source': () => fileSource(),
    'agent-adapter': () => mcpAgentAdapter(),
    'ui': () => textUi(),
    'defense': () => detectOnlyDefense(),
    'scheduler': () => nightBatchScheduler(),
    'isolation-policy': () => attributePolicy({ roles: { child: 'viewer', parent: 'parent' } }),
  }),
}
