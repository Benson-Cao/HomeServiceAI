import type { VectorProvider, ExtractorProvider, IngestProvider, ModelRouterProvider, WorkerProvider, AuditProvider, BankPolicyProvider } from '../pipeline/types.js';
export declare function memoryVector(): VectorProvider;
export declare function sentenceExtractor(): ExtractorProvider;
export declare function dedupeIngest(): IngestProvider;
/** 双通道平级路由：不设默认通道，按 operation 返回通道标签，由装配决定实际 llm provider。 */
export declare function neutralModelRouter(): ModelRouterProvider;
export declare function boundedWorker(): WorkerProvider;
export declare function inMemoryAudit(): AuditProvider;
export declare function defaultBankPolicy(): BankPolicyProvider;
