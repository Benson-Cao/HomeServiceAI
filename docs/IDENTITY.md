# ④ 身份与审计持久化（A 档切片）

> 基线：架构图 v1.2 · ADR v1.3 · `CONTRACT_VERSION = 1.2.0`
> **不新增 seam、不改 schema、不升版本、不开新 ADR、不动图、不改场景插件、不改 A/B profile、不改内核。**

---

## 1. 解决的问题

③ 之前 `principal` 是请求体里**随便填的字符串**，鉴权是共享 Bearer。也就是说：任何拿到端口的人都能自称 `parent` 去写 `work` / `health`。这属于「入口信任边界缺失」，不是契约缺陷 —— 内核的 `authorize(principal, bank, operation)` 本身是对的，只是喂给它的 principal 不可信。

④ 把入口收紧，同时把审计从内存搬到 PG：

| 之前 | 之后 |
|---|---|
| `principal` = 请求体自报 | `principal` = HMAC 签名 token 里的 `sub` |
| 共享 Bearer（一人泄露全员） | 每个「成员 × 设备」一个 token，可单独吊销 |
| 策略用默认属性 | 目录驱动 ABAC：角色 / 敏感度 / 属主 / 设备 / 时间窗 |
| `inMemoryAudit()`，进程退出即丢 | `pgAudit()`，worker tick 批量落 `memory_audit_log` |
| 拒绝请求无痕 | `http.auth_failed` 也落审计 |

---

## 2. 为什么仍是 A 档（最容易踩的分档陷阱）

按 `CONTRACTS.md`，**新增 seam = B 档 MINOR**。所以 ④ 刻意没有加 `identity` / `directory` seam：

| 需要的能力 | 落在哪 |
|---|---|
| 认证 | `createDaemon` 的**可注入构造参数**（和 `client` 同级），不是 L2 契约 |
| 属性判定 | 既有 `isolation-policy` seam，只换 provider 实现 |
| 审计 | 既有 `audit` seam，只换 provider 实现 |
| 落库驱动 | 既有 `worker` 循环，flush 组合 `(stack.flush() + audit.flush())` |
| 成员目录 | `config/members.json` 配置数据，不是契约字段 |

内核只认 `principal → bank → operation` 三元组，**一行未改**；`src/scenes/memory-scene.ts` **一行未改**；`seams/*.ts` / 10 份 schema / registry / 架构图 / ADR 全部不动。测试 ⑲ 用静态扫描把这条钉死。

---

## 3. Token

```
v1.<base64url(payload)>.<base64url(HMAC-SHA256("v1."+payload, MH_IDENTITY_SECRET))>
payload = { sub, role, dev, iat, exp, v:1 }   // 秒级 Unix 时间
```

- 零第三方依赖（`node:crypto`），`timingSafeEqual` 比较签名
- 校验：前缀 / 签名 / `exp` / 未来签发（容忍 60s 漂移）/ `v` / 字段类型，任一失败返回 `null`，**不抛穿请求**
- gate 再查目录：`sub` 存在、设备在可信列表、全局时间窗满足
- 轮换方式：改 `MH_IDENTITY_SECRET` → 所有旧 token 立即失效

`npm run token:issue -- --sub=parent --device=laptop-parent` 签发；`--list` 查目录。

---

## 4. 目录驱动 ABAC

`directoryPolicy(directory)` 返回既有 `PolicyProvider`，四个属性维度全部在 **L2 执行点**：

| 维度 | 来源 |
|---|---|
| 角色 | `members[].role`（parent / admin / child / viewer） |
| 敏感度 / 属主 | `banks[].sensitivity` / `banks[].owner` |
| 设备可信度 | `trustedDevices` + `members[].devices`（gate 层硬拒 + 策略层兜底） |
| 时间窗 | `windowStart/End`（UTC HH:mm，支持跨午夜），可全局或按 bank |

另加两条硬边界：

1. `members[].banks` 白名单 —— 目录外的 bank 直接 false（fail-closed）
2. 目录外 subject 直接 false

`reflect` 不是独立授权操作：场景插件内部先走 `recall` 的三元组校验。

---

## 5. 审计落库

`pgAudit()` 填既有 `audit` seam：

