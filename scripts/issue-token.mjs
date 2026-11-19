#!/usr/bin/env node
/**
 * ④ 给家庭成员签发访问 token（手机/平板/电脑各签一个）。
 *
 *   npm run token:issue -- --sub=parent --device=laptop-parent
 *   npm run token:issue -- --sub=child --device=tablet-kid --ttl=86400
 *   npm run token:issue -- --list          # 只列目录里的成员与可信设备
 *
 * 密钥只从环境变量 MH_IDENTITY_SECRET 读，不打印、不落盘。
 * token 本身会打印一次 —— 请存到设备的密码管理器，别贴聊天。
 */
import { loadDotEnv } from './pg-connect.mjs'
import { loadMembersFromEnv } from './load-members.mjs'
import { issueToken, verifyToken } from '../build/src/runtime/identity.js'

loadDotEnv()

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=')
      return [k, v.length ? v.join('=') : true]
    }),
)

const secret = process.env.MH_IDENTITY_SECRET || ''
if (!secret) {
  console.error('[token:issue] FAIL · 未设置 MH_IDENTITY_SECRET（先在 .env 里生成：openssl rand -hex 32）')
  process.exit(1)
}

const loaded = loadMembersFromEnv({ required: true })
if (!loaded) process.exit(1)
const dir = loaded.directory

if (args.list) {
  console.log(JSON.stringify({
    source: loaded.source,
    members: [...dir.members.values()].map((m) => ({ sub: m.sub, role: m.role, banks: m.banks, devices: m.devices })),
    banks: Object.fromEntries(dir.banks),
    trustedDevices: [...dir.trustedDevices],
  }, null, 2))
  process.exit(0)
}

const sub = typeof args.sub === 'string' ? args.sub.trim() : ''
const device = typeof args.device === 'string' ? args.device.trim() : ''
if (!sub || !device) {
  console.error('[token:issue] FAIL · 用法：npm run token:issue -- --sub=<成员> --device=<设备> [--ttl=<秒>]')
  console.error('  可用成员：', [...dir.members.keys()].join(', '))
  process.exit(1)
}

const member = dir.members.get(sub)
if (!member) {
  console.error(`[token:issue] FAIL · 目录里没有成员 "${sub}"；可用：${[...dir.members.keys()].join(', ')}`)
  process.exit(1)
}
if (!dir.trustedDevices.has(device) && !(member.devices ?? []).includes(device)) {
  console.error(`[token:issue] FAIL · 设备 "${device}" 不在可信列表；该成员可用：${(member.devices ?? []).join(', ') || '（无）'}`)
  process.exit(1)
}

const ttl = Number(args.ttl ?? process.env.MH_TOKEN_TTL_SECONDS ?? 2_592_000)
if (!Number.isFinite(ttl) || ttl <= 0) {
  console.error('[token:issue] FAIL · --ttl 必须是正数（秒）')
  process.exit(1)
}

const role = typeof args.role === 'string' ? args.role : member.role
const token = issueToken({ secret, sub, role, device, ttlSeconds: Math.floor(ttl) })
const check = verifyToken({ secret, token })
if (!check) {
  console.error('[token:issue] FAIL · 自校验失败，token 未输出')
  process.exit(1)
}

const base = (process.env.MH_HTTP_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
console.log(JSON.stringify({
  ok: true,
  sub, role, device,
  expires_at: new Date(check.exp * 1000).toISOString(),
  ttl_seconds: Math.floor(ttl),
  token,
  usage: `curl -s -H "Authorization: Bearer ${token}" ${base}/stats`,
  warning: 'token 只显示这一次，请存到设备密码管理器；轮换密钥或改 MH_IDENTITY_SECRET 会让所有旧 token 立即失效。',
}, null, 2))
