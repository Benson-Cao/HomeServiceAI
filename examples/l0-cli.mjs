#!/usr/bin/env node
/**
 * L0 唯一读写入口（一次性进程：hydrate → 操作 → flush → 退出）。
 * 容器内：docker compose run --rm app node examples/l0-cli.mjs <cmd>
 * 宿主机：node examples/l0-cli.mjs <cmd>（需 .env + npm install）
 */
import { loadDotEnv, resolveDsn, connectPg } from '../scripts/pg-connect.mjs'
import { createL0Stack } from '../build/src/runtime/l0-stack.js'
import { assemble } from '../build/src/runtime/assemble.js'

const argv = process.argv.slice(2)
const flags = {}
const pos = []
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=')
    flags[k] = v ?? true
  } else pos.push(a)
}
const cmd = pos[0] ?? 'stats'
const principal = flags.principal ?? process.env.MH_PRINCIPAL ?? 'parent'
const bank = flags.bank ?? process.env.MH_BANK ?? 'home'

loadDotEnv()
const client = await connectPg(resolveDsn())
const stack = await createL0Stack(client)
const assembled = assemble(stack.profile)
const svc = assembled.service
if (!svc) throw new Error('场景插件未就绪')

let out
switch (cmd) {
  case 'stats':
    out = {
      profile: stack.profile.name,
      records: stack.storage.all().length,
      visible: stack.storage.all().filter((r) => r.state === 'visible').length,
      archived: stack.storage.all().filter((r) => r.state === 'archived').length,
      embeddings: stack.vector.size(),
      quarantined: stack.vector.quarantined(),
      pendingWrites: stack.pendingWrites(),
      contractVersion: stack.contractVersion,
    }
    break
  case 'retain': {
    const text = pos.slice(1).join(' ')
    if (!text) throw new Error('用法：retain <文本> [--principal=x] [--bank=x]')
    const r = svc.retain({ principal, bank_id: bank, content: text })
    svc.drain()
    out = r
    break
  }
  case 'recall': {
    const query = pos.slice(1).join(' ')
    if (!query) throw new Error('用法：recall <查询> [--principal=x] [--bank=x]')
    out = svc.recall({ principal, bank_id: bank, query, token_budget: Number(flags.budget ?? 1024) })
    break
  }
  case 'reflect': {
    const question = pos.slice(1).join(' ')
    if (!question) throw new Error('用法：reflect <问题>')
    out = svc.reflect({ principal, bank_id: bank, question })
    break
  }
  case 'archive': {
    const [id, ...reasonParts] = pos.slice(1)
    if (!id) throw new Error('用法：archive <event_id> <原因>')
    svc.archive(id, reasonParts.join(' ') || 'manual-review')
    out = { archived: id }
    break
  }
  default:
    throw new Error(`未知命令 ${cmd}（可用：stats / retain / recall / reflect / archive）`)
}

// 注意：不调用 assembled.dispose() —— 它会把本插件写入的记录标为「归档待审」。
// 退出前必须 flush，否则内存镜像中尚未落库的写会丢失。
await stack.flush()
console.log(JSON.stringify(out, null, 2))
await stack.close()
