// 文件锁:基于 mkdir 原子性(O_EXCL 语义)。
// 用途:config 写锁(避免并发写盘损坏)、同 thread_key continue 串行(避免线程历史写坏)。
// 锁记录持有者 pid + 时间戳;持有进程已死的陈旧锁会被抢占(stale steal)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { aliveAndOurs, procToken } from "./process.mjs";

// MOMO_HOME 优先,与 config.mjs / jobs.mjs 对齐(否则锁与状态落在不同树)。
const LOCK_ROOT = path.join(process.env.MOMO_HOME || path.join(os.homedir(), ".momo"), "locks");
const STALE_MS = 60_000; // 锁老于此且持有者已死 → 可抢占
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

function lockDir(name) {
  return path.join(LOCK_ROOT, `${name}.lock`);
}

function sleepSync(ms) {
  // 阻塞式 sleep,锁等待场景下可接受(短临界区)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

// 原子获取:mkdir 锁本体目录(已存在则 EEXIST)。
function attemptMkdir(dir) {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function ensureRoot() {
  fs.mkdirSync(LOCK_ROOT, { recursive: true });
}

function isStale(dir) {
  const meta = readLockMeta(dir);
  if (!meta) {
    // 没 meta:可能正在写,给一次 mtime 兜底
    try {
      const age = Date.now() - fs.statSync(dir).mtimeMs;
      return age > STALE_MS;
    } catch {
      return true;
    }
  }
  const age = Date.now() - (meta.acquiredAt ?? 0);
  // 持有者"仍是当初那个进程"才算活(PID 被复用 → token 不匹配 → 视为已死,可抢,避免永久占锁)。
  if (meta.pid && aliveAndOurs(meta.pid, meta.token)) {
    return false;
  }
  // 持有者已死/被复用 → 立即可抢(也兼顾老锁)
  return !meta.pid || age > 0 ? true : age > STALE_MS;
}

function steal(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// 获取锁,返回 release 函数。超时抛错。
export function acquireLock(name, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  ensureRoot();
  const dir = lockDir(name);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (attemptMkdir(dir)) {
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ pid: process.pid, token: procToken(process.pid), acquiredAt: Date.now() }),
        "utf8"
      );
      let released = false;
      return () => {
        if (released) return;
        released = true;
        steal(dir);
      };
    }

    // 没拿到:陈旧锁(持有者死)→ 抢占
    if (isStale(dir)) {
      steal(dir);
      continue;
    }

    if (Date.now() >= deadline) {
      const meta = readLockMeta(dir);
      throw new Error(
        `lock "${name}" busy${meta?.pid ? ` (held by pid ${meta.pid})` : ""}; timed out after ${timeoutMs}ms`
      );
    }
    sleepSync(POLL_MS);
  }
}

// 在锁保护下同步执行 fn。
export function withLock(name, fn, options = {}) {
  const release = acquireLock(name, options);
  try {
    return fn();
  } finally {
    release();
  }
}

export const CONFIG_LOCK = "config";

// 同线程串行锁名:按 thread_key 派生。
export function threadLockName(threadKey) {
  return `thread-${threadKey}`;
}
