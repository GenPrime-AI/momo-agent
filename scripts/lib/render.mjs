// 纯文本渲染:list(模型表)/status(job 状态)/result(最终输出)。
// 纯函数,不碰 IO。

function pad(str, width) {
  const s = String(str ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  const out = [line(headers), line(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) {
    out.push(line(r));
  }
  return out.join("\n");
}

// /momo:list —— 模型表。models: registry 解析后的 [{ model, provider, protocols, clients, defaultClient, effort, defaultEffort }]
export function renderModelList(models) {
  if (!models || models.length === 0) {
    return "尚无已配置的 model。用 /momo:config 添加。";
  }
  const rows = models.map((m) => {
    const clients = (m.clients ?? [])
      .map((c) => (c === m.defaultClient ? `${c}*` : c))
      .join(",");
    const effort = (m.effort ?? [])
      .map((e) => (e === m.defaultEffort ? `${e}*` : e))
      .join(",");
    const protocols = Array.isArray(m.protocols) ? m.protocols.join(",") : String(m.protocols ?? "");
    return [m.model, m.provider, protocols, clients, effort];
  });
  return `${renderTable(["MODEL", "PROVIDER", "PROTOCOL", "CLIENTS", "EFFORT"], rows)}\n\n* = 默认`;
}

function elapsed(startIso, endIso) {
  const start = Date.parse(startIso ?? "");
  if (!Number.isFinite(start)) {
    return "";
  }
  const end = endIso ? Date.parse(endIso) : Date.now();
  const total = Math.max(0, Math.round((end - start) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

function statusBadge(job) {
  if (job.status === "running" && job.suspectedStuck) {
    return "running(疑似卡死)";
  }
  return job.status;
}

// 单 job 一行摘要。
function jobLine(job) {
  const parts = [
    job.id,
    statusBadge(job),
    `${job.model}/${job.client}/${job.effort}`,
    elapsed(job.started_at, job.status === "running" ? null : job.last_heartbeat)
  ];
  return parts.filter(Boolean).join("  ");
}

// /momo:status(全部)—— assessed jobs 列表。
export function renderStatusList(jobs) {
  if (!jobs || jobs.length === 0) {
    return "没有 momo job。用 /momo:work 派发一个。";
  }
  const running = jobs.filter((j) => j.status === "running");
  const finished = jobs.filter((j) => j.status !== "running");
  const sections = [];
  if (running.length) {
    sections.push(["运行中:", ...running.map((j) => `  ${jobLine(j)}`)].join("\n"));
    if (running.some((j) => j.suspectedStuck)) {
      sections.push("提示:疑似卡死的 job 可用 /momo:cancel <job-id> 终止。");
    }
  }
  if (finished.length) {
    sections.push(["已结束:", ...finished.map((j) => `  ${jobLine(j)}`)].join("\n"));
  }
  return sections.join("\n\n");
}

// /momo:status <job-id>(单个)。
export function renderStatusOne(job) {
  const lines = [
    `job:        ${job.id}`,
    `status:     ${statusBadge(job)}`,
    `model:      ${job.model}`,
    `client:     ${job.client}`,
    `effort:     ${job.effort}`,
    `cwd:        ${job.cwd}`,
    `pid:        ${job.pid ?? "-"}`,
    `started:    ${job.started_at}`,
    `heartbeat:  ${job.last_heartbeat ?? "-"}`,
    `elapsed:    ${elapsed(job.started_at, job.status === "running" ? null : job.last_heartbeat)}`
  ];
  if (job.exit_code != null) {
    lines.push(`exit_code:  ${job.exit_code}`);
  }
  if (job.error) {
    lines.push(`error:      ${job.error}`);
  }
  if (job.status === "running" && job.suspectedStuck) {
    lines.push("");
    lines.push("提示:心跳超时,疑似卡死。可 /momo:cancel " + job.id);
  }
  return lines.join("\n");
}

// /momo:result —— done 打印完整结果;否则提示当前 status。
export function renderResult(job, resultText) {
  if (job.status === "done") {
    return resultText && resultText.trim() ? resultText : "(job 完成,但无输出文本)";
  }
  if (job.status === "running") {
    const stuck = job.suspectedStuck ? "(疑似卡死)" : "";
    return `job ${job.id} 仍在运行${stuck},尚无最终结果。用 /momo:status ${job.id} 查看进度。`;
  }
  // 失败类终态
  const reason = job.error ? `:${job.error}` : "";
  return `job ${job.id} 状态为 ${job.status}${reason}。没有可取的成功结果。`;
}

// 派发成功提示。
export function renderWorkAccepted(job) {
  return [
    `已后台派发 job ${job.id}(${job.model}/${job.client}/${job.effort})。`,
    `查看进度:/momo:status ${job.id}`,
    `取回结果:/momo:result ${job.id}`
  ].join("\n");
}

// cancel 结果提示。
export function renderCancel(job, result) {
  const how = result?.delivered ? `已杀进程树(${result.method})` : "进程已不存在";
  return `job ${job.id} 已取消(status=killed),${how}。`;
}
