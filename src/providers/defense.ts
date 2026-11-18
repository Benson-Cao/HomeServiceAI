import type { DefenseProvider } from '../pipeline/types.js'

/**
 * 规则只存 pattern 源码，不共享 RegExp 实例。
 * 带 /g 的模块级正则用 .test() 会推进 lastIndex，连续扫描第二条就会漏检 PII（真实缺陷）。
 * 每次 scan 现场 new RegExp，lastIndex 恒从 0 开始，跨平台、跨调用一致。
 */
const RULES: ReadonlyArray<{ kind: string; source: string; flags?: string }> = Object.freeze([
  { kind: 'email', source: '[\\w.+-]+@[\\w-]+\\.[\\w.]+' },
  { kind: 'phone-cn', source: '(?<!\\d)1[3-9]\\d{9}(?!\\d)' },
  { kind: 'api-key', source: '(?:sk-|ghp_|AKIA)[A-Za-z0-9_-]{8,}' },
  { kind: 'bearer', source: 'Bearer\\s+[A-Za-z0-9._-]{12,}' },
])

const fresh = (source: string, flags = 'g'): RegExp => new RegExp(source, flags)

/** PII / 密钥扫描：默认开启，命中即 redact 并给出可观测类别。 */
export function piiDefense(): DefenseProvider {
  return {
    kind: 'pii-scan',
    scan(text) {
      const kinds: string[] = []
      let redacted = text
      for (const r of RULES) {
        if (!fresh(r.source, r.flags).test(redacted)) continue
        kinds.push(r.kind)
        redacted = redacted.replace(fresh(r.source, r.flags), `[REDACTED:${r.kind}]`)
      }
      return { flagged: kinds.length > 0, kinds, redacted }
    },
  }
}

/** 第二实现：只标记不改写（可互换验证）。 */
export function detectOnlyDefense(): DefenseProvider {
  return {
    kind: 'detect-only',
    scan(text) {
      const kinds = RULES.filter((r) => fresh(r.source, r.flags).test(text)).map((r) => r.kind)
      return { flagged: kinds.length > 0, kinds, redacted: text }
    },
  }
}
