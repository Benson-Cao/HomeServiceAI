import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import type { PolicyProvider } from '../pipeline/types.js'
import { attributePolicy } from '../providers/policy.js'

/**
 * ④ 身份与目录：把「请求里随便填的字符串 principal」换成**已验证的 subject**。
 *
 * 刻意不新增 seam：
 *   - 认证是 daemon 的入口可注入参数（和 `client` 同级），不是 L2 契约；
 *   - 属性判定仍走既有 `isolation-policy` seam，这里只给它喂真实目录配置；
 *   - 内核 `authorize(principal, bank, operation)` 一行未改，场景插件一行未改。
 *
 * Token 是本地 HMAC 签名的紧凑串（零第三方依赖）：
 *   v1.<base64url(payload)>.<base64url(hmac_sha256("v1."+payload, secret))>
 * payload = { sub, role, dev, iat, exp }，秒级 Unix 时间。
 */

export interface MemberSpec {
  sub: string
  role: 'parent' | 'admin' | 'child' | 'viewer' | string
  /** 该成员可见的 bank 白名单；省略则按 banks 表判定。 */
  banks?: string[]
  devices?: string[]
}

export interface BankSpec {
  sensitivity?: 'public' | 'family' | 'private'
  owner?: string
  /** 可选访问时间窗（HH:mm，本地按 UTC 比较，见 inWindow）。 */
  windowStart?: string
  windowEnd?: string
}

export interface MemberDirectory {
  members: Map<string, MemberSpec>
  banks: Map<string, BankSpec>
  trustedDevices: Set<string>
  /** 全局访问窗口（HH:mm），对私有域生效。 */
  windowStart?: string
  windowEnd?: string
}

export interface Identity {
  principal: string
  role: string
  device: string
  deviceTrusted: boolean
  issuedAt: number
  expiresAt: number
}

export interface IdentityGate {
  authenticate(authorization: string | undefined): Identity | null
  readonly enabled: true
}

export interface IssueTokenInput {
  secret: string
  sub: string
  role?: string
  device?: string
  ttlSeconds?: number
  nowSeconds?: number
}

export interface VerifyTokenInput {
  secret: string
  token: string
  nowSeconds?: number
}

export interface TokenPayload {
  sub: string
  role: string
  dev: string
  iat: number
  exp: number
  v: 1
}

const PREFIX = 'v1'

function b64url(input: string | Buffer): string {
  const b = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return b.toString('base64url')
}

function unb64url(input: string): Buffer {
  return Buffer.from(input, 'base64url')
}

function sign(signingInput: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(signingInput, 'utf8').digest())
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function issueToken(input: IssueTokenInput): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const ttl = input.ttlSeconds ?? 86_400 * 30
  if (!input.secret) throw new Error('issueToken: secret 不能为空')
  if (!input.sub || !input.sub.trim()) throw new Error('issueToken: sub 不能为空')
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('issueToken: ttlSeconds 必须为正数')
  const payload: TokenPayload = {
    sub: input.sub.trim(),
    role: input.role ?? 'member',
    dev: input.device ?? 'unknown',
    iat: now,
    exp: now + Math.floor(ttl),
    v: 1,
  }
  const body = b64url(JSON.stringify(payload))
  const signingInput = `${PREFIX}.${body}`
  return `${signingInput}.${sign(signingInput, input.secret)}`
}

