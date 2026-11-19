import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { profileA } from '../build/src/profiles/profile-a.js'
import { profileB } from '../build/src/profiles/profile-b.js'
import { assemble } from '../build/src/runtime/assemble.js'

async function settled() {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

test('Ⓐ 静态证明：场景插件源码不含任何 provider 名 / 场景名 / 品牌名', () => {
  const src = readFileSync(new URL('../src/scenes/memory-scene.ts', import.meta.url), 'utf8')
  const forbidden = [
    'inMemoryStorage', 'fileJsonStorage', 'apiLlm', 'localLlm',
    'cosineRetriever', 'keywordRetriever', 'hashEmbedder', 'boundedQueue',
    'simpleRrf', 'weightedRrf', 'simplePolicy', 'attributePolicy', 'Hindsight', 'pgvector', 'Ollama', 'OpenAI',
    'evidenceCountConsolidator', 'confidenceRevisionConsolidator',
    'confidenceConflict', 'proofCountConflict', 'freshnessExpiry', 'conservativeExpiry',
    'adjacencyGraph', 'invertedFulltext', 'literalFulltext',
    'semanticRetriever', 'overlapRetriever', 'bm25Retriever', 'graphRetriever',
    'temporalRetriever', 'intervalRetriever', 'lexicalRanker', 'provenanceRanker',
    'pairwiseReranker', 'identityReranker', 'inMemorySync', 'resumableSync',
    'fileSource', 'inlineSource', 'restAgentAdapter', 'mcpAgentAdapter',
    'jsonUi', 'textUi', 'jsonTransport', 'textOcr', 'piiDefense', 'detectOnlyDefense',
    'nightBatchScheduler', 'alwaysOnScheduler', 'memoryVector', 'sentenceExtractor',
    'dedupeIngest', 'neutralModelRouter', 'boundedWorker', 'inMemoryAudit', 'defaultBankPolicy',
    'health', 'kid', 'work.profile', 'home.profile',
    'deepseekLlm', 'localGatewayLlm', 'openAiCompatibleLlm', 'DeepSeek',
    'DEEPSEEK_ENDPOINT', 'deepseek-flash', 'cloudProfile', 'localGatewayProfile',
    'reflectWithModel', 'Ollama', 'vLLM', 'LM Studio',
    'createDaemon', 'daemonProfile', 'createWorkerLoop', 'profile-daemon',
    'node:http', 'smoke-daemon', 'MH_HTTP_TOKEN',
    'createIdentityGate', 'directoryPolicy', 'issueToken', 'verifyToken',
    'pgAudit', 'memory_audit_log', 'MH_IDENTITY_SECRET', 'members.example',
    'token:issue', 'audit:recent',
  ]
  const hit = forbidden.filter((w) => src.includes(w))
  assert.deepEqual(hit, [], `场景插件不应知道具体实现：${hit.join(', ')}`)
  assert.ok(src.includes("ctx.use<StorageProvider>('storage')"), '只认 seam id')
})

test('Ⓑ 两份 profile 的 seam 集合完全一致，仅 factory 不同', () => {
  assert.equal(profileA.providers.length, profileB.providers.length)
  const idsA = profileA.providers.map((p) => p.id)
  const idsB = profileB.providers.map((p) => p.id)
  assert.deepEqual(idsA, idsB)
  const seamsA = profileA.providers.map((p) => p.seam).sort()
  const seamsB = profileB.providers.map((p) => p.seam).sort()
  assert.deepEqual(seamsA, seamsB)
  assert.notEqual(profileA.name, profileB.name)
})

test('Ⓒ 换 provider 零改动：同一场景插件在 A / B 上跑出同构结果', async () => {
  const runs = []
  for (const profile of [profileA, profileB]) {
    const app = assemble(profile)
    assert.ok(app.service, '场景插件应就绪')
    const tree = app.kernel.dumpTree()
    assert.ok(tree.find((f) => f.id === 'scene.memory')?.state === 'active', '场景插件应 active')

    const a = app.service.retain({ principal: 'u1', bank_id: 'b1', content: '项目记忆：季度复盘结论' })
    const b = app.service.retain({ principal: 'u1', bank_id: 'b1', content: '项目记忆：接口契约版本' })
    assert.equal(a.accepted, true)
    assert.equal(b.accepted, true)
    await settled()
    app.service.drain()

    const res = app.service.recall({ principal: 'u1', bank_id: 'b1', query: '项目记忆', token_budget: 256 })
    runs.push({ profile: profile.name, res, app, a })
  }

  const [ra, rb] = runs
  assert.deepEqual(Object.keys(ra.res).sort(), Object.keys(rb.res).sort())
  assert.ok(ra.res.items.length > 0 && rb.res.items.length > 0, '两个 provider 组合都能召回')
  assert.equal(ra.res.contract_version, rb.res.contract_version)
  assert.equal(ra.res.reranked, true, 'ranker/reranker 已接入')
  assert.equal(rb.res.reranked, true)
  assert.deepEqual(Object.keys(ra.res.channel_hits).sort(), Object.keys(rb.res.channel_hits).sort())
  assert.equal(typeof ra.res.token_used, 'number')
  assert.equal(typeof rb.res.token_used, 'number')

  const p = ra.a.provenance
  assert.deepEqual(Object.keys(p).sort(), [
    'contract_version', 'embedding_dim', 'evidence', 'model_id',
    'pipeline_run_id', 'producer_plugin_id', 'quantization_version',
  ].sort(), '溯源 7 字段齐全')
  assert.equal(p.contract_version, '1.2.0')
  assert.equal(typeof p.embedding_dim, 'number')

  for (const r of runs) r.app.dispose()
})

test('Ⓓ 装配层只有一份场景插件定义，不随 profile 变化', () => {
  const src = readFileSync(new URL('../src/runtime/assemble.ts', import.meta.url), 'utf8')
  assert.equal((src.match(/createMemoryScene/g) || []).length, 2, 'import + 调用各一次')
  assert.ok(!src.includes('profileA') && !src.includes('profileB'), '装配层不绑定具体 profile')
})
