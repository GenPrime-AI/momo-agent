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

// 进程身份 token:区分"同一 PID 但已被 OS 回收复用"。用 `ps -o lstart=,args=` —— 启动时刻
// + 完整命令行。对 momo 的 runner,args 含唯一 job-id(node …/momo.mjs __run-job <id>),
// 因此即便同秒同 PID 复用,只要命令行不同就能区分(抗碰撞)。记录 pid 时一并存其 token。
// 短重试,避免 ps 偶发失败导致拿不到 token。
export function procToken(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === "win32") return null; // win 另案;POSIX 为主
  for (let i = 0; i < 3; i += 1) {
    const r = spawnSync("ps", ["-o", "lstart=,args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true
    });
    if (!r.error && r.status === 0) {
      const s = (r.stdout || "").replace(/\s+/g, " ").trim();
      if (s) return s;
    }
    // 进程不存在 → ps 退出非 0,直接返回 null(无需重试)
    if (r.status != null && r.status !== 0) return null;
  }
  return null;
}

// crash 检测用(fail-SAFE):pid 是否"仍存活且仍是当初那个进程"。token 缺失时退回裸 isAlive
// —— 宁可不误判一个活着的进程为 crashed(缺 token 时不主动判死)。
export function aliveAndOurs(pid, token) {
  if (!isAlive(pid)) return false;
  if (!token) return true;
  const cur = procToken(pid);
  return cur != null && cur === token;
}

// 杀/偷锁用(fail-CLOSED):必须**正向验证**是当初那个进程才算 ours。token 缺失或不匹配
// 一律不认 —— 宁可不杀(避免误杀无关进程)。
export function verifiedOurs(pid, token) {
  if (!isAlive(pid) || !token) return false;
  const cur = procToken(pid);
  return cur != null && cur === token;
}

// 仅当**正向验证**为当初那个进程时才杀其进程树(复用/无法验证则跳过,绝不误杀无关进程)。
export function terminateTreeIfOurs(pid, token, options = {}) {
  if (!verifiedOurs(pid, token)) {
    return { attempted: false, delivered: false, method: "skipped" };
  }
  return terminateProcessTree(pid, options);
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
