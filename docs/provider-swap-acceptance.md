# V0.5 降级验收集

基线：ADR v1.2「V0.5 降级验收集」+ 架构图 v1.2 右侧 8 条运行时语义验收。

## 必验（4 条）

1. 换掉一个 provider（storage 或 llm），场景插件零改动
2. `accepted → visible` 延迟可测
3. 卸载一个插件，其注册能力全部回收，且已写入记忆进入归档待审、不物理删除
4. 换 `embedding_dim` / `quantization_version` 后旧向量被隔离或拒检，且该状态可观测 —— **静默降质的唯一拦截点**

## 不降级（内核原语）

- `principal → bank → operation` 三元组校验
- 跨 bank 检索被拒、kid 只读生效

## 降级：只留 seam / 留桩、不验收、不计入未完成

| 项 | V0.5 处理 |
|---|---|
| 增量同步 lag 双向不丢 | `edge-buffer` 留桩 |
| worker 重试 / 死信 / 成本上限 | 队列有界 + 背压即可，全量策略后补 |
| API 与本地大模型各自完整闭环 | 只要求 `llm` 两个 provider 可装配、可互换 |
| Graph / Temporal / Cross-Encoder / Reflect / 心智模型预计算 | 只定义契约，不实现 |

## 验收判据

**不是「能回答」，是「换得动」。** 过不了第 1 条，后续全部是沙上建塔。

## V0.6 已升级（A 档，不再是降级项）

`consolidator` / `conflict` / `expiry` 已有真实实现（各 2 个可互换 provider），并接入 retain / recall：

- 相同断言 → 证据累积（`proof_count` / `confidence` 单调），加强同一条，不新建、不覆盖
- 不同断言 → 矛盾裁决，落败方归档待审；双方记录与证据链都保留，不物理删除
- `valid_to` 已过 / `valid_from` 未到 / freshness 衰减至 stale → 归档待审并发出可观测事件
- 验收：ⓓ / ⓔ 已改为真行为断言；`tests/governance.test.mjs` 7 项专项；A/B 两 profile 用不同策略实现，场景插件零改动

## V0.7 收口（A 档）

上一节列出的全部降级项已升级为真实实现：`sync`、四路检索、`reranker` / `ranker`、`Reflect`、心智模型预计算、ABAC 全量属性集，以及 source / agent-adapter / ui / transport / ocr / defense / scheduler / graph / fulltext / vector / extractor / ingest / audit / bank-policy / worker / model-router。

`seam-registry.json` 的 32 个 seam 全部 `implemented`；验收 ⓑ / ⓛ 已从「桩可观测」升级为真行为断言，新增 `tests/v07-full-stack.test.mjs` 11 项专项。**`CONTRACT_VERSION` 仍 1.2.0，架构图 v1.2 不动，未开新 ADR。**

必验 4 条不变：换 provider 零改动、`accepted → visible` 可测、卸载归档不物理删除、换 `embedding_dim` 旧向量隔离且可观测。
