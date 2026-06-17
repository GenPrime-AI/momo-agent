---
description: Show momo job status. With a job-id shows that one job; bare shows all jobs. Liveness is verified (pid probe + heartbeat + timeout), not just the stored status field.
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" status "$ARGUMENTS"`

Present the command output to the user as-is.

- If no job-id was passed: the output lists all jobs. Render it compactly (a table is fine). Preserve the actionable fields: job id, model, client, effort, status, and any follow-up hints (e.g. `/momo:result <id>`, `/momo:cancel <id>`).
- If a job-id was passed: show the full output for that job, including any liveness note (e.g. crashed / suspected-stuck / timeout). Do not summarize or condense it.
