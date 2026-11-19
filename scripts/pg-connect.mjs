#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 读取根 .env，只补齐未定义的键（不覆盖容器/宿主已注入的值）。 */
export function loadDotEnv() {
  const file = join(ROOT, '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i < 1) continue
    const key = s.slice(0, i).trim()
    let val = s.slice(i + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

/** 容器内用服务名 db；宿主机脚本自动改写成 localhost:POSTGRES_PORT。 */
export function resolveDsn() {
  const raw = process.env.MH_PG_DSN
  if (!raw) throw new Error('缺少 MH_PG_DSN，请复制 .env.example 为 .env 后填写')
  if (process.env.MH_IN_CONTAINER === '1') return raw
  const u = new URL(raw)
  u.hostname = process.env.MH_PG_HOST || 'localhost'
  u.port = process.env.POSTGRES_PORT || '5432'
  return u.toString()
}

/** pg 是 optionalDependency：只在 L0 路径动态加载，核心 verify 不需要它。 */
export async function connectPg(dsn) {
  let mod
  try {
    mod = await import('pg')
  } catch {
    throw new Error('未找到 pg 驱动。请执行 npm install（pg 为 optionalDependency），或使用 docker compose 镜像。')
  }
  const Client = mod.Client ?? mod.default?.Client
  if (!Client) throw new Error('pg 模块未导出 Client')
  const client = new Client({ connectionString: dsn })
  await client.connect()
  return client
}
