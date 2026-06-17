#!/usr/bin/env node
// momo 入口:子命令分发。
//   work / continue / status / result / cancel / list / config-set / cleanup
//   __run-job(内部:被 work/continue detached 派生,真正跑 client)
//
// 应用层。协议层(resolve/config/registry/clients)按 SPEC §9 路径 import,假定已存在。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assessJob,
  createRunningJob,
  DEFAULT_TIMEOUT_MS,
  finalizeJob,
  generateJobId,
  heartbeat,
  HEARTBEAT_INTERVAL_MS,
  isTerminal,
  jobLogFile,
  listJobs,
  readJob,
  readPersistedSessionId,
  resolveJobRef,
  threadKey,
  writeJob
} from "./lib/jobs.mjs";
import { acquireLock, CONFIG_LOCK, threadLockName, withLock } from "./lib/lock.mjs";
import { binaryAvailable, spawnDetached, terminateProcessTree } from "./lib/process.mjs";
import {
  renderCancel,
  renderModelList,
  renderResult,
  renderStatusList,
  renderStatusOne,
  renderWorkAccepted
} from "./lib/render.mjs";

// ——— 协议层(adapter 接口约定见 SPEC §5;路径见 §9)———
import { loadConfig, saveConfig } from "./lib/config.mjs";
import {
  listModels as listModelNames,
  getModel,
  providerForModel,
  defaultClient,
  defaultEffortForClient,
  compatibleClients
} from "./lib/registry.mjs";
import { resolve as resolveExecContext } from "./lib/resolve.mjs";
import { getClient } from "./lib/clients/index.mjs";

// 把 resolve() 的执行上下文补成 runtime 期望的形态(补 timeoutMs)。
// MOMO_TIMEOUT_MS 环境变量可覆盖 wall-clock 上限(测试/调参用)。
function resolveContext(opts) {
  const config = loadConfig();
  const ctx = resolveExecContext(config, opts);
  const envTimeout = Number(process.env.MOMO_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0
    ? envTimeout
    : ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return { ...ctx, timeoutMs };
}

// 供 /momo:list 渲染:从 config 投影出 render.mjs 期望的 model view。
function resolveModelView(modelName) {
  const config = loadConfig();
  const model = getModel(config, modelName);
  if (!model) {
    return { model: modelName, provider: "?", protocols: [], clients: [], effort: [] };
  }
  const prov = providerForModel(config, modelName);
  const dClient = defaultClient(model);
  return {
    model: modelName,
    provider: model.provider,
    protocols: prov && Array.isArray(prov.protocols) ? prov.protocols : [],
    clients: Array.isArray(model.clients) ? model.clients : [],
    defaultClient: dClient,
    effort: Array.isArray(model.effort) ? model.effort : [],
    defaultEffort: dClient ? defaultEffortForClient(model, dClient) : null,
    compatibleClients: compatibleClients(config, modelName)
  };
}

const SELF = fileURLToPath(import.meta.url);
const SESSION_ID_ENV = "CLAUDE_SESSION_ID"; // 主 session id 注入环境变量

function fail(message, code = 1) {
  process.stderr.write(`momo: ${message}\n`);
  process.exit(code);
}

// ——— form C 参数解析:全 flag,任务正文在 `--` 之后 ———
// 返回 { flags: {model,client,effort,...}, task: string|null }
function parseFormC(argv) {
  const flags = {};
  const dashDashIdx = argv.indexOf("--");
  const flagArgs = dashDashIdx === -1 ? argv : argv.slice(0, dashDashIdx);
  const task = dashDashIdx === -1 ? null : argv.slice(dashDashIdx + 1).join(" ");

  for (let i = 0; i < flagArgs.length; i += 1) {
    const arg = flagArgs[i];
    if (!arg.startsWith("--")) {
      throw new Error(`无法识别的位置参数 "${arg}"(任务正文必须放在 -- 之后)`);
    }
    const key = arg.slice(2);
    const next = flagArgs[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`flag --${key} 缺少取值`);
    }
    flags[key] = next;
    i += 1;
  }
  return { flags, task };
}

