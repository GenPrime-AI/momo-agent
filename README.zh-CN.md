# momo

**把一段活委派给任意厂商的模型,在任意兼容的 CLI 客户端上后台跑,然后取回结果。**

momo 是一个 [Claude Code](https://code.claude.com) 插件。在你的主 Claude 会话里,你可以把一个自包含的任务交给 GLM、DeepSeek、Kimi、MiniMax、GPT/Codex —— 任何能通过本机某个 CLI 客户端访问到的模型 —— 让它在后台跑,跑完再把结果收回来。可以理解为 OpenAI Codex 插件的"委派"思路,泛化成**多厂商 × 多客户端**。

[English](./README.md)

---

## 为什么用

- **把子任务外包**给更便宜/更快/更专长的模型,主循环还留在自己的模型上。
- **并行扇出** —— 一次性派发多个 `/momo:work`,每个都是独立后台 job。
- **多厂商一套心智** —— provider/model 配置一次,之后统一驱动。

## 工作原理

两层:

- **协议层** —— 一个 model 能被某个 client 驱动,当且仅当该 client 会说的协议在 model endpoint 暴露的协议里。例如 GLM 暴露 Anthropic 协议,所以 `claude` CLI 能驱动它(只需配 base_url + key + model)。只支持自家工具协议的模型,就用那个工具驱动(如 OpenAI Responses 用 `codex`)。
- **应用层** —— slash 命令 + 后台运行时。`/momo:work` 解析出 `(model, client, effort)`,把 client 作为**隔离的、headless 的后台进程**起起来,立刻返回一个 `job-id`。status/result/cancel/continue 都针对这个 job。

每个 job **永远后台、非阻塞**,在 per-thread **FIFO** 锁下执行(同线程的 continue 按提交顺序跑),并以可验证的进程身份追踪(被 OS 回收复用的 PID 绝不会误杀无关进程)。委派运行与你本机配置**隔离**(`claude --bare`、`codex --ignore-user-config --ignore-rules`),并默认 bypass 权限,让 headless 任务能在其工作目录内读写文件。

> 委派出去的子进程**看不到**你的主对话 —— 它只看到你传进去的任务正文(以及 `/momo:continue` 时它自己的历史线程)。任务需要的上下文请写进任务里,或让它读工作目录下的文件。

## 安装(在 Claude Code 里)

```bash
# 1. 把本仓库加为插件 marketplace
claude plugin marketplace add GenPrime-AI/momo-agent

# 2. 安装插件
claude plugin install momo@momo-agent
```

重启 / 新开一个 Claude Code 会话,`/momo:*` 命令即可用。

> 需要相应的 client CLI 已安装:`claude`(驱动 Anthropic 协议模型)和/或 `codex`(驱动 OpenAI 协议模型),以及你配置的每个 provider 的 API key。

## 配置

`/momo:config` 是对话式的 —— 直接运行它,然后用自然语言说要配什么,例如:

```
/momo:config
> 智谱的 key 是 <KEY>,base url 用官方 anthropic 那个,模型 glm-5.2,effort high/medium/low
```

它会写入 `~/.momo/config.json`(明文 key,留在你本机,绝不进仓库)。结构:

```jsonc
{
  "version": 1,
  "providers": {
    "zhipu": {
      "protocols": ["anthropic"],
      "base_url": { "anthropic": "https://open.bigmodel.cn/api/anthropic" },
      "api_key": "<你的 key>"
    }
  },
  "models": {
    "glm-5.2": {
      "provider": "zhipu",
      "model_id": "GLM-5.2",
      "clients": ["claude"],   // 有序;第一个 = 默认
      "effort":  ["high", "medium", "low"]
    }
  }
}
```

## 命令

| 命令 | 作用 |
|---|---|
| `/momo:config` | 配置 provider / model / key / base-url / effort(自然语言)。 |
| `/momo:list` | 列出已配模型、可用 client(默认带 `*`)和 effort 选项。 |
| `/momo:work --model <m> [--client <c>] [--effort <e>] -- <任务>` | 委派任务;立刻返回 `job-id`(绝不阻塞)。 |
| `/momo:status [job-id]` | 查 job 状态(running / done / failed / timeout / killed / crashed;会标"疑似卡死")。 |
| `/momo:result <job-id>` | 取回已完成 job 的最终结果。 |
| `/momo:continue <job-id> -- <追加指令>` | 接着该 job 的线程续接(在其之后、按顺序跑)。 |
| `/momo:cancel <job-id>` | 终止一个运行中的 job。 |

不指定 `--client` / `--effort` 时,取该 model 配置里的第一个;`--model` 必填。

### 示例

```
/momo:work --model glm-5.2 -- 重构 src/auth.ts:把 login() 改成 async/await,行为不变
  → ✓ job glm-5.2-a1b2(后台)

/momo:status a1b2      → running …
/momo:result a1b2      → <模型的输出>
/momo:continue a1b2 -- 再给错误分支加个单测
```

## 客户端与协议(v1)

| 客户端 | 协议 | 可驱动 | effort 词表 |
|---|---|---|---|
| `claude` | anthropic | GLM、Claude、DeepSeek、Kimi、MiniMax、Qwen…(任何 Anthropic 兼容端点) | low, medium, high, xhigh, max |
| `codex` | openai | OpenAI / OpenAI 兼容端点 | none, minimal, low, medium, high, xhigh |

新增一个 client = 加一个适配器文件;registry/运行时不用改。

## 说明

- **面向 POSIX**(macOS / Linux):用进程组、信号、`ps` 做存活/身份判定。Windows 为 best-effort。
- API key 以明文存于本机 `~/.momo/config.json`。分享过的 key 请及时轮换。
- session 归属使用 Claude Code 官方的 `CLAUDE_ENV_FILE` 机制,每个会话的后台 job 会在其 `SessionEnd` 时被清理。

## 许可

MIT
