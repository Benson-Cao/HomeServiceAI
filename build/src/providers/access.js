import { existsSync, readFileSync } from 'node:fs';
/** 文件采集适配器：原件留在 host，只产出指针与文本。 */
export function fileSource() {
    return {
        kind: 'file',
        collect(paths) {
            return paths.filter((p) => existsSync(p)).map((p) => ({ pointer: p, content: readFileSync(p, 'utf8') }));
        },
    };
}
/** 第二实现：内联文本源（聊天/导入用）。 */
export function inlineSource() {
    return {
        kind: 'inline',
        collect(paths) { return paths.map((p, i) => ({ pointer: `inline:${i}`, content: p })); },
    };
}
/** Agent 接入：REST / MCP 风格统一请求形状，内核不感知协议细节。 */
export function restAgentAdapter() {
    return {
        kind: 'rest',
        handle({ operation, payload }) {
            if (operation !== 'retain' && operation !== 'recall' && operation !== 'reflect' && operation !== 'sync') {
                return { status: 400, body: { error: 'unsupported-operation' } };
            }
            return { status: 200, body: { operation, payload } };
        },
    };
}
/** 第二实现：MCP 风格 tools/call 包装。 */
export function mcpAgentAdapter() {
    return {
        kind: 'mcp-tools',
        handle({ operation, payload }) {
            return { status: 200, body: { jsonrpc: '2.0', method: `tools/call`, params: { name: operation, arguments: payload } } };
        },
    };
}
export function jsonUi() {
    return { kind: 'json', render(view, data) { return JSON.stringify({ view, data }); } };
}
export function textUi() {
    return { kind: 'text', render(view, data) { return `[${view}] ${typeof data === 'string' ? data : JSON.stringify(data)}`; } };
}
export function jsonTransport() {
    return {
        kind: 'json',
        encode(payload) { return JSON.stringify(payload); },
        decode(raw) { return JSON.parse(raw); },
    };
}
/** 确定性 OCR 桩：把文本指针还原为文本；真实 OCR 是进程外 provider（ADR-006）。 */
export function textOcr() {
    return {
        kind: 'text-passthrough',
        read(pointer) {
            return existsSync(pointer) ? readFileSync(pointer, 'utf8') : pointer.replace(/^ocr:/, '');
        },
    };
}
