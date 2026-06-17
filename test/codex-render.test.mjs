// Coverage for the codex client path (work + continue/resume) and render purity.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sampleConfig,
  makeHome,
  writeConfigFile,
  runMomo,
  parseJobId,
  readJobFile,
  waitForJob,
} from "./helpers.mjs";

import { renderModelList, renderStatusList, renderResult } from "../scripts/lib/render.mjs";
import claude from "../scripts/lib/clients/claude.mjs";
import codex from "../scripts/lib/clients/codex.mjs";

function setup() {
  const h = makeHome();
  writeConfigFile(h.momoHome, sampleConfig());
  return h;
}

test("codex work runs to done and parses JSONL result + session id", async () => {
  const h = setup();
  try {
    const r = runMomo(["work", "--model", "gpt-5-codex", "--client", "codex", "--", "do codex"], {
      home: h.home,
      env: { MOCK_RESULT: "codex result text" },
    });
    assert.equal(r.status, 0, r.stderr);
    const id = parseJobId(r.stdout);
    const job = await waitForJob(h.momoHome, id, (j) => j.status === "done");
    assert.equal(job.status, "done");
    assert.equal(job.result_text, "codex result text");
    assert.equal(job.session_id, "codex-mock-session");
  } finally {
    h.cleanup();
  }
});

test("codex continue resumes the prior session (codex supports resume)", async () => {
  const h = setup();
  try {
    const base = runMomo(["work", "--model", "gpt-5-codex", "--", "base codex"], { home: h.home });
    const baseId = parseJobId(base.stdout);
    await waitForJob(h.momoHome, baseId, (j) => j.status === "done");

    const cont = runMomo(["continue", baseId, "--", "more codex"], { home: h.home });
    assert.equal(cont.status, 0, cont.stderr);
    const contId = parseJobId(cont.stdout);
    const job = await waitForJob(h.momoHome, contId, (j) => j.status === "done", {
      timeoutMs: 8000,
    });
    assert.equal(job.status, "done");
  } finally {
    h.cleanup();
  }
});

test("claude buildInvocation: pins --session-id (fresh) and unsets AUTH_TOKEN", () => {
  const inv = claude.buildInvocation({
    taskPrompt: "hi",
    modelId: "GLM-5.2",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "sess-1",
    resume: false,
  });
  assert.equal(inv.command, "claude");
  assert.ok(inv.argv.includes("--session-id"));
  assert.ok(inv.argv.includes("sess-1"));
  assert.equal(inv.env.ANTHROPIC_AUTH_TOKEN, null, "AUTH_TOKEN must be flagged for unset");
  assert.equal(inv.env.ANTHROPIC_BASE_URL, "https://b");

  const res = claude.buildInvocation({
    taskPrompt: "hi",
    modelId: "GLM-5.2",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "sess-1",
    resume: true,
  });
  assert.ok(res.argv.includes("--resume"));
  assert.equal(res.argv.includes("--session-id"), false);
});

test("codex buildInvocation: resume uses 'exec resume <session>'", () => {
  const inv = codex.buildInvocation({
    taskPrompt: "hi",
    modelId: "gpt-5-codex",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "cs-1",
    resume: true,
  });
  // shape: exec resume [OPTIONS] [SESSION_ID] [PROMPT] — options come before the session id
  assert.deepEqual(inv.argv.slice(0, 2), ["exec", "resume"]);
  assert.ok(inv.argv.includes("--json"), "resume must also emit JSONL");
  const sid = inv.argv.indexOf("cs-1");
  assert.ok(sid > 2, "session id must come AFTER options");
  assert.equal(inv.argv[sid + 1], "hi", "prompt must come right after session id");
  assert.ok(inv.argv.indexOf("--ignore-user-config") < sid, "options precede session id");
  assert.equal(inv.env.MOMO_API_KEY, "k");
});

test("codex buildInvocation: fresh run injects --json + wire_api(default chat) + responses override", () => {
  const fresh = codex.buildInvocation({
    taskPrompt: "hi",
    modelId: "glm-5.2",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "cs-1",
    resume: false,
  });
  const joined = fresh.argv.join(" ");
  assert.ok(fresh.argv.includes("--json"), "must request JSONL events");
  assert.match(joined, /model_providers\.momo\.wire_api="chat"/, "default wire_api is chat");
  assert.equal(codex.supportsResume, true);

  // codex-native models (name contains "codex") should auto-use responses even without an explicit wireApi.
  const auto = codex.buildInvocation({
    taskPrompt: "hi",
    modelId: "gpt-5-codex",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "cs-1",
    resume: false,
  });
  assert.match(auto.argv.join(" "), /model_providers\.momo\.wire_api="responses"/, "gpt-5-codex auto-defaults to responses");

  // an explicit wireApi override still takes precedence.
  const explicit = codex.buildInvocation({
    taskPrompt: "hi",
    modelId: "some-openai-model",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "cs-1",
    resume: false,
    wireApi: "responses",
  });
  assert.match(explicit.argv.join(" "), /model_providers\.momo\.wire_api="responses"/);
});

test("codex parseResult: from a log+JSONL mix, returns only the LAST agent message", () => {
  const raw = [
    "[2026-06-17] starting codex exec ...",
    "tool: reading files",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first chunk" } }),
    "tool: running tests",
    JSON.stringify({ msg: { type: "agent_message", message: "FINAL ANSWER" } }),
  ].join("\n");
  assert.equal(codex.parseResult(raw), "FINAL ANSWER");
});

test("delegated runs are isolated from local config (claude --bare, codex --ignore-*)", () => {
  const c = claude.buildInvocation({
    taskPrompt: "hi", modelId: "GLM-5.2", baseUrl: "https://b", apiKey: "k",
    effort: "high", sessionId: "s", resume: false,
  });
  assert.ok(c.argv.includes("--bare"), "claude delegate must run bare (no caller hooks/plugins/CLAUDE.md)");

  const x = codex.buildInvocation({
    taskPrompt: "hi", modelId: "gpt-5-codex", baseUrl: "https://b", apiKey: "k",
    effort: "high", sessionId: "s", resume: false,
  });
  const j = x.argv.join(" ");
  assert.match(j, /--ignore-user-config/);
  assert.match(j, /--ignore-rules/);
});

test("renderModelList marks defaults with *", () => {
  const out = renderModelList([
    {
      model: "glm-5.2",
      provider: "zhipu",
      protocols: ["anthropic", "openai"],
      clients: ["claude", "codex"],
      defaultClient: "claude",
      effort: ["high", "low"],
      defaultEffort: "high",
    },
  ]);
  assert.match(out, /claude\*/);
  assert.match(out, /high\*/);
  assert.doesNotMatch(out, /codex\*/);
});

test("renderStatusList handles empty input", () => {
  assert.match(renderStatusList([]), /No momo jobs/);
});

test("queued jobs render as in-progress, not finished", () => {
  const list = renderStatusList([
    { id: "j-1", status: "queued", model: "glm-5.2", client: "claude", effort: "high", started_at: "x" },
  ]);
  assert.match(list, /In progress/);
  assert.doesNotMatch(list, /Finished/);

  const res = renderResult({ id: "j-1", status: "queued" }, null);
  assert.match(res, /queued|hasn't started/);
  assert.doesNotMatch(res, /no successful result/);
});
