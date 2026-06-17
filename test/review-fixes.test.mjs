// Regression coverage for the codex-review fixes:
//  P1  assessJob() must kill runner+client process trees before marking timeout.
//  P2  config-set must refuse to overwrite a hand-broken config.json.
//  P2  SessionStart hook must persist the main session id for later cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  makeHome,
  sampleConfig,
  writeConfigFile,
  runMomo,
  runCleanup,
  jobsDir,
  readJobFile,
} from "./helpers.mjs";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn a detached long sleeper (its own process group, like a real client/runner).
function sleeper(seconds = 30) {
  const c = spawn("sleep", [String(seconds)], { detached: true, stdio: "ignore" });
  c.unref();
  return c.pid;
}

test("P1: assessJob kills runner+client trees before marking a wedged job timeout", async () => {
  const h = setup();
  const runner = sleeper(30);
  const client = sleeper(30);
  try {
    const id = "glm-5.2-wedged";
    const rec = {
      id,
      status: "running",
      pid: runner, // runner alive (wedged) — NOT dead, so it's the timeout branch, not crashed
      client_pid: client,
      model: "glm-5.2",
      client: "claude",
      effort: "high",
      thread_key: "tk",
      session_id: "s",
      claude_session: null,
      cwd: h.home,
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      last_heartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      timeout_ms: 1000, // already exceeded
      exit_code: null,
      error: null,
    };
    fs.mkdirSync(jobsDir(h.momoHome), { recursive: true });
    fs.writeFileSync(path.join(jobsDir(h.momoHome), `${id}.json`), JSON.stringify(rec));

    // /momo:status invokes assessJob.
    const r = runMomo(["status", id], { home: h.home });
    assert.equal(r.status, 0, r.stderr);

    const job = readJobFile(h.momoHome, id);
    assert.equal(job.status, "timeout", "wedged job must be marked timeout");

    // both trees must be gone (no orphan client)
    for (let i = 0; i < 40 && (alive(runner) || alive(client)); i++) await wait(50);
    assert.equal(alive(runner), false, "runner tree must be killed");
    assert.equal(alive(client), false, "client tree must be killed (no orphan)");
  } finally {
    try { process.kill(-runner, "SIGKILL"); } catch {}
    try { process.kill(-client, "SIGKILL"); } catch {}
    h.cleanup();
  }
});

test("P2: config-set refuses to overwrite a hand-broken config.json", () => {
  const h = setup();
  try {
    const cfgPath = path.join(h.momoHome, "config.json");
    fs.writeFileSync(cfgPath, "{ this is not json ::::"); // hand-broken
    const before = fs.readFileSync(cfgPath, "utf8");

    const payload = JSON.stringify(sampleConfig());
    const r = runMomo(["config-set", "--json", payload], { home: h.home });

    assert.notEqual(r.status, 0, "must fail rather than silently overwrite");
    assert.match(r.stderr, /解析失败|拒绝|手改坏/, "error must explain the refusal");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "broken file must be preserved untouched");
  } finally {
    h.cleanup();
  }
});

test("P2: SessionStart hook persists the main session id to ~/.momo/current-session", () => {
  const h = setup();
  try {
    const r = runCleanup(["SessionStart"], {
      home: h.home,
      input: JSON.stringify({ session_id: "sess-PERSIST-123" }),
    });
    assert.equal(r.status, 0, r.stderr);
    const p = path.join(h.momoHome, "current-session");
    assert.ok(fs.existsSync(p), "current-session file must be written");
    assert.equal(fs.readFileSync(p, "utf8").trim(), "sess-PERSIST-123");
  } finally {
    h.cleanup();
  }
});

function setup() {
  const h = makeHome();
  writeConfigFile(h.momoHome, sampleConfig());
  return h;
}
