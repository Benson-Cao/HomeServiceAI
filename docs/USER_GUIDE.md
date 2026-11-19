# 最终形态与使用教程

> 适用：架构图 v1.2 · ADR v1.3 · `CONTRACT_VERSION = 1.2.0`
> 本手册面向**使用者**，不要求读过架构图。命令都在仓库根目录执行。

---

## 0. 一句话

**它是你家局域网里一台自己管的「记忆服务器」**：手机、电脑、平板、Agent 都通过 HTTP 往里写记忆、从里查记忆；每个家庭成员有自己的身份和可见范围，写进去的东西带证据链和时间，能审计、能备份、能恢复，而且换模型、换数据库、换检索引擎都不用改上面的应用。

---

## 1. 产品的最终形态是什么

### 1.1 已经是的样子（④ 之后，代码层收口）

```
        手机 · 平板 · 电脑 · 浏览器 · Agent
                    │ HTTP / JSON + Bearer 成员 token
                    ▼
┌────────────────── NAS / 主机：docker compose ──────────────────┐
│                                                                │
│  app（常驻，restart: unless-stopped）                           │
│  ├ REST 10 个端点，0.0.0.0:8080                                │
│  ├ 身份门：HMAC 签名 token → subject（不再信任请求自报）        │
│  ├ ABAC：角色 / bank 敏感度 / 设备可信度 / 时间窗               │
│  ├ 后台 worker（每 1s）：队列 → visible → PG 落库 + 审计落库   │
│  ├ 记忆治理：脱敏 → 抽取 → 证据累积 / 矛盾裁决 / 过期归档       │
│  │           → 四路召回 → 声明式融合 → token 裁剪              │
│  ├ 可选真模型：云 API / 本地网关双通道平级（默认不发网络）      │
│  └ SIGTERM → 最后一次落库 → 优雅关停                           │
│                    │ 同一进程内内存镜像（单写进程）             │
│                    ▼                                            │
│  db（常驻）PostgreSQL 16 + pgvector                            │
│  ├ memory_records      记忆 + 三时间戳 + 7 字段溯源 + 状态      │
│  ├ memory_embeddings   向量 + 维度/量化版本（静默降质拦截）     │
│  └ memory_audit_log    审计（不含记忆正文）                     │
│  命名卷 pgdata · 逻辑备份 / 恢复                                │
└────────────────────────────────────────────────────────────────┘
```

**已经具备的性质**

| 性质 | 说明 |
|---|---|
| 自托管 | 数据全在自己的 PG 卷里，没有云端依赖也能跑 |
| 多成员隔离 | parent / child 各签 token；work、health 私有域孩子看不到 |
| 可审计 | 每次请求、每次 retain/recall/拒绝都落 `memory_audit_log`，且不含正文 |
| 记忆会演进 | 相同事实累积证据不新建；矛盾裁决归档落败方；过期归档待审，**永不物理删除** |
| 可追溯 | 每条记忆带 7 字段溯源（谁写的、哪次 run、哪个模型、向量维度、契约版本） |
| 可换 | 宿主 / 模型 / 存储 / 检索 / 场景全是插件 seam，换 provider 场景代码零改动 |
| 可恢复 | `db:backup` / `db:restore`，worker 关停前强制落库 |

### 1.2 还不是的样子（必须说清，别越界期待）

| 还不是 | 现状 | 差什么 |
|---|---|---|
| 开箱即用的家庭 App | 只有 REST + JSON，没有界面 | 一个前端（A 档，填 `ui` seam） |
| 真·语义记忆 | `extractor` 按句号分句、`embedder` 是 16 维哈希 | 真 Embedding / 真 LLM 抽取 provider |
| 真·SQL 向量检索 | 四路召回在内存做 | `retriever.semantic` 换成 pgvector `<=>` |
| 自动采集 | 没有文件/日历/穿戴/聊天适配器 | `source` / `sync` provider + 合成数据验收 |
| 独立 MCP 端点 | 只开 REST | `agent-adapter` 换 `mcpAgentAdapter` 并起监听 |
| 公网 / HTTPS | 局域网裸端口 | 反代 + 证书（运维，不改代码） |
| 真实账号体系 | token 是本地 HMAC 签发的，不是 OAuth/OIDC | 外部 IdP 接入（仍填 `isolation-policy`） |

> **关键判断**：上表每一项都**不是架构缺口**。它们全部是「往既有 seam 里填真实实现」，按 `CONTRACTS.md` 的分档属于 **A 档** —— 不动 `CONTRACT_VERSION`、不改架构图、不开新 ADR、不改场景插件。
> 换句话说：**骨架已经收口，剩下的是器官**。只要接上一个真模型 + 一个真采集源 + 一个前端，形态上就等于最初那张「家庭私有化 AI 中心」概念图。

