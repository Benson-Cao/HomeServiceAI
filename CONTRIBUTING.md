# Contributing

欢迎加 provider、采集器、前端、真实检索引擎。这套架构的价值就在「不改场景代码就能换实现」，所以贡献前请先花两分钟看分档。

## 0. 三条铁律

1. **内核不写业务**：`src/kernel/` 里出现场景名、模型名 / provider 名 / 品牌名、部署通道判断、检索策略、场景授权分支 —— CI 直接 FAIL。这不是风格建议，是 `ci/kernel-purity.mjs` 的可执行断言。
2. **场景插件不认实现**：`src/scenes/memory-scene.ts` 只 import seam id。`tests/provider-swap.test.mjs` 静态扫描禁用词表，加新 provider 时记得把实现名补进禁用词表（不是改场景插件）。
3. **改契约先写 ADR**：`seams/*.ts` / schema / 字段语义的变更走 `CONTRACTS.md` 的 B/C 档，别在 PR 里夹带。

## 1. 先判分档（决定你要不要写文档）

| 你想做的事 | 档 | 版本 | ADR | 架构图 |
|---|---|---|---|---|
| 加真实 provider（真 Embedding / 真 LLM 抽取 / pgvector ANN / 采集器 / 前端 / MCP 端点） | **A** | 不动 `1.2.0` | 不用 | 不动 |
| 新增 seam / 新增可选字段 / 新增 profile | **B** | MINOR → `1.3.0` | 建议记一笔 | 仅 seam 清单变时 |
| 删字段 / 改字段语义 / 推翻既有决策 / 单文件安装包（Go·Rust） | **C** | MAJOR | **必须** | **必须升** |

**判据看 `git diff` 落在哪**：
- 只动 `src/providers/` `src/scenes/` `src/profiles/` `src/runtime/` `tests/` + registry 的 `v05_status` → A 档，直接合
- 动 `seams/*.ts` / `*.schema.json` 且改了字段语义 → 停，先写 ADR

> ADR-004「切忌在 V0.5 铺开」是**排期纪律**，不是契约冻结。现在架构已收口，加 provider 不需要再开 ADR。

## 2. 本地起步

```bash
git clone https://github.com/Benson-Cao/HomeServiceAI.git
cd HomeServiceAI
npm install                 # 构建期依赖：typescript + @types/node，可选 pg
npm run verify              # schema 校验 → 内核纯度 → tsc 构建 → 全部单测
```

`npm test` 的 `pretest` 会自动构建，仓库不提交 `build/`。核心运行时零第三方依赖（HTTP 用 `node:http`、token 用 `node:crypto`）。

## 3. 加一个 provider（A 档标准流程）

1. 在 `src/providers/` 新建实现，**导出工厂函数**，只实现 `src/pipeline/types.ts` 里对应的 seam 接口
2. 在 `src/profiles/bindings.ts`（或运行时 `bindings()` 覆盖）里挂到既有 seam id；不要新增 seam
3. 写测试：至少覆盖「正常路径 + 失败不抛穿内核 + 与另一实现互换」
4. 把新实现名加进 `tests/provider-swap.test.mjs` 的禁用词表
5. `npm run verify` 全绿；`npm run dump:tree` 看装配是否 PENDING
6. 若它要发网络：**单测必须用可注入的 fake fetch**，真调用只放 `scripts/smoke-*.mjs`（需 env 才跑，不进 `verify` / CI）

### 同步契约 ↔ 异步世界的阻抗

不少 seam 是同步接口（`StorageProvider`、`LlmProvider.complete()`、`AuditProvider.record()`），但真实 DB / HTTP 是异步的。**别改契约**（改了就是 C 档）。沿用现有桥接范式：

- `pgvectorStorage`：内存镜像 + `L0Stack.flush()` 全量 diff → 参数化 UPSERT
- `openAiCompatibleLlm`：`prepare()` 异步真调 → 放进同步槽 → `complete()` 从槽里取
- `pgAudit`：`record()` 同步入缓冲 → worker tick 批量 `INSERT ... ON CONFLICT DO NOTHING`

## 4. 测试纪律

- 单测**绝不发真实网络 / 连真实 DB / 烧 API 费用**。用 `scripts/mock-pg.mjs`、fake fetch、临时端口、固定时刻
- 时间与时钟：别写「假设当前 UTC 不在夜间窗口」这类断言，注入可控时钟（见 `tests/identity.test.mjs`）
- 跨平台：CI 跑 `ubuntu-latest + windows-latest`。路径一律 `fileURLToPath` / `path.join`，不要拼 `dir.pathname`；命令别依赖 shell glob（`node --test tests/` 而不是 `tests/*.test.mjs`）
- 每个回归缺陷补一条固化用例，别只修实现

## 5. 记忆治理语义别踩坏

- 相同断言 → **证据累积**（`proof_count` / `confidence` 单调，不新建不覆盖）
- 矛盾 → 策略裁决，落败方**归档待审**，双方证据链都留着
- 过期 / 未生效 / freshness stale → 归档待审，不物理删除
- 换 embedding 维度 / 量化版本 → 旧向量**隔离拒检**且可观测（专治「不报错只变差」）
- 插件卸载 → 它写入的记录标 `plugin-disposed:pending-review`，不是 `DELETE`
- 鉴权执行点在内核（`principal → bank → operation`），属性判定在 L2 `isolation-policy`；**profile 只装配不裁决**
- `recall` 授权被拒返回 `200 + 空 items`，不泄露 bank 是否存在

## 6. PR 前自查

- [ ] `npm run verify` 全绿（两个平台都会跑，别只在本机试）
- [ ] `node ci/kernel-purity.mjs --dir src/kernel` PASS
- [ ] 场景插件源码零 provider 实现名
- [ ] `git diff` 落在哪一档已判，B/C 档已写 ADR
- [ ] 没往仓库里放 `.env` / token / 真实个人数据 / `node_modules/` / `build/`
- [ ] 涉及新 provider 时，禁用词表已更新
- [ ] 文档同步：`README.md` / `CHANGELOG.md` / 对应 `docs/*.md`

PR 模板会再问一遍这些，照实勾即可。

## 7. 相关文档

| 文档 | 看什么 |
|---|---|
| `CONTRACTS.md` | A/B/C 分档与判据、版本规则 |
| `docs/ADR.md` | 6 条架构决策（含 ADR-006 语言选型） |
| `docs/USER_GUIDE.md` | 最终形态与使用者教程 |
| `docs/IDENTITY.md` | ④ 身份与审计的 A 档落点自查 |
| `docs/RELEASE.md` | 发布 / tag / branch protection |
