// Job 状态层:CRUD + 存活判定(SPEC §4.1)+ 心跳。
// 每个 job 一个 ~/.momo/jobs/<id>.json 文件 + 同名 .log。
// job 文件本身就是事实来源(无中央 state.json),避免并发写盘冲突。
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { aliveAndOurs, terminateTreeIfOurs } from "./process.mjs";
import { withLock } from "./lock.mjs";

// 与 config.mjs 一致:MOMO_HOME 环境变量优先(测试/隔离安装/wrapper 用),否则 ~/.momo。
// 三处(config/jobs/lock)必须对齐,否则 config 与 job/log/锁 落在不同树,status/result/清理读不到。
const MOMO_HOME = process.env.MOMO_HOME || path.join(os.homedir(), ".momo");
const JOBS_DIR = path.join(MOMO_HOME, "jobs");
const ACTIVE_SESSIONS_FILE = path.join(MOMO_HOME, "active-sessions.json");
const SEQ_FILE = path.join(MOMO_HOME, "seq");

export const HEARTBEAT_INTERVAL_MS = 5_000; // runner 心跳间隔(≤5s)
export const HEARTBEAT_STALE_MS = 30_000; // 超此无心跳 → 疑似卡死
export const DEFAULT_TIMEOUT_MS = 600_000; // wall-clock 兜底上限

// 终态集合
const TERMINAL = new Set(["done", "failed", "timeout", "killed", "crashed"]);
// 活动(未终态)状态:queued(已派发、排队等 thread 锁)+ running(真正在跑 client)。
const ACTIVE = new Set(["queued", "running"]);

export function nowIso() {
  return new Date().toISOString();
}

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function isActive(status) {
  return ACTIVE.has(status);
}

export function ensureJobsDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

// ——— 活跃 session 注册表 ———
// SessionStart 把 session id 加入集合,SessionEnd 移除。命令子进程拿不到自己的
// session id(平台不注入 env),work 记录 claude_session 时只在**恰好一个活跃 session**
// 时才归属它(单 session 安全);多个活跃 session 时不猜(返回 null),避免归错 session
// 而被另一个 SessionEnd 误杀。RMW 在锁内做,防并发 Start/End 竞争。
// 条目格式 { id, at(ISO) }。带 TTL 自愈:过期项在每次写入与读取时被剔除 —— 即便某个
// SessionEnd 没能移除自己(如退化路径下 stdin 无 id),陈旧条目也不会永久堆积、卡住 lastSession。
const ACTIVE_SESSION_TTL_MS = 48 * 60 * 60 * 1000;