const KNOWN_WORK_FLAGS = new Set(["model", "client", "effort"]);

function assertKnownFlags(flags, allowed) {
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      throw new Error(`未知 flag --${key}`);
    }
  }
}

// ——— work:校验 → 派生后台进程 → 立刻打印 job-id(永远非阻塞)———
function cmdWork(argv) {
  let parsed;
  try {
    parsed = parseFormC(argv);
    assertKnownFlags(parsed.flags, KNOWN_WORK_FLAGS);
  } catch (error) {
    fail(error.message);
  }
  const { flags, task } = parsed;

  // §8 校验顺序由 resolveContext(协议层)负责 fail-fast,抛错带可用项。
  let ctx;
  try {
    ctx = resolveContext({
      model: flags.model,
      client: flags.client,
      effort: flags.effort
    });
  } catch (error) {
    fail(error.message);
  }

  // §8.7 任务正文为空
  if (!task || !task.trim()) {
    fail("任务正文为空(请在 -- 之后给出要委派的活)");
  }

  const cwd = process.cwd();
  const tk = threadKey(cwd, ctx.model, ctx.client);
  const id = generateJobId(ctx.model);
  // 为新线程钉死一个确定性 session id,供后续 continue/resume(SPEC §5.1)。
  const sessionId = randomUUID();

  startBackgroundJob({
    id,
    ctx,
    task,
    cwd,
    thread_key: tk,
    session_id: sessionId,
    resume: false
  });

  process.stdout.write(`${renderWorkAccepted(readJob(id))}\n`);
}

// ——— continue:复用 (thread_key, session_id) 起新后台 job,同线程串行 ———
function cmdContinue(argv) {
  // 形态:continue <job-id> -- <追加指令>
  const dashDashIdx = argv.indexOf("--");
  const head = dashDashIdx === -1 ? argv : argv.slice(0, dashDashIdx);
  const task = dashDashIdx === -1 ? null : argv.slice(dashDashIdx + 1).join(" ");
  const reference = head[0];

  if (!reference) {
    fail("用法:/momo:continue <job-id> -- <追加指令>");
  }
  if (!task || !task.trim()) {
    fail("追加指令为空(请在 -- 之后给出)");
  }

  let base;
  try {
    base = resolveJobRef(reference);
  } catch (error) {
    fail(error.message);
  }
  if (!base) {
    fail(`找不到 job "${reference}"。用 /momo:status 查看已知 job。`);
  }

  // resume 能力由 client 适配器决定(SPEC §5.2:codex 可能不支持)。
  const client = getClient(base.client);
  if (!client) {
    fail(`job ${base.id} 的 client "${base.client}" 不可用`);
  }
  if (client.supportsResume === false) {
    fail(`client "${base.client}" 暂不支持 continue/resume`);
  }
  // 只能续接已完成(done)的 job:对 codex 这类 client,可 resume 的真实会话 id 是在
  // 任务完成、解析子进程输出后才回填的;若原 job 仍在跑或异常终止,session_id 还是
  // 占位 UUID,续接会接到错误/不存在的线程。
  if (base.status !== "done") {
    fail(
      `job ${base.id} 当前是 "${base.status}",只能 continue 已完成(done)的 job。` +
        `请用 /momo:status 等它完成后再续接。`
    );
  }
  if (!base.session_id) {
    fail(`job ${base.id} 没有可 resume 的 session_id(原 job 可能未成功建立会话)`);
  }

  // 重新解析执行上下文(provider key/base_url 可能已变),沿用原 model/client/effort。
  let ctx;
  try {
    ctx = resolveContext({ model: base.model, client: base.client, effort: base.effort });
  } catch (error) {
    fail(error.message);
  }

  const id = generateJobId(base.model);
  // 同 thread_key 串行:加文件锁(派生进程瞬时持有,真正串行在 __run-job 内)。
  startBackgroundJob({
    id,
    ctx,
    task,
    cwd: base.cwd,
    thread_key: base.thread_key,
    session_id: base.session_id,
    resume: true
  });

  process.stdout.write(`${renderWorkAccepted(readJob(id))}\n`);
}

