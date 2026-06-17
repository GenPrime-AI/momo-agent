#!/usr/bin/env node
// SessionEnd hook:主 session 结束时,杀掉本 session 派生的所有 running momo job 进程树。
// 不留孤儿(SPEC §2.2)。主 session id 从 hook stdin JSON 或环境变量取。
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  addActiveSession,
  finalizeJob,
  listRunningBySession,
  removeActiveSession
} from "./lib/jobs.mjs";
import { terminateProcessTree } from "./lib/process.mjs";

const SESSION_ID_ENV = "CLAUDE_SESSION_ID";

// 杀 claude_session == sessionId 的所有 running job。返回被杀 job 列表。
export function cleanupSession(sessionId) {
  if (!sessionId) {
    return [];
  }
  const jobs = listRunningBySession(sessionId);
  const killed = [];
  for (const job of jobs) {
    // 先直接杀 client 子树(SIGKILL),不依赖 runner 的 SIGTERM relay,避免孤儿。
    if (job.client_pid) {
      terminateProcessTree(job.client_pid, { signal: "SIGKILL" });
    }
    // 再杀 __run-job(detached 组 leader);其 SIGTERM 处理器作为双保险。
    terminateProcessTree(job.pid, { signal: "SIGTERM" });
    finalizeJob(job.id, { status: "killed", error: "主 session 结束,自动清理" });
    killed.push(job.id);
  }
  return killed;
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
    // 把当前主 session id 登记到活跃集合。work 在只有一个活跃 session 时据此归属 job
    // (单 session 安全),保证 SessionEnd 能匹配清理(SPEC §2.2)。
    if (sessionId) addActiveSession(sessionId);
    process.stdout.write(`momo: session ${sessionId ?? "?"} 已登记\n`);
    return;
  }

  // SessionEnd:从活跃集合移除本 session,并只用 stdin/env 给出的 session id 清理。
  // 不猜全局 singleton —— 多 session 并发时用它清理会误杀别的 session 的 job。无 id → no-op。
  if (sessionId) removeActiveSession(sessionId);
  if (!sessionId) {
    process.stdout.write("momo cleanup: 无 session id,跳过(避免误杀其他 session 的 job)\n");
    return;
  }
  const killed = cleanupSession(sessionId);
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
