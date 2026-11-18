# 图 ↔ ADR ↔ contract_version 映射

`CONTRACT_VERSION = 1.2.0`（对齐架构图 v1.2 / ADR v1.2）。

| 契约文件 | 架构图落点 | ADR 依据 |
|---|---|---|
| `memory-event.schema.json` | L1 词汇 `MemoryEvent`；L0 统一元数据 | 前置共识 2（时间） |
| `time-model.schema.json` | L1 `TimeModel` 注（bi-temporal） | 前置共识 2 |
| `bank.schema.json` / `isolation.schema.json` | L1 `Bank` / `IsolationScope`；L2 `isolation-policy` | ADR-002、前置共识 3 |
| `evidence.schema.json` | L1 `Evidence`；L3 管线「证据累积，非覆盖」 | 前置共识 2 |
| `provenance.schema.json` | L1 `Provenance（7 字段）`；右栏② | ADR v1.2 CR-005 |
| `sync.schema.json` | L1 `SyncCursor` / `Job`；横切带① | ADR-003、前置共识 1 |
| `recall.schema.json` | L1 `RecallResult + provenance`；L2 四路 retriever + fusion | ADR-001（有界背压） |
| `operations.schema.json` | L1 `Retain / Recall / Reflect` 契约定义 | ADR-004（V0.5 链路） |
| `seam-registry.json` | L2 全部 seam | ADR-001/002/003 + V0.5 降级集 |
| `ci/kernel-purity.mjs` | L1「唯一不可动部分」+ 禁止写入内核清单 | ADR「破功判据」 |
| `src/kernel/runtime.ts` / `cli.ts` | L1 五件事 + `dumpTree` PENDING 诊断 | 前置共识 1/3、ADR-002、禁止清单 |
| `src/providers/*` | L3 默认 provider 候选（各 seam 两个可互换实现） | ADR-001 双通道、ADR-006 进程边界 |
| `src/scenes/memory-scene.ts` | 场景插件：retain/recall 闭环、静默降质拦截、归档不删 | ADR v1.2 必验 4 条、前置共识 2 |
| `src/runtime/stubs.ts` | V0.5 降级项留桩（sync / consolidator / expiry） | ADR v1.2 降级验收集 |
| `tests/acceptance.test.mjs` | 8 条运行时语义 + 必验 4 条脚本化 | ADR「运行时语义验收清单」 |
| `src/providers/consolidator.ts` · `conflict.ts` · `expiry.ts` | L2 `consolidator` / `conflict` / `expiry` seam 的真实实现（各 2 个可互换） | 前置共识 2、ADR v1.2 横切⑦ |
| `tests/governance.test.mjs` | 证据累积 / 矛盾修正 / 过期归档 / 事件可观测 / 归档不删 | ADR「冲突与过期策略」 |
| `src/providers/graph.ts` · `retrievers.ts` · `ranker.ts` | L2 graph / fulltext / 四路 retriever / ranker / reranker 实现 | ADR-004 四路召回、横切「合并语义声明式」 |
| `src/providers/sync.ts` | L2 `sync`：水位线 / 去重指纹 / 断点续传 / lag | ADR-003、前置共识 1 |
| `src/providers/defense.ts` · `scheduler.ts` · `policy.ts` | L2 defense / scheduler / ABAC 全属性策略 | ADR-001、ADR-002、ADR「PII 默认开启」 |
| `src/providers/access.ts` · `system.ts` | L2 外围接入与系统 seam 真实实现 | ADR-006 进程边界 |
| `src/profiles/bindings.ts` | 32 个 seam 的统一装配表，A/B 只覆盖 factory | ADR「Profile 只装配」 |
| `tests/v07-full-stack.test.mjs` | 四路融合 / ABAC 四维 / Reflect / 预计算 / 外围 seam 验收 | ADR 运行时语义验收清单 |

## 版本规则

- **PATCH**：注释、示例、描述文案变更，不改字段。
- **MINOR**：新增可选字段 / 新增 seam，向后兼容；必须跑通换 provider 测试。
- **MAJOR**：删字段、改类型、改语义 → **必须新开 ADR**，且同时更新架构图版本号。
- 任何变更都不得让 `src/kernel/` 出现场景名、模型名、品牌名、部署通道判断（CI 扫描目标同为 `src/kernel`）。