### 1.3 什么时候要重新动架构

只有一种：要把「TS 仓库 + Docker」变成**给 NAS 用户的单文件安装包**（无 Node runtime）。按 ADR-006，那是 C 档：新 ADR + 升 `CONTRACT_VERSION` + 同步改架构图版本号，Go/Rust 才重新上桌。日常加能力完全不用。

---

## 2. 五分钟跑起来

### 前置

- Docker + Docker Compose（飞牛 fnOS / 群晖 / 任意 Linux / Windows Docker Desktop 都行）
- 或 Node ≥ 18（宿主机直跑，需 `npm install`）
- 同一局域网内的手机 / 电脑

### 步骤

```bash
# 1) 拿到仓库（或解压 memory-harness-contracts.zip）
cd memory-harness-contracts

# 2) 生成配置
cp .env.example .env
#    务必改 POSTGRES_PASSWORD 与 MH_PG_DSN 里的密码（两处一致）

# 3) 成员目录
cp config/members.example.json config/members.json

# 4) 生成身份密钥
openssl rand -hex 32
#    把输出填进 .env 的 MH_IDENTITY_SECRET=
#    注意：填了它就忽略 MH_HTTP_TOKEN，两者互斥

# 5) 起服务
docker compose up -d

# 6) 健康检查
curl http://127.0.0.1:8080/health
```

预期：

```json
{"ok":true,"profile":"profile-daemon","contract_version":"1.2.0",
 "records":0,"visible":0,"pending_writes":0,
 "worker":{"ticks":1,"running":true},"identity":"member-token"}
```

看到 `"identity":"member-token"` 就说明身份模式生效了。

> 只想先试、不想配身份：把 `MH_IDENTITY_SECRET` 留空、`MH_HTTP_TOKEN` 也留空即可无鉴权运行（**仅限可信内网**）。详见 `docs/DAEMON.md`。

### 离线自检（不需要 Docker）

```bash
npm install
npm run verify                       # 116 项全绿
npm run smoke:daemon -- --mock        # 无身份，全链路
npm run smoke:daemon -- --identity    # 有身份 + 目录 ABAC + 审计落库
npm run smoke:stack -- --mock         # PG 往返
npm run smoke:llm -- --mock           # 真模型桥接（fake fetch）
```

---

## 3. 配置身份（第一次必做）

### 3.1 成员目录长什么样

`config/members.json`：

```json
{
  "members": [
    { "sub": "parent", "role": "parent",
      "banks": ["home", "work", "health", "kid"],
      "devices": ["laptop-parent", "phone-parent"] },
    { "sub": "child", "role": "child",
      "banks": ["home", "kid"],
      "devices": ["tablet-kid"] }
  ],
  "banks": {
    "home":   { "sensitivity": "family",  "owner": "parent" },
    "work":   { "sensitivity": "private", "owner": "parent" },
    "health": { "sensitivity": "private", "owner": "parent" },
    "kid":    { "sensitivity": "family",  "owner": "parent",
                "windowStart": "06:00", "windowEnd": "21:00" }
  },
  "trustedDevices": ["laptop-parent", "phone-parent", "tablet-kid"]
}
```

字段含义：

| 字段 | 作用 |
|---|---|
| `members[].sub` | 成员唯一标识，token 里的 subject |
| `members[].role` | `parent` / `admin` / `child` / `viewer`；`viewer` 不能写 |
| `members[].banks` | 该成员能访问的 bank 白名单（**硬边界**） |
| `members[].devices` | 该成员允许的设备 |
| `banks[].sensitivity` | `private` 仅属主 / admin 可读写；`family` 按角色；`public` 只读角色不得写 |
| `banks[].owner` | 私有域属主 |
| `windowStart/End` | 访问时间窗，**UTC 的 HH:mm**，支持跨午夜（如 22:00–06:00） |
| `trustedDevices` | 全局可信设备；不在列表里的设备直接 401 |

改完目录要 `docker compose restart app` 才生效。

### 3.2 看目录 / 签发 token

```bash
# 列出成员与可信设备
npm run token:issue -- --list

# 给每个「成员 × 设备」签一个
npm run token:issue -- --sub=parent --device=laptop-parent
npm run token:issue -- --sub=parent --device=phone-parent
npm run token:issue -- --sub=child  --device=tablet-kid
```

输出示例（**token 只显示这一次**）：

