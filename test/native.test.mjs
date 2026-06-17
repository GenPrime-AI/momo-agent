// Native (built-in) models: auth inherited from the client, no provider/key injection.
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolve, ResolveError } from "../scripts/lib/resolve.mjs";
import { getModel, listModels, isNative } from "../scripts/lib/registry.mjs";
import claude from "../scripts/lib/clients/claude.mjs";
import codex from "../scripts/lib/clients/codex.mjs";

const EMPTY = { version: 1, providers: {}, models: {} };

test("registry exposes built-in native models; config can shadow them", () => {
  assert.ok(isNative(getModel(EMPTY, "claude")), "claude is a native built-in");
  assert.ok(isNative(getModel(EMPTY, "codex")), "codex is a native built-in");
  assert.ok(listModels(EMPTY).includes("claude"));

  // a user-configured model with the same name takes precedence (not native)
  const shadowed = { version: 1, providers: {}, models: { claude: { provider: "p", model_id: "X", clients: ["claude"] } } };
  assert.equal(isNative(getModel(shadowed, "claude")), false, "config model shadows the native built-in");
});

test("resolve(native): no provider/baseUrl/apiKey; effort optional, never defaulted", () => {
  // PATH override so the fake 'claude' binary resolves (helpers ship a mock-bin dir under test/).
  const env = { ...process.env };
  const ctx = resolve(EMPTY, { model: "claude", taskPrompt: "hi", env });
  assert.equal(ctx.native, true);
  assert.equal(ctx.provider, null);
  assert.equal(ctx.baseUrl, null);
  assert.equal(ctx.apiKey, null);
  assert.equal(ctx.modelId, null, "native pins no model id by default");
  assert.equal(ctx.effort, null, "native does not force a default effort");

  // effort forwards when explicitly given and legal
  const withEffort = resolve(EMPTY, { model: "claude", effort: "high", taskPrompt: "hi", env });
  assert.equal(withEffort.effort, "high");

  // illegal effort is rejected
  assert.throws(
    () => resolve(EMPTY, { model: "claude", effort: "ultra", taskPrompt: "hi", env }),
    (e) => e instanceof ResolveError && /invalid for native model/.test(e.message)
  );
});

test("claude.buildInvocation(native): setting-sources isolation, no --bare, empty env", () => {
  const inv = claude.buildInvocation({
    taskPrompt: "hi", modelId: null, baseUrl: null, apiKey: null,
    effort: null, sessionId: "s", resume: false, native: true,
  });
  const j = inv.argv.join(" ");
  assert.match(j, /--setting-sources\s+ --strict-mcp-config/, "native uses setting-sources isolation");
  assert.equal(inv.argv.includes("--bare"), false, "native must NOT use --bare (it disables OAuth)");
  assert.equal(inv.argv.includes("--model"), false, "no --model when modelId is null");
  assert.deepEqual(inv.env, {}, "native injects no env (auth inherited)");

  // with a pinned model id, --model is passed
  const pinned = claude.buildInvocation({
    taskPrompt: "hi", modelId: "claude-sonnet-4-6", baseUrl: null, apiKey: null,
    effort: "high", sessionId: "s", resume: false, native: true,
  });
  assert.ok(pinned.argv.includes("--model") && pinned.argv.includes("claude-sonnet-4-6"));
  assert.ok(pinned.argv.includes("--effort") && pinned.argv.includes("high"));
});

test("codex.buildInvocation(native): no provider override, no MOMO_API_KEY, keeps isolation", () => {
  const inv = codex.buildInvocation({
    taskPrompt: "hi", modelId: null, baseUrl: null, apiKey: null,
    effort: null, sessionId: "s", resume: false, native: true,
  });
  const j = inv.argv.join(" ");
  assert.doesNotMatch(j, /model_provider/, "native must not set a custom provider");
  assert.doesNotMatch(j, /MOMO_API_KEY/);
  assert.equal(inv.argv.includes("-m"), false, "no -m when modelId is null");
  assert.match(j, /--ignore-user-config/, "isolation flags stay (auth.json survives them)");
  assert.deepEqual(inv.env, {}, "native injects no env");

  // effort still forwards via the generic config override
  const withEffort = codex.buildInvocation({
    taskPrompt: "hi", modelId: "gpt-5-codex", baseUrl: null, apiKey: null,
    effort: "high", sessionId: "s", resume: false, native: true,
  });
  assert.match(withEffort.argv.join(" "), /model_reasoning_effort="high"/);
  assert.ok(withEffort.argv.includes("-m") && withEffort.argv.includes("gpt-5-codex"));
});
