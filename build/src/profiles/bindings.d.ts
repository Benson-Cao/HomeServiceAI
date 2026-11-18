import type { SeamId } from '../../seams/vocabulary.js';
import type { ProviderBinding } from './types.js';
type Factory = () => unknown;
export declare function bindings(overrides?: Partial<Record<SeamId, Factory>>): ProviderBinding[];
export {};