function readRawActiveSessions() {
  try {
    const arr = JSON.parse(fs.readFileSync(ACTIVE_SESSIONS_FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function freshEntries(raw, now) {
  return raw.filter(
    (e) =>
      e &&
      typeof e.id === "string" &&
      e.id &&
      Number.isFinite(Date.parse(e.at)) &&
      now - Date.parse(e.at) < ACTIVE_SESSION_TTL_MS
  );
}

function writeRawActiveSessions(list) {
  fs.mkdirSync(MOMO_HOME, { recursive: true });
  const tmp = `${ACTIVE_SESSIONS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list), "utf8");
  fs.renameSync(tmp, ACTIVE_SESSIONS_FILE);
}

function activeIds(now = Date.now()) {
  return freshEntries(readRawActiveSessions(), now).map((e) => e.id);
}

export function addActiveSession(sessionId) {
  if (!sessionId) return;
  withLock("active-sessions", () => {
    const now = Date.now();
    const kept = freshEntries(readRawActiveSessions(), now).filter((e) => e.id !== sessionId);
    kept.push({ id: sessionId, at: new Date(now).toISOString() });
    writeRawActiveSessions(kept);
  });
}

export function removeActiveSession(sessionId) {
  if (!sessionId) return;
  withLock("active-sessions", () => {
    const now = Date.now();
    const kept = freshEntries(readRawActiveSessions(), now).filter((e) => e.id !== sessionId);
    writeRawActiveSessions(kept);
  });
}

// 恰好一个活跃 session → 返回它;否则 null(0 个或并发多个都不猜)。
export function soleActiveSession() {
  const active = activeIds();
  return active.length === 1 ? active[0] : null;
}

export function jobFile(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

export function jobLogFile(id) {
  return path.join(JOBS_DIR, `${id}.log`);
}

// 全局单调递增序号(提交顺序)。同线程的 FIFO 排队据此判断"谁更早提交"。锁内 read-inc-write。
export function nextSeq() {
  return withLock("seq", () => {
    let n = 0;
    try {
      n = parseInt(fs.readFileSync(SEQ_FILE, "utf8"), 10) || 0;
    } catch {
      n = 0;
    }
    n += 1;
    fs.mkdirSync(MOMO_HOME, { recursive: true });
    const tmp = `${SEQ_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, String(n), "utf8");
    fs.renameSync(tmp, SEQ_FILE);
    return n;
  });
}

// 同线程上是否还有"更早提交(seq 更小)且未终态"的 job —— FIFO 判断用。
export function earlierActiveOnThread(threadKeyVal, seq, selfId) {
  if (!Number.isFinite(seq)) return false;
  return listJobs().some(
    (j) =>
      j.thread_key === threadKeyVal &&
      j.id !== selfId &&
      isActive(j.status) &&
      Number.isFinite(j.seq) &&
      j.seq < seq
  );
}

// thread_key = sha1(cwd|model|client),用于 resume 与同线程串行锁。
export function threadKey(cwd, model, client) {
  return createHash("sha1").update(`${cwd}|${model}|${client}`).digest("hex").slice(0, 16);
}

// job-id = 人可读前缀(model)+ 随机后缀,全局唯一。
// 用 4 字节(32 位)熵,并校验同名 job 文件不存在(碰撞则重抽),避免覆盖旧 job 的
// .json/.log 导致 status/result 错乱。
export function generateJobId(model) {
  const prefix = String(model).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
  for (let i = 0; i < 50; i++) {
    const id = `${prefix}-${randomBytes(4).toString("hex")}`;
    if (!fs.existsSync(jobFile(id))) return id;
  }
  // 极端情况(几乎不可能):加更长后缀兜底
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

// 原子写:tmp + rename。**私有** —— 任何 job 状态变更都必须经下面的状态机 API
// (createRunningJob / markRunning / backfill=patchIfActive / heartbeat / finalizeJob),
// 它们统一走 transition() 加锁 + 终态吸收。模块外不得裸写 job 状态。
function writeJob(record) {
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

// 创建初始记录,状态为 **queued**(已派发、等 thread 锁)。__run-job 拿到锁、真正开跑
// 时再 markRunning() 翻成 running 并把 started_at 重置为开跑时刻 —— 排队期间不计 wall-clock。
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
  timeout_ms = DEFAULT_TIMEOUT_MS,
  seq = null,
  // 后端身份(durable):continue 用这些锁定原始 backend,免受 model 别名后续重映射影响。
  provider = null,
  model_id = null,
  protocol = null,
  wire_api = null
}) {
  const ts = nowIso();
  const record = {
    id,
    status: "queued",
    pid,
    pid_token: null,
    client_pid_token: null,
    seq,
    model,
    client,
    effort,
    provider,
    model_id,
    protocol,
    wire_api,
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

// 每个 job 一把锁,序列化"状态转移"的读-改-写。
function jobLockName(id) {
  return `job-${id}`;
}

// ───────────────────────── 状态机唯一写入口 ─────────────────────────
// 所有 job 状态变更必经此处。不变量(结构上保证,无需各调用点自觉):
//   1) 锁内读-改-写:同一 job 的并发变更串行,杜绝陈旧覆盖。
//   2) 终态吸收:job 一旦进入终态(done/failed/timeout/killed/crashed),任何后续 transition
//      都原样返回、不再改动 —— 第一个置终态的赢,cancel 不会被迟到的 finalize 复活。
//   3) apply(cur) 返回新记录则写,返回 null 则不写。
// 唯一例外是 createRunningJob(创建,无前态),它是 job 的第一次写。
function transition(id, apply) {
  return withLock(jobLockName(id), () => {
    const cur = readJob(id);
    if (!cur) return null;
    if (isTerminal(cur.status)) return cur; // 终态吸收
    const next = apply(cur);
    if (!next) return cur;
    writeJob(next);
    return next;
  });
}

// queued → running:进入 thread 锁、真正开跑时调用,把 started_at/last_heartbeat 重置为
// 开跑时刻(排队等锁的时间不计入 wall-clock)。已终态(排队中被 cancel)则不翻。
export function markRunning(id) {
  return transition(id, (cur) => {
    const ts = nowIso();
    return { ...cur, status: "running", started_at: ts, last_heartbeat: ts };
  });
}

// 非终态字段 backfill(pid / client_pid 等):活动态才写,终态不复活。
export function patchIfActive(id, patch) {
  return transition(id, (cur) => ({ ...cur, ...patch }));
}

// runner 周期心跳:活动态才更新 last_heartbeat,终态不复活。
export function heartbeat(id) {
  return transition(id, (cur) => ({ ...cur, last_heartbeat: nowIso() }));
}

// 置终态(runner 收尾 / cancel / cleanup / assess 超时·crashed 的唯一入口)。
// 并**剥离 _exec**(含运行参数与敏感字段,不长期保留)。终态吸收由 transition 保证。
// patch 可带 status/exit_code/error/session_id/result_text。
export function finalizeJob(id, patch = {}) {
  return transition(id, (cur) => {
    const { _exec, ...rest } = cur;
    return { ...rest, ...patch, pid: null, last_heartbeat: nowIso() };
  });
}

// 存活判定(SPEC §4.1)——三招叠加,返回判定后的 view(可能写回 crashed/timeout)。
// 不改 done/failed/killed 等已写好的终态。
export function assessJob(job, opts = {}) {
  const now = opts.now ?? Date.now();
  // 已是终态:直接返回,附带 staleness 信息便于渲染
  if (isTerminal(job.status)) {
    return { ...job, suspectedStuck: false };
  }

  // queued:在等 thread 锁,**不计 wall-clock 超时**(还没开跑)。
  // 只有在 runner pid 已**真正回填**(pid>0 且有身份)却不再存活时,才判 crashed —— 否则
  // pid 仍是占位 0(刚创建、runner 还没 backfill)会被并发 status 误判 crashed、丢掉合法 job。
  if (job.status === "queued") {
    if (job.pid > 0 && !aliveAndOurs(job.pid, job.pid_token)) {
      terminateTreeIfOurs(job.client_pid, job.client_pid_token, { signal: "SIGKILL" });
      const updated = finalizeJob(job.id, {
        status: "crashed",
        error: job.error ?? "排队中进程退出(疑似硬崩)"
      });
      return { ...(updated ?? job), suspectedStuck: false };
    }
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
    terminateTreeIfOurs(job.client_pid, job.client_pid_token, { signal: "SIGKILL" });
    terminateTreeIfOurs(job.pid, job.pid_token, { signal: "SIGKILL" });
    const updated = finalizeJob(job.id, {
      status: "timeout",
      error: job.error ?? `wall-clock 超时(>${Math.round(timeoutMs / 1000)}s),已杀进程树`
    });
    return { ...(updated ?? job), suspectedStuck: false };
  }

  // 2. pid 探活:status==running 但 runner 进程已死(或 PID 被复用,非当初那个)→ crashed。
  // runner 死了但 client 可能仍存活(被孤立)→ 一并(验身份后)杀掉 client 子树,杜绝孤儿。
  if (!aliveAndOurs(job.pid, job.pid_token)) {
    terminateTreeIfOurs(job.client_pid, job.client_pid_token, { signal: "SIGKILL" });
    const updated = finalizeJob(job.id, {
      status: "crashed",
      error: job.error ?? "进程已退出但未写终态(疑似硬崩)"
    });
    return { ...(updated ?? job), suspectedStuck: false };
  }

  // 3. 心跳新鲜度:超阈值没动 → 标"疑似卡死"(不改 status,仅提示可 cancel)
  const hbMs = Date.parse(job.last_heartbeat ?? job.started_at ?? "");
  const suspectedStuck = Number.isFinite(hbMs) && now - hbMs > HEARTBEAT_STALE_MS;
  return { ...job, suspectedStuck };
}

// 取活动 job(queued/running),做完存活判定后仍活动的。
export function listActiveJobs() {
  return listJobs()
    .map((j) => assessJob(j))
    .filter((j) => isActive(j.status));
}

// 按 claude_session 取活动(queued/running)job(SessionEnd 清理用)。
export function listRunningBySession(claudeSession) {
  return listJobs().filter((j) => isActive(j.status) && j.claude_session === claudeSession);
}

// 无归属(claude_session 为空)的活动 job —— 当最后一个活跃 session 结束、
// 已无 session 能认领它们时,SessionEnd 据此清掉,避免泄漏。
export function listRunningUnowned() {
  return listJobs().filter((j) => isActive(j.status) && !j.claude_session);
}

// 当前活跃 session 列表(SessionEnd 判断"是否最后一个"用),已按 TTL 自愈过滤。
export function activeSessions() {
  return activeIds();
}

export { MOMO_HOME, JOBS_DIR };
