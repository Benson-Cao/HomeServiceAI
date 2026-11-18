# Memory Harness · 架构决策记录（ADR）

状态：已采纳（2026-11-17）
适用：v1.1 架构图 + V0.5 切片
维护原则：本文件只记决策与判据，不复制架构图内容。

## 修订记录

- v1.1（2026-11-17）：**ADR-001 修订**——Chat 类 `retain` / `reflect` 由「默认云 API」改为「**同时支持 API 与本地大模型部署**」，两通道平级、无默认优先级，由 profile 装配决定。其余 ADR 不变。
  连带修正：原「纯私有化 profile 则开夜间批处理窗口」为例外分支，双通道下会留下「云 API 无需排队」的暗示，故改为「任何通道均受有界队列约束，本地部署可叠加批处理窗口」。属同一句的逻辑收口，不涉及其它 ADR。

- v1.2（2026-11-17）：**评审收口，不改任何决策**。第 4 行适用基线仍为 v1.1 图（经核验不存在 v1.4，CR-001 整条撤销）；第 18 / 45 行 ABAC 执行点保持 L2 `isolation-policy` 不动（CR-002 整条撤销）。本版三处修订：
  ① 运行时语义验收清单 +1 条「换 `embedding_dim` / 量化版本后旧向量隔离或拒检且可观测」，拦截静默降质（CR-005）；
  ② 新增「V0.5 降级验收集」，划清最短链路与横切全量验收的边界（CR-006）；
  ③ 落地顺序③ 的 `memory-engine` 统一为图上 `storage` / `llm` / `retriever` provider（CR-008）。
  数字订正：横切约束为右栏 9 条 + 落地顺序注，非 12 条；运行时语义验收 7 条 → 8 条；V0.5 核心验收另计 3 条。
  防幻觉：评审中出现的 `v1.4` / `收紧到 L4` / `idempotency key` / `无锁` / `200ms` / `200x` / `SQLite` / `时间戳保证有序` 均无来源，判为不存在，未作为修订输入。

- v1.3（2026-11-18）：**新增 ADR-006（语言选型与进程边界）**，见文末。消除技术债 TD-001：引入 tsc 编译链，`seams/*.ts` 不再只是纸面契约，编译产物成为运行时单一版本源，内核删除内联 `isCompatible`。
  **不改决策、不升 `CONTRACT_VERSION`（仍 1.2.0）、不改架构图 v1.2** —— 本次是实现层工程链补齐，非契约变更；按 `CONTRACTS.md` 版本规则属 PATCH。第 4 行适用基线、第 18 / 45 行 ABAC 执行点仍保持原样。

---

## 前置共识（三处校准）

1. **幂等性不是 L1 内核原语。** 由 `SyncCursor` + 去重指纹 + `Job` 状态机 + `producer_plugin_id` 在词汇层与运行时层共同保证。抬进内核等于让内核理解「一次业务写入」。
2. **时间维度拆成三个时间戳 + 一个有效区间**：`occurred_at`（事件发生）、`recorded_at`（入库）、`valid_from / valid_to`（事实生效）。valid time ≠ 记录时间；bi-temporal 指 valid + transaction。更正事实不得丢弃旧证据链。
3. **ABAC 是新增决议，执行点在 L2 `isolation-policy` seam，不在 L4。** Profile 只声明装配、不做授权；内核在每次 retain / recall 前强制 `principal → bank → operation` + 属性校验，插件无旁路。跨 profile recall 走同一治理网关，不另起策略引擎。

## 溯源字段（定稿）

每条记忆必带：`producer_plugin_id` / `pipeline_run_id` / `contract_version` / `model_id` / `embedding_dim` / 量化版本 / `Evidence`（引用、置信度、时效）。

换模型或换 embedding 后新旧向量混检是**静默降质**——不报错、只变差，比事实冲突更难查。

---

## ADR-001　分级推理 + 双通道模型供给 + 有界背压

**决策**