/** 只做密码学校验；目录校验由 gate 完成。返回 null 表示不可用，绝不抛穿请求。 */
export function verifyToken(input: VerifyTokenInput): TokenPayload | null {
  try {
    const parts = input.token.split('.')
    if (parts.length !== 3 || parts[0] !== PREFIX) return null
    const [, body, sig] = parts
    const signingInput = `${PREFIX}.${body}`
    if (!safeEqual(sign(signingInput, input.secret), sig)) return null
    const parsed: unknown = JSON.parse(unb64url(body).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const p = parsed as Record<string, unknown>
    if (p.v !== 1) return null
    if (typeof p.sub !== 'string' || !p.sub.trim()) return null
    if (typeof p.iat !== 'number' || typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null
    if (typeof p.role !== 'string' || typeof p.dev !== 'string') return null
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
    if (now >= p.exp) return null
    if (p.iat > now + 60) return null // 不允许未来签发（时钟漂移容忍 60s）
    return { sub: p.sub, role: p.role, dev: p.dev, iat: p.iat, exp: p.exp, v: 1 }
  } catch {
    return null
  }
}

function hhmmToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v)
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** UTC 时间窗；跨午夜窗口（如 22:00–06:00）也支持。 */
export function inWindow(at: string | number, start?: string, end?: string): boolean {
  if (!start && !end) return true
  const d = typeof at === 'number' ? new Date(at) : new Date(at)
  if (Number.isNaN(d.getTime())) return false
  const cur = d.getUTCHours() * 60 + d.getUTCMinutes()
  const s = start ? hhmmToMinutes(start) : null
  const e = end ? hhmmToMinutes(end) : null
  if (s === null && e === null) return true
  if (s !== null && e === null) return cur >= s
  if (s === null && e !== null) return cur <= e
  if (s !== null && e !== null) return s <= e ? cur >= s && cur <= e : cur >= s || cur <= e
  return true
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** 严格解析目录；错误配置在启动时就暴露，不静默降级成「所有人可读写」。 */
export function parseDirectory(raw: unknown): MemberDirectory {
  if (!isObject(raw) || !Array.isArray(raw.members)) {
    throw new Error('parseDirectory: 需要 { members: [...] }')
  }
  const members = new Map<string, MemberSpec>()
  for (const m of raw.members) {
    if (!isObject(m) || typeof m.sub !== 'string' || !m.sub.trim() || typeof m.role !== 'string') {
      throw new Error('parseDirectory: 每个 member 需要 sub / role')
    }
    const banks = Array.isArray(m.banks) ? m.banks.filter((b): b is string => typeof b === 'string') : undefined
    const devices = Array.isArray(m.devices) ? m.devices.filter((d): d is string => typeof d === 'string') : undefined
    members.set(m.sub.trim(), { sub: m.sub.trim(), role: m.role, banks, devices })
  }
  if (members.size === 0) throw new Error('parseDirectory: members 不能为空')

  const banks = new Map<string, BankSpec>()
  if (raw.banks !== undefined) {
    if (!isObject(raw.banks)) throw new Error('parseDirectory: banks 必须是对象')
    for (const [name, spec] of Object.entries(raw.banks)) {
      if (!isObject(spec)) throw new Error(`parseDirectory: banks.${name} 必须是对象`)
      const sensitivity = spec.sensitivity
      if (sensitivity !== undefined && !['public', 'family', 'private'].includes(String(sensitivity))) {
        throw new Error(`parseDirectory: banks.${name}.sensitivity 非法`)
      }
      banks.set(name, {
        sensitivity: sensitivity as BankSpec['sensitivity'],
        owner: typeof spec.owner === 'string' ? spec.owner : undefined,
        windowStart: typeof spec.windowStart === 'string' ? spec.windowStart : undefined,
        windowEnd: typeof spec.windowEnd === 'string' ? spec.windowEnd : undefined,
      })
    }
  }

  const trustedDevices = new Set<string>(
    Array.isArray(raw.trustedDevices)
      ? raw.trustedDevices.filter((d): d is string => typeof d === 'string')
      : [],
  )

  return {
    members, banks, trustedDevices,
    windowStart: typeof raw.windowStart === 'string' ? raw.windowStart : undefined,
    windowEnd: typeof raw.windowEnd === 'string' ? raw.windowEnd : undefined,
  }
}

export interface CreateGateOptions {
  secret: string
  directory: MemberDirectory
  /** 设备必须出现在目录可信列表里，否则 401（设备维度在认证层硬校验）。 */
  requireTrustedDevice?: boolean
  nowSeconds?: () => number
  now?: () => string
}

export function createIdentityGate(options: CreateGateOptions): IdentityGate {
  const { secret, directory } = options
  if (!secret) throw new Error('createIdentityGate: secret 不能为空')
  const requireTrusted = options.requireTrustedDevice ?? true
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const now = options.now ?? (() => new Date().toISOString())

  return {
    enabled: true,
    authenticate(authorization) {
      if (!authorization || !authorization.startsWith('Bearer ')) return null
      const payload = verifyToken({ secret, token: authorization.slice(7).trim(), nowSeconds: nowSeconds() })
      if (!payload) return null
      const member = directory.members.get(payload.sub)
      if (!member) return null
      if (member.banks && member.banks.length === 0) return null
      const deviceTrusted = directory.trustedDevices.has(payload.dev) || (member.devices?.includes(payload.dev) ?? false)
      if (requireTrusted && !deviceTrusted) return null
      // 全局时间窗也在认证层做一次硬判定；策略层还会按 bank 再判一次。
      if (!inWindow(now(), directory.windowStart, directory.windowEnd)) return null
      return {
        principal: payload.sub,
        role: member.role,
        device: payload.dev,
        deviceTrusted,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
      }
    },
  }
}

/**
 * 目录驱动的 isolation-policy provider：填既有 seam，不新增契约。
 * 四个属性维度全部落在 L2 策略执行点：角色 / 敏感度 / 设备可信度 / 时间窗口。
 */
export function directoryPolicy(
  directory: MemberDirectory,
  options: { now?: () => string } = {},
): PolicyProvider {
  const now = options.now ?? (() => new Date().toISOString())
  const roles: Record<string, string> = {}
  const bankSensitivity: Record<string, 'public' | 'family' | 'private'> = {}
  const bankOwners: Record<string, string> = {}
  const trustedDevices: Record<string, boolean> = {}
  for (const [sub, m] of directory.members) {
    roles[sub] = m.role
    trustedDevices[sub] = !(m.devices && m.devices.length > 0) || m.devices.some((d) => directory.trustedDevices.has(d))
  }
  for (const [bank, spec] of directory.banks) {
    if (spec.sensitivity) bankSensitivity[bank] = spec.sensitivity
    if (spec.owner) bankOwners[bank] = spec.owner
  }
  const base = attributePolicy({ roles, bankSensitivity, bankOwners, trustedDevices })

  return {
    evaluate({ principal, bank, operation }) {
      const member = directory.members.get(principal)
      if (!member) return false // 目录外的 subject 一律拒绝，fail-closed
      if (member.banks && !member.banks.includes(bank)) return false
      const spec = directory.banks.get(bank)
      // bank 级时间窗（覆盖全局窗）
      if (!inWindow(now(), spec?.windowStart ?? directory.windowStart, spec?.windowEnd ?? directory.windowEnd)) return false
      if (operation === 'reflect') return false // reflect 内部先走 recall 授权
      return base.evaluate({ principal, bank, operation })
    },
  }
}

/** 审计行 id：进程内唯一，避免依赖 PG 序列（离线 mock 也能跑）。 */
export function auditId(): string {
  return `aud_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}
