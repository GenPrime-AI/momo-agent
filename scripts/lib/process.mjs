// 进程原语:后台 detached spawn、杀整棵进程树、kill -0 探活。
// 借鉴 codex lib/process.mjs 的 terminateProcessTree(进程组优先)。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

// kill -0:仅探活,不发真信号。pid 存活返回 true。
export function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM:进程存在但无权限(仍算存活);ESRCH:不存在。
    return error?.code === "EPERM";
  }
}

// 二进制是否可用(self-check)。用 spawnSync 跑探测命令。
export function binaryAvailable(command, probeArgs = ["--help"], options = {}) {
  const result = spawnSync(command, probeArgs, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true
  });
  if (result.error?.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  return { available: true, detail: (result.stdout || result.stderr || "ok").trim() };
}

// 后台启动:detached + 独立进程组(setsid 语义),stdout/stderr 重定向到 logFile。
// 父进程 unref 后可立即退出,子进程继续跑。返回 pid。
export function spawnDetached(command, argv, { cwd, env, logFile } = {}) {
  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");
  const child = spawn(command, argv, {
    cwd,
    env,
    detached: true, // 自成进程组(组 id == child.pid),便于整树 kill
    stdio: ["ignore", out, err],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  if (!child.pid) {
    throw new Error(`failed to spawn ${command}`);
  }
  return child.pid;
}

function looksLikeMissingProcess(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

// 杀整棵进程树:detached 子进程自成进程组,kill(-pid) 命中整组。
// 失败回退到单 pid。返回 { attempted, delivered, method }。
export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }
  const platform = options.platform ?? process.platform;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const signal = options.signal ?? "SIGTERM";

  if (platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill" };
    }
    const combined = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    if (!result.error && looksLikeMissingProcess(combined)) {
      return { attempted: true, delivered: false, method: "taskkill" };
    }
    // 回退到单进程 kill
    try {
      killImpl(pid);
      return { attempted: true, delivered: true, method: "kill" };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "kill" };
      }
      throw error;
    }
  }

  // POSIX:先打整组(负 pid)
  try {
    killImpl(-pid, signal);
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process-group" };
    }
    // 组 kill 失败(如没成组)→ 退回单进程
    try {
      killImpl(pid, signal);
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}
