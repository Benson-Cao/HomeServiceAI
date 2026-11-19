# L0 部署与使用手册（A 档切片）

> 基线：架构图 v1.2 · ADR v1.3 · `CONTRACT_VERSION = 1.2.0`
> 本刀只做 **L0 宿主与持久化**，不新增 seam、不改 schema、不升版本、不开新 ADR、不动图。

---

## 1. 这一刀交付了什么

对照架构图 L0 最初列的六项：

| L0 项 | 本刀 | 说明 |
|---|---|---|
| 容器化运行时 + 持久卷 | ✅ | `Dockerfile` 多阶段 + `docker-compose.yml` 命名卷 `pgdata` |
| 快照备份 / 恢复 | ✅ | `db:backup` / `db:restore`（gzip 逻辑备份） |
| 局域网 / HTTPS / 远程隧道 | ⚠️ | 端口映射 + 说明；HTTPS 反代留待运维配置 |
| 账号与防火墙 | ⚠️ | PG 账号隔离；尚无真实身份体系（`principal` 仍是字符串） |
| PostgreSQL + pgvector 单库 | ✅ | `pgvector/pgvector:pg16` + 两张表 |
| 飞牛 fnOS 图形化部署 | ❌ | 标准 compose，可在 fnOS 容器里导入；未做图形化封装 |

---

## 2. L0 当时的产品形态（③ 已演进，见 `docs/DAEMON.md`）

> **本节保留 L0 切片的历史基线**。`docker-compose.yml` 现已把 `app` 改成常驻 REST 服务（`restart: unless-stopped` + 8080 端口 + 后台 worker + healthcheck），不再是下面画的一次性 CLI 容器。当前形态以 `docs/DAEMON.md` §1 为准。

```
┌─ 你的 NAS / 主机 ─────────────────────────────────┐
│                                                   │
│  db（常驻容器）                app（一次性容器）    │
│  PostgreSQL 16 + pgvector     Node 20 + build/     │
│  命名卷 pgdata                l0-cli.mjs            │
│  ├ memory_records (20 列)     hydrate → 操作       │
│  └ memory_embeddings          → flush → 退出       │
│        ▲                            │              │
│        └──────── 同一份 .env ───────┘              │
└───────────────────────────────────────────────────┘
```

**只有 `db` 常驻**。`app` 是一次性 CLI 容器，每次 `docker compose run --rm` 起一个短命进程：连库 → hydrate → 执行一条命令 → flush → 退出。

这是刻意选择，不是偷工减料：

- `StorageProvider` 是**同步契约**，PG 是异步客户端。本刀用「内存镜像 + flush 全量 diff」桥接，任何原地修改（包括 `strengthened` 改 `provenance.evidence`）都能被捕获落库；
- 镜像在进程内，**多进程同时写会分叉**。所以 L0 强制单写进程；
- **没有 HTTP / MCP 监听端点**，也没有真模型调用、多端 UI、后台常驻 worker。这些是 ③ 的内容。

一句话：**L0 当时是自托管、可备份、可重启恢复的「记忆数据服务 + CLI」；③ 之后已经变成可被 App 调用的常驻 REST 服务**，但 L0 的单写进程约束仍然成立（见下）。

---

## 3. 快速开始

```bash
cp .env.example .env
# 务必改掉 POSTGRES_PASSWORD 与 MH_PG_DSN 里的密码

docker compose up -d db          # 只起数据服务（维护/备份演练时用）
docker compose up -d             # ③ 之后：db + 常驻 app 一起起（日常用）
docker compose config -q         # 校验配置（可选）

# 自检：离线，不需要 PG
npm run smoke:stack -- --mock

# 自检：真 PG 往返（写一条 → 落库 → 新进程 hydrate → recall 命中 → 自动清理）
npm run smoke:stack
```

> 沙盒/无 Docker daemon 环境只能跑 `--mock` 与 `docker compose config`；真实 PG 往返需要在你自己的机器上跑。

---

## 4. 日常使用（维护用 CLI）

