import type { RecallChannel } from '../../seams/vocabulary.js';
import type { PluginDefinition } from '../kernel/types.js';
import type { MemoryService } from '../pipeline/types.js';
export declare const MEMORY_SCENE_ID = "scene.memory";
/** 声明式通道权重：合并语义显式给出，不靠插件加载顺序隐式决定。 */
export declare const CHANNEL_WEIGHTS: Readonly<Partial<Record<RecallChannel, number>>>;
export declare function createMemoryScene(onReady: (service: MemoryService) => void): PluginDefinition;
