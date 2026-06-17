# codex-login Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a keyless `codex-login` client that drives the `codex` CLI using the user's own `codex login` (ChatGPT) auth, selectable in `/momo:run` / `/momo:work`, without changing the existing isolated+keyed `codex` client.

**Architecture:** A new client adapter `codex-login` (binary `codex`, `protocol: "openai"`, flag `usesClientAuth: true`) reuses the existing `codex` adapter's `parseResult`/`extractSessionId`/`allowedEffort` but builds a `codex exec` invocation **without** `--ignore-user-config` and **without** the `MOMO_API_KEY` / `model_providers.momo` overrides — so codex falls back to its default provider + `$CODEX_HOME/auth.json` login. `resolve.mjs` learns to (a) find the binary via `adapter.binary` and (b) skip the `base_url`/`api_key` requirements for `usesClientAuth` adapters. `config.mjs` exempts a provider declaring `auth: "login"` from the key/base_url checks. The config flow gains an OpenAI → (API | local Codex) branch.

**Tech Stack:** Node.js ESM (`.mjs`), zero runtime dependencies (node built-ins only), `node:test` for tests, `codex` CLI.

## Global Constraints

- Node built-ins only; **zero third-party dependencies** (matches the rest of `scripts/`).
- Do **not** change the behavior of the existing `codex` adapter — `codex-login` is additive.
- POSIX focus (macOS/Linux); same as the rest of momo.
- Tests run with: `node --test test/*.mjs` — the whole suite must stay green.
- Commit messages use Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`), matching the repo's history. End each commit message with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- Work on branch `feat/codex-login-adapter`.

## File Structure

- Create: `scripts/lib/clients/codex-login.mjs` — the new adapter (one responsibility: build a login-mode codex invocation; reuse codex parsing).
- Modify: `scripts/lib/clients/index.mjs` — register the adapter.
- Modify: `scripts/lib/resolve.mjs` — binary indirection (`adapter.binary`) + `usesClientAuth` credential skip, in both `resolve` and `resolveForContinue`.
- Modify: `scripts/lib/config.mjs` — `auth: "login"` provider exemption + reject unknown `auth` values.
- Modify: `scripts/momo.mjs` — guard the `MOMO_JOB_API_KEY` env handoff against a null key (login jobs have no key).
- Modify: `commands/config.md` — OpenAI provider → (API | local Codex) branch.
- Create: `test/codex-login.test.mjs` — adapter, resolve, validateConfig, and end-to-end work-job tests (reusing `test/mock-bin/codex`).

---

### Task 1: `codex-login` adapter + registry

**Files:**
- Create: `scripts/lib/clients/codex-login.mjs`
- Modify: `scripts/lib/clients/index.mjs:6-9`
- Test: `test/codex-login.test.mjs`

**Interfaces:**
- Consumes: the existing `codex` adapter's default export (`scripts/lib/clients/codex.mjs`) for `allowedEffort`, `parseResult`, `extractSessionId`.
- Produces: a default-exported adapter object `{ name: "codex-login", protocol: "openai", binary: "codex", usesClientAuth: true, allowedEffort, supportsResume, sessionIdStable, buildInvocation, parseResult, extractSessionId }`. `buildInvocation({ taskPrompt, modelId, effort, sessionId, resume })` returns `{ command: "codex", argv, env: {}, files: [] }`.

- [ ] **Step 1: Write the failing test**

Create `test/codex-login.test.mjs`:

```js
// codex-login: keyless, ChatGPT-login codex adapter — identity, build invocation,
// resolve (no key/base_url), config validation, and an end-to-end work job.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import codexLogin from "../scripts/lib/clients/codex-login.mjs";
import { getClient, knownClientNames } from "../scripts/lib/clients/index.mjs";

