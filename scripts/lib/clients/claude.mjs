// claude.mjs — client adapter for the `claude` CLI (speaks anthropic protocol).
// SPEC §5.1.
//
// Verified against `claude --help`:
//   -p / --print, --output-format json, --session-id <uuid>, -r/--resume [value],
//   --effort <low|medium|high|xhigh|max>.

export default {
  name: "claude",
  protocol: "anthropic",
  allowedEffort: new Set(["low", "medium", "high", "xhigh", "max"]),
  supportsResume: true,
  // 会话 id 在 work 创建时就用 --session-id 钉死,完成前即可知 → continue 可排队在
  // 仍在运行的 base 后面(靠 thread 锁串行),不必等 base 完成。
  sessionIdStable: true,

  // Pure: returns { command, argv, env, files }.
  // - env: vars to set/unset for the child. A value of `null` means UNSET.
  // - files: temp config files to drop to disk first (none for claude).
  buildInvocation({ taskPrompt, modelId, baseUrl, apiKey, effort, sessionId, resume }) {
    // --bare:最小模式,跳过调用方的 hooks/插件/CLAUDE.md/skills/settings/MCP —— 委派子进程
    // 只看到任务正文 + 自己的线程历史(SPEC §2.3),也避免重入 momo 自己的 SessionStart/End 钩子。
    const argv = ["-p", "--bare", "--output-format", "json"];
    if (resume) {
      // Resume an existing thread by its claude session id.
      argv.push("--resume", sessionId);
    } else {
      // Pin a deterministic session id so we can resume later.
      argv.push("--session-id", sessionId);
    }
    argv.push("--effort", effort);
    argv.push(taskPrompt);

    const env = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_MODEL: modelId,
      // Must be unset so the proxy key (api_key) is used, not an OAuth token.
      ANTHROPIC_AUTH_TOKEN: null,
    };

    return { command: "claude", argv, env, files: [] };
  },

  // `--output-format json` prints a single JSON object whose `result` field is
  // the final assistant text. Fall back gracefully if shape differs.
  parseResult(rawStdout) {
    const text = (rawStdout || "").trim();
    if (!text) return "";
    // Try whole-string JSON first.
    const obj = tryParse(text);
    if (obj) return extractText(obj);
    // Fall back: scan lines for the last JSON object (stream-ish output).
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = tryParse(lines[i].trim());
      if (o) {
        const t = extractText(o);
        if (t) return t;
      }
    }
    return text; // last resort: raw
  },

  // claude session id == the --session-id we pinned (or the resumed one).
  extractSessionId(rawStdout, ctx) {
    const text = (rawStdout || "").trim();
    if (text) {
      const obj = tryParse(text) || lastJsonLine(text);
      if (obj && typeof obj.session_id === "string") return obj.session_id;
    }
    return (ctx && ctx.sessionId) || null;
  },
};

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function lastJsonLine(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = tryParse(lines[i].trim());
    if (o) return o;
  }
  return null;
}

function extractText(obj) {
  if (typeof obj.result === "string") return obj.result;
  if (typeof obj.text === "string") return obj.text;
  // some shapes: { type:"result", result:"..." } already covered; arrays of content
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((c) => (typeof c === "string" ? c : c && c.text) || "")
      .join("");
  }
  return "";
}
