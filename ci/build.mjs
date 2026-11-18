#!/usr/bin/env node
/**
 * 统一构建入口：定位 tsc 与 @types/node → 编译 → 复制 JSON 契约到 build/。
 *
 * 定位顺序（不依赖任何机器的全局安装状态）：
 *   1. 项目 node_modules/.bin/tsc（npm install 后的标准落点）
 *   2. 从项目根 createRequire 解析 typescript 包的 lib/tsc.js
 *   3. NODE_PATH / npm root -g 下的 typescript 包
 * 产物：build/seams 与 build/src 下的 .js 文件，纯 ESM，运行时零依赖。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(join(ROOT, 'package.json'))

function tryResolve(pkgJson) {
  try { return dirname(req.resolve(pkgJson)) } catch { return null }
}

/** 找到可直接用 node 执行的 tsc.js 入口。 */
function locateTsc() {
  const localBin = join(ROOT, 'node_modules', '.bin', 'tsc')
  if (existsSync(localBin)) return { cmd: localBin, label: 'local .bin' }

  const libDir = tryResolve('typescript/package.json')
  if (libDir) {
    const entry = join(libDir, 'lib', 'tsc.js')
    if (existsSync(entry)) return { cmd: entry, label: 'resolved typescript' }
    const bin = join(libDir, 'bin', 'tsc')
    if (existsSync(bin)) return { cmd: bin, label: 'resolved typescript bin' }
  }

  for (const base of (process.env.NODE_PATH ?? '').split(':').filter(Boolean)) {
    const entry = join(base, 'typescript', 'lib', 'tsc.js')
    if (existsSync(entry)) return { cmd: entry, label: 'NODE_PATH' }
  }
  try {
    const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const entry = join(g, 'typescript', 'lib', 'tsc.js')
    if (existsSync(entry)) return { cmd: entry, label: 'npm root -g' }
  } catch { /* npm 不可用则跳过 */ }

  return null
}

/** 找到包含 node 类型声明的 @types 根目录。 */
function locateTypeRoots() {
  const roots = []
  const local = join(ROOT, 'node_modules', '@types')
  if (existsSync(local)) roots.push(local)
  const nodeTypes = tryResolve('@types/node/package.json')
  if (nodeTypes) roots.push(dirname(nodeTypes))
  for (const base of (process.env.NODE_PATH ?? '').split(':').filter(Boolean)) {
    const t = join(base, '@types')
    if (existsSync(t)) roots.push(t)
  }
  return [...new Set(roots)]
}

const found = locateTsc()
if (!found) {
  console.error('[build] FAIL · 找不到 tsc。请先执行 npm install（devDependencies 已声明 typescript）。')
  process.exit(2)
}
const typeRoots = locateTypeRoots()
if (!typeRoots.length) {
  console.error('[build] FAIL · 找不到 @types/node。请先执行 npm install。')
  process.exit(2)
}

const base = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'))
const cfg = { ...base, compilerOptions: { ...base.compilerOptions, typeRoots } }
const cfgPath = join(ROOT, 'tsconfig.build.json')
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')

const buildDir = join(ROOT, 'build')
rmSync(buildDir, { recursive: true, force: true })

try {
  execFileSync(process.execPath, [found.cmd, '-p', cfgPath], { cwd: ROOT, stdio: 'inherit' })
} catch {
  console.error('[build] FAIL · TypeScript 编译未通过（noEmitOnError）。')
  process.exit(1)
}

// 运行时需要读 registry / schema，统一复制到 build/seams，保证只发 build/ 也能跑
mkdirSync(join(buildDir, 'seams'), { recursive: true })
const copied = []
for (const f of readdirSync(join(ROOT, 'seams')).filter((x) => x.endsWith('.json'))) {
  copyFileSync(join(ROOT, 'seams', f), join(buildDir, 'seams', f))
  copied.push(f)
}

const tsver = execFileSync(process.execPath, [found.cmd, '-v'], { encoding: 'utf8' }).trim()
console.log(`[build] PASS · ${tsver} · tsc=${found.label} · ${copied.length} 个 JSON 契约已复制 · 产物 build/`)