test("codex-login adapter: identity + reused codex pieces", () => {
  assert.equal(codexLogin.name, "codex-login");
  assert.equal(codexLogin.protocol, "openai");
  assert.equal(codexLogin.binary, "codex");
  assert.equal(codexLogin.usesClientAuth, true);
  assert.ok(codexLogin.allowedEffort.has("high"));
  assert.ok(knownClientNames().includes("codex-login"));
  assert.equal(getClient("codex-login"), codexLogin);
});

test("codex-login buildInvocation: login mode, no config-isolation, no key env", () => {
  const inv = codexLogin.buildInvocation({
    taskPrompt: "say hi",
    modelId: "gpt-5-codex",
    effort: "medium",
    sessionId: "s1",
    resume: false,
  });
  assert.equal(inv.command, "codex");
  assert.equal(inv.argv[0], "exec");
  assert.ok(inv.argv.includes("-m"));
  assert.ok(inv.argv.includes("gpt-5-codex"));
  // login mode: must NOT isolate from user config, must NOT inject a momo provider/key
  assert.equal(inv.argv.includes("--ignore-user-config"), false);
  assert.equal(inv.argv.some((a) => String(a).includes("model_providers.momo")), false);
  assert.equal("MOMO_API_KEY" in (inv.env || {}), false);
  // effort is wired through, task prompt is last
  assert.ok(inv.argv.some((a) => String(a).includes('model_reasoning_effort="medium"')));
  assert.equal(inv.argv[inv.argv.length - 1], "say hi");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/codex-login.test.mjs`
Expected: FAIL — `Cannot find module '.../clients/codex-login.mjs'`.

- [ ] **Step 3: Create the adapter**

Create `scripts/lib/clients/codex-login.mjs`:

```js
// codex-login.mjs — client adapter for the `codex` CLI using the user's own
// `codex login` (ChatGPT/OpenAI) auth instead of a momo-configured api key.
//
// Same binary and output format as the `codex` adapter, but:
//   - no `--ignore-user-config`  → codex loads $CODEX_HOME (incl. auth.json login)
//   - no MOMO_API_KEY / model_providers.momo overrides → codex uses its own default provider + login
// Result: a keyless, login-based codex path, selectable as client "codex-login".

import codex from "./codex.mjs";

export default {
  name: "codex-login",
  protocol: "openai",
  // The adapter name differs from the executable; resolve uses `binary` to find it on PATH.
  binary: "codex",
  // Auth comes from the client's own login → resolve skips provider base_url/api_key.
  usesClientAuth: true,
  allowedEffort: codex.allowedEffort,
  supportsResume: true,
  // codex's resumable session id is only known after parsing output (same as the codex adapter).
  sessionIdStable: false,

  // Pure: returns { command, argv, env, files }. No baseUrl/apiKey/wireApi — login mode ignores them.
  buildInvocation({ taskPrompt, modelId, effort, sessionId, resume }) {
    // --ignore-rules keeps the run determined by the task body (no project/user .rules);
    // we deliberately KEEP user-config so $CODEX_HOME/auth.json (the login) is used.
    const iso = [
      "--ignore-rules",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    const opts = [];
    if (effort) opts.push("-c", `model_reasoning_effort="${effort}"`);

    let argv;
    if (resume) {
      // Options before SESSION_ID, else codex misparses them as positional args.
      argv = ["exec", "resume", ...iso, ...opts, "-m", modelId, sessionId, taskPrompt];
    } else {
      argv = ["exec", ...iso, "-m", modelId, ...opts, taskPrompt];
    }
    // Empty env overlay: inherit the parent env so codex reads its own login/config.
    return { command: "codex", argv, env: {}, files: [] };
  },

  // Same wire format as the codex adapter — reuse its parsers (plain functions, no `this`).
  parseResult: codex.parseResult,
  extractSessionId: codex.extractSessionId,
};
```

- [ ] **Step 4: Register the adapter**

Modify `scripts/lib/clients/index.mjs` lines 6-9:

```js
import claude from "./claude.mjs";
import codex from "./codex.mjs";
import codexLogin from "./codex-login.mjs";

const ADAPTERS = [claude, codex, codexLogin];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/codex-login.test.mjs`
Expected: PASS (both Task 1 tests green).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/clients/codex-login.mjs scripts/lib/clients/index.mjs test/codex-login.test.mjs
git commit -m "feat(client): add keyless codex-login adapter (uses codex's own login)"
```

---

### Task 2: resolve — binary indirection + client-auth credential skip

**Files:**
- Modify: `scripts/lib/resolve.mjs` (`resolve` §8.4 line 212 and §8.6 lines 252-265 + return line 295; `resolveForContinue` lines 104-117 + its return)
- Modify: `scripts/momo.mjs:471` (guard the `MOMO_JOB_API_KEY` handoff against a null key)
- Test: `test/codex-login.test.mjs`

**Interfaces:**
- Consumes: `getClient`/registry; the `adapter.binary` and `adapter.usesClientAuth` fields from Task 1.
- Produces: `resolve(config, { model, client?, effort?, env? })` returns a context where, for a `usesClientAuth` adapter, `apiKey === null` and `baseUrl === null`, and `binaryPath` is resolved from `adapter.binary`. Non-auth adapters are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/codex-login.test.mjs`:

```js
import { resolve } from "../scripts/lib/resolve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_BIN = path.join(HERE, "mock-bin");
const ENV = { ...process.env, PATH: `${MOCK_BIN}${path.delimiter}${process.env.PATH}` };

// A config that drives codex via the user's login (no provider key/base_url).
function loginConfig() {
  return {
    version: 1,
    providers: { "codex-local": { protocols: ["openai"], auth: "login" } },
    models: {
      "gpt-5-codex-login": {
        provider: "codex-local",
        model_id: "gpt-5-codex",
        clients: ["codex-login"],
      },
    },
  };
}

test("resolve: codex-login needs no key/base_url and finds the codex binary", () => {
  const ctx = resolve(loginConfig(), {
    model: "gpt-5-codex-login",
    env: ENV,
    taskPrompt: "hi",
  });
  assert.equal(ctx.client, "codex-login");
  assert.equal(ctx.apiKey, null);
  assert.equal(ctx.baseUrl, null);
  assert.equal(ctx.modelId, "gpt-5-codex");
  assert.ok(ctx.binaryPath.endsWith(`${path.sep}codex`));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/codex-login.test.mjs`
Expected: FAIL — `resolve` throws `ResolveError` `client-not-installed` (it looks for an executable literally named `codex-login`) or `api-key-missing`.

- [ ] **Step 3: Binary indirection in `resolve` (§8.4)**

Modify `scripts/lib/resolve.mjs` line 212:

```js
  // §8.4 — client binary installed?
  const binaryPath = resolveBinary(adapter.binary || client, env);
```

- [ ] **Step 4: Credential skip in `resolve` (§8.6)**

Replace `scripts/lib/resolve.mjs` lines 252-265 (the `§8.6` block) with:

```js
  // §8.6 — credentials. A client-auth adapter (e.g. codex-login) uses the client's own
  // login (e.g. `codex login`), so it needs no provider base_url/api_key.
  let baseUrl = null;
  let apiKey = null;
  if (!adapter.usesClientAuth) {
    baseUrl = provider.base_url && provider.base_url[protocol];
    if (!baseUrl) {
      throw new ResolveError(
        "base-url-missing",
        `provider "${providerName}" is missing a base_url for the ${protocol} protocol. Run /momo:config to fill it in.`
      );
    }
    if (typeof provider.api_key !== "string" || provider.api_key.trim() === "") {
      throw new ResolveError(
        "api-key-missing",
        `provider "${providerName}" is missing api_key. Run /momo:config to fill it in.`
      );
    }
    apiKey = provider.api_key;
  }
```

Then change the `resolve` return (was line 295) from `apiKey: provider.api_key,` to:

```js
    apiKey,
```

- [ ] **Step 5: Same two changes in `resolveForContinue`**

In `scripts/lib/resolve.mjs`, change line 104:

```js
  const binaryPath = resolveBinary(adapter.binary || base.client, env);
```

Replace lines 111-117 (the base_url/api_key block) with:

```js
  let baseUrl = null;
  let apiKey = null;
  if (!adapter.usesClientAuth) {
    baseUrl = provider.base_url && provider.base_url[protocol];
    if (!baseUrl) {
      throw new ResolveError("base-url-missing", `provider "${base.provider}" is missing a base_url for the ${protocol} protocol.`);
    }
    if (typeof provider.api_key !== "string" || provider.api_key.trim() === "") {
      throw new ResolveError("api-key-missing", `provider "${base.provider}" is missing api_key.`);
    }
    apiKey = provider.api_key;
  }
```

Then change the `resolveForContinue` return from `apiKey: provider.api_key,` to:

```js
    apiKey,
```

- [ ] **Step 6: Guard the `MOMO_JOB_API_KEY` handoff (work path)**

In `scripts/momo.mjs`, change line 471 from:

```js
      env: { ...process.env, MOMO_JOB_API_KEY: ctx.apiKey },
```

to (don't set the var to a null/"null" for keyless login jobs):

```js
      env: { ...process.env, ...(ctx.apiKey ? { MOMO_JOB_API_KEY: ctx.apiKey } : {}) },
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/codex-login.test.mjs`
Expected: PASS. Then run the full suite to confirm no regression in the existing `codex`/resolve paths:
Run: `node --test test/*.mjs`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/resolve.mjs scripts/momo.mjs test/codex-login.test.mjs
git commit -m "feat(resolve): support client-auth adapters (no provider key/base_url) + binary indirection"
```

---

### Task 3: config validation — `auth: "login"` providers

**Files:**
- Modify: `scripts/lib/config.mjs:266-278` (provider base_url/api_key block)
- Test: `test/codex-login.test.mjs`

**Interfaces:**
- Consumes: the `loginConfig()` helper defined in Task 2's test.
- Produces: `validateConfig(config)` returns `[]` for a provider with `auth: "login"` and no `api_key`/`base_url`; still errors for a plain provider missing `api_key`; errors on an unknown `auth` value.

- [ ] **Step 1: Write the failing test**

Append to `test/codex-login.test.mjs`:

```js
import { validateConfig } from "../scripts/lib/config.mjs";

test("validateConfig: auth:'login' provider may omit api_key and base_url", () => {
  assert.deepEqual(validateConfig(loginConfig()), []);
});

test("validateConfig: a non-login provider with no api_key still errors", () => {
  const cfg = loginConfig();
  delete cfg.providers["codex-local"].auth; // now a plain provider
  const errs = validateConfig(cfg);
  assert.ok(errs.some((e) => /missing api_key/.test(e)), errs.join(" | "));
});

test("validateConfig: unknown auth value is rejected", () => {
  const cfg = loginConfig();
  cfg.providers["codex-local"].auth = "oauth2";
  const errs = validateConfig(cfg);
  assert.ok(errs.some((e) => /unknown auth/.test(e)), errs.join(" | "));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/codex-login.test.mjs`
Expected: FAIL — the `auth:'login'` case reports `missing a base_url` / `missing api_key`, and the unknown-auth case has no matching error yet.

- [ ] **Step 3: Implement the exemption**

In `scripts/lib/config.mjs`, replace lines 266-278 (the `base_url` object check + the `api_key` check) with:

```js
    const isLogin = prov.auth === "login";
    if (prov.auth !== undefined && prov.auth !== "login") {
      errors.push(`${tag} has unknown auth "${prov.auth}". Only "login" is supported.`);
    }
    if (!isLogin) {
      if (!prov.base_url || typeof prov.base_url !== "object" || Array.isArray(prov.base_url)) {
        errors.push(`${tag} must have a base_url object (keyed by protocol).`);
      } else if (Array.isArray(prov.protocols)) {
        for (const proto of prov.protocols) {
          const u = prov.base_url[proto];
          if (!u || typeof u !== "string") {
            errors.push(`${tag} is missing a base_url for protocol "${proto}".`);
          }
        }
      }
      if (typeof prov.api_key !== "string" || prov.api_key.trim() === "") {
        errors.push(`${tag} is missing api_key.`);
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/codex-login.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/config.mjs test/codex-login.test.mjs
git commit -m "feat(config): allow auth:\"login\" providers to omit api_key/base_url"
```

---

### Task 4: end-to-end keyless `work` job

**Files:**
- Test: `test/codex-login.test.mjs` (reuses `test/mock-bin/codex` + helpers)

**Interfaces:**
- Consumes: `makeHome`, `writeConfigFile`, `runMomo`, `parseJobId`, `waitForJob` from `test/helpers.mjs`; the `loginConfig()` helper from Task 2's test; the registered `codex-login` client; the mock `codex` binary on PATH (injected by `runMomo`'s env).
- Produces: proof that `/momo:work --model gpt-5-codex-login` dispatches and the detached job reaches `done` without any api key.

- [ ] **Step 1: Write the test**

Append to `test/codex-login.test.mjs`:

```js
import {
  makeHome,
  writeConfigFile,
  runMomo,
  parseJobId,
  waitForJob,
} from "./helpers.mjs";

test("work: keyless codex-login job dispatches and completes via mock codex", async () => {
  const h = makeHome();
  try {
    writeConfigFile(h.momoHome, loginConfig());
    const r = runMomo(
      ["work", "--model", "gpt-5-codex-login", "--", "say hi"],
      { home: h.home, env: { MOCK_RESULT: "login-ok" } }
    );
    assert.equal(r.status, 0, r.stderr);
    const id = parseJobId(r.stdout);
    assert.ok(id, `no job id in stdout: ${r.stdout}`);
    const job = await waitForJob(h.momoHome, id, (j) =>
      ["done", "failed", "crashed", "timeout"].includes(j.status)
    );
    assert.equal(job.status, "done", JSON.stringify(job));
  } finally {
    h.cleanup();
  }
});
```

- [ ] **Step 2: Run the test**

Run: `node --test test/codex-login.test.mjs`
Expected: PASS — `runMomo` prepends `test/mock-bin` to PATH, so `codex` resolves to the mock, which emits an `agent_message` and the job finalizes as `done`. (This run exercises the Task 2 `MOMO_JOB_API_KEY` null-guard on the work path.)

- [ ] **Step 3: Run the full suite**

Run: `node --test test/*.mjs`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add test/codex-login.test.mjs
git commit -m "test(client): end-to-end keyless codex-login work job"
```

---

### Task 5: `/momo:config` — OpenAI → (API | local Codex) branch

**Files:**
- Modify: `commands/config.md`

**Interfaces:**
- Consumes: nothing in code (this is the LLM-facing command prompt).
- Produces: instructions so a future `/momo:config` session, when adding an OpenAI-protocol provider, offers "use API" vs "use local Codex (login)", and for local Codex writes an `auth:"login"` provider + a `codex-login` model after checking `codex` is installed and logged in.

- [ ] **Step 1: Add the branch documentation**

In `commands/config.md`, after the paragraph ending `...a model's clients must be drivable by its provider's protocols.` (line 32), insert:

```markdown

**OpenAI-protocol providers have two auth modes — ask which.** When the user wants to add a provider that speaks the `openai` protocol (driven by `codex`), offer:

1. **Use API** — the standard flow above: collect `base_url` (e.g. `https://api.openai.com/v1`) and `api_key`, with a model whose `clients` include `codex`.
2. **Use local Codex (login)** — drive `codex` with the user's own `codex login` (ChatGPT/OpenAI) session; **no api key**. First verify the CLI and login:
   - `codex --version` (if missing, tell the user to install the `codex` CLI and stop).
   - `codex login status` (if not logged in, ask the user to run `! codex login` in their terminal, then continue).

   Then persist a login provider plus a model whose client is `codex-login` (note: **no `api_key`, no `base_url`**):

   ```jsonc
   {
     "providers": { "codex-local": { "protocols": ["openai"], "auth": "login" } },
     "models": {
       "gpt-5-codex": { "provider": "codex-local", "model_id": "gpt-5-codex", "clients": ["codex-login"] }
     }
   }
   ```

   The `codex-login` client speaks the `openai` protocol and uses the client's own login, so the runtime requires neither a key nor a base_url for it.
```

- [ ] **Step 2: Verify by reading**

Run: `node --check scripts/momo.mjs` (sanity: no code touched) and re-read `commands/config.md` to confirm the inserted block is well-formed and consistent with the `loginConfig()` shape used in tests (`auth: "login"`, `clients: ["codex-login"]`).
Expected: the JSON example matches the validated shape; no contradictions.

- [ ] **Step 3: Commit**

```bash
git add commands/config.md
git commit -m "docs(config): add OpenAI provider API-vs-local-Codex(login) branch"
```

---

### Task 6: Activation + manual smoke test (verification)

**Files:** none (operational).

**Interfaces:**
- Consumes: the committed branch; the user's real `codex login` session.
- Produces: momo running from the local clone with a working keyless `codex-login` model.

- [ ] **Step 1: Full suite green on the branch**

Run: `node --test test/*.mjs`
Expected: all PASS.

- [ ] **Step 2: Point momo at the local clone and reinstall**

```bash
claude plugin marketplace add /Users/zhanghao/work/momo-agent
claude plugin install momo@momo-agent
```
Expected: `Successfully installed plugin: momo@momo-agent (scope: user)` from the local marketplace. (Start a new Claude Code session to pick up the new plugin code.)

- [ ] **Step 3: Configure a local-Codex model**

In a new session run `/momo:config`, choose "add a provider" → OpenAI → "use local Codex (login)". Confirm `codex --version` and `codex login status` pass, then persist the `codex-local` / `gpt-5-codex` (`codex-login`) entry. Verify with `/momo:list`.
Expected: a row `gpt-5-codex  codex-local  openai  codex-login*`.

- [ ] **Step 4: Real delegation smoke test**

Run: `/momo:run --model gpt-5-codex -- reply with the single word OK`
Expected: momo delegates via `codex exec` using the login (no key), and returns the model's reply when done.

- [ ] **Step 5: Push the branch (if the user wants a durable fork)**

```bash
git push -u origin feat/codex-login-adapter
```
(Only if the user has push rights / wants it on the remote. Otherwise the local branch is the durable copy.)

---

## Self-Review

**Spec coverage:**
- New `codex-login` adapter → Task 1. ✓
- Registry registration → Task 1. ✓
- resolve binary indirection + `usesClientAuth` skip (both functions) → Task 2. ✓
- `MOMO_JOB_API_KEY` null handoff → Task 2 Step 6. ✓
- config `auth:"login"` exemption → Task 3. ✓
- config shape (`codex-local` / `auth:"login"` / `codex-login`) → used in Tasks 2-5. ✓
- `/momo:config` OpenAI → (API | local Codex) branch → Task 5. ✓
- Tests (adapter, resolve, validateConfig, e2e work) → Tasks 1-4. ✓
- Placement & activation (local clone install) → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code.

**Type/name consistency:** Adapter fields (`name`, `protocol`, `binary`, `usesClientAuth`, `allowedEffort`) are used identically in resolve (`adapter.binary`, `adapter.usesClientAuth`) and config (registry-derived). Model/provider names (`codex-local`, `gpt-5-codex-login`, `gpt-5-codex`, `codex-login`) are consistent across Tasks 2-5. The resolve return uses the locally-computed `apiKey`/`baseUrl` (set to `null` for login), matching the test assertions `ctx.apiKey === null` / `ctx.baseUrl === null`.

**Scope:** Single, focused feature — one adapter plus the minimal wiring to support keyless client-auth. No unrelated refactoring.
