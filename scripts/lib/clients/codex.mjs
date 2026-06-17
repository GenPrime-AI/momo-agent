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
  // codex 真实可 resume 的会话 id 要解析子进程输出后才知 → 只能续接已完成的 base。
  sessionIdStable: false,

  // Pure: returns { command, argv, env, files }.
  //   wireApi: openai 兼容端点的协议类型。普通 OpenAI 兼容(如 GLM /paas/v4)用
  //   "chat"(Chat Completions);codex-native 模型(gpt-5-codex)需 "responses"。
  //   未指定时默认 "chat"。由 model/provider 的可选 wire_api 字段驱动(resolve 透传)。
  buildInvocation({ taskPrompt, modelId, baseUrl, apiKey, effort, sessionId, resume, wireApi }) {
    // 显式 wireApi 优先;否则按 model 自动判定:codex-native 模型(名字含 codex,
    // 如 gpt-5-codex)走 "responses",普通 OpenAI 兼容端点走 "chat"。
    const wire = wireApi || (/codex/i.test(String(modelId)) ? "responses" : "chat");
    const providerOverrides = [
      "-c", 'model_provider="momo"',
      "-c", 'model_providers.momo.name="momo"',
      "-c", `model_providers.momo.base_url="${baseUrl}"`,
      "-c", 'model_providers.momo.env_key="MOMO_API_KEY"',
      "-c", `model_providers.momo.wire_api="${wire}"`,
      "-c", `model_reasoning_effort="${effort}"`,
    ];

    // 隔离:--ignore-user-config(不加载 $CODEX_HOME/config.toml)+ --ignore-rules(不加载
    // 用户/项目 .rules)—— 委派行为只由任务正文 + 所选 provider/model 决定,跨机器一致。
    // --json:事件以 JSONL 打到 stdout,parseResult 取最后的 agent 消息(而非掺日志的整段)。
    // --dangerously-bypass-approvals-and-sandbox:委派 headless,无人批准;默认 bypass 让 codex 能
    // 自主执行/读写(建议在隔离 worktree)。与 claude 适配器的 --dangerously-skip-permissions 对齐。
    const iso = [
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox"
    ];
    let argv;
    if (resume) {
      // 形态:codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
      // 选项(含 -c provider 覆盖、-m)必须在 SESSION_ID 之前,否则会被当成位置参数误解析。
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
// 真实 codex --json 事件形态多变,常见:
//   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
//   {"msg":{"type":"agent_message","message":"..."}}
// 因此在 obj / obj.msg / obj.item 三处都尝试取文本。
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
