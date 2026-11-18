#!/usr/bin/env node
/**
 * 内核破功静态检查。
 * 内核 PR 中出现场景名 / 模型名·provider 名·品牌名 / 部署通道判断 /
 * 检索算法与融合权重 / 场景授权分支，任一即 exit 1。
 *
 * 用法：node ci/kernel-purity.mjs --dir src/kernel
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'src/kernel'
const root = resolve(process.cwd(), dirArg)
const terms = JSON.parse(readFileSync(new URL('./forbidden-terms.json', import.meta.url), 'utf8'))

const EXCLUDE = /(^|\/)(node_modules|dist|build|\.git|ci|docs|seams)(\/|$)|\.md$|\.json$/
const CODE = /\.(ts|tsx|js|mjs|cjs|py|go|rs)$/
const SKIP_SELF = /kernel-purity\.mjs$/

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = relative(process.cwd(), p).replace(/\\/g, '/')
    if (EXCLUDE.test(rel)) continue
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (CODE.test(name) && !SKIP_SELF.test(rel)) out.push(p)
  }
  return out
}

function compile(raw) {
  if (raw.startsWith('/') && raw.endsWith('/')) return new RegExp(raw.slice(1, -1), 'i')
  return new RegExp(`(^|[^A-Za-z0-9_])${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i')
}

const violations = []
for (const file of walk(root)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const [category, list] of Object.entries(terms)) {
      if (category === 'note') continue
      for (const raw of list) {
        if (compile(raw).test(line)) {
          violations.push({ file: relative(process.cwd(), file), line: i + 1, category, text: line.trim() })
        }
      }
    }
  })
}

if (!existsSync(root)) {
  console.error(`[kernel-purity] 目标目录不存在：${dirArg}。内核实现应落位于此，CI 不得静默跳过。`)
  process.exit(2)
}
if (violations.length) {
  console.error(`[kernel-purity] FAIL · ${violations.length} 处破功：`)
  for (const v of violations) console.error(`  ${v.file}:${v.line} [${v.category}] ${v.text}`)
  console.error('内核只认：插件、依赖、事件、ctx 注册、契约版本、principal → bank → operation。')
  process.exit(1)
}
console.log(`[kernel-purity] PASS · 扫描 ${walk(root).length} 个代码文件，未发现内核越界。`)
