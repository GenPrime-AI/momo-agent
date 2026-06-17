---
description: Delegate a chunk of work to a model running on a chosen CLI client, in the background. Returns a job-id immediately and never blocks.
argument-hint: "--model <m> [--client <c>] [--effort <e>] -- <task text>"
allowed-tools: Agent
---

Delegate work to momo. The invocation form is flag-based:

`/momo:work --model <m> [--client <c>] [--effort <e>] -- <task text>`

Everything after `--` is the literal task text and must be passed through untouched, even if it contains `--something` — it is NOT a flag.

Raw user request:
$ARGUMENTS

Routing:

- If the user gave a bare `/momo:work` with NO arguments (or with no `--model` and no task text), DO NOT guess. Ask them back: which model should this go to, and what should it do? Optionally remind them they can pass `--client` / `--effort`. They can run `/momo:list` to see configured models. Stop after asking — do not call the subagent yet.

- Otherwise, forward the request to the `momo:momo-runner` subagent via the `Agent` tool (`subagent_type: "momo:momo-runner"`), passing the user's flags and task text through verbatim. The subagent makes a single Bash call:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" work --model <m> [--client <c>] [--effort <e>] -- <task text>
  ```

  The runtime validates, spawns a background process, and prints a `job-id` immediately WITHOUT waiting for the work to finish.

Rules:

- Do not do the work yourself, inspect files, or pre-plan the task. momo runs it on the delegated client.
- Do not block waiting for the job. The whole point is non-blocking background delegation; the user can fire several `/momo:work` calls in parallel.
- Return the subagent's output (the job-id and any hint) to the user verbatim. Then they can use `/momo:status`, `/momo:result <job-id>`, `/momo:cancel <job-id>`, or `/momo:continue <job-id>`.
- Do not strip or reinterpret `--model` / `--client` / `--effort`, and never move task text into a flag or vice versa.