// 落 job 记录 + 派生 detached __run-job 进程。
function startBackgroundJob({ id, ctx, task, cwd, thread_key, session_id, resume }) {
  // job 记录里附带执行参数,供 __run-job 读取(子进程看不到主对话,正文自带上下文)。
  const record = createRunningJob({
    id,
    pid: 0, // 占位,__run-job 启动后回填自身 pid
    model: ctx.model,
    client: ctx.client,
    effort: ctx.effort,
    thread_key,
    session_id,
    claude_session: process.env[SESSION_ID_ENV] ?? readPersistedSessionId() ?? null,
    cwd,
    timeout_ms: ctx.timeoutMs
  });
  // 附加 runner 需要、但不属于状态契约的字段
  writeJob({
    ...record,
    _exec: {
      modelId: ctx.modelId,
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      effort: ctx.effort,
      wireApi: ctx.wireApi ?? null,
      task,
      resume,
      session_id,
      thread_key,
      timeout_ms: ctx.timeoutMs
    }
  });

  const pid = spawnDetached(process.execPath, [SELF, "__run-job", id], {
    cwd,
    env: process.env,
    logFile: jobLogFile(id)
  });
  // detached 进程组 leader 的 pid 即整树根
  writeJob({ ...readJob(id), pid });
}

// ——— __run-job(内部):detached 子进程,真正跑 client、心跳、写终态 ———
async function cmdRunJob(argv) {
  const id = argv[0];
  if (!id) {
    process.exit(2);
  }
  const job = readJob(id);
  if (!job || !job._exec) {
    process.exit(2);
  }
  // 回填自身 pid(detached leader)。
  writeJob({ ...job, pid: process.pid });

  const exec = job._exec;
  const client = getClient(job.client);

  await runUnderThreadLock(id, job, exec, client);
}

