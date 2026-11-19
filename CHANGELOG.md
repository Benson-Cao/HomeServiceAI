# Changelog

所有版本都遵循 `CONTRACTS.md` 的 A/B/C 变更分档。`CONTRACT_VERSION` 自 v1.2.0 起未变 —— 下表全部是 **A 档填充既有 seam**，未动契约字段、架构图 v1.2、ADR（6 条）。

---

## v1.2.0（待发布 tag）

> 发布动作见 `docs/RELEASE.md`。基线：架构图 v1.2 · ADR v1.3 · `CONTRACT_VERSION = 1.2.0`。

### ④ 身份与审计持久化
- `principal` 不再信任请求体自报，改由 HMAC 签名成员 token（`v1.payload.sig`）的 `sub` 派生
- 目录驱动 ABAC：角色 / bank 敏感度·属主 / 设备可信度 / UTC 时间窗（支持跨午夜），执行点仍在 L2 `isolation-policy`
- `pgAudit()` 填 `audit` seam，worker tick 批量落 `memory_audit_log`；`content`/`query`/`token` 一律脱敏，审计不含记忆正文
- 新增 `npm run token:issue`（`--list` / 按成员×设备签发）、`npm run audit:recent`、`npm run smoke:daemon -- --identity`、`config/members.example.json`
- 兼容共享 `MH_HTTP_TOKEN`，但与 `MH_IDENTITY_SECRET` 互斥；两者都空则仅可信内网无鉴权

### ③ 常驻 REST 服务与后台 worker
- 原生 `node:http` 常驻 10 个端点；`app` 改 `restart: unless-stopped`，加 healthcheck
- `createWorkerLoop()` 单并发 tick = `drain()` + `flush()`（records + audit），`retain` 返回 **202 Accepted**，`accepted→visible` 成为真实可测 SLA
- 优雅关停（SIGTERM/SIGINT）：最后一次落库 → 关闭监听 → 关闭 PG；**不调用 `app.dispose()`**（那是插件卸载语义，会归档记录）
- 单写进程约束：daemon 运行时不得再跑 `l0-cli` 写容器

### ② 真模型 provider
- `openAiCompatibleLlm()` 填 `llm` seam：`fetch` + `AbortController` 超时、429 尊重 `Retry-After` 退避、协议错误不抛穿内核、`usage` 可观测
- 云 API / 本地网关**双通道平级**，无默认通道；默认 profile 不发网络
- 同步契约阻抗：`prepare()` 异步真调 → 同步槽 → `reflect()` 原样消费；场景插件零改动
- `npm run smoke:llm`（先列 `/models` 再真调）、`--local` 模式；真调用不进 `verify` / CI

### L0 自托管持久化
- 多阶段 `Dockerfile` + `docker compose`（db 常驻 PG16+pgvector，app 常驻）+ 命名卷 + healthcheck
- `pgvectorStorage` / `pgVectorIndex` 填 `storage` + `vector` seam；内存镜像 + flush 全量 diff 桥接同步契约与异步 PG
- `memory_records`（三时间戳 / 7 字段溯源 / 状态机）、`memory_embeddings`（`vector(16)` + 量化版本，静默降质拦截）
- `npm run db:backup` / `db:restore`（`--clean --if-exists` / `ON_ERROR_STOP=1`）、`smoke:stack --mock`、`docker compose config -q`

### V0.8 评审回归修复
- Windows 兼容：`fileURLToPath` 路径、纯 JS `tsc.js` 入口、`build/` 不提交 + 六个 pre 钩子
- 三个真实逻辑缺陷：defense `/g` 正则 `lastIndex` 残留漏检、`resumableSync` 断点续传空壳、consolidator 判重口径不一致
- ⓗ 测试与真实 UTC 时钟解耦；CI 增加 `windows-latest` matrix，并修了 YAML flow mapping 与 glob 不展开两处新缺陷

### V0.7 全栈闭环
- `seam-registry.json` 32 个 seam 全部 `implemented`，V0.5 桩整体退役
- 四路检索（semantic / bm25 / graph / temporal）+ 声明式 `CHANNEL_WEIGHTS` RRF 融合 + ranker / reranker
- 增量同步：水位线 / 指纹去重 / 断点续传 / lag 可观测；端侧只缓冲不裁决
- 冲突与过期治理：相同断言证据累积不覆盖、矛盾裁决归档落败方、`valid_from~valid_to` + freshness 归档待审、**永不物理删除**
- Reflect、心智模型预计算、ABAC 四维、defense 脱敏、外围接入（source / agent-adapter / ui / transport / ocr）

### 契约与内核（更早）
- 10 份 JSON Schema + TS 类型，单一版本源 `CONTRACT_VERSION = 1.2.0`
- L1 微内核五件事：生命周期 / 声明式依赖（缺失 PENDING 不崩）/ 类型化事件总线 / `ctx` 逆序回收 / 契约版本 + 强制鉴权（fail-closed）
- 三道机器约束：schema 版本一致、内核破功静态检查、`换 provider 零改动` 静态断言
- 技术债 TD-001 消除：TS 编译链补齐，版本源来自编译产物

---

## 分档提示（给后续贡献者）

| 你想改什么 | 档 | 动作 |
|---|---|---|
| 加真实 provider / 采集器 / 前端 / SQL ANN | **A** | 直接改 `src/providers/` 等，`npm run verify` 过一遍 |
| 新增 seam / 新增可选字段 / 新增 profile | **B** | MINOR → `1.3.0`，跑通换 provider 测试，改 registry |
| 删字段 / 改字段语义 / 推翻决策 / 单文件安装包 | **C** | MAJOR → 必须新 ADR + 升版本 + 同步改架构图版本号 |

**ADR-004「切忌在 V0.5 铺开」是排期纪律，不是契约冻结。**