## 变更分档与判据（防口径漂移）

本节澄清一个易混点：**「加实现」≠「改契约」**。L2 的 seam 清单与 registry 早已定义全部接口，把 `v05_status` 从 `deferred` / `stub` 填充为 `implemented` 不产生新契约。

| 档 | 典型动作 | `CONTRACT_VERSION` | ADR | 架构图 | 验收 |
|---|---|---|---|---|---|
| **A 填充既有 seam** | 真实模型 provider、采集器、飞牛 host、UI、四路检索、Reflect 实现；只改 `v05_status` | **不动** | **不需要** | **不动** | `npm run verify` |
| **B 扩展契约** | 新增 seam、新增可选字段、新增 profile 装配层 | **MINOR** `1.2.0 → 1.3.0` | 不强制（建议记一笔） | 仅 seam 清单变化时出小版本 | verify + 换 provider 测试 |
| **C 改语义** | 删字段、改类型、改既有决策语义；发行形态变单文件安装包（ADR-006 唯一触发条件） | **MAJOR** | **必须新开** | **必须同步升版本** | 新 ADR 全量验收 |

**判据：看 `git diff` 落在哪**

- 只动 `src/providers/` · `src/scenes/` · `src/profiles/` · `seam-registry.json` 的 `v05_status` → **A 档，直接合**
- 动 `seams/*.ts` / `*.schema.json` 且是新增（可选字段、新 seam） → **B 档**
- 动 `seams/*.ts` / `*.schema.json` 且**改或删既有字段语义**，或推翻既有 ADR 决策 → **C 档，停，先写 ADR**

**C 档为什么必须升版本（不是流程洁癖）**

每条记忆的 `provenance.contract_version` 都带着写入时的版本号。语义变了而号不动，旧记忆会被新代码按「同一版本」读 —— 不报错、只变差，正是验收项 ⓘ 专门拦截的静默降质；同时「图 ↔ ADR ↔ `contract_version`」三方映射断裂，回访「为什么这么设计」无据可查。这条线管的是**契约语义**，不是**实现数量**：加 50 个 provider 不动版本，改一个字段含义就得动。

**两条边界**

- `ADR-004`「切忌在 V0.5 铺开全部 Pipeline 组件」是**排期纪律，不是契约冻结**；V0.5 之后按 A 档推进，不需要为每批 provider 开 ADR。
- 本节自身是文档级澄清、不改任何字段 → 按 PATCH 定义连版本都不用动，**不升 `CONTRACT_VERSION`**。用它自己检验分档规则，正好自洽。

## V0.5 边界

`Reflect` 与 Graph/Temporal/Cross-Encoder/心智模型预计算在本版本**只定义契约、不实现**，状态见 `seam-registry.json` 的 `v05_status`。详见 `docs/provider-swap-acceptance.md`。

## 技术债 TD-001（2026-11-17 登记 → 2026-11-18 **已消除**）

**状态：CLOSED（ADR-006 / ADR v1.3）。** 已引入 `tsc` 编译链：TypeScript 5.6.3 + `@types/node` 20，`ci/build.mjs` 统一编译并把 JSON 契约复制到 `build/seams/`。`src/kernel/runtime.ts` 直接 `import { CONTRACT_VERSION, isCompatible } from '../../seams/contract-version.js'`，编译产物即运行时单一版本源；内联判定已删除。`ci/check-schemas.mjs` 增加「TS 源 ↔ JSON 契约」一致性校验，`tests/acceptance.test.mjs` ⓐ 再校验编译产物 ↔ Schema ↔ registry。**未改 `seams/` 任何契约字段、未升 `CONTRACT_VERSION`**（PATCH 级工程链补齐）。

以下为原始登记内容，保留作追溯：

`seams/contract-version.ts` 是 TS 类型源，当前仓库无 tsc 编译链，Node 20 无法直接 import `.ts`。
内核 `runtime.mjs` 因此**只读** `seams/seam-registry.json` 取得 `contract_version`，并内联 `isCompatible` 的等价判定（主版本一致）。