> ⚠️ **③ 之后 `app` 已常驻**。下面是维护用一次性 CLI；**daemon 正在运行时不要用它写**，否则两个进程的内存镜像分叉。
> 先 `docker compose stop app`，用完再 `docker compose start app`；日常读写走 `docs/DAEMON.md` 的 REST 端点。

所有读写都走同一个 CLI，命令会被 compose 的 `command` 覆盖：

```bash
# 看状态
docker compose run --rm app node examples/l0-cli.mjs stats

# 写一条记忆
docker compose run --rm app node examples/l0-cli.mjs retain "客厅灯晚上七点自动开"

# 指定成员 / 隔离域（用 -e，避免 compose 把 --flag 当成自己的参数）
docker compose run --rm -e MH_PRINCIPAL=parent -e MH_BANK=health \
  app node examples/l0-cli.mjs retain "血压 120/80"

# 召回
docker compose run --rm app node examples/l0-cli.mjs recall "客厅灯" --bank=home

# 跨记忆综合（注意：当前 llm 是确定性桩，见 §7）
docker compose run --rm app node examples/l0-cli.mjs reflect "家里的照明习惯"

# 手动归档（只改状态，不物理删除）
docker compose run --rm app node examples/l0-cli.mjs archive ev_xxx "manual-review"
```

输出统一是 JSON，可直接被脚本消费。`retain` 返回 `event_id / job_id / provenance`；`recall` 返回带 `time + provenance` 的 `items`。

**退出前必须 `flush`**——CLI 已内置。不要调用 `assemble().dispose()`：它会把本插件写入的记录标成「归档待审」，那是插件卸载语义，不是正常退出语义。

宿主机直接跑也行（不经过容器）：

```bash
npm install
node examples/l0-cli.mjs stats          # resolveDsn 自动把 @db: 换成 @localhost:POSTGRES_PORT
```

---

## 5. 数据模型

| 表 | 关键列 |
|---|---|
| `memory_records` | 三时间戳 `occurred_at / recorded_at / valid_from~valid_to`、状态 `pending→visible→archived`、`provenance JSONB`（7 字段 + evidence）、`vector JSONB`、`facts JSONB`、`raw_pointer`、`dedupe_fingerprint`、`contract_version` |
| `memory_embeddings` | `embedding vector(16)`、`dim`、`quantization_version`、`contract_version`，外键级联删除 |

DDL 唯一源是 `src/providers/pgvector.ts` 的 `SCHEMA_SQL`；`docker/initdb/01-schema.sql` 是它的字面副本，**由 `tests/l0-pgvector.test.mjs` ① 断言两者逐字一致**。全部 `IF NOT EXISTS`，`ensureSchema()` 每次启动幂等执行。

> `vector(16)` 是 L0 的**固定维度约束**。换 embedding 模型时，维度不符的向量不写 embedding 列（写 NULL、保留 `dim`、进 `quarantined()` 可观测），与 recall 侧的静默降质拦截口径一致；真正启用新维度需要一条 DDL migration（`ALTER COLUMN ... TYPE vector(N)`），属运维动作，不是契约变更。

---

## 6. 备份与恢复

```bash
npm run db:backup                              # → backups/mh-<时间戳>.sql.gz
npm run db:backup -- /path/to/my.sql.gz       # 指定路径
npm run db:restore -- backups/mh-xxx.sql.gz
```

脚本用 `docker compose exec -T db pg_dump / psql`，参数是数组 + 流，**不依赖 shell 展开**（Windows 也安全）。备份是逻辑备份，`--clean --if-exists`；恢复开 `ON_ERROR_STOP=1`。

**恢复演练建议**：`docker compose down` → 删除卷 `docker volume rm memory-harness-contracts_pgdata` → `up -d db` → `db:restore` → `stats` 应看到原记录数。卷删除不可逆，演练前先留一份备份副本。

---

## 7. 已知边界（别越界期待）