- 本地常驻只保留小 Embedding / 轻量 Rerank / OCR。
- Chat 类 `retain` / `reflect` **同时支持 API 与本地大模型部署**（Ollama / vLLM / llama.cpp / LM Studio 等 OpenAI 兼容网关）。两条通道平级，均为 `llm` seam 下的 provider，由 profile 装配决定走向；**内核与记忆管线不感知部署位置、不设默认通道**。
- 分级不因通道改变：按任务分级（抽取用小模型、reflect 用大模型），云与本地一视同仁。
- 任何通道都开有界队列：写入先落原始事件、立即返回 `accepted`，抽取与整合排队执行；本地 / 纯私有化部署可叠加「夜间批处理窗口」。云 API 同样受队列约束（限流、成本），不设例外。
- 队列有界、单并发、超限背压：宁可写入慢，不让 NAS 被拖死。

**后果**

- 本地全量部署的 profile 可做到数据零出网；代价是冷启动、显存/内存占用与更低吞吐，需在 profile 中显式声明资源预算与并发上限。
- 切换通道不改任何场景插件代码；验收以「换 provider 零改动」为准，而非「能跑通」。

## ADR-002　策略执行点

ABAC 在 L2，内核在每次 retain / recall 前做三元组 + 属性校验，插件无旁路。Profile 只声明装配，不承载授权逻辑；跨 profile recall 复用同一治理网关。

## ADR-003　端侧只缓冲、不裁决

新增 `edge-buffer` seam：本地队列 + 断点续传，cursor 由服务端签发。多端冲突一律回服务端按 `ConflictPolicy` 裁决，端侧不做合并，避免离线分叉。

## ADR-004　V0.5 最短链路

`Text → 小 Embedding → PostgreSQL(pgvector) → 单路语义召回 → 简单 RRF → retain/recall 闭环`。切忌在 V0.5 铺开全部 Pipeline 组件。

---

## V0.5 切片边界

**只留 seam 接口与契约版本、不实现**：Graph / Temporal 四路、Cross-Encoder、Reflect、心智模型预计算、ABAC 全量属性集、`edge-buffer` 完整实现（可留桩）。

**验收不是「能回答」，而是：**

- 换掉一个 provider（storage 或 llm），场景插件零改动；
- `accepted → visible` 延迟可测；
- 卸载一个插件，其注册能力全部回收，且已写入记忆进入归档待审、不物理删除。

### V0.5 降级验收集（CR-006）

V0.5 只验 4 条，其余「只留 seam / 留桩、不验收、不计入未完成」：

- **必验**：上述核心 3 条 + 「换 `embedding_dim` / 量化版本后，旧向量被隔离或拒检，且该状态可观测」（CR-005，静默降质的唯一拦截点）。
- **降级**：增量同步 lag 双向不丢（`edge-buffer` 留桩）；矛盾按置信度修正、stale 归档待审（`consolidator` / `expiry` 留桩）；worker 重试 / 死信 / 成本上限（队列有界 + 背压即可，全量策略后补）；两通道各自完成完整 retain / recall 闭环（V0.5 只要求 `llm` 两个 provider 可装配、可互换）。
- **不降级**：`principal → bank → operation` 三元组与跨 bank 拒绝是内核原语，V0.5 必须验收；降级的只是 ABAC 全量属性集。

## 「禁止写入内核」清单（破功判据）

内核 PR 中出现以下任一，即视为破功：

- 场景名（work / kid / health / home …）
- 模型名、provider 名、品牌名（含 NAS 品牌）
- **部署通道判断**（云 / 本地、API 地址、是否出网）
- 检索算法、融合权重、模型路由策略
- 任何针对具体场景的授权分支

内核只认：插件、依赖、事件、`ctx` 注册、契约版本、`principal → bank → operation`。

> 判据一句话：**内核的 PR 里出现任何场景名、模型名、品牌名或部署通道，就是那一刻。**

## 运行时语义验收清单

- □ 增量同步 lag 可观测，双向不丢
- □ 跨 bank 检索被拒，kid 只读生效
- □ 矛盾记忆按置信度修正，不覆盖
- □ stale 记忆归档待审，证据可回溯
- □ `accepted → visible` 延迟可测
- □ worker 重试 / 死信 / 成本有上限
- □ API 通道与本地大模型通道均可独立完成 retain / recall 闭环
- □ 换 `embedding_dim` / 量化版本后旧向量被隔离或拒检，且可观测（防静默降质）