- **未改 `seams/` 任何契约文件、未升 `CONTRACT_VERSION`** —— 避免刚收口的 v1.2 基线再次漂移；按规则，改 seams/ 需 ADR + 升版本。
- 消除条件：引入 tsc / Node 22 strip-types 后，把 `.ts` 编译为运行时产物，`runtime.mjs` 改为 import 编译产物，删除内联判定。
- 一致性保障：`ci/check-schemas.mjs` 已校验全部 JSON 契约版本为 1.2.0；内核启动时另做主版本校验。

## V0.6 A 档实践记录（2026-11-18）

把 V0.5 降级的 `consolidator` / `conflict` / `expiry` 从桩升级为真实实现，接入 retain / recall 主链路，`seam-registry.json` 的 `v05_status` 翻转 `stub → implemented`。验收 ⓓ / ⓔ / ⓛ 从「桩可观测」升级为「真行为验收」，新增 7 项治理专项测试。

**按「变更分档与判据」自查改动落点**：

- 未动 `seams/*.ts`、未动任何 `*.schema.json`、未动 `CONTRACT_VERSION`（仍 `1.2.0`）、未动架构图 v1.2、未开新 ADR。
- `src/kernel/runtime.ts` 只新增 3 个事件白名单名（`memory.consolidation.strengthened` / `memory.conflict.revised` / `memory.expiry.archived`），属运行时词汇扩展，**不是契约字段**，纯度检查仍 PASS。
- `src/pipeline/types.ts` 是本地实现类型（非 `seams/` 契约源），随实现扩展。
- `git diff` 主体落在 `src/providers/` · `src/scenes/` · `src/profiles/` · `src/runtime/stubs.ts` · `tests/` · `seam-registry.json` 的 `v05_status` → **判定 A 档，直接合**。

备注（非技术债、不阻塞）：事件白名单目前定义在 `src/kernel/runtime.ts`。若日后需要跨进程共享事件词汇表，应下沉到 `seams/` 并走 MINOR；当前单进程内核无需提前引入。

## V0.7 A 档实践记录（2026-11-18）

把 `seam-registry.json` 剩余 15 个 `deferred` / `stub` seam 连同 Reflect、心智模型预计算、ABAC 全量属性集一次收完：**32 个 seam 全部 `implemented`**，V0.5 桩整体退役（`src/runtime/stubs.ts` 删除）。

**分步检查**：① 存储/检索层 8 个 provider → ② 接入/模型/治理层 provider → ③ 全量装配 + 场景插件 32 seam 主链路 → ④ 旧断言升级 + 11 项全栈专项 → ⑤ 文档与落点自查。每步 `tsc build` + `kernel-purity` + 单测回归；最终 `npm run verify` **49/49**。

**按「变更分档与判据」自查**：

- 未动 `seams/*.ts`、未动任何 `*.schema.json`、未动 `CONTRACT_VERSION`（仍 `1.2.0`）、未动架构图 v1.2、未开新 ADR。
- `seams/seam-registry.json` 只改 `v05_status` 与描述性 `note`（后者按版本规则属 PATCH 注释/文案）。
- `src/kernel/runtime.ts` 只增 4 个事件白名单名（运行时词汇扩展，**非契约字段**），纯度检查 PASS。
- `src/pipeline/types.ts` 是本地实现类型（非 `seams/` 契约源），随实现扩展；系统 provider 接口已归位于此，场景插件只从契约层取形状。
- 新增文件落点：`src/providers/` · `src/profiles/bindings.ts` · `tests/`。
- `git diff` 主体落在 A 档允许目录 → **判定 A 档，直接合**。

**实现期抓到的真实缺陷**：① 系统 provider 接口定义在 `src/providers/system.ts`，场景插件 import 不到 → 归位到 `pipeline/types.ts`；② TS strict 嵌套闭包收窄丢失 → 非空别名；③ 批量替换把 `enq.accepted` 误伤为 `enqRef.accepted`；④ 融合结果 `channel` 被末次写入覆盖 → 改为保留贡献最大的一路；⑤ 两处测试用例自身构造错误（对称名次、得分数组比较）。

**备注仍然成立**：事件白名单定义在 `src/kernel/runtime.ts`，单进程内核无需下沉 `seams/`；若日后跨进程共享事件词汇表，按 B 档 MINOR 处理。
