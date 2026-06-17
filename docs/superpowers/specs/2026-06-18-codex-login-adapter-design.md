# Design: `codex-login` client adapter (keyless, ChatGPT-login Codex)

**Date:** 2026-06-18
**Branch:** `feat/codex-login-adapter`
**Status:** Approved design — pending implementation

## Problem

momo's only path to the `codex` CLI is the `codex` adapter, which runs
`codex exec --ignore-user-config --ignore-rules` and injects a per-job
`MOMO_API_KEY` against a custom `model_providers.momo` endpoint. By design this
**isolates** the delegated run from the user's local Codex config and auth, so it
**always requires a `base_url` + API key** (config validation rejects an empty
`api_key`).

The official `openai-codex` plugin instead spawns `codex app-server` with the
inherited environment, so it reuses the user's `codex login` (ChatGPT) auth and
needs **no API key**.

We want that keyless, login-based path available **inside momo's normal
`/momo:run` / `/momo:work` flow**, selectable as a distinct client, without
disturbing the existing isolated+keyed `codex` path.

## Non-goals

- Do not modify or remove the existing `codex` adapter's behavior.
- Do not bridge momo to the `/codex:rescue` Claude Code agent (a detached momo
  job cannot invoke a Claude Code agent). We replicate the *mechanism*
  (codex + login auth), not the command.
- No `app-server` JSON-RPC integration; we use `codex exec` like the existing
  adapter, minus the isolation/key wiring.

## Approach

Add a new client adapter `codex-login` rather than toggling the existing one.
Two adapters coexist with clear, separate semantics:

| client | auth | isolation | needs key |
|---|---|---|---|
| `codex` (existing) | injected `MOMO_API_KEY` + `model_providers.momo` | `--ignore-user-config` | yes |
| `codex-login` (new) | inherited `$CODEX_HOME/auth.json` (ChatGPT login) | none (uses user's codex auth) | no |

Rejected alternative: a `use_login` flag on the existing `codex` adapter — makes
one adapter carry two auth/isolation semantics and dirties validation. Rejected.

## Components

### 1. `scripts/lib/clients/codex-login.mjs` (new)

A self-contained adapter implementing the client interface. To avoid
duplication it imports the existing `codex` adapter and reuses its
`allowedEffort`, `parseResult`, and `extractSessionId`.

Adapter fields:
- `name: "codex-login"`
- `protocol: "openai"`
- `binary: "codex"` — the real executable name (the adapter name differs from
  the binary; see resolve change below)
- `usesClientAuth: true` — marker meaning "auth comes from the client's own
  login; no `base_url`/`api_key` required"
- `allowedEffort`: reused from `codex` (`none/minimal/low/medium/high/xhigh`)
- `supportsResume: true`, `sessionIdStable: false`

`buildInvocation({ taskPrompt, modelId, effort, sessionId, resume })`:
- Runs: `codex exec [resume <sessionId>] --ignore-rules --json
  --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
  -m <modelId> -c model_reasoning_effort="<effort>" <taskPrompt>`
- **Differs from `codex`:** no `--ignore-user-config`; no `MOMO_API_KEY` env; no
  `model_providers.momo` `-c` overrides; no `wire_api`.
- `env`: inherit `process.env` (so `$CODEX_HOME/auth.json` login is used).
- Returns `{ command: "codex", argv, env: process.env, files: [] }`.
- Keeps `--ignore-rules` so the delegated run is determined by the task prompt
  (consistent with momo's delegation model), while still using the login auth.

### 2. `scripts/lib/clients/index.mjs`

Import `codex-login` and add it to `ADAPTERS`. `getClient`, `knownClientNames`,
`clientsForProtocol`, and registry helpers pick it up automatically.

### 3. `scripts/lib/resolve.mjs` (two functions: `resolve`, `resolveForContinue`)

- **Binary resolution:** use `resolveBinary(adapter.binary || client, env)` so a
  client named `codex-login` resolves the `codex` executable.
- **Auth skip:** when `adapter.usesClientAuth === true`, skip the
  `base-url-missing` and `api-key-missing` checks and set `baseUrl = null`,
  `apiKey = null` in the returned context. Otherwise behavior is unchanged.

### 4. `scripts/lib/config.mjs` (`validateConfig`)

- A provider may declare `auth: "login"`. When set, **exempt** that provider from
  the non-empty `api_key` requirement and the per-protocol `base_url`
  requirement. `protocols` is still required.
- Non-login providers validate exactly as today (missing key still errors).

Config shape produced:
```jsonc
"providers": {
  "codex-local": { "protocols": ["openai"], "auth": "login" }
},
"models": {
  "gpt-5-codex": {
    "provider": "codex-local", "model_id": "gpt-5-codex",
    "clients": ["codex-login"], "effort": ["medium", "high", "low"]
  }
}
```
`/momo:list` shows a row with `protocol=openai`, `clients=codex-login*`.

### 5. `commands/config.md`

When the user adds an **OpenAI-protocol** provider, branch into two modes:
1. **Use API** — existing flow: collect `base_url` + `api_key`.
2. **Use local Codex** — login mode: verify `codex --version` (prompt to install
   if absent) and `codex login status` (prompt the user to run `codex login` if
   not authenticated), then write the `auth:"login"` provider + a `codex-login`
   model. **Never ask for a key.**

## Data flow

`/momo:run --model gpt-5-codex` →
`resolve()` picks client `codex-login` → `usesClientAuth` → `apiKey=null`,
`baseUrl=null`, `binaryPath=<codex>` → adapter `buildInvocation` →
`codex exec ... -m gpt-5-codex ...` with inherited env → codex uses
`$CODEX_HOME/auth.json` → output parsed by reused `codex.parseResult`.

## Error handling

- `codex` not installed → existing `client-not-installed` resolve error (now via
  `adapter.binary`).
- Not logged in → codex itself emits an auth error; surfaced through the job's
  normal failed-state stderr. The `config.md` login-status pre-check catches the
  common case earlier.
- A non-login provider missing a key still fails validation (unchanged).

## Testing

New `test/codex-login.test.mjs`, reusing `test/mock-bin/codex`:
1. `resolve()` on a login model returns `apiKey === null`, `baseUrl === null`,
   `binaryPath` ending in `codex`, `client === "codex-login"`.
2. `buildInvocation()` output: argv contains `exec`, `-m`, `model_reasoning_effort`;
   does **not** contain `--ignore-user-config`; `env` has no `MOMO_API_KEY`.
3. `validateConfig`: an `auth:"login"` provider with no key/base_url passes; a
   plain provider with no key still errors.
4. Existing `codex` adapter tests remain green (no behavioral change).

Run: `node --test test/*.mjs` — all green.

## Placement & activation

- Durable working copy at `/Users/zhanghao/work/momo-agent`, changes on
  `feat/codex-login-adapter`.
- Activate by pointing momo at the local copy:
  `claude plugin marketplace add /Users/zhanghao/work/momo-agent` then reinstall
  `momo`, replacing the GitHub-based install.