// 在 thread_key 锁保护下执行整个 client run(含心跳 + 超时兜底)。
// 同 thread_key 的并发 continue 在此排队,避免线程历史写坏(SPEC §4.3)。
async function runUnderThreadLock(id, job, exec, client) {
  const releaseThread = acquireLock(threadLockName(exec.thread_key), { timeoutMs: 600_000 });

  let invocation;
  try {
    invocation = client.buildInvocation({
      taskPrompt: exec.task,
      modelId: exec.modelId,
      baseUrl: exec.baseUrl,
      apiKey: exec.apiKey,
      effort: exec.effort,
      wireApi: exec.wireApi ?? null,
      sessionId: exec.session_id,
      resume: exec.resume
    });
  } catch (error) {
    finalizeJob(id, { status: "failed", error: `构造调用失败: ${error.message}` });
    releaseThread();
    process.exit(1);
  }

  // 落盘 client 需要的临时配置文件
  for (const f of invocation.files ?? []) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.content, "utf8");
  }

  // env 值为 null = 需 UNSET(SPEC §5:claude 强制 unset ANTHROPIC_AUTH_TOKEN)。
  const childEnv = { ...process.env };
  for (const [k, v] of Object.entries(invocation.env ?? {})) {
    if (v === null) {
      delete childEnv[k];
    } else {
      childEnv[k] = v;
    }
  }
  // client detached:自成进程组,terminateProcessTree(child.pid) 能命中其整棵子树。
  const child = spawn(invocation.command, invocation.argv, {
    cwd: job.cwd,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  // 持久化 client 进程组 leader pid。cancel/cleanup 据此**直接**杀 client 子树,
  // 不再单点依赖 runner 的 SIGTERM relay(runner 若已崩,client 不致成孤儿)。
  {
    const cur = readJob(id) ?? job;
    writeJob({ ...cur, client_pid: child.pid });
  }

  // cancel 仍会杀 __run-job(job.pid)。装 SIGTERM 处理器:转手杀 client 子树后退出
  // (作为 client 子树被独立杀掉之外的双保险)。
  const onTerm = () => {
    terminateProcessTree(child.pid, { signal: "SIGKILL" });
    process.exit(0);
  };
  process.on("SIGTERM", onTerm);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  // 心跳:每 ≤5s 更新 last_heartbeat
  const hb = setInterval(() => heartbeat(id), HEARTBEAT_INTERVAL_MS);

  // 超时兜底:wall-clock 上限 → SIGKILL 杀进程树(SIGKILL 不可被 trap,client 必死、
  // close 必触发)→ status=timeout。再加一道硬退出兜底:万一 close 仍不触发(如 stdio
  // 管道卡住),宽限后强制写终态、释放线程锁、退出,绝不让 runner 永久占锁/卡 running。
  let timedOut = false;
  let hardExitTimer = null;
  const timeoutMs = exec.timeout_ms ?? job.timeout_ms;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child.pid, { signal: "SIGKILL" });
    hardExitTimer = setTimeout(() => {
      try {
        const cur = readJob(id) ?? job;
        const { _exec, ...rest } = cur;
        writeJob({
          ...rest,
          status: "timeout",
          pid: null,
          exit_code: null,
          error: `wall-clock 超时(>${Math.round(timeoutMs / 1000)}s);SIGKILL 后仍未退出,强制收尾`
        });
      } catch {
        /* best effort */
      }
      releaseThread();
      process.exit(0);
    }, 5000);
    hardExitTimer.unref?.();
  }, timeoutMs);

  const exit = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => resolve({ code: null, signal: null, spawnError: err }));
  });

  clearInterval(hb);
  clearTimeout(timer);
  if (hardExitTimer) clearTimeout(hardExitTimer);

  // 清理 _exec(运行参数不长期保留)
  const stripExec = (extra) => {
    const cur = readJob(id) ?? job;
    const { _exec, ...rest } = cur;
    writeJob({ ...rest, ...extra });
  };

  if (timedOut) {
    stripExec({});
    finalizeJob(id, {
      status: "timeout",
      exit_code: exit.code,
      error: `wall-clock 超时(>${Math.round(timeoutMs / 1000)}s),已杀进程树`
    });
    releaseThread();
    process.exit(0);
  }

  if (exit.spawnError) {
    stripExec({});
    finalizeJob(id, { status: "failed", error: mapClientError(exit.spawnError.message, stderr) });
    releaseThread();
    process.exit(1);
  }

  if (exit.code === 0) {
    // 解析结果文本 + session id(供后续 continue)
    let resultText = "";
    let sessionId = job.session_id ?? null;
    try {
      resultText = client.parseResult(stdout) ?? "";
    } catch (error) {
      resultText = stdout;
    }
    try {
      sessionId = client.extractSessionId(stdout, { cwd: job.cwd }) ?? sessionId;
    } catch {
      /* keep prior */
    }
    stripExec({ session_id: sessionId, result_text: resultText });
    finalizeJob(id, { status: "done", exit_code: 0 });
    releaseThread();
    process.exit(0);
  }

  // 非零退出 → failed,把 stderr 映射成友好错误
  stripExec({});
  finalizeJob(id, {
    status: "failed",
    exit_code: exit.code,
    error: mapClientError(`client 退出码 ${exit.code}`, stderr)
  });
  releaseThread();
  process.exit(1);
}

// 运行后才暴露的错(401/网络)→ 友好提示。
function mapClientError(base, stderr) {
  const text = (stderr || "").trim();
  if (/401|unauthorized|invalid api key|authentication/i.test(text)) {
    return `${base}: 鉴权失败(检查 api_key,/momo:config)`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo/i.test(text)) {
    return `${base}: 网络错误(检查 base_url / 连通性)`;
  }
  const tail = text ? `: ${text.split("\n").slice(-3).join(" ").slice(0, 400)}` : "";
  return `${base}${tail}`;
}

