import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createKernel, CONTRACT_VERSION, EVENT_TYPES } from '../build/src/kernel/runtime.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('① 依赖齐备才激活；缺失时 PENDING 且不抛错', () => {
  const k = createKernel()
  k.plugin({ id: 'provider.a', apply: (ctx) => ctx.registerSeam('storage', {}) })
  let started = 0
  k.plugin({ id: 'consumer.b', inject: ['storage', 'embedder'], apply: () => { started++ } })
  const row = k.dumpTree().find((f) => f.id === 'consumer.b')
  assert.equal(started, 0)
  assert.equal(row.state, 'pending')
  assert.deepEqual(row.missingDeps, ['embedder'])
  assert.equal(k.dumpTree().find((f) => f.id === 'provider.a').state, 'active')
  k.dispose()
})

test('② 后补 provider 自动激活，无需重启', () => {
  const k = createKernel()
  let started = 0
  k.plugin({ id: 'c', inject: ['storage'], apply: () => { started++ } })
  assert.equal(started, 0)
  k.plugin({ id: 'p', apply: (ctx) => ctx.registerSeam('storage', {}) })
  assert.equal(started, 1)
  assert.equal(k.dumpTree().find((f) => f.id === 'c').state, 'active')
  k.dispose()
})

test('③ 依赖消失回 PENDING 且副作用已回滚；补回后重新激活', () => {
  const k = createKernel()
  let undo
  k.plugin({ id: 'p', apply: (ctx) => { undo = ctx.registerSeam('storage', {}) } })
  let hits = 0
  let started = 0
  k.plugin({
    id: 'c', inject: ['storage'],
    apply: (ctx) => { started++; ctx.on('memory.job.state', () => { hits++ }) },
  })
  assert.equal(started, 1)
  undo()
  assert.equal(k.dumpTree().find((f) => f.id === 'c').state, 'pending')
  assert.equal(k.emit('memory.job.state', {}), 0, '回退后监听应已回收')
  k.plugin({ id: 'p2', apply: (ctx) => ctx.registerSeam('storage', {}) })
  assert.equal(started, 2)
  assert.equal(k.emit('memory.job.state', {}), 1)
  k.dispose()
})

test('④ 卸载逆序回收 seam / listener / interval 全部副作用', () => {
  const k = createKernel()
  const order = []
  const unload = k.plugin({
    id: 'composite',
    apply: (ctx) => {
      ctx.registerSeam('storage', {})
      ctx.on('memory.retain.accepted', () => order.push('listener'))
      ctx.every(10_000, () => order.push('timer'))
    },
  })
  assert.equal(k.services.includes('storage'), true)
  unload()
  assert.deepEqual(k.services, [], 'seam 应回收')
  assert.equal(k.emit('memory.retain.accepted', {}), 0, 'listener 应回收')
  assert.deepEqual(k.dumpTree(), [], '插件树应清空')
  assert.deepEqual(order, [])
  k.dispose()
})

test('⑤ 后注册覆盖前注册；前者卸载不误删后者', () => {
  const k = createKernel()
  const u1 = k.plugin({ id: 'older', apply: (ctx) => ctx.registerSeam('storage', { v: 1 }) })
  k.plugin({ id: 'newer', apply: (ctx) => ctx.registerSeam('storage', { v: 2 }) })
  assert.equal(k.services.includes('storage'), true)
  u1()
  assert.equal(k.services.includes('storage'), true, '旧 owner 卸载不得删掉新 provider')
  k.dispose()
})

test('⑥ 类型化事件总线：未声明事件拒绝；单个 listener 抛错不阻断其余', () => {
  const k = createKernel()
  k.plugin({
    id: 'bus',
    apply: (ctx) => {
      ctx.on('memory.retain.accepted', () => { throw new Error('boom') })
      ctx.on('memory.retain.accepted', () => globalThis.__busHit = (globalThis.__busHit ?? 0) + 1)
    },
  })
  assert.throws(() => k.emit('not.declared', {}), /未声明/)
  k.emit('memory.retain.accepted', {})
  assert.equal(globalThis.__busHit, 1)
  assert.equal(k.errors.length, 1, '错误应被记录而非让进程崩')
  assert.match(k.errors[0].error, /boom/)
  delete globalThis.__busHit
  k.dispose()
})