- **③ 已有常驻 REST 端点**：`app` 监听 8080，10 个端点、后台 worker、优雅关停，见 `docs/DAEMON.md`。**MCP 未起独立监听**，只是 `agent-adapter` seam 的另一个 provider。
- **真模型已可接，但默认不挂**：`llm` seam 已有真 HTTP provider（见 `docs/LLM.md`），`reflect` 在显式装配下能拿到真模型输出；**默认 A/B 两份 profile 仍是确定性 stub**，不发网络。`embedder` 仍是 16 维哈希、`extractor` 仍按句号分句、`precompute` 仍截断 240 字 —— 这些是后续切片。
- **SQL 级 ANN 检索未接**：四路召回仍在内存做；`memory_embeddings` 表已落库，可在 `retriever.semantic` seam 内改用 `<=>`（仍 A 档）。
- **单写进程仍然成立**：daemon 持有进程内内存镜像，不要同时跑第二个写容器或 `l0-cli` 写命令。要横向扩展需改为直接 SQL 读写或引入分布式锁。
- **④ 已有本地身份，但无 HTTPS / 远程隧道**：成员 token + 目录 ABAC 已落地（见 `docs/IDENTITY.md`），不是 OAuth/OIDC；局域网裸露端口仅供内网使用，公网访问要自行加反代与证书。
- **备份是逻辑备份**，非 PITR；高频写入场景需另配 WAL 归档。

---

## 8. A 档落点自查