## 落地顺序

① 冻结词汇表 → ② 定 seam + 鉴权 → ③ 写 `storage` / `llm` / `retriever` 各两个可互换 provider 验证互换 → ④ profile/patch 装配 → ⑤ 才做采集器与插件清单。同步 / 冲突 / 异步作为横切验收项贯穿全程；V0.5 按上文降级验收集执行，不做全量验收。

---

## ADR-006　语言选型与进程边界

状态：已采纳（2026-11-18）｜类别：实现层，非契约变更

**决策**

1. **TypeScript（Node ≥ 18，ESM）是内核与插件的唯一主语言。** 所有运行时源码写 `.ts`，经 `tsc` 编译到 `build/`；测试与 CI 工具链用 `.mjs`（工具不需要类型），但**不承载业务逻辑**。
2. **Python 只做模型侧外部 provider**：Embedding / OCR / 本地 LLM 等生态依赖，经 HTTP 或子进程接入 `llm` / `embedder` seam，**不得进入内核目录、不得成为内核 import**。
3. **Go / Rust 不进 V0.5。** 同步/采集侧若日后成为 I/O 瓶颈，可作为独立 provider 引入 —— seam 是接口契约，不是语言承诺。
4. **JSON Schema / YAML / profile 清单是声明式契约，不算实现语言**，不参与语言选型争议。
5. **进程边界**：内核进程内只做 TypeScript；重模型与重 I/O 一律在 seam provider 的进程外实现。跨语言 provider 必须自行满足 `contract_version` 与 `provenance` 7 字段。

**理由**

- L1 五件事里最吃语言特性的是**运行时模块图**：声明式依赖、热插拔、按 id 整行覆盖、`ctx` 注册后逆序 disposer 回收、profile 后层覆盖前层。动态模块系统表达几乎零成本；静态编译语言要用「子进程 + IPC / WASM」换，seam 会从函数调用升级成跨进程协议，V0.5 最短链路当场变重。
- **「禁止写入内核」必须能被机器检查**。动态语言里 `scene === 'health'` 可藏在元编程 / monkey patch / 配置字符串里，静态检查挡不住，「靠 CI 不靠自觉」就废一半。TypeScript + `strict` + AST 可扫的源码面是这条判据成立的前提。
- Go `plugin` 不能卸载、要求构建版本完全一致、平台受限 —— 「热插拔」直接不成立。Rust/WASM 插件优雅但插件作者门槛与迭代速度，对当前推进节奏是奢侈品。
- 零外部运行时依赖保持不变：`tsc` 是**构建期** devDependency，产物是纯 ESM JS，NAS 上只需 Node。

**代价**

- 多一层 `build/`；`npm run verify` 必须先 build。由 `ci/build.mjs` 统一负责定位 tsc、编译、复制 JSON 契约，本地与 CI 同一条命令。
- 模型侧跨进程：多一次序列化 / 一次网络或 IPC 往返，需在 `accepted → visible` 埋点里单独计量。
- TD-001 消除后，`runtime` 不再只读 `seam-registry.json` 取版本，改为 import 编译产物；`ci/check-schemas.mjs` 增加「TS 常量 ↔ JSON 契约版本」一致性校验。

**重新评估的触发条件（唯一）**

发行形态从「开发者自行部署的仓库」变为「给 NAS 用户的单文件安装包」时，单二进制 / 低内存 / 无 Node runtime 会压过插件热插拔的便利，Go / Rust 重新上桌。届时必须**新开 ADR + 升 `CONTRACT_VERSION` + 同步改架构图版本号**，不以聊天结论替代。

**边界重申**

- 本次不升 `CONTRACT_VERSION`（仍 `1.2.0`）、不改架构图 v1.2、不改任何 seam 字段。
- 「禁止写入内核清单」不变；内核目录只允许 TS 源码与类型声明，出现 `.mjs` 实现即视为绕过编译链。
- 跨语言 provider 允许出现品牌名 / 模型名（它们是默认 provider 候选），纯度检查只扫内核目录。
