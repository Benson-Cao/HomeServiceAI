import type { SourceProvider, AgentAdapterProvider, UiProvider, TransportProvider, OcrProvider } from '../pipeline/types.js';
/** 文件采集适配器：原件留在 host，只产出指针与文本。 */
export declare function fileSource(): SourceProvider;
/** 第二实现：内联文本源（聊天/导入用）。 */
export declare function inlineSource(): SourceProvider;
/** Agent 接入：REST / MCP 风格统一请求形状，内核不感知协议细节。 */
export declare function restAgentAdapter(): AgentAdapterProvider;
/** 第二实现：MCP 风格 tools/call 包装。 */
export declare function mcpAgentAdapter(): AgentAdapterProvider;
export declare function jsonUi(): UiProvider;
export declare function textUi(): UiProvider;
export declare function jsonTransport(): TransportProvider;
/** 确定性 OCR 桩：把文本指针还原为文本；真实 OCR 是进程外 provider（ADR-006）。 */
export declare function textOcr(): OcrProvider;