```json
{
  "ok": true,
  "sub": "parent", "role": "parent", "device": "laptop-parent",
  "expires_at": "2026-12-19T...",
  "ttl_seconds": 2592000,
  "token": "v1.eyJzdWIiOi...",
  "usage": "curl -s -H \"Authorization: Bearer v1....\" http://127.0.0.1:8080/stats"
}
```

把 token 存到每台设备的密码管理器里。**改 `MH_IDENTITY_SECRET` 会让所有旧 token 立即失效**（这就是轮换方式）。

> 也可以用 `MH_MEMBERS='{"members":[...]}'` 内联配置，不挂文件；优先级高于 `MH_MEMBERS_FILE`。

### 3.3 放到设备上

手机/平板最省事的方式：用支持自定义 Header 的 HTTP 客户端（如 HTTP Shortcuts、Termux、快捷指令），把

```
Authorization: Bearer <你的token>
Content-Type: application/json
```

存成预设。或者搭一个极简前端填 `ui` seam —— 那是 A 档，不改任何契约。

---

## 4. 日常使用

### 4.1 变量准备

```bash
BASE=http://127.0.0.1:8080          # 同一局域网内换成 NAS 的 IP
TOK='v1.你的token'
H="Authorization: Bearer $TOK"
```

### 4.2 写一条记忆（retain）

```bash
curl -s -X POST $BASE/retain \
  -H "$H" -H 'Content-Type: application/json' \
  -d '{
    "bank_id": "home",
    "content": "客厅灯晚上七点自动开",
    "occurred_at": "2026-11-19T19:00:00+08:00",
    "raw_pointer": "nas://photos/2026-11-19/living-room.jpg"
  }'
```

返回 **202 Accepted**：

```json
{"accepted":true,"job_id":"job_xxx","event_id":"ev_xxx","provenance":{...7字段...}}
```

⚠️ **202 不等于立刻能查到**。后台 worker 会在下一个 tick（默认 1 秒）把它变成 `visible` 并落库。这是刻意设计：`accepted → visible` 是可测 SLA。

> 身份模式下**不要**在 body 里写 `principal` —— 它由 token 决定。写了且不一致会返回 `400 principal-mismatch`。

可选字段：`occurred_at`（发生时间）、`valid_from` / `valid_to`（事实生效区间）、`scene`、`raw_pointer`。

**「换了工作」这类更正怎么写**：不要删旧记录，直接写新事实并给旧的设 `valid_to`。矛盾裁决会把落败方归档待审，双方证据链都留着。

### 4.3 查记忆（recall）

```bash
curl -s -X POST $BASE/recall \
  -H "$H" -H 'Content-Type: application/json' \
  -d '{"bank_id":"home","query":"客厅灯","token_budget":1024}'
```

```json
{
  "items": [{
    "fact_id":"ev_xxx",
    "narrative":"客厅灯晚上七点自动开",
    "time":{"occurred_at":"...","recorded_at":"...","valid_from":null,"valid_to":null},
    "provenance":{ "...7字段..." }
  }],
  "channel_hits":{"semantic":1,"bm25":1,"graph":1,"temporal":1},
  "reranked":true,"token_used":6,"quarantined":[],"contract_version":"1.2.0"
}
```

可选 `valid_at`（按某个时刻查，过期/未生效的记录自动归档待审）。

### 4.4 跨记忆综合（reflect）

```bash
curl -s -X POST $BASE/reflect \
  -H "$H" -H 'Content-Type: application/json' \
  -d '{"bank_id":"home","question":"家里的照明习惯是什么"}'
```

挂了真模型时 `synthesis` 是模型输出，并附 `model_reply`（model / latency / retries / usage）；没挂时是确定性桩，也能跑，不发网络。

### 4.5 其他端点

```bash
curl -s -H "$H" $BASE/health      # 健康（无需 token）
curl -s -H "$H" $BASE/stats       # 服务/worker/审计统计
curl -s -H "$H" $BASE/tree       # 32 个 seam 装配状态、PENDING 诊断
curl -s $BASE/                    # 端点索引

# 多源同步（端侧只缓冲，冲突回服务端裁决）
curl -s -X POST $BASE/sync -H "$H" -H 'Content-Type: application/json' \
  -d '{"sourceId":"phone-parent","watermark":"w1","items":[{"fingerprint":"fp1","content":"手机端缓冲的一条"}]}'

# 手动归档（只改状态，不删除）
curl -s -X POST $BASE/archive -H "$H" -H 'Content-Type: application/json' \
  -d '{"event_id":"ev_xxx","reason":"manual-review"}'

# 显式预计算心智模型
curl -s -X POST $BASE/precompute -H "$H" -H 'Content-Type: application/json' -d '{}'
```

