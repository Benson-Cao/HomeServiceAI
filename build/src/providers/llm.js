/** Provider A：API 通道（V0.5 为确定性桩，不真发网络）。 */
export function apiLlm() {
    return {
        channel: 'api',
        modelId: 'api-chat-stub',
        complete(prompt) {
            return `[api] ${prompt.length}:ok`;
        },
    };
}
/** Provider B：本地大模型通道（V0.5 为确定性桩，与 API 通道平级）。 */
export function localLlm() {
    return {
        channel: 'local',
        modelId: 'local-chat-stub',
        complete(prompt) {
            return `[local] ${prompt.length}:ok`;
        },
    };
}
