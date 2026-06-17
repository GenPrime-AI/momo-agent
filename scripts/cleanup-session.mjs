#!/usr/bin/env node
// SessionEnd hook:主 session 结束时,杀掉本 session 派生的所有 running momo job 进程树。
// 不留孤儿。主 session id 从 hook stdin JSON 或环境变量取。
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  activeSessions,
  addActiveSession,
  executionStillLive,
  finalizeJob,
  listRunningBySession,
  listRunningUnowned,
  removeActiveSession
} from "./lib/jobs.mjs";
import { terminateTreeIfOurs } from "./lib/process.mjs";

const SESSION_ID_ENV = "CLAUDE_SESSION_ID";
const MOMO_SESSION_ID_ENV = "MOMO_SESSION_ID";

function killJob(job, reason) {
  // client 已退出(任务已结束、runner 正在收尾)→ 不抢占,让 runner 写真实结果(done/failed),
  // 否则会丢掉"恰好在 session 关闭瞬间完成"的结果。返回 false 表示没杀。
  if (!executionStillLive(job)) return false;
  // 仍在跑:先认领终态(killed,终态吸收必胜 runner 的 close 收尾),再验身份杀进程(复用则跳过)。
  finalizeJob(job.id, { status: "killed", error: reason });
  terminateTreeIfOurs(job.client_pid, job.client_pid_token, { signal: "SIGKILL" });
  terminateTreeIfOurs(job.pid, job.pid_token, { signal: "SIGTERM" });
  return true;
}

// 杀 claude_session == sessionId 的所有 running job;opts.alsoUnowned=true 时,额外杀掉
// 所有无归属(claude_session 为空)的 running job —— 仅在这是最后一个活跃 session 时传入,
// 此时已无 session 能认领它们,杀掉既不泄漏也不会误杀别的 session 的 job。
export function cleanupSession(sessionId, opts = {}) {
  const killed = [];
  const targets = [];
  if (sessionId) targets.push(...listRunningBySession(sessionId));
  if (opts.alsoUnowned) targets.push(...listRunningUnowned());
  const seen = new Set();
  for (const job of targets) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    const reason =
      sessionId && job.claude_session === sessionId
        ? "主 session 结束,自动清理"
        : "无归属 job 在最后一个 session 结束时清理";
    if (killJob(job, reason)) killed.push(job.id);
  }
  return killed;
}

// 把 MOMO_SESSION_ID 写进 Claude Code 的 per-session env 文件($CLAUDE_ENV_FILE);
// 之后**本 session** 所有命令子进程都会带上它 → work 能拿到自己正确的 session id,
// 多 session 并发也不串(官方机制,codex 同款)。env 文件不可用则静默跳过(降级到
// active-sessions 的单 session 启发式)。
function exportSessionIdToEnvFile(sessionId) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || !sessionId) return;
  const escaped = `'${String(sessionId).replace(/'/g, `'\\''`)}'`;
  try {
    fs.appendFileSync(envFile, `export ${MOMO_SESSION_ID_ENV}=${escaped}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

// 从 hook stdin(JSON,字段 session_id)读主 session id;失败回退环境变量。
async function readSessionIdFromStdin() {
  if (process.stdin.isTTY) {
    return null;
  }
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed.session_id ?? parsed.sessionId ?? null;
  } catch {
    return null;
  }
}

async function main() {
  // hook 模式由 argv[2] 给出:SessionStart | SessionEnd(缺省按 SessionEnd 处理)。
  const mode = process.argv[2] || "SessionEnd";
  const fromStdin = await readSessionIdFromStdin();
  // stdin 优先;否则用 SessionStart 写进 $CLAUDE_ENV_FILE 的 MOMO_SESSION_ID(本 session 准确),
  // 再退到 CLAUDE_SESSION_ID。
  const sessionId =
    fromStdin ?? process.env[MOMO_SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;

  if (mode === "SessionStart") {
    // 1) 写 per-session env 文件,让本 session 的 work 子进程拿到正确的 MOMO_SESSION_ID。
    // 2) 登记到活跃集合(env 文件不可用时的单 session 降级 + 判断"最后一个 session")。
    if (sessionId) {
      exportSessionIdToEnvFile(sessionId);
      addActiveSession(sessionId);
    }
    process.stdout.write(`momo: session ${sessionId ?? "?"} 已登记\n`);
    return;
  }

  // SessionEnd:确定要结束的 session id。stdin/env 没给时,若**恰好一个活跃 session**,
  // 可安全推断为它(单 session 场景,不会误判);多个活跃时不猜。
  let endId = sessionId;
  if (!endId) {
    const act = activeSessions();
    if (act.length === 1) endId = act[0];
  }
  // "是否最后一个 session" = 除 endId 外已无其它活跃 session(在注销**前**算)。
  const lastSession = activeSessions().filter((s) => s !== endId).length === 0;
  if (!endId && !lastSession) {
    process.stdout.write("momo cleanup: 无 session id 且有多个活跃 session,跳过(避免误杀)\n");
    return;
  }
  // 先清理(此时 job 仍能按 session id 被发现),成功后再注销 —— 若 hook 在两步之间崩溃,session
  // 标记仍在,后续 SessionEnd 仍能据其重新发现并清理,绝不永久泄漏。
  const killed = cleanupSession(endId, { alsoUnowned: lastSession });
  if (endId) removeActiveSession(endId);
  process.stdout.write(`momo cleanup: 杀掉 ${killed.length} 个 running job\n`);
}

// 仅作为脚本直接运行时执行 main(被 import 时只导出 cleanupSession)。
// 用 pathToFileURL 正确转义路径(含空格/特殊字符的安装目录也能匹配),
// 否则裸 `file://${argv[1]}` 在带空格的插件路径下永不相等 → hook 静默失效。
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`momo cleanup error: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
