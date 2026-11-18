import type { PolicyProvider, AccessAttributes } from '../pipeline/types.js';
/**
 * L2 isolation-policy 的默认 provider（ABAC 简化版）。
 * 属性判定在这里，内核只做三元组校验 —— profile 不承载授权。
 */
export declare function simplePolicy(): PolicyProvider;
export interface AbacConfig {
    /** principal → 角色；bank → 敏感度与属主；设备可信度默认值 */
    roles?: Record<string, string>;
    bankSensitivity?: Record<string, 'public' | 'family' | 'private'>;
    bankOwners?: Record<string, string>;
    trustedDevices?: Record<string, boolean>;
}
/**
 * ABAC 全量属性策略（L2 isolation-policy 执行点）。
 * 属性判定在策略 provider 内部，内核只做三元组校验；profile 只装配、不授权。
 * 四个属性维度：成员角色 / 数据敏感度 / 设备可信度 / 时间窗口。
 */
export declare function attributePolicy(config?: AbacConfig): PolicyProvider & {
    withAttributes(input: {
        principal: string;
        bank: string;
        operation: string;
        attributes?: AccessAttributes;
        at?: string;
    }): boolean;
};
