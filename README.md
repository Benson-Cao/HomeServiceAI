# Memory Harness · Contracts + Kernel

[![contracts-and-kernel](https://github.com/Benson-Cao/HomeServiceAI/actions/workflows/kernel-purity.yml/badge.svg)](https://github.com/Benson-Cao/HomeServiceAI/actions/workflows/kernel-purity.yml)

> 插件化记忆运行底盘的**契约仓库 + L1 微内核 + V0.7 全栈闭环 + L0 自托管部署 + ② 真模型 + ③ 常驻 REST/worker + ④ 身份与审计持久化**。
> 基线：架构图 v1.2 · ADR v1.3（含 ADR-006）· `CONTRACT_VERSION = 1.2.0`。
> **代码层架构已收口**：换宿主 / 换模型 / 换引擎 / 换场景都不改场景代码。后续真实模型、采集器、前端全属 A 档填充。

## 📖 先看这里

- **不知道这是什么、想直接用** → [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)（最终形态 + 详细使用教程）
- 想部署 / 备份 → [`docs/DEPLOY.md`](docs/DEPLOY.md)
- 想接真模型 → [`docs/LLM.md`](docs/LLM.md)
- 想看常驻服务端点 → [`docs/DAEMON.md`](docs/DAEMON.md)
- 想看 ④ 身份设计 → [`docs/IDENTITY.md`](docs/IDENTITY.md)
- 推完代码要发版 → [`docs/RELEASE.md`](docs/RELEASE.md) · [`CHANGELOG.md`](CHANGELOG.md)
- 要贡献代码 → [`CONTRIBUTING.md`](CONTRIBUTING.md)

## 语言与编译链（ADR-006）

- **TypeScript（Node ≥ 18，ESM）是内核与插件的唯一主语言**；`src/` 全部 `.ts`，经 `tsc` 编译到 `build/`。
- 测试 / CI 工具链用 `.mjs`，**不承载业务逻辑**。
- `typescript` / `@types/node` 是**构建期** devDependency；L0 的 `pg` 是 optionalDependency。HTTP 用原生 `node:http`、token 用 `node:crypto`，**核心运行时零第三方依赖**。
- Python 只做模型侧进程外 provider；Go / Rust 不进 V0.5。
- 技术债 TD-001 **已消除**：版本源来自编译产物 `build/seams/contract-version.js`。

## 目录

```
seams/          契约与类型（TS 源 + 10 份 JSON Schema + seam-registry.json）
src/kernel/     L1 微内核：生命周期 / 依赖 / 事件 / 可逆副作用 / 版本+鉴权 + CLI
src/providers/  默认 provider 候选：32 个 seam 全覆盖 + pgvector + openai-compatible + pgAudit
src/pipeline/   词汇与溯源类型、7 字段 Provenance
src/scenes/     场景插件（唯一一份，只认 seam id，不含任何 provider 名）
src/profiles/   两份装配清单：结构相同，仅 provider 实现不同（其余装配运行时生成）
src/runtime/    assemble + l0-stack + llm-gateway + worker-loop + daemon + identity
config/         members.example.json（④ 成员目录模板）
tests/          内核 15 / 换 provider 4 / 横切 12 / 治理 7 / 全栈 11 / 回归 7
                / L0 11 / 真模型 15 / 常驻 15 / 身份审计 19 = 116 项
ci/             build wrapper / schema 校验 / 内核破功静态检查
docker/         initdb DDL（与 SCHEMA_SQL 由测试断言同源）
scripts/        PG 连接 / mock / 备份 / 三个 smoke / token:issue / audit:recent
examples/       l0-cli（维护用）+ daemon.mjs（常驻入口）
docs/           ADR.md、USER_GUIDE.md、DEPLOY.md、DAEMON.md、LLM.md、IDENTITY.md、验收集
```

## 命令

```bash
npm install          # 首次：装构建期依赖（typescript + @types/node，可选 pg）
npm run verify       # schema → 内核纯度 → 单测（pretest 自动先 tsc 构建）
npm test             # 116 项单测；pretest 自动构建，不依赖仓库里是否已有 build/
npm run acceptance   # 12 项横切验收
npm run governance   # 7 项冲突与过期治理专项
npm run stack        # 11 项 V0.7 全栈专项
npm run dump:tree    # 插件树 + PENDING 诊断
```

### 跑起来（详见 `docs/USER_GUIDE.md`）

```bash
cp .env.example .env && cp config/members.example.json config/members.json
# 改默认密码；openssl rand -hex 32 填进 MH_IDENTITY_SECRET
docker compose up -d
curl http://127.0.0.1:8080/health

npm run token:issue -- --sub=parent --device=laptop-parent   # 给每台设备签 token
npm run smoke:daemon -- --identity    # 离线全链路（身份 + ABAC + 审计落库）
npm run audit:recent -- --limit=20    # 查审计
```

`retain` 返回 **202 Accepted**，后台 worker 让记录 `visible` 并落库。**单写进程**：daemon 运行时别再跑 `l0-cli` 写容器。

### ③/④ 服务端点

`GET /health /stats /tree /`，`POST /retain /recall /reflect /sync /archive /precompute`。
④ 之后 `principal` 由签名成员 token 派生，不再信任请求体自报；共享 Bearer 仍兼容但互斥。

### ② 真模型

```bash
npm run smoke:llm             # 先列 /models 核对当期模型名，再真调一次
npm run smoke:llm -- --local  # 本地 OpenAI 兼容网关
```

默认不挂云 API：只有显式装配才发网络。真调用不进 `verify` / CI。

### 备份

```bash
npm run db:backup
npm run db:restore -- backups/mh-xxx.sql.gz
```

## 三道机器约束

1. `ci/check-schemas.mjs`：JSON 契约版本必须等于 TS 单一源 `CONTRACT_VERSION`。
2. `ci/kernel-purity.mjs --dir src/kernel`：内核 PR 出现场景名 / 模型名·provider 名·品牌名 / 部署通道判断 / 检索策略 / 场景授权分支，任一即 FAIL。
3. `tests/provider-swap.test.mjs`：静态证明场景插件源码不含任何 provider 实现名 —— **换 provider 零改动**是可跑的断言；禁用词表随 ②③④ 扩展。

## 仓库与推送

远端 `Benson-Cao/HomeServiceAI` / `main`。线上仍是导入版 `4ca682f`（1 Commit / failure），本地是独立提交链，**两者历史无关，所有切片均未推送**。

有电脑时一键推送（凭据用你本机 git，不需要给任何人 token）：

```bash
npm run push:deferred -- --dry-run --yes   # 离线全演练，连 fast-forward push 一起验
npm run push:deferred -- --yes             # 真正推送
```

脚本以线上为父叠**一个替换提交**，不 force、不覆盖导入记录，并会清掉线上残留的 `build/` 跟踪产物。之后按 `docs/RELEASE.md` 做 tag / Release / branch protection。凭据一律走本地环境变量，不进仓库、不进对话。

MIT

## 各切片收口

| 切片 | 内容 |
|---|---|
| **V0.7** | 32 个 seam 全部 `implemented`；四路检索 + 声明式 RRF、增量同步、ABAC 四维、defense、Reflect、预计算。其中 26 个进主链路，6 个是外围接入契约 |
| **L0** | `pgvectorStorage` / `pgVectorIndex` 填 `storage` + `vector`；内存镜像 + flush 全量 diff；三时间戳 / 7 字段溯源 / `vector(16)`；备份恢复、compose healthcheck |
| **②** | `openAiCompatibleLlm()` 填 `llm` seam；`prepare()` 异步外环 + `complete()` 同步槽；云 API / 本地双通道平级；超时 / 429 退避 / usage 可观测 |
| **③** | `node:http` 常驻 REST 10 端点；`createWorkerLoop()` 单并发 tick = drain + flush；`app` 改 `restart: unless-stopped`；优雅关停不触发 dispose 归档 |
| **④（本刀）** | HMAC 成员 token → principal 由签名派生；`directoryPolicy()` 目录驱动 ABAC；`pgAudit()` 落 `memory_audit_log`（正文脱敏）；`token:issue` / `audit:recent`；19 项专项 |

**全部 A 档**：未动 `seams/*.ts`、10 份 schema、架构图 v1.2、ADR（仍 6 条）、registry 32 seam 状态、场景插件、内核、A/B profile。判据见 `CONTRACTS.md`。

## 构建与平台

仓库**不提交 `build/`**（`.gitignore` 忽略）。`pretest` / `preacceptance` / `pregovernance` / `prestack` / `predump:tree` / `prepack` 自动构建，所以 `git clone → npm install → npm test` 与 `npm pack` 都不会因缺产物失败。构建只定位 `typescript/lib/tsc.js` 纯 JS 入口，不用平台相关的 `.bin/tsc` 脚本。

CI 跑 `matrix.os: [ubuntu-latest, windows-latest]`。容器与备份脚本不进 CI（需 Docker daemon）；离线部分由 `tests/l0-pgvector.test.mjs`、`tests/daemon.test.mjs`、`tests/identity.test.mjs` 与各 `smoke --mock` 覆盖。

> 边界：`api.deepseek.com` 在沙盒返回 403、本机无 Docker daemon，所以**真模型真调与真实容器启动未跑过**；离线验收覆盖其余全部。
