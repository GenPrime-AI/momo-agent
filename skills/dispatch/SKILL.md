---
name: dispatch
description: >-
  Route a momo request to the right momo command (delegate / query / configure / manage jobs).
  Use this whenever the user invokes momo by name. Trigger on momo-anchored phrases ONLY — never on a
  generic "run a script / make a background task" without the momo anchor, and never assume a specific
  provider is configured.
  Delegate: "momo 调度", "momo 一下", "用 momo 跑", "让 momo 做", "momo 委派给…", "让 momo 后台跑",
  "momo 并行", "momo 扇出给几个模型", "use momo to delegate", "let momo run this", "momo this".
  Query capabilities: "momo 支持哪些模型", "momo 有哪些模型", "momo 配了什么", "momo 能调度谁",
  "what models does momo have", "momo list".
  Configure: "配置 momo", "给 momo 加个模型", "给 momo 加 provider", "momo 配 key", "configure momo".
  Manage jobs: "momo 任务到哪了", "momo 进度", "看下 momo 的任务", "momo 那个结果", "取回 momo 结果",
  "取消 momo 任务", "momo 接着跑", "momo 继续", "check my momo jobs", "momo status", "momo result".
---

You are the natural-language entry point for the **momo** plugin (delegate work to any vendor's model
on any compatible CLI client). The user invoked momo without typing a slash command; figure out the
intent and carry it out using `node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" <subcommand>`.

Runtime path: `${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs`. Config lives in `~/.momo/config.json`.

## First, if a specific model is mentioned — verify it's configured

momo can only drive models the user has configured. Before delegating to a named model, check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" list
```

If the named model is **not** listed (or nothing is configured), do NOT fail blindly — tell the user
what *is* configured and offer to add it via the Configure flow below. Never assume GLM/DeepSeek/Kimi/
Codex etc. are present.

## Route by intent

### 1) Delegate work

**Default: one independent background shell PER task.** Delegate with `run`, making **one** Bash call
**per task** with `run_in_background: true`. Each task is its own shell — running independently and
notifying you with its own result when it finishes (non-blocking, no polling). This is what users
expect: "delegate this and tell me when it's done."

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" run --model <m> [--client <c>] [--effort <e>] --stdin <<'MOMO_TASK_EOF'
<the entire task text, verbatim>
MOMO_TASK_EOF
```

- **One task** → one `momo run` background call.
- **Several tasks** ("多开几个并行", testing/comparing multiple models, etc.) → fire ONE `momo run`
  background call **per task**, so the user sees N **independent** background shells. Do NOT merge them
  into a single command, and do NOT write a foreground poll loop waiting on all of them.
  - This holds **even when the user wants the results compared or a combined report** — wanting a
    combined *report* is NOT a request to combine *execution*. Run N independent shells, then aggregate
    the N results into the report after each has notified.
  - Collapse into a single command/loop **only** if the user **explicitly** asks to "run it as one
    command" / "合并到一个命令".

When picking `--model`/`--client`/`--effort`: omit `--client`/`--effort` to use the model's defaults.

**Use `work` (momo-managed detached jobs) only when the user explicitly needs momo's job management** —
to `cancel`/`continue` a job, have jobs survive across sessions, or run a large batch where keeping that
many live background shells is impractical. Even then, **never foreground-poll**; if you must wait and
aggregate, run the collection loop itself with `run_in_background`. When in doubt, choose `run`.

### 2) Query capabilities
Run `momo.mjs list` and present the configured models, their clients (default `*`) and effort options.

### 3) Configure
Ask what to set (provider / model / api-key / base-url / effort), parse the user's natural-language
answer into the config JSON shape, confirm it back, then persist:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" config-set --json '<structured JSON>'
```
Confirm before overwriting an existing key. (This only edits config; it never calls a model.)

### 4) Manage jobs
- progress / "where's my job" → `momo.mjs status [job-id]`
- fetch output → `momo.mjs result <job-id>`
- stop one → `momo.mjs cancel <job-id>`
- continue a finished job's thread → `momo.mjs continue <job-id> --stdin <<heredoc`

## Rules

- Stay a thin router: decide intent, run the right subcommand, relay the result. Don't do the delegated
  work yourself.
- Never busy-poll a foreground (`run`) job — that defeats the non-blocking design.
- Pass task text via a quoted heredoc on `--stdin` so apostrophes / quotes / newlines survive.
- If intent is ambiguous (e.g. bare "momo"), ask a one-line clarifying question.
