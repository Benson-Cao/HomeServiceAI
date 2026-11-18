import { createHash } from 'node:crypto';
import { CONTRACT_VERSION } from '../../seams/contract-version.js';
export function fingerprint(text) {
    return createHash('sha256').update(text).digest('hex').slice(0, 32);
}
export function makeProvenance(input) {
    const evidence = {
        quotes: input.quotes,
        proof_count: 1,
        confidence: input.confidence ?? 0.5,
        freshness: 'new',
        valid_time: { valid_from: input.validFrom ?? null, valid_to: input.validTo ?? null },
    };
    return {
        producer_plugin_id: input.pluginId,
        pipeline_run_id: input.runId,
        contract_version: CONTRACT_VERSION,
        model_id: input.modelId,
        embedding_dim: input.embeddingDim,
        quantization_version: input.quantizationVersion,
        evidence,
    };
}
