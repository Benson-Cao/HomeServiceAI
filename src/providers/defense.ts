import type { DefenseProvider } from '../pipeline/types.js'

const RULES: Array<{ kind: string; re: RegExp }> = [
  { kind: 'email', re: /[\w.+-]+@[\w-]+\.[\w.]+/g },
  { kind: 'phone-cn', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: 'api-key', re: /(?:sk-|ghp_|AKIA)[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]{12,}/g },
]

/** PII / 密钥扫描：默认开启，命中即 redact 并给出可观测类别。 */
export function piiDefense(): DefenseProvider {
  return {
    kind: 'pii-scan',
    scan(text) {
      const kinds: string[] = []
      let redacted = text
      for (const r of RULES) {
        const m = redacted.match(r.re)
        if (m?.length) {
          kinds.push(r.kind)
          redacted = redacted.replace(r.re, `[REDACTED:${r.kind}]`)
        }
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
      const kinds = RULES.filter((r) => r.re.test(text)).map((r) => r.kind)
      return { flagged: kinds.length > 0, kinds, redacted: text }
    },
  }
}
