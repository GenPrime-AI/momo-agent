# Momo Agent

**Delegate a chunk of work to any vendor's model, running on any compatible CLI client, in the background — and fetch the result back.**

momo is a [Claude Code](https://code.claude.com) plugin. From your main Claude session you can hand a self-contained task to GLM, DeepSeek, Kimi, MiniMax, GPT/Codex — any model reachable through a CLI client your machine has — let it run in the background, and collect the result when it's done. Think of it as the OpenAI Codex plugin's "delegate" idea, generalized to **multi-vendor × multi-client**.

[简体中文](./README.zh-CN.md)

---

## Why

- **Offload subtasks** to cheaper/faster/specialized models while your main loop stays on its model.
- **Fan out in parallel** — fire many `/momo:work` calls at once; each runs as an independent background job.
- **One mental model for many providers** — configure providers/models once, drive them all the same way.

## How it works

Two layers:

- **Protocol layer** — a model is usable by a client when the client speaks a protocol the model's endpoint exposes. e.g. GLM exposes the Anthropic protocol, so the `claude` CLI can drive it (just point base URL + key + model). A model that only speaks its own tool's protocol is driven by that tool (e.g. `codex` for OpenAI's Responses API).
- **Application layer** — slash commands + a background runtime. `/momo:work` resolves `(model, client, effort)`, spawns the client as an isolated, headless, background process, and returns a `job-id` immediately. Status/result/cancel/continue act on that job.

Each job is **always background and non-blocking**, runs under a per-thread **FIFO** lock (same-thread continuations execute in submission order), and is tracked with a verifiable process identity (so a recycled PID can never kill an unrelated process). Delegated runs are **isolated** from your local config (`claude --bare`, `codex --ignore-user-config --ignore-rules`) and run with bypass-permission so a headless job can read/write files in its working directory.

> The delegated subprocess does **not** see your main conversation — it only sees the task text you pass (and, for `/momo:continue`, its own prior thread). Put the context the task needs into the task itself, or point it at files in the working directory.

## Install (in Claude Code)

```bash
# 1. add this repo as a plugin marketplace
claude plugin marketplace add GenPrime-AI/momo-agent

# 2. install the plugin
claude plugin install momo@momo-agent
```

Restart / start a new Claude Code session, then the `/momo:*` commands are available.

> Requires the relevant client CLI installed: `claude` (for Anthropic-protocol models) and/or `codex` (for OpenAI-protocol models), plus an API key for each provider you configure.

## Configure

`/momo:config` is conversational — just run it and say what to set, e.g.:

```
/momo:config
> zhipu's key is <KEY>, base url is the official anthropic one, model glm-5.2, effort high/medium/low
```

It writes `~/.momo/config.json` (plaintext keys — kept on your machine, never in this repo). Shape:

```jsonc
{
  "version": 1,
  "providers": {
    "zhipu": {
      "protocols": ["anthropic"],
      "base_url": { "anthropic": "https://open.bigmodel.cn/api/anthropic" },
      "api_key": "<your key>"
    }
  },
  "models": {
    "glm-5.2": {
      "provider": "zhipu",
      "model_id": "GLM-5.2",
      "clients": ["claude"],   // ordered; first = default
      "effort":  ["high", "medium", "low"]
    }
  }
}
```

## Commands

| Command | What it does |
|---|---|
| `/momo:config` | Configure providers / models / keys / base-urls / effort (natural language). |
| `/momo:list` | Show configured models, their clients (default `*`) and effort options. |
| `/momo:run  --model <m> [--client <c>] [--effort <e>] -- <task>` | Delegate a task as a **Claude background shell task**: non-blocking, and Claude notifies you with the model's result when it finishes. No polling. |
| `/momo:work --model <m> [--client <c>] [--effort <e>] -- <task>` | Delegate a task as a **momo-managed detached job**; returns a `job-id` immediately (never blocks). Retrieve with status/result; supports cancel/continue and survives across sessions. |
| `/momo:status [job-id]` | Show job status (running / done / failed / timeout / killed / crashed; flags suspected-stuck). |
| `/momo:result <job-id>` | Fetch the final result of a finished job. |
| `/momo:continue <job-id> -- <follow-up>` | Resume the job's thread with a follow-up (runs after it, in order). |
| `/momo:cancel <job-id>` | Kill a running job. |

Unspecified `--client` / `--effort` fall back to the model's first configured option. `--model` is required.

### Two ways to go background

- **`/momo:run` — ride Claude's own background.** It runs the client synchronously and prints the result; the command is launched with `run_in_background: true`, so the conversation isn't blocked and Claude re-invokes the agent with the result when the model finishes. Best for "delegate one thing and get notified." No job files, no polling.
- **`/momo:work` — momo-managed detached jobs.** The work is detached into momo's own background process and tracked as a job. Best when you fan out many at once, need `cancel` / `continue`, or want jobs to survive across sessions. You retrieve results with `/momo:status` and `/momo:result`.

### Example

```
/momo:work --model glm-5.2 -- refactor src/auth.ts: make login() async/await, keep behavior
  → ✓ job glm-5.2-a1b2 (background)

/momo:status a1b2      → running …
/momo:result a1b2      → <the model's output>
/momo:continue a1b2 -- now add a unit test for the error path
```

## Clients & protocols

| Client | Protocol | Drives | Effort levels the CLI accepts |
|---|---|---|---|
| `claude` | anthropic | GLM, Claude, DeepSeek, Kimi, MiniMax, Qwen … (any Anthropic-compatible endpoint) | `low`, `medium`, `high`, `xhigh`, `max` |
| `codex` | openai | OpenAI / OpenAI-compatible endpoints | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` |

The right-hand column is the set of effort values the **client CLI** will accept — **not** a promise that every model honors all of them. A given model / provider may support only a subset, or ignore effort entirely (e.g. GLM, DeepSeek and others each expose their own thinking/effort behavior). You declare the levels a specific model actually offers in its `effort` list in `~/.momo/config.json`, and momo only accepts an effort that is **both** in that model's list **and** legal for the chosen client.

Adding a client = adding one adapter file; the registry/runtime don't change.

## Notes

- **POSIX-focused** (macOS / Linux): uses process groups, signals and `ps` for liveness/identity. Windows is best-effort.
- API keys are stored in plaintext in `~/.momo/config.json` on your machine. Rotate keys you've shared.
- Session ownership uses Claude Code's official `CLAUDE_ENV_FILE` mechanism so each session's background jobs are reaped on its `SessionEnd`.

## License

MIT
