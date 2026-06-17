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

You are the natural-language entry point for the momo plugin (delegate work to any vendor's model on any compatible CLI client). The user invoked momo without a slash command; work out the intent and carry it out via `node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" <subcommand>`. Config lives in `~/.momo/config.json`.

When a specific model is named, first confirm it's configured by running `momo.mjs list`. If it isn't there (or nothing is configured), tell the user what is configured and offer the Configure flow below — momo only drives models the user has set up.

## Route by intent

### 1) Delegate work

Launch one independent background shell per task. Delegate with `run`, making one Bash call per task with `run_in_background: true`, so each task runs on its own and notifies you with its result when it finishes — non-blocking, no polling.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" run --model <m> [--client <c>] [--effort <e>] --stdin <<'MOMO_TASK_EOF'
<the task text, verbatim>
MOMO_TASK_EOF
```

For several tasks (e.g. "多开几个并行", comparing models), fire one such call per task, so the user gets N independent shells. If they want the outputs compared or written up, aggregate the N results once each has notified — that's a report, not a reason to run them as one command. Combine into a single command only if the user explicitly asks to. Omit `--client` / `--effort` to use the model's defaults.

Use `work` (a momo-managed detached job) only when the user needs to cancel or continue a job, have it survive across sessions, or run a batch too large for that many live shells — forward to the `momo:momo-runner` subagent. Even then, wait via `run_in_background`, not a foreground poll loop.

### 2) Query capabilities

Run `momo.mjs list` and present the configured models, their clients (default `*`) and effort.

### 3) Configure

Ask what to set (provider / model / api-key / base-url / effort), turn the user's answer into the config JSON shape, confirm it back, then persist with `momo.mjs config-set --json '<structured JSON>'`. Confirm before overwriting an existing value. This only edits config; it never calls a model.

### 4) Manage jobs

- progress → `momo.mjs status [job-id]`
- fetch output → `momo.mjs result <job-id>`
- stop one → `momo.mjs cancel <job-id>`
- follow up on a finished job → `momo.mjs continue <job-id> --stdin <<heredoc`

## Rules

Stay a thin router: pick the intent, run the right subcommand, relay the result; don't do the delegated work yourself. Pass task text via a quoted heredoc on `--stdin` so apostrophes, quotes, and newlines survive. If the intent is ambiguous (e.g. a bare "momo"), ask one short clarifying question.
