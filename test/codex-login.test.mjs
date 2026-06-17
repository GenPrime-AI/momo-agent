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
