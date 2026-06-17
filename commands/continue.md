---
description: Continue an existing momo job's thread with a follow-up instruction. Spawns a NEW background job reusing the prior thread/session, returns a new job-id. Never blocks.
argument-hint: "<job-id> -- <follow-up instruction>"
allowed-tools: Agent
---

Continue a prior momo job's conversation thread. The invocation form is:

`/momo:continue <job-id> -- <follow-up instruction>`

Everything after `--` is the literal follow-up instruction and must be passed through untouched, even if it contains `--something`.

Raw user request:
$ARGUMENTS

Routing:

- If the user gave a bare `/momo:continue` with no job-id, or no follow-up text after `--`, DO NOT guess. Ask them back: which job-id do you want to continue, and what's the follow-up instruction? They can run `/momo:status` to see job-ids. Stop after asking — do not call the subagent yet.

- Otherwise, forward the request to the `momo:momo-runner` subagent via the `Agent` tool (`subagent_type: "momo:momo-runner"`), passing the job-id and follow-up text through verbatim. The subagent makes a single Bash call:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" continue <job-id> -- <follow-up instruction>
  ```

  The runtime reuses the original job's thread (resuming its client session, serialized per thread) and spawns a NEW background job, printing a new `job-id` immediately without waiting.

Rules:

- Do not do the work yourself, inspect files, or pre-plan. momo runs it on the delegated client.
- Do not block waiting for the job; this is non-blocking background delegation.
- Return the subagent's output (the new job-id and any hint) to the user verbatim.
- Resume support is client-dependent: the `claude` client supports it; if the original job ran on a client that cannot resume (e.g. `codex`, per its adapter), the runtime will say so — relay that message as-is.
