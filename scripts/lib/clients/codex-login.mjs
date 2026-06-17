// codex-login.mjs — client adapter for the `codex` CLI using the user's own
// `codex login` (ChatGPT/OpenAI) auth instead of a momo-configured api key.
//
// Same binary and output format as the `codex` adapter, but:
//   - no `--ignore-user-config`  → codex loads $CODEX_HOME (incl. auth.json login)
//   - no MOMO_API_KEY / model_providers.momo overrides → codex uses its own default provider + login
// Result: a keyless, login-based codex path, selectable as client "codex-login".

import codex from "./codex.mjs";

export default {
  name: "codex-login",
  protocol: "openai",
  // The adapter name differs from the executable; resolve uses `binary` to find it on PATH.
  binary: "codex",
  // Auth comes from the client's own login → resolve skips provider base_url/api_key.
  usesClientAuth: true,
  allowedEffort: codex.allowedEffort,
  supportsResume: true,
  // codex's resumable session id is only known after parsing output (same as the codex adapter).
  sessionIdStable: false,

  // Pure: returns { command, argv, env, files }. No baseUrl/apiKey/wireApi — login mode ignores them.
  buildInvocation({ taskPrompt, modelId, effort, sessionId, resume }) {
    // --ignore-rules keeps the run determined by the task body (no project/user .rules);
    // we deliberately KEEP user-config so $CODEX_HOME/auth.json (the login) is used.
    const iso = [
      "--ignore-rules",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    const opts = [];
    if (effort) opts.push("-c", `model_reasoning_effort="${effort}"`);

    let argv;
    if (resume) {
      // Options before SESSION_ID, else codex misparses them as positional args.
      argv = ["exec", "resume", ...iso, ...opts, "-m", modelId, sessionId, taskPrompt];
    } else {
      argv = ["exec", ...iso, "-m", modelId, ...opts, taskPrompt];
    }
    // Empty env overlay: inherit the parent env so codex reads its own login/config.
    return { command: "codex", argv, env: {}, files: [] };
  },

  // Same wire format as the codex adapter — reuse its parsers (plain functions, no `this`).
  parseResult: codex.parseResult,
  extractSessionId: codex.extractSessionId,
};
