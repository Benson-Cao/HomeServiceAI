# ③ 常驻 REST 服务与后台 worker（④ 已叠加身份与审计）

> 基线：架构图 v1.2 · ADR v1.3 · `CONTRACT_VERSION = 1.2.0`
> 两刀都**不新增 seam、不改 schema、不升版本、不开新 ADR、不动图、不改场景插件、不改 A/B profile**。
> **使用者请先看 [`docs/USER_GUIDE.md`](USER_GUIDE.md)**（最终形态 + 详细教程）；④ 的设计见 [`docs/IDENTITY.md`](IDENTITY.md)。

---

## 1. 产品形态（这一刀真正改变了什么）

```
┌─ NAS / 主机 ───────────────────────────────────────────────────┐
│                                                                │
│  db（常驻）                    app（常驻，restart: unless-stopped）│
│  PostgreSQL 16 + pgvector      Node 20 · 0.0.0.0:8080           │
│  命名卷 pgdata                 ├ REST 监听（node:http，零依赖）   │
│  ├ memory_records              ├ 后台 worker（每 1s tick）        │
│  └ memory_embeddings           │   ├ service.drain() → visible   │
│        ▲                       │   └ stack.flush()  → PG 落库    │
│        └────── 同一进程内内存镜像 ──┤                            │
│                                ├ 可选真模型（API / 本地平级）    │
│                                └ SIGTERM → 最后一次 tick → 关闭  │
└────────────────────────────────────────────────────────────────┘
             ▲ HTTP
   电脑 / 手机 / 平板 / 浏览器 / Agent
```

**从「一次性 CLI 容器」变成「可被 App 调用的记忆 API」**：`retain` 返回 `202 Accepted + job_id`，后台 worker 让记录 `visible` 并落库，`recall` / `reflect` 随时可读。这才是图 2 家庭私有化中心真正能被多端挂上的形态。

### 一个刻意保留的约束：单写进程

L0 的 `storage` 是**进程内内存镜像**（同步 seam ↔ 异步 PG 的桥）。同一时刻只允许一个写进程，否则镜像分叉。

> ⚠️ **daemon 运行时不要再跑 `docker compose run --rm app node examples/l0-cli.mjs retain ...`**。
> 维护用 CLI 时先 `docker compose stop app`，用完再 `docker compose start app`；日常读写一律走 REST。

---

## 2. 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康探针；**豁免 Bearer**，供容器 healthcheck。返回 ok / profile / pending_writes / worker |
| GET | `/stats` | service + worker 统计、记录数、向量数、quarantined、pending_writes |
| GET | `/tree` | `dumpTree()`：32 个 seam 装配状态，PENDING 诊断 |
| GET | `/` | `ui` seam 渲染的端点索引（text/plain） |
| POST | `/retain` | `202` 已接受；`403` 授权拒绝；`400` 字段缺失 |
| POST | `/recall` | 四路召回 + 融合 + ranker/reranker，按 `token_budget` 裁剪 |
| POST | `/reflect` | 挂了真模型则走 `prepare()` 外环，否则确定性桩 |
| POST | `/sync` | 多源增量同步入口 |
| POST | `/archive` | 手动归档（只改状态，不物理删除） |
| POST | `/precompute` | 显式驱动心智模型预计算 |

响应统一 JSON；每个响应带 `x-request-id` 与 `x-contract-version: 1.2.0`。

**④ 鉴权**：配了 `MH_IDENTITY_SECRET` 后，除 `/health` 外所有端点要求 `Authorization: Bearer <成员token>`，且 **`principal` 由 token 的 `sub` 派生**，请求体里自报的 `principal` 不一致会返回 `400 principal-mismatch`。共享 `MH_HTTP_TOKEN` 仍兼容，但两者互斥；都不填则无鉴权（仅可信内网）。每次请求、每次拒绝都落审计，详见 `docs/IDENTITY.md`。

**请求体示例**

```json
// POST /retain
{"principal":"parent","bank_id":"home","content":"客厅灯晚上七点自动开"}

// POST /recall
{"principal":"parent","bank_id":"home","query":"客厅灯","token_budget":1024}

// POST /reflect
{"principal":"parent","bank_id":"home","question":"照明习惯"}
```

可选字段：`occurred_at` / `valid_from` / `valid_to` / `scene` / `raw_pointer`（retain），`valid_at`（recall / reflect）。

---

