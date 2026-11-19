## 变更分档（必勾一项）

按 `CONTRACTS.md` 判据，看 `git diff` 落在哪：

- [ ] **A 档** · 填充既有 seam（真实 provider / 采集器 / 前端 / SQL ANN / 文档修）→ `CONTRACT_VERSION` 不动、架构图 v1.2 不动、不需要 ADR
- [ ] **B 档** · 新增 seam / 可选字段 / profile → MINOR 到 `1.3.0`，registry 已改，换 provider 测试通过
- [ ] **C 档** · 改字段语义 / 删字段 / 推翻决策 / 单文件安装包 → **已先写 ADR**，已升 `CONTRACT_VERSION`，架构图版本号已同步

> 不确定就选 C 档先讨论。ADR-004「切忌在 V0.5 铺开」是排期纪律，不是契约冻结，加 provider 不用开 ADR。

## 改了这些吗

- [ ] `seams/*.ts` 或 `*.schema.json`（改了就说明是否动了字段语义）
- [ ] `src/scenes/memory-scene.ts`（**正常情况不应改**）
- [ ] `src/kernel/`（正常情况不应改）
- [ ] 新增 provider → 已把实现名补进 `tests/provider-swap.test.mjs` 禁用词表
- [ ] 新增网络调用 → 单测用 fake fetch / mock，**真调用只在 `scripts/smoke-*.mjs`，不进 `verify` / CI**

## 验证

```
npm run verify        # 结果：____ / ____ pass
node ci/kernel-purity.mjs --dir src/kernel   # PASS / FAIL
npm run dump:tree     # 有无 PENDING：____
```

- [ ] 本机已跑 `npm run verify` 全绿
- [ ] 已知 CI 会在 `ubuntu-latest` + `windows-latest` 各跑一次；路径 / glob 已按跨平台写
- [ ] 时间与时钟相关断言已注入可控时钟，不依赖真实 UTC

## 记忆治理自查（如触及 retain / recall / 策略）

- [ ] 相同断言仍是证据累积，不新建不覆盖
- [ ] 矛盾 / 过期 / 卸载只归档，不物理删除
- [ ] 换 embedding 维度后旧向量隔离拒检且可观测
- [ ] 鉴权执行点仍在内核；profile 没有长出授权分支

## 安全

- [ ] 没有提交 `.env` / token / 真实个人数据 / `node_modules/` / `build/`
- [ ] 没有把凭据写进文档或测试夹具

## 说明

<!-- 一句话说清「为什么」，再列关键改动。纯 A 档填充不需要长篇架构论述。 -->
