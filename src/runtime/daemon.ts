import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { SeamId } from '../../seams/vocabulary.js'
import { CONTRACT_VERSION } from '../../seams/contract-version.js'
import { bindings } from '../profiles/bindings.js'
import type { Profile } from '../profiles/types.js'
import type {
  MemoryService, AgentAdapterProvider, TransportProvider, UiProvider, LlmProvider,
  AuditProvider, PolicyProvider, RetainInput, RecallInput, ReflectInput,
} from '../pipeline/types.js'
import { createL0Stack, type L0Stack } from './l0-stack.js'
import { assemble, type Assembled } from './assemble.js'
import { createWorkerLoop, type WorkerLoopHandle } from './worker-loop.js'
import { reflectWithModel } from './llm-gateway.js'
import type { PreparedLlmProvider } from '../providers/openai-compatible.js'
import type { PgLikeClient } from '../providers/pgvector.js'
import { pgAudit, type PgAuditProvider } from '../providers/pg-audit.js'
import { directoryPolicy, type Identity, type IdentityGate, type MemberDirectory } from './identity.js'

/**
 * ③ 常驻服务 + ④ 身份与审计持久化。
 *
 * 全部通过既有 seam 装配，**不改契约、不改场景插件、不改 A/B profile、不改内核**：
 *   - `agent-adapter` 校验 operation 并正规化请求形状
 *   - `transport` 负责 JSON 编解码，`ui` 负责根视图渲染
 *   - `isolation-policy` 换成目录驱动的 ABAC（角色/敏感度/设备/时间窗）
 *   - `audit` 换成 pgAudit，后台 worker 批量落库
 *   - `worker` 循环驱动 drain + flush（records + audit）
 *
 * ④ 的信任边界收紧：**principal 不再信任请求体自报**，而是从已验证的
 * HMAC token 派生；未配身份目录时保持 ③ 的旧行为（或共享 Bearer）。
 *
 * 单写进程：L0 存储是内存镜像，同一时刻只允许一个 daemon 写。
 * stop() 刻意**不调用 app.dispose()** —— 那是插件卸载语义，会把记录归档待审。
 */

export interface DaemonProfileOptions {
  llm?: LlmProvider
  storage?: unknown
  vector?: unknown
  audit?: AuditProvider
  policy?: PolicyProvider
}

export function daemonProfile(options: DaemonProfileOptions = {}): Profile {
  const overrides: Partial<Record<SeamId, () => unknown>> = {}
  if (options.storage) overrides['storage'] = () => options.storage
  if (options.vector) overrides['vector'] = () => options.vector
  if (options.llm) overrides['llm'] = () => options.llm
  if (options.audit) overrides['audit'] = () => options.audit
  if (options.policy) overrides['isolation-policy'] = () => options.policy
  return { name: 'profile-daemon', providers: bindings(overrides) }
}

export interface DaemonOptions {
  /** 真实 PG 或离线 mock，注入式，便于零依赖验收。 */
  client: PgLikeClient
  /** 可选真模型 provider；不传则用默认确定性桩，不发网络。 */
  llm?: LlmProvider
  host?: string
  /** 0 = 系统分配临时端口（测试用）。 */
  port?: number
  workerIntervalMs?: number
  autoStartWorker?: boolean
  maxBodyBytes?: number
  /** ③ 遗留：设了才启用共享 Bearer；/health 豁免。与 identity 互斥。 */
  token?: string
  /** ④ 身份门：配了则 principal 由签名 token 派生，忽略 MH_HTTP_TOKEN。 */
  identity?: IdentityGate
  /** ④ 成员目录：配了则 isolation-policy 换成目录驱动 ABAC。 */
  directory?: MemberDirectory
  adapter?: AgentAdapterProvider
  transport?: TransportProvider
  ui?: UiProvider
  /** 可注入自定义 audit provider（默认 pgAudit）。 */
  audit?: AuditProvider
  now?: () => string
}

