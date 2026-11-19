# ② 真模型 provider 接入手册（A 档切片）

> 基线：架构图 v1.2 · ADR v1.3 · `CONTRACT_VERSION = 1.2.0`
> 本刀只填既有 `llm` seam：**不新增 seam、不改 schema、不升版本、不开新 ADR、不动图、不改场景插件**。

---

## 1. 官方接口核对（2026-11-19）

| 项 | 值 | 依据 |
|---|---|---|
| OpenAI 兼容 base_url | `https://api.deepseek.com`（**不加 `/v1`**） | 官方 Quick Start [^1] |
| chat 路径 | `/chat/completions` | 同上 |
| 鉴权 | `Authorization: Bearer <key>` | 同上 |
| 思考开关 | `thinking: {"type":"enabled"\|"disabled"}` | 官方「思考模式」指南 [^2] |
| 思考强度 | `reasoning_effort: low\|high\|max` | 同上 |
| 响应正文 | `choices[0].message.content`；思考模式另有 `reasoning_content` | 同上 |
| 计量 | `usage.prompt_tokens / completion_tokens / total_tokens` | 同上 |

[^1]: `api-docs.deepseek.com` / `platform.deepseek.com` 的 Quick Start 页，多份快照一致给出 base_url 与 `/chat/completions`。
[^2]: `api-docs.deepseek.com/zh-cn/guides/thinking_mode`。

### ⚠️ 模型名存在版本漂移，不锁死

官方不同快照出现过两种写法：`deepseek-v4-flash`（含 `deepseek-v4-pro`、vision 实验版）与 `deepseek-flash`（Quick Start 注明 "Use deepseek-flash as the model name"）。`deepseek-chat` / `deepseek-reasoner` 已于 **2026-07-24 15:59 UTC** 停用，两个旧别名都映射到 Flash 的非思考 / 思考模式，**不是** Pro；误选 Pro 成本约为 3 倍 [^3]。

[^3]: 官方弃用公告与独立定价追踪（2026-09-18 核对）。价格数字仅作选型提示，以厂商当期价目表为准。

因此：

- 常量 `DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash'` 只是**默认值**
- `deepseekLlm({ model })` / 环境变量 `DEEPSEEK_MODEL` 可覆盖
- `smoke:llm` **先打 `/models`** 打印当期真实列表；若默认名不在列表里会明确提示显式指定
- 刻意**不自动取 `/models` 第一个**：不同型号价差数倍，选错不报错、只悄悄变贵

---

## 2. 最大的工程约束：同步 seam ↔ 异步 HTTP

`LlmProvider.complete(prompt): string` 是**同步**契约，真 fetch 是异步的。改契约会让 `MemoryEvent` 语义变化，属 C 档（升版本 + ADR + 改图），本刀不做。

采用与 L0 `hydrate → 同步操作 → flush` **同构**的桥接：

```
异步外环                          同步内核（一行未改）
──────────                        ──────────────────
reflectWithModel(app, p, input)
  ├─ await p.prepare(question)  ── 真发 /chat/completions
  │    └─ 结果写入「下一次 complete 的同步槽」
  └─ app.service.reflect(input)
       ├─ recall()                 （同步）
       └─ model.complete(prompt)  → 从槽里取到真结果
                                  → ReflectResult.synthesis
```

- `complete()` 三级取值：**精确缓存 → 预取槽 → 确定性降级串**
- `complete()` **绝不抛错、绝不发网络**；网络异常只留在 `provider.stats.lastError`
- 真调用失败时 `reflectWithModel` 返回 `model_reply: null`，内核照常走降级串，不抛穿应用
- 一次 `prepare()` 对应紧接着的一次 `reflect()`；槽被消费即清空（`hasPendingReply()` 可观测）

> ③ 常驻端点落地时，这个外环编排会固化进 worker。现在它是一段显式调用，不藏在内核里。

---

## 3. 双通道平级，不设默认

同一份实现 `openAiCompatibleLlm()`，两个工厂：

| 工厂 | `channel` | 默认端点 | `thinking` |
|---|---|---|---|
| `deepseekLlm()` | `api` | `https://api.deepseek.com/chat/completions` | 显式 `disabled` |
| `localGatewayLlm()` | `local` | `http://127.0.0.1:11434/v1/chat/completions` | 不发送（本地网关通常不认） |

- **默认 A/B 两份 profile 原样不动**，仍用确定性 stub；真模型只在 `cloudProfile()` / `localGatewayProfile()` 显式装配时生效
- 这两份装配沿用 `l0Profile()` 的「运行时生成」模式，**不新增 profile 文件**，seam 集合与 A/B 严格一致（测试 ⑪ 断言）
- 本地端点 / 模型名可通过 `LLM_LOCAL_ENDPOINT` / `LLM_LOCAL_MODEL` 指向 Ollama、vLLM、LM Studio
- 显式关闭思考模式：官方默认开启且 effort=high，会**静默**产生 `reasoning_content` 与额外 token；要推理再传 `thinking:'enabled'`

---

## 4. 用法

### 代码里

