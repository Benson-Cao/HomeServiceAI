#!/usr/bin/env node
/** 从 compose 的 db 容器导出逻辑备份（gzip）。用法：npm run db:backup -- [输出路径] */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { ROOT, loadDotEnv } from './pg-connect.mjs'

loadDotEnv()
const user = process.env.POSTGRES_USER || 'mh'
const db = process.env.POSTGRES_DB || 'memory_harness'
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
const target = resolve(arg ?? join(ROOT, 'backups', `mh-${stamp}.sql.gz`))
mkdirSync(dirname(target), { recursive: true })

const child = spawn('docker', [
  'compose', 'exec', '-T', 'db', 'pg_dump',
  '-U', user, '-d', db, '--clean', '--if-exists', '--no-owner', '--no-privileges',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })

const exited = new Promise((res, rej) => {
  child.on('error', rej)
  child.on('exit', (code) => code === 0 ? res() : rej(new Error(`pg_dump 退出码 ${code}`)))
})

try {
  await Promise.all([
    pipeline(child.stdout, createGzip(), createWriteStream(target)),
    exited,
  ])
  console.log(`[backup] OK · ${target}`)
} catch (err) {
  console.error(`[backup] FAIL · ${err.message}`)
  process.exit(1)
}
