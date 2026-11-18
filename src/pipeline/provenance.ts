import { createHash } from 'node:crypto'
import { CONTRACT_VERSION } from '../../seams/contract-version.js'
import type { Provenance, Evidence } from './types.js'

export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

export function makeProvenance(input: {
  pluginId: string
  runId: string
  modelId: string
  embeddingDim: number
  quantizationVersion: string
  quotes: string[]
  confidence?: number
  validFrom?: string | null
  validTo?: string | null
}): Provenance {
  const evidence: Evidence = {
    quotes: input.quotes,
    proof_count: 1,
    confidence: input.confidence ?? 0.5,
    freshness: 'new',
    valid_time: { valid_from: input.validFrom ?? null, valid_to: input.validTo ?? null },
  }
  return {
    producer_plugin_id: input.pluginId,
    pipeline_run_id: input.runId,
    contract_version: CONTRACT_VERSION,
    model_id: input.modelId,
    embedding_dim: input.embeddingDim,
    quantization_version: input.quantizationVersion,
    evidence,
  }
}
