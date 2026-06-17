// codex.mjs — client adapter for the `codex` CLI (speaks openai protocol).
//
// Verified against `codex exec --help` and `codex exec resume --help`:
//   codex exec [OPTIONS] [PROMPT]
//     -m, --model <MODEL>
//     -c, --config <key=value>     (TOML-parsed; strings need embedded quotes)
//     --skip-git-repo-check
//     --json                       (JSONL events to stdout)
//     -o, --output-last-message <FILE>   (final message written here)
//   codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]    -> resume IS supported.
//
// Custom OpenAI-compatible endpoint is wired via `-c model_providers.momo.*`
// overrides + a MOMO_API_KEY env var (env_key indirection).

export default {
  name: "codex",
  protocol: "openai",
  allowedEffort: new Set(["none", "minimal", "low", "medium", "high", "xhigh"]),
  supportsResume: true,
  // codex's actual resumable session id is only known after parsing subprocess output → can only continue from a completed base.
  sessionIdStable: false,

  // Pure: returns { command, argv, env, files }.
  //   wireApi: which OpenAI wire protocol codex speaks to the endpoint. codex >=0.139 REMOVED
  //   `wire_api="chat"` (Chat Completions) — it now only loads `wire_api="responses"` (the Responses API),
  //   so that is the default. An explicit wire_api on the model/provider (passed through by resolve) still
  //   wins verbatim, e.g. forcing "chat" for an older codex.
  //   NOTE: a Chat-Completions-only endpoint (no /responses route, e.g. api.xiaomimimo.com/v1) can no longer
  //   be driven by codex on these versions — it returns 404; drive such providers via the anthropic client.
  buildInvocation({ taskPrompt, modelId, baseUrl, apiKey, effort, sessionId, resume, wireApi }) {
    // Explicit wireApi wins; otherwise default to "responses" (the only value codex >=0.139 accepts).
    const wire = wireApi || "responses";
    const providerOverrides = [
      "-c", 'model_provider="momo"',
      "-c", 'model_providers.momo.name="momo"',
      "-c", `model_providers.momo.base_url="${baseUrl}"`,
      "-c", 'model_providers.momo.env_key="MOMO_API_KEY"',
      "-c", `model_providers.momo.wire_api="${wire}"`,
    ];
    if (effort) providerOverrides.push("-c", `model_reasoning_effort="${effort}"`); // optional

    // Isolation: --ignore-user-config (don't load $CODEX_HOME/config.toml) + --ignore-rules (don't load
    // user/project .rules) — delegated behavior is determined only by the task body + chosen provider/model, consistent across machines.
    // --json: events are written as JSONL to stdout, parseResult takes the last agent message (not the whole log-mixed blob).
    // --dangerously-bypass-approvals-and-sandbox: delegation is headless, no one to approve; bypass by default lets codex
    // execute/read/write autonomously (recommended in an isolated worktree). Aligned with the claude adapter's --dangerously-skip-permissions.
    const iso = [
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox"
    ];
    let argv;
    if (resume) {
      // Form: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
      // Options (including -c provider overrides and -m) must come before SESSION_ID, else they're misparsed as positional args.
      argv = ["exec", "resume", ...iso, ...providerOverrides, "-m", modelId, sessionId, taskPrompt];
    } else {
      argv = ["exec", ...iso, "-m", modelId, ...providerOverrides, taskPrompt];
    }

    const env = {
      MOMO_API_KEY: apiKey,
    };

    return { command: "codex", argv, env, files: [] };
  },

  // codex exec (without --json) streams human-readable output; the final agent
  // message is the last substantive block. We parse defensively:
  //  - if JSONL (--json) lines are present, pick the last item/agent message text;
  //  - else return the trailing non-empty text block.
  parseResult(rawStdout) {
    const text = (rawStdout || "").trim();
    if (!text) return "";

    const lines = text.split(/\r?\n/);

    // Try JSONL events first (if runner used --json).
    let jsonlFinal = null;
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("{")) continue;
      const obj = tryParse(s);
      if (!obj) continue;
      const t = jsonEventText(obj);
      if (t) jsonlFinal = t;
    }
    if (jsonlFinal) return jsonlFinal;

    // Plain-text fallback: strip leading log/meta lines, return tail block.
    const meaningful = lines
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim() !== "");
    return meaningful.length ? meaningful.join("\n") : text;
  },

  // For resume we need codex's session/conversation id.
  //  - --json events carry a session/conversation id;
  //  - plain output may print "session id: <uuid>".
  // Prefer a freshly emitted id; otherwise fall back to ctx.sessionId.
  extractSessionId(rawStdout, ctx) {
    const text = (rawStdout || "").trim();
    if (text) {
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim();
        if (s.startsWith("{")) {
          const obj = tryParse(s);
          const id = obj && (obj.session_id || obj.conversation_id || (obj.msg && obj.msg.session_id));
          if (typeof id === "string" && id) return id;
        }
      }
      const m = text.match(/session[_ ]?id[:=]\s*([0-9a-fA-F-]{8,})/);
      if (m) return m[1];
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

// Extract assistant text from a codex JSONL event object (best-effort across shapes).
// Real codex --json event shapes vary; common ones:
//   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
//   {"msg":{"type":"agent_message","message":"..."}}
// So we try to extract text from all three: obj / obj.msg / obj.item.
function jsonEventText(obj) {
  const carriers = [obj.msg, obj.item, obj].filter((c) => c && typeof c === "object");
  for (const c of carriers) {
    const type = c.type || obj.type;
    if (type && /agent_message|assistant|message|item\.completed|task_complete/.test(String(type))) {
      if (typeof c.text === "string" && c.text) return c.text;
      if (typeof c.message === "string" && c.message) return c.message;
      if (typeof c.last_agent_message === "string" && c.last_agent_message) return c.last_agent_message;
    }
  }
  if (typeof obj.last_agent_message === "string") return obj.last_agent_message;
  return "";
}
