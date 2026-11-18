import type { Provenance } from './types.js';
export declare function fingerprint(text: string): string;
export declare function makeProvenance(input: {
    pluginId: string;
    runId: string;
    modelId: string;
    embeddingDim: number;
    quantizationVersion: string;
    quotes: string[];
    confidence?: number;
    validFrom?: string | null;
    validTo?: string | null;
}): Provenance;