// ——— status ———
function cmdStatus(argv) {
  const reference = argv[0];
  if (!reference) {
    const jobs = listJobs().map((j) => assessJob(j));
    process.stdout.write(`${renderStatusList(jobs)}\n`);
    return;
  }
  let job;
  try {
    job = resolveJobRef(reference);
  } catch (error) {
    fail(error.message);
  }
  if (!job) {
    fail(`找不到 job "${reference}"`);
  }
  process.stdout.write(`${renderStatusOne(assessJob(job))}\n`);
}

// ——— result ———
function cmdResult(argv) {
  const reference = argv[0];
  if (!reference) {
    fail("用法:/momo:result <job-id>");
  }
  let job;
  try {
    job = resolveJobRef(reference);
  } catch (error) {
    fail(error.message);
  }
  if (!job) {
    fail(`找不到 job "${reference}"`);
  }
  const assessed = assessJob(job);
  process.stdout.write(`${renderResult(assessed, assessed.result_text)}\n`);
}

// ——— cancel:杀进程树 → status=killed ———
function cmdCancel(argv) {
  const reference = argv[0];
  if (!reference) {
    fail("用法:/momo:cancel <job-id>");
  }
  let job;
  try {
    job = resolveJobRef(reference);
  } catch (error) {
    fail(error.message);
  }
  if (!job) {
    fail(`找不到 job "${reference}"`);
  }
  if (isTerminal(job.status)) {
    fail(`job ${job.id} 已是终态 (${job.status}),无需取消`);
  }
  // 先直接杀 client 子树(SIGKILL),再杀 runner 组 —— 不依赖 runner 的 relay,
  // 避免 runner 已崩时 client 成孤儿。
  if (job.client_pid) {
    terminateProcessTree(job.client_pid, { signal: "SIGKILL" });
  }
  const result = terminateProcessTree(job.pid);
  finalizeJob(job.id, { status: "killed", error: "用户取消" });
  process.stdout.write(`${renderCancel(job, result)}\n`);
}

// ——— list ———
function cmdList() {
  let models;
  try {
    const config = loadConfig();
    models = listModelNames(config).map((name) => resolveModelView(name));
  } catch (error) {
    fail(error.message);
  }
  process.stdout.write(`${renderModelList(models)}\n`);
}

// ——— config-set(只校验 + 原子写,不做 NL 解析)———
function cmdConfigSet(argv) {
  const parsed = parseFormC(argv);
  const jsonStr = parsed.flags.json;
  if (!jsonStr) {
    fail("用法:config-set --json '<结构化JSON>'");
  }
  let payload;
  try {
    payload = JSON.parse(jsonStr);
  } catch (error) {
    fail(`--json 不是合法 JSON: ${error.message}`);
  }
  try {
    // saveConfig(协议层):校验(§6.1)+ 原子写 + 写锁;坏 JSON 不覆盖在 config.mjs 内保证。
    withLock(CONFIG_LOCK, () => saveConfig(payload));
  } catch (error) {
    fail(error.message);
  }
  process.stdout.write("配置已写入 ~/.momo/config.json。用 /momo:list 查看。\n");
}

// ——— cleanup(SessionEnd 也可经 cleanup-session.mjs)———
async function cmdCleanup() {
  const { cleanupSession } = await import("./cleanup-session.mjs");
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const killed = cleanupSession(sessionId);
  process.stdout.write(`cleanup: 杀掉 ${killed.length} 个 running job\n`);
}

// ——— 分发 ———
async function main() {
  const [, , sub, ...rest] = process.argv;
  switch (sub) {
    case "work":
      return cmdWork(rest);
    case "continue":
      return cmdContinue(rest);
    case "status":
      return cmdStatus(rest);
    case "result":
      return cmdResult(rest);
    case "cancel":
      return cmdCancel(rest);
    case "list":
      return cmdList();
    case "config-set":
      return cmdConfigSet(rest);
    case "cleanup":
      return cmdCleanup();
    case "__run-job":
      return cmdRunJob(rest);
    default:
      fail(
        `未知子命令 "${sub ?? ""}"。可用:work continue status result cancel list config-set cleanup`,
        2
      );
  }
}

main().catch((error) => {
  fail(error?.stack || error?.message || String(error));
});
