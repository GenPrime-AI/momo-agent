---
description: Continue an existing momo job's thread with a follow-up instruction. Spawns a NEW background job reusing the prior thread/session, returns a new job-id. Never blocks.
argument-hint: "<job-id> -- <follow-up instruction>"
allowed-tools: Agent
---

Continue a prior momo job's thread with a follow-up:

`/momo:continue <job-id> -- <follow-up instruction>`

Everything after `--` is the literal follow-up, passed through untouched.

Raw user request:
$ARGUMENTS

If there's no job-id or no follow-up text, ask for both, then stop. The user can run `/momo:status` to see job-ids.

Otherwise forward the request to the `momo:momo-runner` subagent (`subagent_type: "momo:momo-runner"`) with the job-id and follow-up text verbatim. momo reuses the original job's thread (resuming its client session, serialized per thread) and spawns a new background job, printing a new `job-id` without waiting. Return the runner's output verbatim.

Resume is client-dependent — `claude` supports it; if the original job ran on a client that can't resume (e.g. `codex`), momo says so, and you relay that message as-is.
