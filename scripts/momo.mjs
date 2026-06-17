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
  earlierActiveOnThread,
  executionStillLive,
  finalizeJob,
  generateJobId,
  nextSeq,
  heartbeat,
  HEARTBEAT_INTERVAL_MS,
  isActive,
  isTerminal,
  jobLogFile,
  listJobs,
  markRunning,
  patchIfActive,
  readJob,
  resolveJobRef,
  soleActiveSession,
  threadKey
} from "./lib/jobs.mjs";
import { acquireLock, threadLockName } from "./lib/lock.mjs";
import {
  binaryAvailable,
  procToken,
  spawnDetached,
  terminateProcessTree,
  terminateTreeIfOurs
} from "./lib/process.mjs";
import {
  renderCancel,
  renderModelList,
  renderResult,
  renderStatusList,
  renderStatusOne,
  renderWorkAccepted
} from "./lib/render.mjs";

// ——— 协议层(adapter 接口约定见 SPEC §5;路径见 §9)———
import { loadConfig, patchConfig } from "./lib/config.mjs";
import {
  listModels as listModelNames,
  getModel,
  providerForModel,
  defaultClient,
  defaultEffortForClient,
  compatibleClients
} from "./lib/registry.mjs";
import { resolve as resolveExecContext, resolveForContinue } from "./lib/resolve.mjs";
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

// /momo:continue 专用:用 job 持久化的原始后端身份重建上下文(+ timeoutMs 兜底)。
function resolveContinueContext(base) {
  const config = loadConfig();
  const ctx = resolveForContinue(config, base);
  const envTimeout = Number(process.env.MOMO_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
// 主 session id:优先 MOMO_SESSION_ID(SessionStart 钩子经 $CLAUDE_ENV_FILE 注入,
// per-session 准确、多 session 不串),其次 CLAUDE_SESSION_ID,最后单活跃 session 兜底。
const MOMO_SESSION_ID_ENV = "MOMO_SESSION_ID";
const SESSION_ID_ENV = "CLAUDE_SESSION_ID";

function currentSessionId() {
  return process.env[MOMO_SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? soleActiveSession() ?? null;
}

function fail(message, code = 1) {
  process.stderr.write(`momo: ${message}\n`);
  process.exit(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ——— form C 参数解析:全 flag,任务正文在 `--` 之后 ———
// 返回 { flags: {model,client,effort,...}, task: string|null }
// 契约(见 agents/momo-runner.md):调用方把任务作为**单个 shell 引号参数**传在 `--` 之后,
// 因此 `--` 后通常只有一个 argv 元素,join(" ") 即原样返回(空格/换行/缩进保真)。仅当调用方
// 误传成多个裸 token 时才退化为单空格连接 —— 那是 shell 分词造成的,momo 已无从还原。
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
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = flagArgs[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`flag --${key} 缺少取值`);
    }
    flags[key] = next;
    i += 1;
  }
  return { flags, task };
}

// 布尔 flag(无取值)。--stdin:任务正文从 stdin 读(配合引号 heredoc,免疫撇号/引号/换行)。
const BOOLEAN_FLAGS = new Set(["stdin"]);
const KNOWN_WORK_FLAGS = new Set(["model", "client", "effort", "stdin"]);

// 从 stdin 读任务正文(byte 安全:引号 heredoc 不做任何 shell 展开)。剥掉 heredoc 末尾的换行。
function readStdinTask() {
  try {
    return fs.readFileSync(0, "utf8").replace(/\n$/, "");
  } catch {
    return "";
  }
}

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
  const { flags } = parsed;
  // --stdin:任务从 stdin 读(robust,免 shell 引号问题);否则取 `--` 之后的正文。
  const task = flags.stdin ? readStdinTask() : parsed.task;

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
  // 形态:continue <job-id> -- <追加指令>  或  continue <job-id> --stdin (正文走 stdin)
  const dashDashIdx = argv.indexOf("--");
  const head = dashDashIdx === -1 ? argv : argv.slice(0, dashDashIdx);
  const useStdin = head.includes("--stdin");
  const reference = head.find((a) => !a.startsWith("--"));
  const task = useStdin
    ? readStdinTask()
    : dashDashIdx === -1
      ? null
      : argv.slice(dashDashIdx + 1).join(" ");

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

  // 先做存活判定 —— base 可能"磁盘上写着 running 但 runner 已硬崩",assessJob 会把它转成
  // crashed 并落盘。否则我们会基于陈旧状态接受 continue,排一个注定 resume 失败的 follow-up。
  base = assessJob(base);

  // resume 能力由 client 适配器决定(SPEC §5.2:codex 可能不支持)。
  const client = getClient(base.client);
  if (!client) {
    fail(`job ${base.id} 的 client "${base.client}" 不可用`);
  }
  if (client.supportsResume === false) {
    fail(`client "${base.client}" 暂不支持 continue/resume`);
  }
  // 何时可续接(会话 id 是否"完成前就稳定"):
  //  - 任何 client:base 已 done → 可续(会话已建立)。
  //  - claude(sessionIdStable):work 时 --session-id 钉死,base 处于活动态(queued/running)
  //    也可续 —— 靠同 thread_key 锁排队在其后。但若 base 已是非 done 终态(crashed/failed/
  //    killed/timeout),会话很可能没真正建立,拒绝并讲清原因。
  //  - codex(不稳定):真实 resume id 要解析完成输出才知 → 只能续 done。
  const stable = client.sessionIdStable === true;
  const okToContinue = base.status === "done" || (stable && isActive(base.status));
  if (!okToContinue) {
    fail(
      stable
        ? `job ${base.id} 当前是 "${base.status}",无法续接(请基于 运行中 或 已完成 的 job)。`
        : `job ${base.id} 当前是 "${base.status}";client "${base.client}" 的会话 id 要等任务完成才确定,请等它 done 后再 continue。`
    );
  }
  if (!base.session_id) {
    fail(`job ${base.id} 没有可 resume 的 session_id(原 job 可能未成功建立会话)`);
  }

  // 用原始后端身份(persist 在 job 里)重建上下文,只取当前 provider 的 key/base_url
  // (允许凭证轮换)。不经 model 别名 → 即便 model 名被重指到别的 backend,老线程仍 resume 原 backend。
  let ctx;
  try {
    ctx = resolveContinueContext(base);
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
    resume: true,
    resume_from: base.id
  });

  process.stdout.write(`${renderWorkAccepted(readJob(id))}\n`);
}

