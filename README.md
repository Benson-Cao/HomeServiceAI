# Memory Harness · Contracts + Kernel

> 插件化记忆运行底盘的**契约仓库 + L1 微内核 + V0.7 全栈闭环**。
> 基线：架构图 v1.2 · ADR v1.3（含 ADR-006）· `CONTRACT_VERSION = 1.2.0` · **V0.7：32 个 L2 seam 全部真实实现，无 stub / deferred**（A 档，不动契约）。

## 语言与编译链（ADR-006）

- **TypeScript（Node ≥ 18，ESM）是内核与插件的唯一主语言**；`src/` 全部 `.ts`，经 `tsc` 编译到 `build/`。
- 测试 / CI 工具链用 `.mjs`，**不承载业务逻辑**。
- `typescript` 与 `@types/node` 是**构建期** devDependency；产物是纯 ESM JS，运行时零依赖。
- Python 只做模型侧进程外 provider；Go / Rust 不进 V0.5。
- 技术债 TD-001 **已消除**：版本源来自编译产物 `build/seams/contract-version.js`，内核不再读 JSON、不再内联 `isCompatible`。

## 目录

```
seams/          契约与类型（TS 源 + 10 份 JSON Schema + seam-registry.json）
src/kernel/     L1 微内核：生命周期 / 依赖 / 事件 / 可逆副作用 / 版本+鉴权 + CLI
src/providers/  默认 provider 候选：32 个 seam 全覆盖，关键 seam 各 2 个可互换实现
src/pipeline/   词汇与溯源类型、7 字段 Provenance
src/scenes/     场景插件（唯一一份，只认 seam id，不含任何 provider 名）
src/profiles/   两份装配清单：结构相同，仅 provider 实现不同
tests/          node --test：内核 15 / 换 provider 4 / 横切 12 / 治理 7 / 全栈 11 / 评审回归 7 = 56 项
ci/             build wrapper / schema 校验 / 内核破功静态检查
src/runtime/    assemble（32 seam 全量装配）
docs/           验收集 + ADR.md（v1.3，含 ADR-006）
```

## 命令

```bash
npm install          # 首次：装构建期依赖（typescript + @types/node）
npm run verify       # 一次跑完：schema → 内核纯度 → 单测（pretest 自动先 tsc 构建）
npm test             # 56 项单测；pretest 自动构建，不依赖仓库里是否已有 build/
npm run acceptance   # 只跑 12 项横切验收
npm run governance   # 只跑 7 项冲突与过期治理专项
npm run stack        # 只跑 11 项 V0.7 全栈专项
npm run dump:tree    # 插件树 + PENDING 诊断
node build/src/kernel/cli.js --dump-tree --json --strict
```

## 三道机器约束

1. `ci/check-schemas.mjs`：JSON 契约版本必须等于 TS 单一源 `CONTRACT_VERSION`。
2. `ci/kernel-purity.mjs --dir src/kernel`：内核 PR 出现场景名 / 模型名·provider 名·品牌名 / 部署通道判断 / 检索策略 / 场景授权分支，任一即 FAIL。
3. `tests/provider-swap.test.mjs`：静态证明场景插件源码不含任何 provider 实现名 —— **换 provider 零改动**不是口号，是可跑的断言。

## 推到 GitHub

本地已 `git init` + commit（分支 `main`），**未 push** —— 需要账号授权与目标仓库。

```bash
git remote add origin git@github.com:<OWNER>/<REPO>.git
git push -u origin main
```

MIT

## V0.7 收口

`seam-registry.json` 的 32 个 seam 全部 `implemented`，V0.5 桩整体退役：

- 四路检索（semantic / bm25 / graph / temporal）独立插件 + 第五个声明式 `CHANNEL_WEIGHTS` 融合 + ranker / reranker
- 增量同步：水位线、指纹去重、断点续传、lag 可观测；端侧只缓冲不裁决
- ABAC 全量属性：角色 / 敏感度 / 设备可信度 / 时间窗口，执行点仍在 L2，profile 不授权
- defense 默认开启（脱敏）、审计、批处理窗口、Reflect、心智模型预计算、外围接入（source / agent-adapter / ui / transport / ocr）
- **口径澄清**：32 个 seam 全部装配真实 provider、全部可 `resolve` 且有行为验收（ⓘ）；其中 **26 个进入 retain / recall / sync 主链路**，`source` / `agent-adapter` / `ui` / `transport` / `ocr` / `model-router` 这 6 个是外围接入契约，由外部消费方调用，不作为场景插件内部依赖使用。场景插件 `inject` 全部 32 个是把它们作为依赖门槛，不等于都在主链路里被 `ctx.use`。

**仍是 A 档**：未动 `seams/*.ts`、未动 schema、`CONTRACT_VERSION` 仍 `1.2.0`、架构图 v1.2 不动、未开新 ADR。判据见 `CONTRACTS.md`「变更分档与判据」与「V0.7 A 档实践记录」。

## 构建与平台

仓库**不提交 `build/`**（`.gitignore` 忽略）。所有入口都由 npm 生命周期钩子自动构建：`pretest` / `preacceptance` / `pregovernance` / `prestack` / `predump:tree` / `prepack`，所以 `git clone → npm install → npm test` 与 `npm pack` 都不会因缺产物而失败。构建只定位 `typescript/lib/tsc.js` 纯 JS 入口，不使用平台相关的 `.bin/tsc` 脚本。

CI 跑 `matrix.os: [ubuntu-latest, windows-latest]`。本地沙盒仅 Linux 验证；Windows 由 Actions 覆盖。
