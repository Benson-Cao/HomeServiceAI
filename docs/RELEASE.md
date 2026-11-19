# ⑤ 发布与仓库运维收尾

> 前置：代码已按 `docs/DEPLOY.md` §10 推送到 `Benson-Cao/HomeServiceAI` 的 `main`。
> 本页全部是**推完之后**的动作，分「命令行」与「GitHub 网页」两组，不需要给任何人凭据。

---

## 0. 先复核推送真的落上了

```bash
git ls-remote https://github.com/Benson-Cao/HomeServiceAI.git refs/heads/main
```

- 返回的 SHA 应等于脚本打印的「新提交」
- 刷新仓库页：`History` 应 ≥ 2（导入版 `4ca682f` 为父 + 一个替换提交）
- README 应有 CI badge、各切片收口表、`USER_GUIDE.md` 入口
- `docs/IDENTITY.md`、`docs/USER_GUIDE.md`、`config/members.example.json` 应存在
- `build/` 应**不再**出现在文件列表里（由 pre 钩子自动生成）
- Actions 应由 `ubuntu-latest + windows-latest` matrix 重跑，且两个 job 全绿

> 若 Actions 仍 failure：先点进 job 看日志。最常见的是 `npm run verify` 在 Windows 上的路径/编码问题；本仓库已修过 `fileURLToPath`、`tsc.js` 入口、glob 展开三处，仍失败就把日志贴出来。

---

## 1. CI badge（已写进 README，无需额外操作）

```markdown
[![contracts-and-kernel](https://github.com/Benson-Cao/HomeServiceAI/actions/workflows/kernel-purity.yml/badge.svg)](https://github.com/Benson-Cao/HomeServiceAI/actions/workflows/kernel-purity.yml)
```

workflow 文件名是 `kernel-purity.yml`，job 名 `verify`，matrix 双 OS。推完刷新 README 即可看到状态；第一次可能显示 `no status`，等 Actions 跑完就有了。

---

## 2. Branch protection（网页操作）

`Settings → Branches → Add branch ruleset`（或经典 `Branch protection rules`）→ 分支名 `main`：

| 建议项 | 设置 | 理由 |
|---|---|---|
| Require a pull request before merging | 个人仓库可关；多人协作建议开 | 让 ⑤ 之后的改动走 PR 模板 |
| Require status checks to pass | **开**，勾选 `verify (ubuntu-latest)` 与 `verify (windows-latest)` | 三道机器约束必须在两个平台都过 |
| Require linear history | 开 | 与「不 force、单替换提交」口径一致 |
| Block force pushes | **开** | 防误操作把导入记录冲掉 |
| Block deletions | **开** | 防误删 main |
| Require conversation resolution | 可选 | — |

> 注意：状态检查名要先让 Actions 成功跑过一次才会出现在可勾选列表里，所以**顺序是先等 CI 绿，再来配 protection**。

---

## 3. 打 tag 与 Release

```bash
git tag -a v1.2.0 -m "Memory Harness v1.2.0 — contracts + kernel + L0 + LLM + daemon + identity"
git push origin v1.2.0
```

然后 `Releases → Create a new release`：

- Tag：`v1.2.0`
- Title：`Memory Harness v1.2.0 · 插件化记忆底盘收口`
- 正文：直接复制 `CHANGELOG.md` 的 `## v1.2.0` 段
- 附件：把 `memory-harness-contracts.zip` 拖上去（方便没 git 的人直接用）
- 不要勾 `Set as pre-release`

> 版本号含义：`package.json` 的 `version` 与 `CONTRACT_VERSION` 同为 `1.2.0`。**只有契约语义变化才升版本**；日常加 provider 属 A 档，不升。

---

## 4. 仓库 About（网页操作）

`Code` 页右侧齿轮：

- Description：`插件化记忆运行底盘 · 契约 + 微内核 + 自托管 REST 服务`
- Website：可留空
- Topics 建议：`memory` `rag` `agent` `plugin-architecture` `self-hosted` `pgvector` `typescript`
- 勾选 `Releases` / `Packages` 展示（可选）

---

## 5. Secrets 与权限（重要：什么都不用存）

**不要在 GitHub Secrets 里放任何 API key / PAT。** 理由：

- `verify` / CI 全部离线：`createMockPgClient` + fake fetch + 临时端口，不需要数据库或模型密钥
- 云模型密钥只在你本地 `.env`（已 `.gitignore` / `.dockerignore` 排除）
- 推送凭据用你本机 git 的 credential helper，`scripts/deferred-push.mjs` 不读取任何 token

若将来要做「真模型 smoke 的 CI 任务」，那时应另开一个可选 workflow + OIDC/短效凭据，并显式标注哪些记忆会出网 —— 那是新决策，不是本页范围。

---

## 6. 协作物料（已随仓库提交）

| 文件 | 用途 |
|---|---|
| `.github/PULL_REQUEST_TEMPLATE.md` | 强制勾选 A/B/C 分档、是否改 `seams/`、`verify` 结果、禁词自查 |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | 复现步骤 + 平台（含 Windows）+ 是否涉及契约 |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | 新能力先判 A/B/C 档，避免把 A 档做成架构变更 |
| `CONTRIBUTING.md` | 怎么加 provider、怎么改契约、三条机器约束、禁止写入内核清单 |
| `CHANGELOG.md` | 各切片 release notes |
| `docs/USER_GUIDE.md` | 使用者入口（最终形态 + 详细教程） |

---

## 7. 推完之后的日常开发节奏

```bash
git clone https://github.com/Benson-Cao/HomeServiceAI.git
cd HomeServiceAI
npm install
npm run verify            # 116 项；pretest 自动 tsc 构建

# 加一个真实 provider（A 档，不动契约）
#   src/providers/xxx.ts → src/profiles/ 或运行时 bindings 装配 → tests/ → npm run verify
git checkout -b feat/xxx
git add -A && git commit -m "feat(provider): xxx (A-tier)"
git push -u origin feat/xxx     # 开 PR，走模板
```

改 `seams/*.ts` / schema / 字段语义前，**先写 ADR**（`CONTRACTS.md` 分档判据），别在 PR 里夹带。

---

## 8. 完成判据（打勾再收工）

- [ ] `git ls-remote ... refs/heads/main` 返回的 SHA = 新提交
- [ ] History ≥ 2，README badge 显示绿色
- [ ] Actions 两个 job 全绿（ubuntu + windows）
- [ ] `build/` 不再被跟踪
- [ ] `v1.2.0` tag 已推，Release 已建且附了 zip
- [ ] branch protection 开了 force-push / deletion 阻止 + 双状态检查
- [ ] About / topics 填好
- [ ] GitHub Secrets 为空
- [ ] 旧 PAT 已 Revoke（`github.com/settings/personal-access-tokens`）

> 最后一条别漏：那个曾在对话里出现过的 PAT 明文，按凭据纪律一律作废处理。