// 落 job 记录 + 派生 detached __run-job 进程。
function startBackgroundJob({ id, ctx, task, cwd, thread_key, session_id, resume, resume_from = null }) {
  // 提交序号(全局单调):同线程 FIFO 据此保持"先提交先执行"。
  const seq = nextSeq();
  // job 记录里附带执行参数,供 __run-job 读取(子进程看不到主对话,正文自带上下文)。
  const record = createRunningJob({
    id,
    pid: 0, // 占位,__run-job 启动后回填自身 pid
    seq,
    model: ctx.model,
    client: ctx.client,
    effort: ctx.effort,
    provider: ctx.provider,
    model_id: ctx.modelId,
    protocol: ctx.protocol,
    wire_api: ctx.wireApi ?? null,
    thread_key,
    session_id,
    claude_session: currentSessionId(),
    cwd,
    timeout_ms: ctx.timeoutMs
  });
  // 附加 runner 需要、但不属于状态契约的字段(加锁守卫:若刚创建就被 SessionEnd 清掉,
  // 不复活)。注意:api_key **不写进 job 文件**(避免明文密钥落进 ~/.momo/jobs/*.json,
  // SIGKILL 后也不残留)—— 改用 runner 进程的环境变量 MOMO_JOB_API_KEY 传递(仅在内存中)。
  patchIfActive(id, {
    _exec: {
      modelId: ctx.modelId,
      baseUrl: ctx.baseUrl,
      effort: ctx.effort,
      wireApi: ctx.wireApi ?? null,
      task,
      resume,
      resume_from,
      session_id,
      thread_key,
      timeout_ms: ctx.timeoutMs
    }
  });

  let pid;
  try {
    pid = spawnDetached(process.execPath, [SELF, "__run-job", id], {
      cwd,
      env: { ...process.env, MOMO_JOB_API_KEY: ctx.apiKey },
      logFile: jobLogFile(id)
    });
  } catch (error) {
    // 后台 runner 没起来(如 cwd 被删):把 queued 记录收尾成 failed,别留 pid:0 僵尸记录。
    finalizeJob(id, { status: "failed", error: `后台 runner 启动失败: ${error.message}` });
    fail(`无法启动后台任务: ${error.message}`);
  }
  // 回填 runner pid + 身份 token(加锁守卫:job 若已被取消/清理,不被陈旧快照复活)。
  patchIfActive(id, { pid, pid_token: procToken(pid) });
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
  // 回填自身 pid + 身份 token(detached leader),加锁守卫:若 work 返回后立刻被 cancel/SessionEnd
  // 置终态,不复活它,且 runner 直接退出(不再起 client)。
  const started = patchIfActive(id, { pid: process.pid, pid_token: procToken(process.pid) });
  if (!started || isTerminal(started.status)) {
    process.exit(0);
  }

  const exec = job._exec;
  const client = getClient(job.client);

  await runUnderThreadLock(id, job, exec, client);
}