### 4.6 错误码速查

| 码 | 含义 | 怎么办 |
|---|---|---|
| `400 invalid-json` / `body-must-be-object` | 请求体不是 JSON 对象 | 检查引号与 `Content-Type` |
| `400 missing-required-field` | 缺 `bank_id` / `content` / `query` / `question` | 补齐 |
| `400 principal-mismatch` | body 里自报的 principal 与 token 不符 | 删掉 `principal` 字段 |
| `401 unauthorized` | token 缺失 / 过期 / 签名错 / 设备不可信 / 不在目录 | 重新 `token:issue` |
| `403 denied` | ABAC 拒绝（bank 不在白名单 / 私有域非属主 / 时间窗外） | 查目录与 bank |
| `404 not-found` | 路径不存在 | 看 `GET /` |
| `405 method-not-allowed` | GET/POST 用反了 | 见端点表 |
| `413 payload-too-large` | 超过 1 MB | 拆成多条 |
| `500 internal-error` | 服务端异常 | `docker compose logs app` |

> `recall` 被授权拒绝时返回 **200 + 空 items**，不是 403 —— 不泄露「这个 bank 是否存在」。

### 4.7 多成员 / 多 bank 的日常建议

| bank | 谁写 | 谁读 | 用途 |
|---|---|---|---|
| `home` | 全家 | 全家 | 日程、家务、家庭事实 |
| `work` | parent | parent | 项目资料（private） |
| `health` | parent | parent | 体检、穿戴（private，最严） |
| `kid` | parent | parent + child | 学习记录（child 只读） |

**孩子拿自己的 token 查 work 会返回空结果；写 work 会 403。** 这不是靠前端隐藏，是内核 `authorize` + L2 目录策略强制的。

---

## 5. 接真模型（可选）

默认不挂任何云 API，`reflect` 用确定性桩也能跑。要真结论，二选一：

### 云 API

```bash
# .env
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=            # 留空用代码默认值
DEEPSEEK_TIMEOUT_MS=20000
```

```bash
npm run smoke:llm     # 先打 /models 打印当期真实模型名，再真调一次
docker compose restart app
```

> 官方模型名有快照漂移（旧名已退役），**以 `/models` 当期返回为准**，别照抄文档。脚本刻意不自动取第一个型号——不同型号价差数倍，选错不报错、只悄悄变贵。

### 本地网关（Ollama / vLLM / LM Studio）

```bash
LLM_LOCAL_ENDPOINT=http://127.0.0.1:11434/v1/chat/completions
LLM_LOCAL_MODEL=qwen2.5:7b
```

```bash
node examples/daemon.mjs --local     # 或 compose 里配了 LLM_LOCAL_ENDPOINT 会自动走
npm run smoke:llm -- --local
```

**隐私提醒**：健康、孩子学习、工作资料发到托管 API 与「家庭私有化」初衷有冲突。建议默认 profile 走本地模型，云 API 只挂在明确授权的部署上；`defense` 脱敏始终在 retain 之前执行。

---

## 6. 审计与合规

```bash
npm run audit:recent -- --limit=20
npm run audit:recent -- --principal=parent --bank=work
npm run audit:recent -- --mock          # 离线空库自检
```

输出每行含 `at / event / principal / bank_id / operation / request_id / payload / contract_version`。

审计会记：`http.request`、`http.response`、`http.auth_failed`、`retain.accepted`、`retain.denied`、`retain.strengthened`、`recall`、`reflect`、`sync`、冲突与过期事件。

**审计不记录记忆正文**（`content` / `query` / `question` / `token` 一律 `[redacted]`），所以审计表本身可以放心备份、放心给管理员看。

> 小特性：访问 `/stats` 自己也是一次 HTTP 请求，会再产生 2 条待落库审计。所以「pending 归零」永远比观测晚一个 tick —— 这是预期，不是 bug。

---

## 7. 备份、恢复、升级、关停

```bash
# 备份（逻辑备份，--clean --if-exists）
npm run db:backup
npm run db:backup -- /path/to/my.sql.gz

# 恢复（ON_ERROR_STOP=1）
npm run db:restore -- backups/mh-xxx.sql.gz

# 恢复演练：down → 删卷 → up db → restore → stats
docker compose down
docker volume rm memory-harness-contracts_pgdata
docker compose up -d db
npm run db:restore -- backups/mh-xxx.sql.gz
```

```bash
docker compose logs -f app       # 看日志
docker compose restart app       # 改了目录 / 环境变量后
docker compose stop app          # 优雅关停（SIGTERM → 最后一次落库）
docker compose down              # 停全部；卷还在
```

