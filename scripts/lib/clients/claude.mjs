// claude.mjs — client adapter for the `claude` CLI (speaks anthropic protocol).
//
// Verified against `claude --help`:
//   -p / --print, --output-format json, --session-id <uuid>, -r/--resume [value],
//   --effort <low|medium|high|xhigh|max>.

export default {
  name: "claude",
  protocol: "anthropic",
  allowedEffort: new Set(["low", "medium", "high", "xhigh", "max"]),
  supportsResume: true,
  // The session id is pinned via --session-id when the work is created, so it's known before completion → continue can queue
  // behind a still-running base (serialized by the thread lock) without waiting for base to finish.
  sessionIdStable: true,

  // Pure: returns { command, argv, env, files }.
  // - env: vars to set/unset for the child. A value of `null` means UNSET.
  // - files: temp config files to drop to disk first (none for claude).
  buildInvocation({ taskPrompt, modelId, baseUrl, apiKey, effort, sessionId, resume }) {
    // --bare: minimal mode, skips the caller's hooks/plugins/CLAUDE.md/skills/settings/MCP — the delegated subprocess
    // only sees the task body + its own thread history, and avoids re-entering momo's own SessionStart/End hooks.
    // --dangerously-skip-permissions: delegation is a headless background job, no one to click permission prompts; bypass by default lets it
    // autonomously read/write files and run tools in the working directory (recommended: an isolated worktree), else it hangs forever on the first permission request.
    const argv = ["-p", "--bare", "--dangerously-skip-permissions", "--output-format", "json"];
    if (resume) {
      // Resume an existing thread by its claude session id.
      argv.push("--resume", sessionId);
    } else {
      // Pin a deterministic session id so we can resume later.
      argv.push("--session-id", sessionId);
    }
    if (effort) argv.push("--effort", effort); // optional: a model may have no effort
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
