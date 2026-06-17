# Momo Agent

> Delegate a chunk of work to **any vendor's model**, running on **any compatible CLI client**, in the background — and fetch the result back.

**momo** is a [Claude Code](https://code.claude.com) plugin. From your main Claude session you hand a self-contained task to GLM, DeepSeek, Kimi, MiniMax, Qwen, GPT/Codex — any model reachable through a CLI client on your machine — let it run in the background, and collect the result when it's done. It's the OpenAI Codex plugin's "delegate" idea, generalized to **multi-vendor × multi-client**.

[简体中文](./README.zh-CN.md)

---

## Highlights

- **Any provider, one workflow** — drive any Anthropic-compatible model through the `claude` CLI, any OpenAI-compatible model through `codex`. Configure once, use them all the same way.
- **Two background modes** — ride Claude Code's own background (`/momo:run`, get auto-notified) or momo-managed jobs (`/momo:work`, fan out & manage).
- **Parallel fan-out** — fire many tasks at once; track them with status / result / cancel / continue.
- **Natural-language trigger** — say "momo …" and it routes for you; no slash required.

## Requirements

- [Claude Code](https://code.claude.com).
- The client CLI you intend to use: **`claude`** (for Anthropic-protocol models) and/or **`codex`** (for OpenAI-protocol models).
- An API key for each provider you configure.

## Install

```bash
claude plugin marketplace add GenPrime-AI/momo-agent
claude plugin install momo@momo-agent
```

Start a new Claude Code session — the `/momo:*` commands (and the `momo` natural-language trigger) become available.

## Quick start

```text
/momo:config                  # conversational: momo asks, you answer (provider, model, key…)
/momo:list                    # see what's configured
/momo:run --model glm-4.6 -- summarize ./src architecture in 5 bullets   # delegate; you're notified when done
```

---

## Configure

`/momo:config` is **conversational** and takes no arguments. Run it; momo asks what you want to set and walks you through it — you answer in plain language, step by step. It never assumes a provider or model; it only stores what you tell it.

```text
You:   /momo:config
momo:  What would you like to set? (a provider's endpoint + key · a model · a model's default client/effort)
You:   add a provider
momo:  Which provider, its protocol(s), base URL, and API key?
You:   call it zhipu, anthropic protocol, https://open.bigmodel.cn/api/anthropic, key sk-…
momo:  And a model on it? (provider · the model_id sent to the client · which clients can drive it)
You:   model glm-5.2, model_id GLM-5.2, client claude
momo:  Here's what I'll save: <echoes the structured config>. Confirm?
You:   yes
```

### What gets stored

It writes `~/.momo/config.json` (plaintext keys — on your machine, never in this repo). A two-provider example:

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

- `clients` and `effort` are **ordered** — the first entry is the default.
- `effort` is **optional**. Only include it for models that actually support effort/thinking levels (e.g. `GLM-5.2`); most third-party models have none — just omit it. See [Clients & protocols](#clients--protocols).
- A model's `clients` must be drivable by its provider's protocols (`claude` speaks `anthropic`, `codex` speaks `openai`).

---

## Usage

### `/momo:list` — see what's configured

```text
/momo:list
```
```text
MODEL     PROVIDER  PROTOCOL   CLIENTS  EFFORT
--------  --------  ---------  -------  ----------------
glm-5.2   zhipu     anthropic  claude*  high*,medium,low
deepseek  deepseek  anthropic  claude*

* = default
```

### `/momo:run` — delegate, non-blocking, notify me when done

Best for "delegate one thing and get the result back." momo runs the model and Claude Code re-notifies you with its output when it finishes — the conversation is **never blocked**, and there's nothing to poll.

```text
/momo:run --model glm-5.2 -- write a regex that matches RFC-5322 email addresses, with a short explanation
```
```text
… (you can keep working; when the model finishes, Claude delivers the result)
```

### `/momo:work` — delegate as a managed background job

Best when you fan out many at once, or need `cancel` / `continue`, or want jobs to survive across sessions. Returns a `job-id` immediately; you fetch the result later.

```text
/momo:work --model glm-5.2 -- refactor src/auth.ts: make login() async/await, keep behavior
```
```text
✓ Dispatched job glm-5.2-a1b2 in the background (glm-5.2/claude/high).
  Check progress: /momo:status glm-5.2-a1b2
  Fetch result:   /momo:result glm-5.2-a1b2
```

### `/momo:status` — check progress

```text
/momo:status               # all jobs
/momo:status glm-5.2-a1b2  # one job
```
States: `queued · running · done · failed · timeout · killed · crashed` (a stalled job is flagged as suspected-stuck).

### `/momo:result` — fetch the output

```text
/momo:result glm-5.2-a1b2
```

### `/momo:continue` — follow up on the same thread

Resumes the job's thread with a new instruction (runs after it, in submission order).

```text
/momo:continue glm-5.2-a1b2 -- now add a unit test for the error path
```

### `/momo:cancel` — stop a job

```text
/momo:cancel glm-5.2-a1b2
```

### Fan out in parallel

Each `/momo:work` is an independent job — dispatch several, then collect:

```text
/momo:work --model glm-5.2  -- generate the data model
/momo:work --model deepseek -- write the API handlers
/momo:work --model glm-5.2  -- write the tests
/momo:status                # watch them all
/momo:result <job-id>       # collect each as it finishes
```

### Natural language (no slash)

Once installed, you can just say what you want using the **`momo`** anchor — the `momo:dispatch` skill routes it for you:

> "**momo**, delegate this to deepseek and tell me when it's done" · "what models does **momo** have?" · "configure **momo**" · "where's my **momo** job?"

---

## `/momo:run` vs `/momo:work`

| | `/momo:run` | `/momo:work` |
|---|---|---|
| Mechanism | rides Claude Code's own background task | momo-managed detached job |
| Non-blocking + auto-notify | ✅ native | ❌ (poll status / fetch result) |
| Cancel / continue / cross-session | — | ✅ |
| Best for | one task, "tell me when done" | fan-out, lifecycle management |

---

## How it works

Two layers:

- **Protocol layer** — a model is usable by a client when the client speaks a protocol the model's endpoint exposes. GLM exposes the Anthropic protocol, so the `claude` CLI can drive it (just point base URL + key + model). A model that only speaks its own tool's protocol is driven by that tool (e.g. `codex` for OpenAI's Responses API).
- **Application layer** — slash commands + a background runtime. A job is resolved from `(model, client, effort)`, the client is spawned as an isolated headless process, and you interact via the commands above.

Delegated runs are **isolated** from your local config (`claude --bare`; `codex --ignore-user-config --ignore-rules`) and run with bypass-permission so a headless job can read/write files in its working directory. Jobs run under a per-thread **FIFO** lock (same-thread continuations execute in order) and are tracked with a verifiable process identity (a recycled PID can never kill an unrelated process).

> The delegated subprocess does **not** see your main conversation — it only sees the task text you pass (and, for `/momo:continue`, its own prior thread). Put the context the task needs into the task itself, or point it at files in the working directory.

---

## Clients & protocols

| Client | Protocol | Drives |
|---|---|---|
| `claude` | anthropic | Claude, plus any Anthropic-compatible endpoint (GLM, DeepSeek, Kimi, MiniMax, Qwen, …) |
| `codex` | openai | OpenAI, plus any OpenAI-compatible endpoint |

**About effort.** Each client CLI *accepts* a fixed set of effort/thinking levels — `claude`: `low / medium / high / xhigh / max`; `codex`: `none / minimal / low / medium / high / xhigh`. But effort is only meaningfully honored by the client's **own** models (Anthropic's for `claude`, OpenAI's for `codex`). **Most third-party Anthropic/OpenAI-compatible models — GLM, DeepSeek, Kimi, MiniMax, Qwen, … — expose no effort/thinking control at all.** A few do (e.g. `GLM-5.2`, under its own model id and its own levels). So set a model's `effort` list to what *that specific model* actually supports — often just omit it. momo only accepts an effort that is in the model's configured list **and** legal for the chosen client.

Adding a client = adding one adapter file; the registry/runtime don't change.

---

## Notes

- **POSIX-focused** (macOS / Linux): uses process groups, signals and `ps` for liveness/identity. Windows is best-effort.
- API keys are stored in plaintext in `~/.momo/config.json` on your machine. Rotate keys you've shared.
- Session ownership uses Claude Code's official `CLAUDE_ENV_FILE` mechanism, so each session's background jobs are reaped on its `SessionEnd`.

## License

MIT