// 在 thread_key 锁保护下执行整个 client run(含心跳 + 超时兜底)。
// 同 thread_key 的并发 continue 在此排队,避免线程历史写坏(SPEC §4.3)。
async function runUnderThreadLock(id, job, exec, client) {
  // 锁等待时长 ≥ 前面 base 的最大运行时(wall-clock 超时)+ 1h 缓冲;锁有"持有者死则抢占"兜底。
  const lockWaitMs = Math.max((exec.timeout_ms ?? DEFAULT_TIMEOUT_MS) + 3_600_000, 3_600_000);

  // ── FIFO + 拿锁后统一校验 ──
  // 反复抢同线程锁,直到:本 job 仍活动、且同线程没有"更早提交(seq 更小)且未完成"的 job。
  // 这样即便多个 continue 几乎同时派发、乱序抢到锁,也严格按提交顺序执行(避免线程历史错序)。
  let releaseThread;
  for (;;) {
    releaseThread = acquireLock(threadLockName(exec.thread_key), { timeoutMs: lockWaitMs });
    const cur = readJob(id);
    if (!cur || isTerminal(cur.status)) {
      // 排队期间已被 cancel/cleanup 置终态 → 绝不执行,直接退出(终态吸收的执行边界守卫)。
      releaseThread();
      process.exit(0);
    }
    if (earlierActiveOnThread(exec.thread_key, job.seq, id)) {
      releaseThread();
      await sleep(150);
      continue;
    }
    break;
  }

  // 轮到本 job:queued → running(重置 started_at 为开跑时刻)。若此刻已终态则不执行 —— markRunning
  // 是终态吸收的,返回非 running 即说明刚被 cancel/cleanup 抢先,立即退出,绝不 buildInvocation/spawn。
  const started = markRunning(id);
  if (!started || started.status !== "running") {
    releaseThread();
    process.exit(0);
  }

  // resume:此刻前驱(FIFO 保证)已结束。要求它真正 done(claude/codex 的会话此时才确定已建立),
  // 并用其**最终** session_id(而非提交时复制的占位值)。前驱未 done → 会话未建立,拒绝续接。
  if (exec.resume && exec.resume_from) {
    const base = readJob(exec.resume_from);
    if (!base || base.status !== "done") {
      finalizeJob(id, {
        status: "failed",
        error: `原 job ${exec.resume_from} 最终为 ${base ? base.status : "缺失"},会话未成功建立,无法续接。`
      });
      releaseThread();
      process.exit(1);
    }
    if (base.session_id) exec.session_id = base.session_id;
  }

  let invocation;
  try {
    invocation = client.buildInvocation({
      taskPrompt: exec.task,
      modelId: exec.modelId,
      baseUrl: exec.baseUrl,
      apiKey: process.env.MOMO_JOB_API_KEY ?? exec.apiKey, // 密钥从 env 取,不从 job 文件
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
  // 先装 SIGTERM 处理器(引用可变 child),**再** spawn —— 这样从 client 一诞生起,
  // 若 runner 被 cancel/cleanup 杀(SIGTERM 打到 runner 组),处理器就会杀掉 client 子树,
  // 不留孤儿;即便 client_pid 还没来得及落盘,也没有"client 已起但无人能杀"的窗口。
  let child = null;
  const onTerm = () => {
    if (child) terminateProcessTree(child.pid, { signal: "SIGKILL" });
    process.exit(0);
  };
  process.on("SIGTERM", onTerm);

  // client detached:自成进程组,terminateProcessTree(child.pid) 能命中其整棵子树。
  child = spawn(invocation.command, invocation.argv, {
    cwd: job.cwd,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  // 持久化 client 进程组 leader pid(加锁守卫)。若发现 job 在我们 spawn client 的瞬间已被
  // 取消/清理(终态),立即杀掉刚起的 client 并退出 —— 不复活 job,也不留孤儿。
  const pj = patchIfActive(id, { client_pid: child.pid, client_pid_token: procToken(child.pid) });
  if (!pj || isTerminal(pj.status)) {
    terminateProcessTree(child.pid, { signal: "SIGKILL" });
    releaseThread();
    process.exit(0);
  }

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
        finalizeJob(id, {
          status: "timeout",
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

  // 所有终态都走 finalizeJob(锁内、终态守卫、自动剥离 _exec)。

  if (timedOut) {
    finalizeJob(id, {
      status: "timeout",
      exit_code: exit.code,
      error: `wall-clock 超时(>${Math.round(timeoutMs / 1000)}s),已杀进程树`
    });
    releaseThread();
    process.exit(0);
  }

  if (exit.spawnError) {
    finalizeJob(id, { status: "failed", error: mapClientError(exit.spawnError.message, stderr) });
    releaseThread();
    process.exit(1);
  }

  if (exit.code === 0) {
    // 解析结果文本 + session id(供后续 continue)
    let resultText = "";
    try {
      resultText = client.parseResult(stdout) ?? "";
    } catch (error) {
      resultText = stdout;
    }
    let extracted = null;
    try {
      extracted = client.extractSessionId(stdout, { cwd: job.cwd }) ?? null;
    } catch {
      /* none */
    }
    // 稳定 client(claude):work 钉死的 session_id 本身就是可 resume 的;解析到更准的就用。
    // 不稳定 client(codex):**只有**真正解析出真实 id 才存;否则置 null,绝不留占位 UUID,
    // 否则 /momo:continue 会拿假 id 去 resume 不存在的线程。
    const sessionId =
      client.sessionIdStable === true ? extracted ?? job.session_id ?? null : extracted;
    finalizeJob(id, { status: "done", exit_code: 0, session_id: sessionId, result_text: resultText });
    releaseThread();
    process.exit(0);
  }

  // 非零退出 → failed,把 stderr 映射成友好错误
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
  // 若 client 已退出(任务已结束、runner 正在收尾写真实结果)→ 不抢占,否则 killed 会吸收掉
  // 刚完成的 done/failed,丢结果。让 runner 正常 finalize。
  if (!executionStillLive(job)) {
    fail(`job ${job.id} 已执行完毕、正在收尾,无法取消;稍后用 /momo:result ${job.id} 取结果。`);
  }
  // 仍在跑:先认领终态(killed)——终态吸收保证它必胜(即便杀 client 触发 runner 的 close 收尾)。
  // 再验身份杀进程(PID 复用则跳过,绝不误杀)。
  finalizeJob(job.id, { status: "killed", error: "用户取消" });
  terminateTreeIfOurs(job.client_pid, job.client_pid_token, { signal: "SIGKILL" });
  const result = terminateTreeIfOurs(job.pid, job.pid_token);
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
    // patchConfig:把**部分** patch 深合并进现有 config(不删除未触及的 provider/model),
    // 再校验(§6.1)+ 原子写 + 写锁;坏 JSON 不覆盖在 config.mjs 内保证。
    patchConfig(payload);
  } catch (error) {
    fail(error.message);
  }
  process.stdout.write("配置已写入 ~/.momo/config.json。用 /momo:list 查看。\n");
}

// ——— cleanup(SessionEnd 也可经 cleanup-session.mjs)———
async function cmdCleanup() {
  const { cleanupSession } = await import("./cleanup-session.mjs");
  const sessionId = currentSessionId();
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