`git diff` 只落在：`src/providers/`、`src/runtime/`、`scripts/`、`examples/`、`tests/`、`docker/`、`docs/`、`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`.env.example`、`package.json`、`package-lock.json`、`README.md`。

- 未动 `seams/*.ts`、未动 10 份 schema、`CONTRACT_VERSION` 仍 **1.2.0**
- 架构图 **v1.2 不动**、ADR 仍 6 条（未新增）
- A/B 两份 profile **原样不动**；`profile-l0` 是新增第三份，seam 集合与 A/B 严格一致（测试 ③ 断言）
- `src/scenes/memory-scene.ts` **一行未改** —— 换 provider 零改动继续成立
- 内核纯度 `PASS`；`pgvector` 等品牌词只在 `src/providers/`，不在 `src/kernel/`
- `pg` 是 `optionalDependency`，动态 `import('pg')` 仅在 L0 路径；`npm run verify` 不加载它，核心运行时仍零依赖

---

## 9. 切片进度与下一刀

- **② 已完成**：真模型 provider，见 `docs/LLM.md`。只有 `reflect` 主链路拿到真模型输出。
- **③ 已完成**：常驻 REST 服务 + 后台 worker，见 `docs/DAEMON.md`。`app` 已改为 `restart: unless-stopped`；`prepare()` 外环在 `POST /reflect` 时执行。
- **④ 已完成**：成员 token / 目录 ABAC / `memory_audit_log` 审计落库，见 `docs/IDENTITY.md`；**完整使用教程与最终形态见 `docs/USER_GUIDE.md`**。
- **⑤ 本地物料已备好**：CI badge / `CHANGELOG.md` / `CONTRIBUTING.md` / PR·Issue 模板 / `docs/RELEASE.md` / `scripts/deferred-push.mjs`（离线 dry-run 已验 fast-forward push 与幽灵文件清理）。真正执行 tag / Release / branch protection 需要 GitHub 权限，随 §10 一起做，清单见 `docs/RELEASE.md`。
- 代码层面架构已收口；后续真实模型全链路、采集器、前端、SQL ANN 全属 A 档填充，不动契约。每一步 `npm run verify` 全绿、A/B 原样不动。

---

## 10. 远端同步（延迟推送 / 手边无电脑时先看这里）

### 当前状态（以远端页面为准，别用旧回执）

| 项 | 状态 |
|---|---|
| 远端 `Benson-Cao/HomeServiceAI` / `main` | 导入版 `4ca682f` · 1 Commit · Actions failure · README 仍是 49 项 / 「未 push」 |
| 本地 | 独立提交链，工作区 clean；`git log --oneline -1` 看当前 HEAD，`npm run verify` 应全绿 |
| 交付物 | `memory-harness-contracts.zip`，已排除 `.git` / `node_modules` / `.env`；`build/` 由 npm 钩子生成 |

> 刻意**不在文档里硬编码 HEAD SHA / commit 数 / zip 体积 / 测试项数** —— 这些每做一刀都会变，写死就是下一次漂移的来源。用命令查实时值。

**两条历史无关，所有切片均未推送。** 之前一次远端写入的回执未能与页面核对一致，一律以 `git ls-remote` 或页面 SHA 为准。当前执行环境无法完成远端写入，且旧凭据已作废、不复用 —— 这一步留给有电脑时做，不阻塞本地使用：`npm run verify`、三个 `smoke --mock`、`docker compose config -q` 都不需要 GitHub。

### 有电脑时：一键推送（推荐）

```bash
npm run push:deferred -- --dry-run --yes   # 离线全演练：本地 bare 仓库当假远端，连 push 一起验
npm run push:deferred -- --yes             # 真正推送
```

`scripts/deferred-push.mjs` 做这几件事：

1. `git clone` 远端 → 以当前 HEAD 为父（不 force）
2. **清空 clone 下来的工作树（保留 `.git`）**，再整体复制本地工作树
3. `git add -A` → `commit` 一个替换提交 → `push HEAD:refs/heads/main`
4. 回读 `git ls-remote` 验证远端 HEAD 与新提交一致

凭据完全交给你本机 git 的 credential helper；脚本**不读取、不存储任何 token**。支持 `--remote` / `--branch` / `--message` / `--keep`，不带 `--yes` 时会打印计划并交互确认。

> ⚠️ **不要用「解压 zip 直接覆盖」**。简单覆盖**不会删除**远端已存在、但本地早已删掉的文件 —— 线上导入版仍在跟踪 `build/` 产物，旧 `stubs` 之类也会残留，推上去就是幽灵文件。脚本的「先清空再复制」正是为了让 git 把它们 stage 成 deleted。这也是本轮检查抓到的真实缺陷。

> 不要 `git push --force`，也不要 `--force-with-lease`：两条历史无关，强推会把导入记录冲掉。
> 若 `git pull` 提示 unrelated histories，别合并，直接跑脚本更干净。
> 若 push 被拒（远端期间被别人更新），**重新跑一次脚本**即可，它会再以最新远端为父。

### 手工等价路径（理解用，不推荐）

```bash
git clone https://github.com/Benson-Cao/HomeServiceAI.git && cd HomeServiceAI
# 删除除 .git 外的所有内容，再复制本地工作树（排除 .env / node_modules / build / backups）
git add -A
git commit -m "feat(memory-harness): L0 persistence + real LLM + daemon REST + identity & audit"
git push
```

### 推完复核

```bash
git ls-remote https://github.com/Benson-Cao/HomeServiceAI.git refs/heads/main
git log --oneline -3
```

SHA 应变成新提交；刷新仓库页应看到 History ≥ 2、README 含 CI badge 与各切片收口表、`docs/IDENTITY.md` / `config/members.example.json` 存在、`build/` 不再被跟踪、Actions 由 `ubuntu + windows` matrix 重跑。

然后按 **[`docs/RELEASE.md`](RELEASE.md)** 做 ⑤ 收尾：CI badge 核对 → 等双平台绿 → branch protection（禁 force / 禁删除 / 双状态检查）→ `v1.2.0` tag + Release（附 zip）→ About / topics → 确认 GitHub Secrets 为空 → Revoke 旧 PAT。

### 若改由 AI 代推（可选，不催）

需要**新建**一个短期细粒度 PAT：`Contents` 读写、`Workflows` 读写、`Metadata` 只读，只授权这一个仓库，有效期 1 天。放进 `/data/workspace/.env` 的 `GITHUB_TOKEN`，用完立刻 Revoke。

代推动作固定为：核对远端实际 SHA → 以线上为父生成替换提交 → 更新 `main` → 删除临时凭据 → 回报可复核 SHA。**不复用旧串、不 force、不写 token 入仓。**

### 凭据纪律

- 任何 token 都不进仓库、不进 `.env.example`、不写进文档
- 明文出现在对话里的凭据一律视为已泄露，只作撤销处理
- 本地 `.env` 已被 `.gitignore` / `.dockerignore` 排除；zip 里不带它

