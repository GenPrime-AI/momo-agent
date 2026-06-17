# Momo Agent

> 把一段活委派给**任意厂商的模型**,在**任意兼容的 CLI 客户端**上后台跑,然后取回结果。

**momo** 是一个 [Claude Code](https://code.claude.com) 插件。在主 Claude 会话里,你把一个自包含的任务交给 GLM、DeepSeek、Kimi、MiniMax、Qwen、GPT/Codex —— 任何能通过本机某个 CLI 客户端访问到的模型 —— 让它后台跑,跑完取回结果。可理解为 OpenAI Codex 插件的"委派"思路,泛化成**多厂商 × 多客户端**。

[English](./README.md)

---

## 亮点

- **多厂商一套流程** —— 任何 Anthropic 兼容模型用 `claude` CLI 驱动,任何 OpenAI 兼容模型用 `codex`。配一次,统一用。
- **内置原生模型,零配置** —— `claude` 和 `codex` 开箱即用,直接复用该 CLI 在你机器上已有的登录态(订阅,或你自己设的全局 env),无需配 provider/key/endpoint。见 [内置原生模型](#内置原生模型)。
- **两种后台模式** —— 骑 Claude Code 原生后台(`/momo:run`,跑完自动通知)或 momo 自管 job(`/momo:work`,扇出与管理)。
- **并行扇出** —— 一次性派发多个任务,用 status / result / cancel / continue 管理。
- **自然语言触发** —— 说"momo …"它就帮你路由,不必打斜杠。

## 前置要求

- [Claude Code](https://code.claude.com)。
- 你要用的 client CLI:**`claude`**(驱动 Anthropic 协议模型)和/或 **`codex`**(驱动 OpenAI 协议模型)。
- 你配置的每个**自定义** provider 的 API key。内置原生 `claude` / `codex` 不需要 —— 它们复用 CLI 自己的登录。

## 安装

```bash
claude plugin marketplace add GenPrime-AI/momo-agent
claude plugin install momo@momo-agent
```

新开一个 Claude Code 会话 —— `/momo:*` 命令(以及 `momo` 自然语言触发)即可用。

## 快速上手

```text
/momo:run --model claude -- 用 5 条要点总结 ./src 的架构   # 零配置 —— 复用你已有的 claude 登录
/momo:config                  # 对话式:加自定义 provider/模型(GLM、DeepSeek…)
/momo:list                    # 看有哪些可用(内置原生 + 你配置的)
/momo:run --model glm-4.6 -- 用 5 条要点总结 ./src 的架构   # 委派;跑完通知你
```

---

## 内置原生模型

有两个模型无需任何配置就一直存在:

| 模型     | client   | 认证                                       |
| -------- | -------- | ------------------------------------------ |
| `claude` | `claude` | `claude` CLI 当前登录的那套                |
| `codex`  | `codex`  | `codex` CLI 当前登录的那套(需已安装)     |

"原生"意味着 momo **什么都不注入** —— 不设 provider、key、endpoint。委派出去的运行**原样继承**该 client 在本机已有的认证:订阅 OAuth 登录,或你通过 env 全局设的自定义供应商。momo 只把这次运行和你的 settings/hooks/CLAUDE.md 隔离开,**绝不碰认证**。

```text
/momo:run --model claude -- review 当前分支的 diff,标出有风险的改动
/momo:run --model claude --effort high -- 给 users 表设计一个迁移方案
```

- 零配置:你自己能用 `claude` / `codex`,momo 就能委派给它们。
- `codex` 只有在 `codex` CLI 已安装并登录时才出现在 `/momo:list` 里。
- `--effort` 给了就转发;不给则由 client 用它自己的默认。
- 如果你配置了一个同名自定义模型,它会覆盖内置的。

> 注意:原生运行走的是你的订阅/登录,因此共享其速率限制 —— 大量并行原生 job 可能撞限流。

---

## 配置

只有**自定义供应商**(GLM、DeepSeek、Kimi…)才需要这一步。内置原生 `claude` / `codex` 不用配。

`/momo:config` 是**对话式**的,不带参数。直接运行它,momo 会反问你要配什么、一步步引导,你用自然语言逐项回答。它**不预设任何 provider 或模型**,只存你告诉它的。

```text
你:    /momo:config
momo:  要配置什么?(某个 provider 的 endpoint + key · 一个模型 · 某模型的默认 client/effort)
你:    加一个 provider
momo:  哪个 provider,走什么协议,base URL 和 API key 是?
你:    叫 zhipu,anthropic 协议,https://open.bigmodel.cn/api/anthropic,key sk-…
momo:  在它上面加个模型吗?(provider · 传给 client 的 model_id · 哪些 client 能驱动)
你:    模型 glm-5.2,model_id GLM-5.2,client claude
momo:  我将保存:<回显结构化配置>,确认?
你:    确认
```

### 存的是什么

它写入 `~/.momo/config.json`(明文 key,在你本机,绝不进仓库)。一个两 provider 的例子:

```jsonc
{
  "version": 1,
  "providers": {
    "zhipu":    { "protocols": ["anthropic"], "base_url": { "anthropic": "https://open.bigmodel.cn/api/anthropic" }, "api_key": "<key>" },
    "deepseek": { "protocols": ["anthropic"], "base_url": { "anthropic": "https://api.deepseek.com/anthropic" },     "api_key": "<key>" }
  },
  "models": {
    "glm-5.2":  { "provider": "zhipu",    "model_id": "GLM-5.2",         "clients": ["claude"], "effort": ["high", "medium", "low"] },
    "deepseek": { "provider": "deepseek", "model_id": "deepseek-v4-pro", "clients": ["claude"] }
  }
}
```

- `clients` 和 `effort` 都是**有序**的 —— 第一个是默认。
- `effort` 是**可选**的。只有真正支持 effort/思考档位的模型(如 `GLM-5.2`)才填;大多数第三方模型没有 effort —— 直接不填。见 [客户端与协议](#客户端与协议)。
- 一个模型的 `clients` 必须能被其 provider 的协议驱动(`claude` 说 `anthropic`,`codex` 说 `openai`)。

---

## 使用

### `/momo:list` —— 看已配置什么

```text
/momo:list
```
```text
MODEL     PROVIDER  PROTOCOL   CLIENTS  EFFORT
--------  --------  ---------  -------  ---------------------------------
glm-5.2   zhipu     anthropic  claude*  high*,medium,low
deepseek  deepseek  anthropic  claude*
claude    native    anthropic  claude*  low,medium,high,xhigh,max
codex     native    openai     codex*   none,minimal,low,medium,high,xhigh

* = default
```

`provider: native` 的行是内置模型 —— 零配置,认证继承自 client。

### `/momo:run` —— 委派、不阻塞、跑完通知我

适合"派一件、拿结果回来"。momo 跑模型,跑完 Claude Code 用通知把输出送回主 agent —— 对话**全程不阻塞**,也无需轮询。

```text
/momo:run --model glm-5.2 -- 写一个匹配 RFC-5322 邮箱地址的正则,并简短解释
```
```text
…(你可以继续干别的;模型跑完时 Claude 把结果带回来)
```

### `/momo:work` —— 委派成可管理的后台 job

适合一次性扇出很多个、或需要 `cancel` / `continue`、或要跨 session 存活。立刻返回 `job-id`,稍后取结果。

```text
/momo:work --model glm-5.2 -- 重构 src/auth.ts:把 login() 改成 async/await,行为不变
```
```text
✓ Dispatched job glm-5.2-a1b2 in the background (glm-5.2/claude/high).
  Check progress: /momo:status glm-5.2-a1b2
  Fetch result:   /momo:result glm-5.2-a1b2
```

### `/momo:status` —— 查进度

```text
/momo:status               # 所有 job
/momo:status glm-5.2-a1b2  # 单个 job
```
状态:`queued · running · done · failed · timeout · killed · crashed`(卡住的会标"疑似卡死")。

### `/momo:result` —— 取输出

```text
/momo:result glm-5.2-a1b2
```

### `/momo:continue` —— 在同一线程上追加

复用该 job 的线程,用新指令续接(在其之后、按提交顺序跑)。

```text
/momo:continue glm-5.2-a1b2 -- 再给错误分支加个单测
```

### `/momo:cancel` —— 停掉一个 job

```text
/momo:cancel glm-5.2-a1b2
```

### 并行扇出

每个 `/momo:work` 都是独立 job —— 派多个,再逐个收:

```text
/momo:work --model glm-5.2  -- 生成数据模型
/momo:work --model deepseek -- 写 API handlers
/momo:work --model glm-5.2  -- 写测试
/momo:status                # 看它们全部
/momo:result <job-id>       # 谁好了取谁
```

### 自然语言(不打斜杠)

装好后,直接用 **`momo`** 锚点说你的需求 —— `momo:dispatch` skill 会帮你路由:

> "**momo**,把这个委派给 deepseek,跑完告诉我" · "**momo** 支持哪些模型?" · "配置 **momo**" · "我的 **momo** 任务到哪了?"

---

## `/momo:run` vs `/momo:work`

| | `/momo:run` | `/momo:work` |
|---|---|---|
| 机制 | 骑 Claude Code 原生后台任务 | momo 自管 detach job |
| 非阻塞 + 自动通知 | ✅ 原生 | ❌(轮询 status / 取 result) |
| cancel / continue / 跨 session | — | ✅ |
| 适合 | 一件事,"跑完叫我" | 扇出、生命周期管理 |

---

## 工作原理

两层:

- **协议层** —— 一个 model 能被某个 client 驱动,当且仅当该 client 会说的协议在 model endpoint 暴露的协议里。GLM 暴露 Anthropic 协议,所以 `claude` CLI 能驱动它(只需配 base_url + key + model)。只支持自家工具协议的模型,就用那个工具驱动(如 OpenAI Responses 用 `codex`)。
- **应用层** —— slash 命令 + 后台运行时。从 `(model, client, effort)` 解析出一个 job,把 client 作为隔离的 headless 进程起起来,你通过上面的命令交互。

委派运行与你本机配置**隔离**(自定义模型:`claude --bare`;原生模型:`claude --setting-sources "" --strict-mcp-config`,既保 OAuth 登录又跳过 settings/hooks/CLAUDE.md;`codex --ignore-user-config --ignore-rules` 两者通用),并默认 bypass 权限,让 headless 任务能在其工作目录内读写文件。job 在 per-thread **FIFO** 锁下执行(同线程的 continue 按顺序跑),并以可验证的进程身份追踪(被复用的 PID 绝不会误杀无关进程)。

> 委派出去的子进程**看不到**你的主对话 —— 它只看到你传进去的任务正文(以及 `/momo:continue` 时它自己的历史线程)。任务需要的上下文请写进任务里,或让它读工作目录下的文件。

---

## 客户端与协议

| 客户端 | 协议 | 可驱动 |
|---|---|---|
| `claude` | anthropic | Claude,以及任何 Anthropic 兼容端点(GLM、DeepSeek、Kimi、MiniMax、Qwen…) |
| `codex` | openai | OpenAI,以及任何 OpenAI 兼容端点 |

**关于 effort。** 每个客户端 CLI *接受*一组固定的 effort/思考档位 —— `claude`:`low / medium / high / xhigh / max`;`codex`:`none / minimal / low / medium / high / xhigh`。但 effort 只有该客户端**自家**的模型才真正生效(`claude` 对 Anthropic 自家模型、`codex` 对 OpenAI 自家模型)。**大多数第三方 Anthropic/OpenAI 兼容模型 —— GLM、DeepSeek、Kimi、MiniMax、Qwen… —— 根本没有 effort/思考控制。** 少数有(例如 `GLM-5.2`,用它自己的 model id 和档位)。所以某模型的 `effort` 列表只填*该模型实际支持的*——往往直接不填。momo 只接受既在该模型列表里、又被所选 client 认可的 effort。

新增一个 client = 加一个适配器文件;registry/运行时不用改。

---

## 说明

- **面向 POSIX**(macOS / Linux):用进程组、信号、`ps` 做存活/身份判定。Windows 为 best-effort。
- API key 以明文存于本机 `~/.momo/config.json`。分享过的 key 请及时轮换。
- session 归属用 Claude Code 官方的 `CLAUDE_ENV_FILE` 机制,每个会话的后台 job 会在其 `SessionEnd` 时清理。

## 许可

MIT