## 3. 快速开始

```bash
cp .env.example .env                              # 改默认密码
cp config/members.example.json config/members.json
openssl rand -hex 32                              # 填进 .env 的 MH_IDENTITY_SECRET
docker compose up -d                              # db + app 都常驻
curl http://127.0.0.1:8080/health                 # 应看到 identity: member-token

npm run token:issue -- --sub=parent --device=laptop-parent   # 给每台设备签 token

# 离线自检（不需要 PG / 密钥）
npm run smoke:daemon -- --mock         # 无身份全链路
npm run smoke:daemon -- --identity     # 身份 + 目录 ABAC + 审计落库
npm run smoke:daemon                   # 探测已运行服务
```

宿主机直接跑（不经过容器）：

```bash
npm install
node examples/daemon.mjs
```

### curl 手工调用

```bash
curl -s -X POST http://127.0.0.1:8080/retain \
  -H 'Content-Type: application/json' \
  -d '{"principal":"parent","bank_id":"home","content":"客厅灯晚上七点自动开"}'

curl -s -X POST http://127.0.0.1:8080/recall \
  -H 'Content-Type: application/json' \
  -d '{"principal":"parent","bank_id":"home","query":"客厅灯"}'

curl -s http://127.0.0.1:8080/stats
```

设了 `MH_HTTP_TOKEN` 时，除 `/health` 外都要加：

```bash
curl -s -H "Authorization: Bearer $MH_HTTP_TOKEN" http://127.0.0.1:8080/stats
```

---

## 4. 后台 worker 语义

一个 **tick = `service.drain()` + `stack.flush()`**，默认每 `MH_WORKER_INTERVAL_MS=1000` ms 一次。

| 性质 | 实现 |
|---|---|
| 单并发 | in-flight 复用，并发 `tick()` 共享同一结果、不重叠 |
| 失败不抛穿 | flush 抛错只记 `stats.lastError` / `failures`，下次 tick 重试（UPSERT 幂等） |
| 关停保证 | `SIGTERM` / `SIGINT` → 最后一次 tick → 关监听 → 关 PG |
| 可观测 | `ticks / drained / flushed / failures / lastAcceptedToVisibleMs`，`/stats` 与 `/health` 都能读 |
| 不 dispose | 刻意不调 `assembled.dispose()`，那是插件卸载语义，会把记录归档待审 |

`retain` 仍返回 `202`，**`accepted ≠ 立刻可召回`**；`accepted → visible` 现在是真实可测 SLA，不再是模拟延迟。

---

## 5. 装配：全部走既有 seam

`daemonProfile()` 只是 `bindings()` 上加三个覆盖（`storage` / `vector` / 可选 `llm`），**seam 集合与 A/B 严格一致**（测试 ⑭ 断言）。

| 用到的既有 seam | 用途 |
|---|---|
| `agent-adapter` | 校验 operation 白名单并正规化请求形状；换 `mcpAgentAdapter` 即换 wire shape |
| `transport` | JSON 编解码 |
| `ui` | `/` 根视图渲染 |
| `worker` / `queue` | 后台 tick 与有界队列 |
| `isolation-policy` | 内核强制三元组鉴权；④ 换成 `directoryPolicy()` 目录驱动 ABAC，执行点仍在 L2 |
| `audit` | ④ 换成 `pgAudit()`，worker tick 批量落 `memory_audit_log`（正文脱敏） |

`src/scenes/memory-scene.ts` **一行未改**；`src/kernel/` 零改动，纯度检查 PASS。

**双通道平级**：`examples/daemon.mjs` 只有在显式配了 `LLM_LOCAL_ENDPOINT` / `--local` 或 `DEEPSEEK_API_KEY` 时才挂真模型；否则用确定性桩、不发网络。`reflect` 通过 `reflectWithModel()` 的 `prepare()` 外环把真结果注入同步槽，内核同步消费。

---

