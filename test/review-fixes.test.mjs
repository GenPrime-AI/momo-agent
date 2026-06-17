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
  waitForJob,
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

test("P2: SessionStart registers an active session; sole active session tags new work", async () => {
  const h = setup();
  try {
    const r = runCleanup(["SessionStart"], {
      home: h.home,
      input: JSON.stringify({ session_id: "sess-ONE" }),
    });
    assert.equal(r.status, 0, r.stderr);
    const af = path.join(h.momoHome, "active-sessions.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(af, "utf8")), ["sess-ONE"]);

    // work has no CLAUDE_SESSION_ID env -> falls back to the sole active session.
    const w = runMomo(["work", "--model", "glm-5.2", "--", "x"], {
      home: h.home,
      env: { MOCK_RESULT: "ok" },
    });
    const id = w.stdout.match(/job\s+([^\s(]+)/)[1];
    const job = await waitForJob(h.momoHome, id, (j) => j.status === "done");
    assert.equal(job.claude_session, "sess-ONE", "sole active session must tag the job");
  } finally {
    h.cleanup();
  }
});

test("P2: with two active sessions, new work is tagged null (no cross-session attribution)", async () => {
  const h = setup();
  try {
    runCleanup(["SessionStart"], { home: h.home, input: JSON.stringify({ session_id: "sess-A" }) });
    runCleanup(["SessionStart"], { home: h.home, input: JSON.stringify({ session_id: "sess-B" }) });

    const w = runMomo(["work", "--model", "glm-5.2", "--", "x"], {
      home: h.home,
      env: { MOCK_RESULT: "ok" },
    });
    const id = w.stdout.match(/job\s+([^\s(]+)/)[1];
    const job = await waitForJob(h.momoHome, id, (j) => j.status === "done");
    assert.equal(job.claude_session, null, "ambiguous (2 active) must not guess a session");
  } finally {
    h.cleanup();
  }
});

test("P2: config-set merges a partial patch (does not delete untouched providers/models)", () => {
  const h = setup(); // starts with full sampleConfig on disk
  try {
    // partial patch: only change zhipu's api_key
    const patch = JSON.stringify({ providers: { zhipu: { api_key: "rotated-key" } } });
    const r = runMomo(["config-set", "--json", patch], { home: h.home });
    assert.equal(r.status, 0, r.stderr);

    const cfg = JSON.parse(fs.readFileSync(path.join(h.momoHome, "config.json"), "utf8"));
    assert.equal(cfg.providers.zhipu.api_key, "rotated-key", "patched field applied");
    assert.ok(cfg.providers.zhipu.base_url.anthropic, "untouched zhipu.base_url preserved");
    assert.ok(cfg.providers.openai, "untouched openai provider preserved");
    assert.ok(cfg.models["glm-5.2"], "untouched models preserved");
  } finally {
    h.cleanup();
  }
});

test("P2: per-model timeout_ms in config is honoured (not the 600s default)", async () => {
  const h = makeHome();
  try {
    const cfg = sampleConfig();
    cfg.models["glm-5.2"].timeout_ms = 1200; // tiny, config-driven
    writeConfigFile(h.momoHome, cfg);

    // hang forever; only the config timeout can end it (no MOMO_TIMEOUT_MS env).
    const r = runMomo(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    assert.equal(r.status, 0, r.stderr);
    const id = r.stdout.match(/job\s+([^\s(]+)/)[1];

    // Must flip to timeout well within a few seconds (proving ~1.2s config, not 600s).
    const job = await waitForJob(h.momoHome, id, (j) => j.status === "timeout", { timeoutMs: 6000 });
    assert.equal(job.status, "timeout", "config timeout_ms must drive the wall-clock kill");
  } finally {
    h.cleanup();
  }
});

test("P2: continue on a still-running codex job is rejected (session id not stable yet)", async () => {
  const h = setup();
  try {
    // codex's resume session id is only known after completion -> reject while running.
    const base = runMomo(["work", "--model", "gpt-5-codex", "--client", "codex", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    const baseId = base.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.momoHome, baseId, (j) => j.status === "running" && j.pid > 0);

    const cont = runMomo(["continue", baseId, "--", "more"], { home: h.home });
    assert.notEqual(cont.status, 0, "codex continue must wait for the base to be done");
    assert.match(cont.stderr, /完成才确定|done|完成/);

    runMomo(["cancel", baseId], { home: h.home });
  } finally {
    h.cleanup();
  }
});

test("P1: continue on a still-running claude job is allowed (queued behind it via thread lock)", async () => {
  const h = setup();
  try {
    // claude pins --session-id up front, so a follow-up can queue behind a running job.
    const base = runMomo(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    const baseId = base.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.momoHome, baseId, (j) => j.status === "running" && j.pid > 0);

    const cont = runMomo(["continue", baseId, "--", "more"], { home: h.home });
    assert.equal(cont.status, 0, cont.stderr); // accepted, not rejected
    const contId = cont.stdout.match(/job\s+([^\s(]+)/)[1];
    // the queued continuation exists and is not terminal yet (waiting on the lock)
    const q = readJobFile(h.momoHome, contId);
    assert.ok(q && (q.status === "queued" || q.status === "running"), "continuation should be active/queued");

    runMomo(["cancel", baseId], { home: h.home });
    runMomo(["cancel", contId], { home: h.home });
  } finally {
    h.cleanup();
  }
});

test("SessionStart writes 'export MOMO_SESSION_ID' into $CLAUDE_ENV_FILE", () => {
  const h = setup();
  try {
    const envFile = path.join(h.home, "claude-env");
    fs.writeFileSync(envFile, "");
    const r = runCleanup(["SessionStart"], {
      home: h.home,
      env: { CLAUDE_ENV_FILE: envFile },
      input: JSON.stringify({ session_id: "sess-ENV" }),
    });
    assert.equal(r.status, 0, r.stderr);
    const written = fs.readFileSync(envFile, "utf8");
    assert.match(written, /export MOMO_SESSION_ID='sess-ENV'/, "per-session id must be exported to env file");
  } finally {
    h.cleanup();
  }
});

test("work prefers MOMO_SESSION_ID env for job ownership", async () => {
  const h = setup();
  try {
    const w = runMomo(["work", "--model", "glm-5.2", "--", "x"], {
      home: h.home,
      env: { MOMO_SESSION_ID: "sess-MOMO", MOCK_RESULT: "ok" },
    });
    const id = w.stdout.match(/job\s+([^\s(]+)/)[1];
    const job = await waitForJob(h.momoHome, id, (j) => j.status === "done");
    assert.equal(job.claude_session, "sess-MOMO");
  } finally {
    h.cleanup();
  }
});

test("SessionEnd of the last session also reaps unowned running jobs (no leak)", async () => {
  const h = setup();
  try {
    // No session vars and no active sessions -> job is unowned (claude_session null).
    const r = runMomo(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    const id = r.stdout.match(/job\s+([^\s(]+)/)[1];
    const running = await waitForJob(h.momoHome, id, (j) => j.status === "running" && j.pid > 0);
    assert.equal(running.claude_session, null, "job should be unowned");

    // SessionEnd with no active sessions => this is the last session => reap unowned.
    const clean = runCleanup(["SessionEnd"], {
      home: h.home,
      input: JSON.stringify({ session_id: "sess-LAST" }),
    });
    assert.equal(clean.status, 0, clean.stderr);
    const job = await waitForJob(h.momoHome, id, (j) => j.status === "killed", { timeoutMs: 4000 });
    assert.equal(job.status, "killed", "unowned job must be reaped when the last session ends");
  } finally {
    h.cleanup();
  }
});

test("continue assesses base liveness: a hard-crashed base is rejected, not queued", async () => {
  const h = setup();
  const dead = sleeper(30);
  try {
    // kill the would-be runner so its pid is dead
    try { process.kill(dead, "SIGKILL"); } catch {}
    await wait(150);

    // craft a job that still says "running" on disk but whose runner pid is dead
    const id = "glm-5.2-deadbase";
    const rec = {
      id, status: "running", pid: dead, client_pid: null,
      model: "glm-5.2", client: "claude", effort: "high",
      thread_key: "tk", session_id: "11111111-1111-1111-1111-111111111111",
      claude_session: null, cwd: h.home,
      started_at: new Date().toISOString(), last_heartbeat: new Date().toISOString(),
      timeout_ms: 600000, exit_code: null, error: null,
    };
    fs.mkdirSync(jobsDir(h.momoHome), { recursive: true });
    fs.writeFileSync(path.join(jobsDir(h.momoHome), `${id}.json`), JSON.stringify(rec));

    const cont = runMomo(["continue", id, "--", "more"], { home: h.home });
    assert.notEqual(cont.status, 0, "continue must reject a crashed base, not queue a doomed resume");
    assert.match(cont.stderr, /crashed|无法续接/);
    // and the assessment got persisted
    const after = readJobFile(h.momoHome, id);
    assert.equal(after.status, "crashed");
  } finally {
    h.cleanup();
  }
});

test("continue survives later model config edits (historical client/effort still resumable)", async () => {
  const h = setup();
  try {
    const base = runMomo(["work", "--model", "glm-5.2", "--", "base"], {
      home: h.home,
      env: { MOCK_RESULT: "ok" },
    });
    const baseId = base.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.momoHome, baseId, (j) => j.status === "done");

    // user edits the model AFTER the job: drops 'claude' from clients and changes effort list
    const cfg = sampleConfig();
    cfg.models["glm-5.2"].clients = ["codex"]; // claude no longer listed
    cfg.models["glm-5.2"].effort = ["low"]; // 'high' no longer listed
    writeConfigFile(h.momoHome, cfg);

    // continue must still resume the old claude thread despite the config drift
    const cont = runMomo(["continue", baseId, "--", "more"], { home: h.home });
    assert.equal(cont.status, 0, cont.stderr);
  } finally {
    h.cleanup();
  }
});

test("P2: provider api key is never serialized into the job file", async () => {
  const h = makeHome();
  try {
    const cfg = sampleConfig();
    cfg.providers.zhipu.api_key = "SECRET-DO-NOT-PERSIST";
    writeConfigFile(h.momoHome, cfg);

    const r = runMomo(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    const id = r.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.momoHome, id, (j) => j.status === "running" && j.pid > 0);

    const raw = fs.readFileSync(path.join(jobsDir(h.momoHome), `${id}.json`), "utf8");
    assert.doesNotMatch(raw, /SECRET-DO-NOT-PERSIST/, "api key must not appear in the job file");
    const job = JSON.parse(raw);
    assert.equal(job._exec?.apiKey, undefined, "_exec must not carry the api key");

    runMomo(["cancel", id], { home: h.home });
  } finally {
    h.cleanup();
  }
});

function setup() {
  const h = makeHome();
  writeConfigFile(h.momoHome, sampleConfig());
  return h;
}