- `record()` **同步**入内存缓冲（契约要求），`flush()` **异步**批量 `INSERT ... ON CONFLICT DO NOTHING`
- 由 daemon 的 worker tick 驱动：`flush = stack.flush() + audit.flush()`
- flush 失败保留整批，下次 tick 重试；id 固定所以幂等
- `stop()` 前最后一次 tick 保证审计缓冲全部落库
- **脱敏**：`content` / `query` / `question` / `token` / `apiKey` 等一律 `[redacted]`，长字符串截断 200 字。`http.request` 只记 method/path/request_id/principal/role/device，**不记 body**

DDL 加在 `SCHEMA_SQL` 唯一源里，`docker/initdb/01-schema.sql` 是它的字面副本，测试 ⑪ 断言逐字一致：

```sql
memory_audit_log (id TEXT PK, at, event, principal, bank_id,
                  operation, request_id, payload JSONB, contract_version)
+ idx_memory_audit_at / idx_memory_audit_principal_bank
```

查询：`npm run audit:recent -- --limit=20 --principal=parent --bank=work`。

---

## 6. 检查里抓到的真实语义

**`/stats` 自己也是一次 HTTP 请求**，会再产生 2 条待落库审计。第一版测试断言「tick 后 `audit.pending === 0`」失败（实际 1）。这不是 bug —— 每个请求都审计是设计要求，所以「pending 归零」永远比观测晚一个 tick。测试改为「再 tick 一次后全部落库」，并在 `USER_GUIDE.md` §6 写明。

另有一处 TS strict 收窄误报：`/` 根视图分支里 `path` 已被收窄成 `'/'`，再写 `path !== '/health'` 触发 TS2367，删掉冗余判断。

---

## 7. 兼容与边界

- `MH_IDENTITY_SECRET` 留空 → 回退 ③ 的共享 `MH_HTTP_TOKEN`；两者都空 → 无鉴权（仅可信内网）
- 两者同时填 → **启动即报错**，不静默选一个
- 填了 secret 但缺成员目录 → **启动即报错**，不静默降级成裸奔
- 身份模式与 `MH_HTTP_TOKEN` 在 `createDaemon` 层也有互斥断言（测试 ⑰）
- `recall` 授权被拒仍返回 `200 + 空 items`，不泄露 bank 是否存在
- 仍是本地 HMAC token，**不是** OAuth/OIDC；`principal` 仍是字符串（契约字段未改）

---

## 8. A 档落点自查

新增：`src/runtime/identity.ts`、`src/providers/pg-audit.ts`、`scripts/load-members.mjs`、`scripts/issue-token.mjs`、`scripts/audit-query.mjs`、`config/members.example.json`、`tests/identity.test.mjs`、`docs/IDENTITY.md`、`docs/USER_GUIDE.md`。

修改：`src/runtime/daemon.ts`、`examples/daemon.mjs`、`scripts/mock-pg.mjs`、`scripts/smoke-daemon.mjs`、`src/providers/pgvector.ts`（仅 DDL）、`docker/initdb/01-schema.sql`（仅 DDL）、`docker-compose.yml`、`Dockerfile`、`.env.example`、`package.json`、`README.md`、`docs/DAEMON.md`、`docs/DEPLOY.md`、`tests/provider-swap.test.mjs`（禁用词扩充）。

- `CONTRACT_VERSION` 仍 **1.2.0**（package / registry / build 三方一致）
- 架构图 v1.2 不动、ADR 仍 6 条、registry 32 seam 状态不变
- `src/scenes/`、`src/kernel/`、`src/profiles/profile-a.ts` / `profile-b.ts` 零改动
- `seam-registry.json` 零改动；`daemonProfile()` 只加既有的 `audit` / `isolation-policy` 覆盖
- **零新依赖**：`node:crypto` + 原生 `node:http`
- 内核违例注入 FAIL → 还原 PASS；凭据精确扫描零命中
- `npm run verify` **116/116**；`smoke:daemon --mock` / `--identity`、`smoke:stack --mock`、`smoke:llm --mock` 全过；`docker compose config -q` PASS

---

## 9. 下一刀

⑤ 仓库运维收尾的**本地物料已备好**（CI badge、`CHANGELOG.md`、`CONTRIBUTING.md`、PR/Issue 模板、`docs/RELEASE.md`、一键推送脚本 `scripts/deferred-push.mjs`）。真正执行 tag / Release / branch protection 需要 GitHub 权限，按 `docs/DEPLOY.md` §10 + `docs/RELEASE.md` 在有电脑时做。

代码层面 ④ 之后**架构已收口**，后续真实模型、采集器、前端、SQL ANN 全属 A 档填充，不动契约。