```js
import { deepseekLlm } from './build/src/providers/openai-compatible.js'
import { cloudProfile, reflectWithModel } from './build/src/runtime/llm-gateway.js'
import { assemble } from './build/src/runtime/assemble.js'

const llm = deepseekLlm({
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: process.env.DEEPSEEK_MODEL,   // 不传则用默认值
  timeoutMs: 20_000,
  maxRetries: 2,
})

const app = assemble(cloudProfile(llm))
app.service.retain({ principal: 'u1', bank_id: 'b1', content: '客厅灯晚上七点自动开' })
app.service.drain()

const r = await reflectWithModel(app, llm, { principal: 'u1', bank_id: 'b1', question: '照明习惯' })
console.log(r.synthesis, r.model_reply.usage)
app.dispose()
```

### 命令行（真调，不进 verify / CI）

```bash
cp .env.example .env         # 填 DEEPSEEK_API_KEY；.env 已被 git/docker/npm 忽略
npm run smoke:llm            # 云 API：先列 /models，再真调一次
npm run smoke:llm -- --local # 本地网关
```

无 `DEEPSEEK_API_KEY` 时脚本 **SKIP（exit 2）**，不是失败。密钥只从环境变量读，不打印、不落盘、不写日志。

### 环境变量

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 云 API 密钥（**必填才真调**） |
| `DEEPSEEK_MODEL` | 覆盖模型名，建议取 `/models` 当期返回 |
| `DEEPSEEK_BASE_URL` | 覆盖 base_url，默认 `https://api.deepseek.com` |
| `DEEPSEEK_TIMEOUT_MS` | 单次超时，默认 20000 |
| `LLM_LOCAL_ENDPOINT` / `LLM_LOCAL_MODEL` | 本地网关端点与模型名 |

---

## 5. 错误、限流与成本

| 情况 | 行为 |
|---|---|
| 429 | 尊重 `Retry-After`；无该头则指数退避；`stats.retried429` 可观测 |
| 4xx / 5xx | 抛 `LlmProtocolError`，含 status 与响应片段前 200 字 |
| 超时 | `AbortController` abort；`stats.timeouts++` |
| 响应畸形 | 缺 `choices` / `content` 非字符串 → `LlmProtocolError` |
| 网络异常 | 记入 `stats.lastError`；**`complete()` 仍返回字符串** |
| 计量 | `stats.totalTokens` 累计 `usage.total_tokens` |

`fetch` 与 `sleep` / `now` 均可注入 → 14 项专项**全部离线**，包括一条全局 `fetch` 守卫断言「绝不触达真实网络」。

---

## 6. 隐私边界（别悄悄破功）

图 2 是家庭私有化愿景，健康 / 孩子学习 / 工作资料发到托管 API 与初衷有冲突。守住三条：

1. **默认不挂云 API**：A/B 原样不动，只有显式 `cloudProfile()` 才发网络
2. **`defense` 仍在 `retain` 之前**：PII / 密钥先 redact，再进任何链路（本刀未改该顺序）
3. **模型名与端点都是装配数据**，不写进内核或场景插件；内核纯度检查 `PASS`

---

## 7. 已知边界（如实登记）

- **只有 `reflect` 主链路拿到真模型输出**。`retain` 的 `extractor` 仍按句号分句、`embedder` 仍是 16 维哈希、`precompute` 仍截断 240 字 —— 这些是后续切片，不是本刀范围
- **无常驻监听端点**，`prepare()` 是显式一次性调用；③ 才固化为 worker
- **未在本机跑过真实 API 调用**：沙盒出口对 `api.deepseek.com` 返回 403（策略拦截，非鉴权失败）。真调用需你本地有网络时执行 `npm run smoke:llm`
- 官方模型名 / 价格存在快照漂移，本文只用当期 Quick Start 作默认，不把二手数字当定论

---

## 8. A 档落点自查

`git diff` 只落在：`src/providers/openai-compatible.ts`（新增）、`src/runtime/llm-gateway.ts`（新增）、`tests/llm-provider.test.mjs`（新增）、`scripts/smoke-llm.mjs`（新增）、`docs/LLM.md`（新增）、`.env.example`、`package.json`、`README.md`、`docs/DEPLOY.md`、`tests/provider-swap.test.mjs`（追加禁用词）。

- 未动 `seams/*.ts`、未动 10 份 schema、`CONTRACT_VERSION` 仍 **1.2.0**
- 架构图 **v1.2 不动**、ADR 仍 6 条、registry 32 seam 状态不变
- `src/scenes/memory-scene.ts` **一行未改** —— 换 provider 零改动继续成立
- A/B 两份 profile **原样不动**；内核纯度 `PASS`，违例注入仍 `FAIL`
- `pg` / 任何模型 SDK **都不是依赖**：用原生 `fetch`，核心运行时零依赖不变
- 单测里出现 `sk-unit-test-placeholder` 等仅为脱敏规则测试样本，非凭据

---

## 9. 下一刀

③ 真后台 worker + REST/MCP 监听端点（把 `prepare()` 外环固化进常驻进程，`app` 才改为 `restart: unless-stopped`）→ ④ 身份与审计持久化 → ⑤ tag / release。每步 A 档、`npm run verify` 全绿、A/B 原样不动。