export interface DaemonHandle {
  readonly url: string
  readonly host: string
  readonly port: number
  readonly profile: Profile
  readonly service: MemoryService
  readonly app: Assembled
  readonly stack: L0Stack
  readonly worker: WorkerLoopHandle
  readonly audit: AuditProvider
  readonly identityEnabled: boolean
  readonly server: Server
  stop(): Promise<void>
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'HttpError'
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function str(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    let settled = false
    const done = (fn: () => void) => { if (!settled) { settled = true; fn() } }
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) { tooLarge = true; return }
      chunks.push(c)
    })
    req.on('end', () => done(() => {
      if (tooLarge) reject(new HttpError(413, 'payload-too-large'))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    }))
    req.on('error', (e) => done(() => reject(e)))
    req.on('aborted', () => done(() => reject(new HttpError(400, 'request-aborted'))))
  })
}

export async function createDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const {
    client, llm, host = '127.0.0.1', port = 0,
    workerIntervalMs = 1000, autoStartWorker = true,
    maxBodyBytes = 1_048_576, token,
    identity: gate, directory,
    now = () => new Date().toISOString(),
  } = options

  if (gate && token) throw new Error('createDaemon: identity 与 token 互斥，只能配一个')

  const stack = await createL0Stack(client)
  const audit: AuditProvider = options.audit ?? pgAudit({ client, now })
  const policy = directory ? directoryPolicy(directory, { now }) : undefined
  const profile = daemonProfile({ llm, storage: stack.storage, vector: stack.vector, audit, policy })
  const app = assemble(profile)
  const service = app.service
  if (!service) throw new Error('场景插件未就绪')

  const adapter = options.adapter ?? app.kernel.resolve<AgentAdapterProvider>('agent-adapter')
  const transport = options.transport ?? app.kernel.resolve<TransportProvider>('transport')
  const ui = options.ui ?? app.kernel.resolve<UiProvider>('ui')
  if (!adapter || !transport || !ui) throw new Error('外围接入 seam 未就绪')
  // strict 下嵌套闭包会丢失可选变量收窄，统一用非空别名（依赖已由内核保证就绪）。
  const serviceRef = service, adapterRef = adapter, transportRef = transport, uiRef = ui

  const auditRef = app.kernel.resolve<AuditProvider>('audit') ?? audit
  const flushable = auditRef as Partial<PgAuditProvider>
  const auditFlush = typeof flushable.flush === 'function'
    ? () => (auditRef as PgAuditProvider).flush()
    : async () => 0

  const worker = createWorkerLoop({
    service: serviceRef,
    flush: async () => (await stack.flush()) + (await auditFlush()),
    pendingWrites: () => stack.pendingWrites() + (typeof flushable.pending === 'function' ? (auditRef as PgAuditProvider).pending() : 0),
    intervalMs: workerIntervalMs,
    autoStart: autoStartWorker,
    now,
  })

  let requestCounter = 0
  const endpointList = [
    'GET /health', 'GET /stats', 'GET /tree', 'GET /',
    'POST /retain', 'POST /recall', 'POST /reflect',
    'POST /sync', 'POST /archive', 'POST /precompute',
  ]

  function send(res: ServerResponse, status: number, payload: unknown, requestId: string): void {
    let body: string
    try { body = transportRef.encode(payload) } catch { body = '{"error":"encode-failed"}' }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-request-id': requestId,
      'x-contract-version': CONTRACT_VERSION,
    })
    res.end(body)
  }

  function parse(raw: string): unknown {
    try { return transportRef.decode(raw) } catch {
      throw new HttpError(400, 'invalid-json')
    }
  }

  /** 通过 agent-adapter seam 校验 operation；协议细节不进内核。 */
  function adapt(operation: string, payload: unknown): void {
    const res = adapterRef.handle({ operation, payload })
    if (res.status !== 200) throw new HttpError(res.status, 'unsupported-operation')
  }

  /** ④ 核心：principal 来自已验证 token，不自报。 */
  function resolvePrincipal(body: Record<string, unknown>, who: Identity | null): string {
    const declared = str(body, 'principal')
    if (who) {
      if (declared && declared !== who.principal) throw new HttpError(400, 'principal-mismatch')
      return who.principal
    }
    if (!declared) throw new HttpError(400, 'missing-required-field')
    return declared
  }

  async function dispatch(
    path: string, raw: string, who: Identity | null, requestId: string,
  ): Promise<{ status: number; body: unknown }> {
    const parsed = raw.trim() === '' ? {} : parse(raw)
    const body = parsed
    if (!isObject(body)) throw new HttpError(400, 'body-must-be-object')

    switch (path) {
      case '/retain': {
        const principal = resolvePrincipal(body, who)
        const bank = str(body, 'bank_id')
        const content = str(body, 'content')
        if (!bank || !content) throw new HttpError(400, 'missing-required-field')
        adapt('retain', body)
        const input: RetainInput = {
          principal, bank_id: bank, content,
          occurred_at: typeof body.occurred_at === 'string' ? body.occurred_at : undefined,
          valid_from: typeof body.valid_from === 'string' ? body.valid_from : null,
          valid_to: typeof body.valid_to === 'string' ? body.valid_to : null,
          scene: typeof body.scene === 'string' ? body.scene : null,
          raw_pointer: typeof body.raw_pointer === 'string' ? body.raw_pointer : null,
        }
        const r = serviceRef.retain(input)
        if (!r.accepted) {
          auditRef.record('retain.denied', { request_id: requestId, principal, bank_id: bank, operation: 'retain' })
          return { status: 403, body: r }
        }
        // 202：accepted ≠ 立刻可召回；worker 负责 visible + 落库。
        return { status: 202, body: r }
      }
      case '/recall': {
        const principal = resolvePrincipal(body, who)
        const bank = str(body, 'bank_id')
        const query = str(body, 'query')
        if (!bank || !query) throw new HttpError(400, 'missing-required-field')
        adapt('recall', body)
        const budget = typeof body.token_budget === 'number' && Number.isFinite(body.token_budget)
          ? Math.max(1, Math.floor(body.token_budget)) : 1024
        const input: RecallInput = {
          principal, bank_id: bank, query, token_budget: budget,
          valid_at: typeof body.valid_at === 'string' ? body.valid_at : null,
        }
        return { status: 200, body: serviceRef.recall(input) }
      }
      case '/reflect': {
        const principal = resolvePrincipal(body, who)
        const bank = str(body, 'bank_id')
        const question = str(body, 'question')
        if (!bank || !question) throw new HttpError(400, 'missing-required-field')
        adapt('reflect', body)
        const input: ReflectInput = {
          principal, bank_id: bank, question,
          valid_at: typeof body.valid_at === 'string' ? body.valid_at : null,
        }
        const prepared = llm as PreparedLlmProvider | undefined
        if (prepared && typeof prepared.prepare === 'function' && typeof prepared.stats === 'object') {
          return { status: 200, body: await reflectWithModel(app, prepared, input) }
        }
        return { status: 200, body: serviceRef.reflect(input) }
      }
      case '/sync': {
        const sourceId = str(body, 'sourceId')
        const watermark = str(body, 'watermark')
        if (!sourceId || !watermark || !Array.isArray(body.items)) throw new HttpError(400, 'missing-required-field')
        const items = body.items.filter(isObject).map((it) => ({
          fingerprint: typeof it.fingerprint === 'string' ? it.fingerprint : '',
          content: typeof it.content === 'string' ? it.content : '',
        }))
        adapt('sync', body)
        return { status: 200, body: serviceRef.sync({ sourceId, watermark, items }) }
      }
      case '/archive': {
        const id = str(body, 'event_id')
        if (!id) throw new HttpError(400, 'missing-required-field')
        const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason : 'manual-review'
        serviceRef.archive(id, reason)
        return { status: 200, body: { archived: id, reason } }
      }
      case '/precompute': {
        return { status: 200, body: { precomputed: serviceRef.precompute() } }
      }
      default:
        throw new HttpError(404, 'not-found')
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req_${(++requestCounter).toString(36)}_${now().replace(/\D/g, '').slice(-8)}`
    void (async () => {
      let path = '/'
      try { path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/' } catch { /* 保持 / */ }
      const method = (req.method ?? 'GET').toUpperCase()

      // 每个请求一个审计上下文；响应状态在 respond() 里补记。
      let who: Identity | null = null
      const respond = (status: number, payload: unknown): void => {
        if (path !== '/health') {
          auditRef.record('http.response', {
            request_id: requestId, path, method, status,
            principal: who?.principal ?? null, operation: path.replace(/^\//, ''),
          })
        }
        send(res, status, payload, requestId)
      }

      // ④ 认证：验签 + 目录 + 设备 + 时间窗；失败也记安全审计。
      if (gate && path !== '/health') {
        who = gate.authenticate(req.headers.authorization)
        if (!who) {
          auditRef.record('http.auth_failed', { request_id: requestId, path, method })
          respond(401, { error: 'unauthorized' })
          return
        }
        auditRef.record('http.request', {
          request_id: requestId, path, method,
          principal: who.principal, role: who.role, device: who.device,
          operation: path.replace(/^\//, ''),
        })
      } else if (token && path !== '/health') {
        const auth = req.headers.authorization ?? ''
        if (auth !== `Bearer ${token}`) {
          auditRef.record('http.auth_failed', { request_id: requestId, path, method })
          respond(401, { error: 'unauthorized' })
          return
        }
      }

      const getRoutes = new Set(['/health', '/stats', '/tree', '/'])
      const postRoutes = new Set(['/retain', '/recall', '/reflect', '/sync', '/archive', '/precompute'])
      if (getRoutes.has(path) && method !== 'GET') { respond(405, { error: 'method-not-allowed' }); return }
      if (postRoutes.has(path) && method !== 'POST') { respond(405, { error: 'method-not-allowed' }); return }

      if (method === 'GET') {
        if (path === '/health') {
          respond(200, {
            ok: true, profile: profile.name, contract_version: CONTRACT_VERSION,
            records: stack.storage.all().length,
            visible: stack.storage.all().filter((r) => r.state === 'visible').length,
            pending_writes: stack.pendingWrites(),
            worker: worker.stats, uptime_since: worker.stats.startedAt,
            identity: gate ? 'member-token' : (token ? 'shared-bearer' : 'none'),
          })
          return
        }
        if (path === '/stats') {
          respond(200, {
            profile: profile.name, contract_version: CONTRACT_VERSION,
            service: serviceRef.stats, worker: worker.stats,
            pending_writes: stack.pendingWrites(),
            records: stack.storage.all().length,
            embeddings: stack.vector.size(),
            quarantined: stack.vector.quarantined(),
            audit: {
              rows: typeof flushable.rows === 'function' ? (auditRef as PgAuditProvider).rows().length : auditRef.entries().length,
              pending: typeof flushable.pending === 'function' ? (auditRef as PgAuditProvider).pending() : 0,
            },
            identity: gate ? 'member-token' : (token ? 'shared-bearer' : 'none'),
          })
          return
        }
        if (path === '/tree') {
          respond(200, { profile: profile.name, tree: app.kernel.dumpTree() })
          return
        }
        if (path === '/') {
          const text = uiRef.render('index', { endpoints: endpointList, contract_version: CONTRACT_VERSION })
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': requestId })
          res.end(text)
          auditRef.record('http.response', { request_id: requestId, path, method: 'GET', status: 200 })
          return
        }
        respond(404, { error: 'not-found' })
        return
      }

      if (method === 'POST') {
        try {
          const raw = await readBody(req, maxBodyBytes)
          const out = await dispatch(path, raw, who, requestId)
          respond(out.status, out.body)
        } catch (err) {
          if (err instanceof HttpError) respond(err.status, { error: err.code })
          else {
            process.stderr.write(`[daemon] ${requestId} internal-error: ${String(err)}\n`)
            respond(500, { error: 'internal-error' })
          }
        }
        return
      }
      respond(405, { error: 'method-not-allowed' })
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  const addr = server.address()
  const actualPort = addr && typeof addr === 'object' ? addr.port : port

  return {
    url: `http://${host}:${actualPort}`,
    host, port: actualPort, profile, service, app, stack, worker,
    audit: auditRef, identityEnabled: Boolean(gate), server,
    async stop(): Promise<void> {
      // 最后一次 tick：把队列里剩余 job、内存镜像与审计缓冲全部落库。
      await worker.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // 刻意不调用 app.dispose()：那是插件卸载语义，会把本进程写入的记录归档待审。
      await stack.close()
    },
  }
}