## 6. 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `MH_HTTP_HOST_PORT` | `8080` | 宿主机映射端口 |
| `MH_HTTP_HOST` / `MH_HTTP_PORT` | `0.0.0.0` / `8080` | 容器内监听地址与端口 |
| `MH_HTTP_TOKEN` | 空 | 兼容模式：非空=除 `/health` 外要求共享 Bearer。**与 `MH_IDENTITY_SECRET` 互斥** |
| `MH_IDENTITY_SECRET` | 空 | ④ 推荐：`openssl rand -hex 32` 生成；填了就启用成员 token，忽略 `MH_HTTP_TOKEN` |
| `MH_MEMBERS_FILE` | `/app/config/members.json` | 成员目录路径；先 `cp config/members.example.json config/members.json` |
| `MH_MEMBERS` | 空 | 内联目录 JSON，优先级高于文件 |
| `MH_TOKEN_TTL_SECONDS` | `2592000` | `token:issue` 默认有效期（秒） |
| `MH_WORKER_INTERVAL_MS` | `1000` | 后台 tick 间隔 |
| `MH_HTTP_URL` | `http://127.0.0.1:8080` | `smoke:daemon` 探测目标 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_TIMEOUT_MS` | — | 云 API 通道（② 已定义） |
| `LLM_LOCAL_ENDPOINT` / `LLM_LOCAL_MODEL` | — | 本地 OpenAI 兼容网关 |

---

## 7. 边界（别越界期待）

- **④ 已有本地身份，但不是账号体系**：`principal` 来自 HMAC 签名成员 token + 目录 ABAC，不再是自报字符串；但它不是 OAuth/OIDC，没有自助注册 / 密码找回 / 联合登录。接外部 IdP 仍是 A 档（填 `isolation-policy`）。
- **MCP 未起独立监听端点**：`mcpAgentAdapter` 是同一 `agent-adapter` seam 的另一个 provider，换装配即可改 wire shape；本刀只开 REST。
- **SQL 级 ANN 未接**：四路召回仍在内存做，`memory_embeddings` 表已落库。
- **`retain` 抽取仍是确定性实现**：`extractor` 分句、`embedder` 16 维哈希、`precompute` 截断 240 字。只有 `reflect` 拿到真模型输出。
- **HTTPS / 反代 / 远程隧道 / 真实多端 UI 仍属运维与后续切片**；局域网裸端口仅供内网。
- **备份仍是逻辑备份**，非 PITR；见 `docs/DEPLOY.md` §6。

---

## 8. A 档落点自查

③ 的 diff 落在 `src/runtime/worker-loop.ts` / `daemon.ts`、`tests/daemon.test.mjs`、`examples/daemon.mjs`、`scripts/smoke-daemon.mjs`、`docs/DAEMON.md`、compose / Dockerfile / `.env.example` / package.json / README / DEPLOY / provider-swap 禁用词。
④ 又叠加 `src/runtime/identity.ts`、`src/providers/pg-audit.ts`、`scripts/load-members.mjs` / `issue-token.mjs` / `audit-query.mjs`、`config/members.example.json`、`tests/identity.test.mjs`、`docs/IDENTITY.md` / `USER_GUIDE.md`，以及 `pgvector.ts` / initdb 的 DDL 追加。详见 `docs/IDENTITY.md` §8。

- 未动 `seams/*.ts`、10 份 schema、`CONTRACT_VERSION` 仍 **1.2.0**
- 架构图 **v1.2 不动**、ADR 仍 6 条、registry 32 seam 状态不变
- `src/scenes/`、`src/kernel/`、`src/profiles/profile-a.ts` / `profile-b.ts` **零改动**
- `provider-swap` 禁用词表扩到 ②③④ 实现名，机器约束继续生效；内核违例注入仍 FAIL → 还原 PASS
- **零新依赖**：HTTP 用 `node:http`，token 用 `node:crypto`；`pg` 仍是 optionalDependency；`npm run verify` 不加载任何网络 / 数据库
- ③④ 共 34 项专项全部离线：`createMockPgClient` + 临时端口 + fake fetch + 固定时刻

---

## 9. 下一刀

**④ 已完成**（身份与审计落库，见 `docs/IDENTITY.md`）。
**⑤ 仓库运维收尾**：本地物料已备好（badge / `CHANGELOG.md` / `CONTRIBUTING.md` / PR·Issue 模板 / `docs/RELEASE.md` / `scripts/deferred-push.mjs`）。真正执行 tag / Release / branch protection 需要 GitHub 权限，按 `docs/DEPLOY.md` §10 与 `docs/RELEASE.md` 做。
代码层面架构已收口；后续真模型全链路、采集器、前端、SQL ANN 全属 A 档填充，不动契约。

> 远端同步仍按 `docs/DEPLOY.md` §10 延迟推送：线上 `4ca682f`，本地提交链独立，不 force。
