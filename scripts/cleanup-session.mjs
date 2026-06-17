#!/usr/bin/env node
// SessionEnd hook:主 session 结束时,杀掉本 session 派生的所有 running momo job 进程树。
// 不留孤儿(SPEC §2.2)。主 session id 从 hook stdin JSON 或环境变量取。
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  activeSessions,
  addActiveSession,
  finalizeJob,
  listRunningBySession,
  listRunningUnowned,
  removeActiveSession
} from "./lib/jobs.mjs";
import { terminateProcessTree } from "./lib/process.mjs";

const SESSION_ID_ENV = "CLAUDE_SESSION_ID";
const MOMO_SESSION_ID_ENV = "MOMO_SESSION_ID";

function killJob(job, reason) {
  // 先直接杀 client 子树(SIGKILL),不依赖 runner 的 SIGTERM relay,避免孤儿。
  if (job.client_pid) {
    terminateProcessTree(job.client_pid, { signal: "SIGKILL" });
  }
  // 再杀 __run-job(detached 组 leader);其 SIGTERM 处理器作为双保险。
  terminateProcessTree(job.pid, { signal: "SIGTERM" });
  finalizeJob(job.id, { status: "killed", error: reason });
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
    killJob(job, sessionId && job.claude_session === sessionId ? "主 session 结束,自动清理" : "无归属 job 在最后一个 session 结束时清理");
    killed.push(job.id);
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
  const sessionId = fromStdin ?? process.env[SESSION_ID_ENV] ?? null;

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

  // SessionEnd:从活跃集合移除本 session;清理本 session 的 job。
  // 若移除后已无活跃 session(这是最后一个),额外清掉无归属的 running job(防泄漏)。
  if (sessionId) removeActiveSession(sessionId);
  const lastSession = activeSessions().length === 0;
  if (!sessionId && !lastSession) {
    process.stdout.write("momo cleanup: 无 session id,跳过(避免误杀其他 session 的 job)\n");
    return;
  }
  const killed = cleanupSession(sessionId, { alsoUnowned: lastSession });
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
