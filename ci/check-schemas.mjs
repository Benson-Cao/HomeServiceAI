#!/usr/bin/env node
/**
 * 校验：① 所有 JSON 契约可解析且带 contract_version；② 版本与 TS 单一源一致。
 * TS 源用文本读取，避免构建顺序依赖（编译产物的一致性另由 acceptance 测试校验）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dirPath = fileURLToPath(new URL('../seams/', import.meta.url))
const src = readFileSync(new URL('../seams/contract-version.ts', import.meta.url), 'utf8')
const m = src.match(/CONTRACT_VERSION\s*=\s*'([^']+)'/)
if (!m) throw new Error('seams/contract-version.ts 未找到 CONTRACT_VERSION 字面量')
const VERSION = m[1]

let n = 0
for (const f of readdirSync(dirPath).filter((x) => x.endsWith('.json'))) {
  const d = JSON.parse(readFileSync(join(dirPath, f), 'utf8'))
  if (!d.contract_version) throw new Error(`${f} 缺少 contract_version`)
  if (d.contract_version !== VERSION) throw new Error(`${f} 版本 ${d.contract_version} ≠ TS 源 ${VERSION}`)
  n++
}
console.log(`[check-schemas] PASS · ${n} 个契约文件 · contract_version=${VERSION}（TS 源 ↔ JSON 一致）。`)
