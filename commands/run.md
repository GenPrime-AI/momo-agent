---
description: Delegate a task to a model in FOREGROUND mode, launched as a Claude background shell task — the conversation is not blocked and you are notified with the model's result when it finishes.
argument-hint: "--model <m> [--client <c>] [--effort <e>] -- <task text>"
allowed-tools: Bash
---

`/momo:run` delegates a task and gets the result back WITHOUT blocking the conversation, by riding Claude Code's own background-task mechanism (not momo's job tracking).

Invocation form: `/momo:run --model <m> [--client <c>] [--effort <e>] -- <task text>`

Raw user request:
$ARGUMENTS

How to run it:

- If the user gave a bare `/momo:run` with no `--model` and no task, do NOT guess — ask which model and what to do, then stop.
- Otherwise make EXACTLY ONE `Bash` call **with `run_in_background: true`**, passing the task via a quoted heredoc on stdin so it survives shell quoting:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" run --model <m> [--client <c>] [--effort <e>] --stdin <<'MOMO_TASK_EOF'
  <the entire task text, verbatim>
  MOMO_TASK_EOF
  ```

Rules:

- `run_in_background: true` is required. It is what makes this non-blocking: Claude Code does not wait, and re-invokes you with a task-notification when the process finishes.
- `momo run` runs the client synchronously in its own process and prints the model's final result to stdout. So the background task completes exactly when the model is done, and its stdout is the result.
- **Do NOT poll** with `/momo:status` or a foreground wait loop — that defeats the purpose. Just launch it in the background and continue; you'll be notified.
- When the task-notification arrives, relay the model's output to the user (it is the stdout of the command).
- Pass `--model` / `--client` / `--effort` through unchanged; everything after the task goes via the heredoc.

Use `/momo:work` instead (momo-managed detached jobs) when you need to fire many at once and manage their lifecycle, cancel/continue them, or have them survive across sessions.