**单写进程铁律**：daemon 运行时**不要**再跑 `docker compose run --rm app node examples/l0-cli.mjs retain ...`。两个进程各持一份内存镜像会分叉。维护用 CLI 前先 `stop app`，用完 `start app`。

升级：解压新 zip 覆盖 → `docker compose up -d --build`。DDL 全是 `IF NOT EXISTS`，`ensureSchema()` 每次启动幂等执行，不用手动迁移。

---

## 8. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `docker compose up -d` 后 `/health` 连不上 | db 还没 healthy | `docker compose ps` 看 healthcheck，等 10–30s |
| 启动日志报 `缺少成员目录` | 填了 secret 但没 `config/members.json` | 从 example 复制；这是**故意启动失败**，不静默裸奔 |
| 启动报 `identity 与 token 互斥` | `.env` 里两个都填了 | 留一个 |
| 所有请求 401 | token 过期 / 换了 secret / 设备不在可信列表 | `npm run token:issue -- ...` 重签 |
| child 写 kid 403 | 目录策略：kid 只由 parent 写 | 用 parent token 写 |
| kid 在晚上查不到 | `windowStart/End` 是 **UTC** | 按 UTC 换算，或去掉窗口 |
| retain 返回 202 但立刻查不到 | 正常，等一个 worker tick | 看 `GET /stats` 的 `worker.ticks` |
| 换 embedding 维度后召回变差 | 静默降质拦截生效 | 旧向量被隔离/拒检，`quarantined` 可观测；需 DDL migration 启用新维度 |
| `smoke:daemon` 报 SKIP | 没有运行中的服务 | 先 `docker compose up -d`，或加 `--mock` / `--identity` |
| 真模型没生效 | 没填 key / 没 restart | `docker compose restart app`，看启动日志的 `llm:` 字段 |

---

## 9. 安全清单（上线前过一遍）

- [ ] `POSTGRES_PASSWORD` 与 `MH_PG_DSN` 里的密码都改了，且一致
- [ ] `MH_IDENTITY_SECRET` 是 `openssl rand -hex 32` 生成的随机值，没进 git
- [ ] `config/members.json` 只保留真实成员与设备；删掉示例里用不到的
- [ ] 每个设备一个 token，别共用；token 存密码管理器，不贴聊天
- [ ] 只对局域网开放 8080；公网访问必须加反代 + HTTPS（当前是裸 HTTP）
- [ ] `npm run db:backup` 定时跑，备份文件放到另一块盘 / 另一台机器
- [ ] 云 API 只在你明确接受「这段记忆会出网」时开启；健康 / kid 优先本地模型
- [ ] 定期 `npm run audit:recent -- --limit=50` 看 `http.auth_failed`

---

## 10. 能力边界（最后再提醒一次）

| 项 | 当前 |
|---|---|
| 记忆抽取 | 按句号分句（确定性），不是 LLM 抽事实 |
| 向量 | 16 维哈希（确定性），不是语义 embedding |
| 检索 | 四路在内存做，`memory_embeddings` 已落库但未用 SQL ANN |
| Reflect | 挂了真模型才是真综合，否则确定性桩 |
| 身份 | 本地 HMAC token + 目录，不是 OAuth/OIDC |
| 界面 | 无，`GET /` 只是端点索引 |

**这些都不影响架构正确性**：契约、状态机、证据链、冲突与静默降质拦截、ABAC 执行点、插件可换性全都是真的，且 116 项机器验收覆盖。换成真实现时，`src/scenes/` 一行都不用改。

---

## 11. 相关文档

| 文档 | 看什么 |
|---|---|
| `docs/DAEMON.md` | 常驻服务的端点、worker 语义、单写进程约束 |
| `docs/IDENTITY.md` | ④ 身份/目录/审计的设计与 A 档自查 |
| `docs/DEPLOY.md` | L0 部署、备份恢复、延迟推送手册 §10 |
| `docs/LLM.md` | 真模型接入、官方参数、双通道 |
| `CONTRACTS.md` | A/B/C 变更分档与判据 |
| `docs/ADR.md` | 6 条架构决策（含 ADR-006 语言选型） |
| `docs/RELEASE.md` | 推完代码后打 tag / Release / branch protection |
| `CHANGELOG.md` | 各切片 release notes |
| `CONTRIBUTING.md` | 怎么加 provider、怎么改契约、禁止写入内核清单 |

> 远端同步：线上仍是导入版 `4ca682f`，所有本地切片按 `docs/DEPLOY.md` §10 延迟推送，不 force、不覆盖历史。
