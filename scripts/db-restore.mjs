#!/usr/bin/env node
/** 把逻辑备份恢复到 compose 的 db 容器。用法：npm run db:restore -- backups/mh-xxx.sql.gz */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { ROOT, loadDotEnv } from './pg-connect.mjs'

loadDotEnv()
const user = process.env.POSTGRES_USER || 'mh'
const db = process.env.POSTGRES_DB || 'memory_harness'
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!arg) {
  console.error('用法：npm run db:restore -- <备份.sql.gz>')
  process.exit(2)
}
const source = resolve(arg)
if (!existsSync(source)) {
  console.error(`[restore] FAIL · 文件不存在：${source}`)
  process.exit(2)
}

const child = spawn('docker', [
  'compose', 'exec', '-T', 'db', 'psql',
  '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1',
], { cwd: ROOT, stdio: ['pipe', 'inherit', 'inherit'] })

const exited = new Promise((res, rej) => {
  child.on('error', rej)
  child.on('exit', (code) => code === 0 ? res() : rej(new Error(`psql 退出码 ${code}`)))
})

try {
  await Promise.all([
    pipeline(createReadStream(source), createGunzip(), child.stdin),
    exited,
  ])
  console.log(`[restore] OK · ${source}`)
} catch (err) {
  console.error(`[restore] FAIL · ${err.message}`)
  process.exit(1)
}