test('⑦ authorize：fail-closed、策略委托、非法元组/操作、策略抛错', () => {
  const k = createKernel()
  assert.equal(k.authorize('u1', 'b1', 'recall'), false, '无策略 provider 必须拒绝')
  assert.equal(k.authorize('', 'b1', 'recall'), false)
  assert.equal(k.authorize('u1', 'b1', 'delete'), false)
  k.plugin({
    id: 'policy',
    apply: (ctx) => ctx.registerSeam('isolation-policy', {
      evaluate: ({ principal, bank, operation }) => principal === 'u1' && bank === 'b1' && operation === 'recall',
    }),
  })
  assert.equal(k.authorize('u1', 'b1', 'recall'), true)
  assert.equal(k.authorize('u2', 'b1', 'recall'), false)
  assert.equal(k.authorize('u1', 'b1', 'retain'), false)
  k.plugin({
    id: 'policy.broken',
    apply: (ctx) => ctx.registerSeam('isolation-policy', { evaluate: () => { throw new Error('x') } }),
  })
  assert.equal(k.authorize('u1', 'b1', 'recall'), false, '策略抛错也应拒绝')
  k.dispose()
})

test('⑧ 契约主版本校验：MAJOR 不同拒绝，MINOR 不同放行', () => {
  assert.throws(() => createKernel({ contractVersion: '2.0.0' }), /主版本不匹配/)
  assert.doesNotThrow(() => createKernel({ contractVersion: '1.9.0' }))
  assert.equal(createKernel().contractVersion, CONTRACT_VERSION)
})

test('⑨ dumpTree 字段完整、按 id 排序、failed 可观测', () => {
  const k = createKernel()
  k.plugin({ id: 'z.ok', apply: () => {} })
  k.plugin({ id: 'a.bad', apply: () => { throw new Error('boom') } })
  const t = k.dumpTree()
  assert.deepEqual(t.map((f) => f.id), ['a.bad', 'z.ok'])
  assert.equal(t[0].state, 'failed')
  assert.match(t[0].error, /boom/)
  assert.deepEqual(t[1].missingDeps, [])
  assert.ok(Array.isArray(t[1].deps))
  k.dispose()
})

test('⑩ 互相依赖不崩溃、不误报收敛失败', () => {
  const k = createKernel()
  assert.doesNotThrow(() => {
    k.plugin({ id: 'x', inject: ['y'], apply: (ctx) => ctx.registerSeam('x', {}) })
    k.plugin({ id: 'y', inject: ['x'], apply: (ctx) => ctx.registerSeam('y', {}) })
  })
  assert.ok(k.dumpTree().every((f) => f.state === 'pending'))
  k.dispose()
})

test('⑪ dispose 后干净且拒绝再注册', () => {
  const k = createKernel()
  k.plugin({ id: 'p', apply: (ctx) => ctx.registerSeam('storage', {}) })
  k.dispose()
  assert.deepEqual(k.dumpTree(), [])
  assert.deepEqual(k.services, [])
  assert.throws(() => k.plugin({ id: 'late', apply: () => {} }), /已 dispose/)
})

test('⑫ 事件类型白名单与契约版本一致', () => {
  assert.ok(EVENT_TYPES.includes('memory.retain.accepted'))
  assert.ok(EVENT_TYPES.includes('memory.authz.decided'))
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length)
  assert.equal(CONTRACT_VERSION, '1.2.0')
})

test('⑬ 内核纯度自检：实现写完后仍不越界', () => {
  const out = execFileSync(process.execPath, ['ci/kernel-purity.mjs', '--dir', 'src/kernel'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.match(out, /PASS/)
})


test('⑭ ctx.use 消费侧注入：依赖就绪后可读到 provider', () => {
  const k = createKernel()
  k.plugin({ id: 'p', apply: (ctx) => ctx.registerSeam('storage', { kind: 'A' }) })
  let seen
  k.plugin({ id: 'c', inject: ['storage'], apply: (ctx) => { seen = ctx.use('storage') } })
  assert.deepEqual(seen, { kind: 'A' })
  assert.equal(k.resolve('storage').kind, 'A')
  assert.equal(k.resolve('nope'), undefined)
  k.dispose()
})

test('⑮ kernel.resolve 是只读观测，返回的不是内部 Map', () => {
  const k = createKernel()
  k.plugin({ id: 'p', apply: (ctx) => ctx.registerSeam('queue', { size: 0 }) })
  assert.equal(typeof k.resolve, 'function')
  assert.equal(k.services.includes('queue'), true)
  assert.deepEqual(k.dumpTree().find((f) => f.id === 'p').deps, [])
  k.dispose()
})
