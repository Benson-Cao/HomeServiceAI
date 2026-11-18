import type {
  JobRecord, VectorProvider, ExtractorProvider, IngestProvider, ModelRouterProvider,
  WorkerProvider, AuditProvider, BankPolicyProvider,
} from '../pipeline/types.js'

export function memoryVector(): VectorProvider {
  const m = new Map<string, number[]>()
  return { kind: 'memory-vector', upsert(id, v) { m.set(id, v) }, size() { return m.size } }
}

export function sentenceExtractor(): ExtractorProvider {
  return { kind: 'sentence', extract(text) { return text.split(/[。；\n]/).map((s) => s.trim()).filter(Boolean) } }
}

export function dedupeIngest(): IngestProvider {
  const seen = new Set<string>()
  return { kind: 'dedupe', accept(fingerprint) { if (seen.has(fingerprint)) return false; seen.add(fingerprint); return true } }
}

/** 双通道平级路由：不设默认通道，按 operation 返回通道标签，由装配决定实际 llm provider。 */
export function neutralModelRouter(): ModelRouterProvider {
  return { kind: 'neutral', route(operation) { return operation === 'reflect' ? 'synthesis' : 'chat' } }
}

export function boundedWorker(): WorkerProvider {
  let n = 0
  return {
    kind: 'bounded',
    run(job) { n++; return { ...job, state: 'succeeded' as const } },
    processed() { return n },
  }
}

export function inMemoryAudit(): AuditProvider {
  const log: Array<{ event: string; payload: unknown }> = []
  return {
    kind: 'memory-audit',
    record(event, payload) { log.push({ event, payload }) },
    entries() { return [...log] },
  }
}

export function defaultBankPolicy(): BankPolicyProvider {
  return {
    kind: 'default',
    retentionDays(bank) { return bank === 'health' ? 3650 : null },
    shareScope(bank) { return bank === 'kid' ? 'family-read' : 'private' },
  }
}
