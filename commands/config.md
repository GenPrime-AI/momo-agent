---
description: Configure momo providers / models / api keys / base urls / effort lists / default client via a natural-language back-and-forth.
allowed-tools: Bash(node:*), AskUserQuestion
---

This command takes no arguments — the user just ran `/momo:config` and hasn't said what to configure yet. You configure momo's `~/.momo/config.json`: the runtime doesn't parse natural language, so you turn what the user says into a structured JSON patch, confirm it, then persist it by calling the runtime.

Start by asking what they want to set, with concrete options: add or edit a provider (its base_url per protocol + api key); add or edit a model (its provider, the model_id passed to the client, which clients can drive it, and — only if that model supports it — an effort list); or set a model's default client / effort ordering. Use `AskUserQuestion` for the high-level choice if it helps, then collect the specifics in conversation. Don't assume — if a needed field is missing (a protocol's base_url, the api key, the provider a model belongs to), ask for it.

Turn the answer into the config-set patch shape (it mirrors `~/.momo/config.json`; include only the keys being set — a partial patch is fine):

```jsonc
{
  "providers": {
    "<name>": {
      "protocols": ["anthropic", "openai"],
      "base_url": { "anthropic": "https://...", "openai": "https://..." },
      "api_key": "<plaintext>"
    }
  },
  "models": {
    "<name>": {
      "provider": "<provider-name>",
      "model_id": "<id passed to the client>",
      "clients": ["claude", "codex"],
      "effort":  ["high", "medium", "low"]
    }
  }
}
```

`clients` and `effort` are ordered — the first entry is the default. `effort` is optional; include it only for models that actually support effort levels. Known clients are `claude` (anthropic protocol) and `codex` (openai protocol), and a model's clients must be drivable by its provider's protocols.

**OpenAI-protocol providers have two auth modes — ask which.** When the user wants to add a provider that speaks the `openai` protocol (driven by `codex`), offer:

1. **Use API** — the standard flow above: collect `base_url` (e.g. `https://api.openai.com/v1`) and `api_key`, with a model whose `clients` include `codex`.
2. **Use local Codex (login)** — drive `codex` with the user's own `codex login` (ChatGPT/OpenAI) session; **no api key**. First verify the CLI and login:
   - `codex --version` (if missing, tell the user to install the `codex` CLI and stop).
   - `codex login status` (if not logged in, ask the user to run `! codex login` in their terminal, then continue).

   Then persist a login provider plus a model whose client is `codex-login` (note: **no `api_key`, no `base_url`**):

   ```jsonc
   {
     "providers": { "codex-local": { "protocols": ["openai"], "auth": "login" } },
     "models": {
       "gpt-5-codex": { "provider": "codex-local", "model_id": "gpt-5-codex", "clients": ["codex-login"] }
     }
   }
   ```

   The `codex-login` client speaks the `openai` protocol and uses the client's own login, so the runtime requires neither a key nor a base_url for it.

Echo back a readable summary of exactly what will be written and get an explicit yes before writing. If the patch would overwrite a value that already exists, call that out and confirm the overwrite first — to see what's already there, run `momo.mjs list`. Then persist:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" config-set --json '<structured JSON>'
```

The runtime validates the patch (provider protocols legal, base_url matches each protocol, model.provider exists, clients known and protocol-compatible, each effort item legal for at least one client) and atomically writes the file. If it rejects the patch, relay the error and fix the JSON rather than retrying blindly. Show the runtime's success or error output to the user when done.
