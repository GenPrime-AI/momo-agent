// Job 状态层:CRUD + 存活判定(SPEC §4.1)+ 心跳。
// 每个 job 一个 ~/.momo/jobs/<id>.json 文件 + 同名 .log。
// job 文件本身就是事实来源(无中央 state.json),避免并发写盘冲突。
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAlive, terminateProcessTree } from "./process.mjs";

const MOMO_HOME = path.join(os.homedir(), ".momo");
const JOBS_DIR = path.join(MOMO_HOME, "jobs");
const SESSION_ID_FILE = path.join(MOMO_HOME, "current-session");

export const HEARTBEAT_INTERVAL_MS = 5_000; // runner 心跳间隔(≤5s)
export const HEARTBEAT_STALE_MS = 30_000; // 超此无心跳 → 疑似卡死
export const DEFAULT_TIMEOUT_MS = 600_000; // wall-clock 兜底上限

// 终态集合
const TERMINAL = new Set(["done", "failed", "timeout", "killed", "crashed"]);

export function nowIso() {
  return new Date().toISOString();
}

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function ensureJobsDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

// ——— 主 session id 持久化 ———
// SessionStart hook 把当前主 session id 落盘;work 记录 claude_session 时,
// 若 env(CLAUDE_SESSION_ID)缺失则回退读此文件 —— 保证 SessionEnd 清理能匹配到。
export function persistSessionId(sessionId) {
  if (!sessionId) return;
  fs.mkdirSync(MOMO_HOME, { recursive: true });
  const tmp = `${SESSION_ID_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, String(sessionId), "utf8");
  fs.renameSync(tmp, SESSION_ID_FILE);
}

export function readPersistedSessionId() {
  try {
    const v = fs.readFileSync(SESSION_ID_FILE, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

export function jobFile(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

export function jobLogFile(id) {
  return path.join(JOBS_DIR, `${id}.log`);
}

// thread_key = sha1(cwd|model|client),用于 resume 与同线程串行锁。
export function threadKey(cwd, model, client) {
  return createHash("sha1").update(`${cwd}|${model}|${client}`).digest("hex").slice(0, 16);
}

// job-id = 人可读前缀(model)+ 短哈希,全局唯一。
export function generateJobId(model) {
  const prefix = String(model).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
  const suffix = randomBytes(2).toString("hex");
  return `${prefix}-${suffix}`;
}

// 原子写:tmp + rename。
export function writeJob(record) {
  ensureJobsDir();
  const file = jobFile(record.id);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

export function readJob(id) {
  const file = jobFile(id);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 局部更新:读 → merge → 原子写。
export function patchJob(id, patch) {
  const existing = readJob(id);
  if (!existing) {
    return null;
  }
  const next = { ...existing, ...patch };
  writeJob(next);
  return next;
}

export function listJobs() {
  ensureJobsDir();
  const ids = fs
    .readdirSync(JOBS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5));
  const jobs = [];
  for (const id of ids) {
    const job = readJob(id);
    if (job) {
      jobs.push(job);
    }
  }
  return jobs.sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")));
}

// job id 解析:精确 → 唯一前缀。歧义/找不到抛错。
export function resolveJobRef(reference, predicate = () => true) {
  const jobs = listJobs().filter(predicate);
  if (!reference) {
    return jobs[0] ?? null;
  }
  const exact = jobs.find((j) => j.id === reference);
  if (exact) {
    return exact;
  }
  const matches = jobs.filter((j) => j.id.startsWith(reference));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`job 引用 "${reference}" 不唯一,请用更长的 job-id`);
  }
  return null;
}

// 创建初始 running 记录(work/continue 派生后台进程后调用)。
export function createRunningJob({
  id,
  pid,
  model,
  client,
  effort,
  thread_key,
  session_id = null,
  claude_session = null,
  cwd,
  timeout_ms = DEFAULT_TIMEOUT_MS
}) {
  const ts = nowIso();
  const record = {
    id,
    status: "running",
    pid,
    model,
    client,
    effort,
    thread_key,
    session_id,
    claude_session,
    cwd,
    timeout_ms,
    started_at: ts,
    last_heartbeat: ts,
    exit_code: null,
    error: null
  };
  writeJob(record);
  return record;
}

// runner 周期心跳:更新 last_heartbeat。
export function heartbeat(id) {
  return patchJob(id, { last_heartbeat: nowIso() });
}

// 写终态(runner 正常/失败收尾用)。
export function finalizeJob(id, { status, exit_code = null, error = null }) {
  return patchJob(id, { status, exit_code, error, pid: null, last_heartbeat: nowIso() });
}

// 存活判定(SPEC §4.1)——三招叠加,返回判定后的 view(可能写回 crashed/timeout)。
// 不改 done/failed/killed 等已写好的终态。
export function assessJob(job, opts = {}) {
  const now = opts.now ?? Date.now();
  // 已是终态:直接返回,附带 staleness 信息便于渲染
  if (isTerminal(job.status)) {
    return { ...job, suspectedStuck: false };
  }

  if (job.status !== "running") {
    return { ...job, suspectedStuck: false };
  }

  // 1. wall-clock 超时兜底:runner 没自杀(可能 runner 自身也卡死/挂了)→ 标 timeout。
  // 关键:置终态前**先杀进程树**(runner + client 两个独立进程组),否则 runner 卡死时
  // 我们把 job 标成终态、清掉 pid,client 仍在后台跑且 job 已不可 cancel → 孤儿。
  const startedMs = Date.parse(job.started_at ?? "");
  const timeoutMs = Number.isFinite(job.timeout_ms) ? job.timeout_ms : DEFAULT_TIMEOUT_MS;
  if (Number.isFinite(startedMs) && now - startedMs > timeoutMs) {
    if (job.client_pid) terminateProcessTree(job.client_pid, { signal: "SIGKILL" });
    if (job.pid) terminateProcessTree(job.pid, { signal: "SIGKILL" });
    const updated = patchJob(job.id, {
      status: "timeout",
      pid: null,
      error: job.error ?? `wall-clock 超时(>${Math.round(timeoutMs / 1000)}s),已杀进程树`
    });
    return { ...(updated ?? job), suspectedStuck: false };
  }

  // 2. pid 探活:status==running 但 runner pid 已死 → crashed(硬崩没写终态)。
  // runner 死了但 client 可能仍存活(被孤立)→ 一并杀掉 client 子树,杜绝孤儿。
  if (!isAlive(job.pid)) {
    if (job.client_pid) terminateProcessTree(job.client_pid, { signal: "SIGKILL" });
    const updated = patchJob(job.id, {
      status: "crashed",
      pid: null,
      error: job.error ?? "进程已退出但未写终态(疑似硬崩)"
    });
    return { ...(updated ?? job), suspectedStuck: false };
  }

  // 3. 心跳新鲜度:超阈值没动 → 标"疑似卡死"(不改 status,仅提示可 cancel)
  const hbMs = Date.parse(job.last_heartbeat ?? job.started_at ?? "");
  const suspectedStuck = Number.isFinite(hbMs) && now - hbMs > HEARTBEAT_STALE_MS;
  return { ...job, suspectedStuck };
}

// 取活动 job(running),做完存活判定后仍为 running 的。
export function listActiveJobs() {
  return listJobs()
    .map((j) => assessJob(j))
    .filter((j) => j.status === "running");
}

// 按 claude_session 取 running job(SessionEnd 清理用)。
export function listRunningBySession(claudeSession) {
  return listJobs().filter((j) => j.status === "running" && j.claude_session === claudeSession);
}

export { MOMO_HOME, JOBS_DIR };
