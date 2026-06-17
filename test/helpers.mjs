// Shared test helpers: isolated MOMO home, PATH-injected mock binaries,
// and a thin wrapper for invoking `momo.mjs` as a subprocess.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_BIN = path.join(HERE, "mock-bin");
export const SCRIPTS = path.resolve(HERE, "..", "scripts");
export const MOMO = path.join(SCRIPTS, "momo.mjs");
export const CLEANUP = path.join(SCRIPTS, "cleanup-session.mjs");

// A sample, fully-valid config.
export function sampleConfig() {
  return {
    version: 1,
    providers: {
      zhipu: {
        protocols: ["anthropic", "openai"],
        base_url: {
          anthropic: "https://open.bigmodel.cn/api/anthropic",
          openai: "https://open.bigmodel.cn/api/paas/v4",
        },
        api_key: "zhipu-key",
      },
      openai: {
        protocols: ["openai"],
        base_url: { openai: "https://api.openai.com/v1" },
        api_key: "openai-key",
      },
    },
    models: {
      "glm-5.2": {
        provider: "zhipu",
        model_id: "GLM-5.2",
        clients: ["claude", "codex"],
        effort: ["high", "medium", "low"],
      },
      "gpt-5-codex": {
        provider: "openai",
        model_id: "gpt-5-codex",
        clients: ["codex"],
        effort: ["high", "medium", "low"],
      },
    },
  };
}

// Create an isolated HOME (=> ~/.momo lives there). Returns { home, momoHome, cleanup }.
export function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "momo-test-"));
  const momoHome = path.join(home, ".momo");
  fs.mkdirSync(momoHome, { recursive: true });
  return {
    home,
    momoHome,
    cleanup() {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function writeConfigFile(momoHome, config) {
  fs.writeFileSync(
    path.join(momoHome, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf8"
  );
}

// Build a child env: isolated HOME, mock-bin prepended to PATH, no MOMO_HOME
// (so config.mjs and jobs.mjs/lock.mjs all agree on $HOME/.momo).
export function childEnv(home, extra = {}) {
  const env = { ...process.env };
  delete env.MOMO_HOME;
  env.HOME = home;
  env.PATH = `${MOCK_BIN}${path.delimiter}${process.env.PATH || ""}`;
  return { ...env, ...extra };
}

// Run momo.mjs synchronously, capturing stdout/stderr/status.
export function runMomo(args, { home, env = {}, input } = {}) {
  const res = spawnSync(process.execPath, [MOMO, ...args], {
    cwd: home,
    env: childEnv(home, env),
    encoding: "utf8",
    input,
  });
  return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status, res };
}

// Run cleanup-session.mjs synchronously, feeding JSON on stdin.
export function runCleanup(args, { home, env = {}, input } = {}) {
  const res = spawnSync(process.execPath, [CLEANUP, ...args], {
    cwd: home,
    env: childEnv(home, env),
    encoding: "utf8",
    input,
  });
  return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
}

export function jobsDir(momoHome) {
  return path.join(momoHome, "jobs");
}

export function readJobFile(momoHome, id) {
  const p = path.join(jobsDir(momoHome), `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function listJobIds(momoHome) {
  const dir = jobsDir(momoHome);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5));
}

// Extract a printed job-id from work/continue stdout ("已后台派发 job <id>(...)").
export function parseJobId(stdout) {
  const m = stdout.match(/job\s+([^\s(]+)/);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a job file until predicate(job) is true or timeout. Returns job or null.
export async function waitForJob(momoHome, id, predicate, { timeoutMs = 8000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = readJobFile(momoHome, id);
    if (job && predicate(job)) return job;
    if (Date.now() > deadline) return job;
    await sleep(pollMs);
  }
}

export { spawn, sleep };
