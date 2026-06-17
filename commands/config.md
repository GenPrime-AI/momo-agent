---
description: Configure momo providers / models / api keys / base urls / effort lists / default client via a natural-language back-and-forth.
allowed-tools: Bash(node:*), AskUserQuestion
---

This command takes NO arguments. The user just ran `/momo:config` — they have not yet said what to configure.

You are configuring momo's `~/.momo/config.json`. The momo runtime does NOT parse natural language; YOU (the LLM) turn what the user says into a structured JSON patch, confirm it, then persist it by calling the runtime.

Follow this flow:

1. ASK FIRST. The user gave you nothing to act on. Ask them what they want to configure. Make the options concrete, for example:
   - add or edit a provider (endpoint base_url per protocol + api key)
   - add or edit a model (which provider, the model_id passed to the client, which clients can drive it, the effort preference list)
   - set the default client / effort ordering for a model
   You may use `AskUserQuestion` for the high-level choice, then collect the specifics in plain conversation. Do not assume — if a needed field (e.g. base_url for a protocol, the api key, the provider a model belongs to) is missing, ask for it.

2. PARSE to structured JSON. Translate the user's natural-language answer into the config-set patch shape. The shape mirrors `~/.momo/config.json`:

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

   Only include the keys the user is actually setting (a partial patch is fine). `clients` and `effort` are ORDERED — the first entry is the default. Known clients are `claude` (speaks the anthropic protocol) and `codex` (speaks the openai protocol). A model's `clients` must be drivable given its provider's protocols.

3. ECHO BACK and confirm. Show the user a readable summary of exactly what will be written (provider names, model names, which fields, masking nothing the user typed but you may shorten the api key for display). Get an explicit yes before writing.

4. CONFIRM OVERWRITES. If the patch would overwrite a provider key, model key, or any existing field that already has a value in the current config, call it out explicitly and ask the user to confirm the overwrite BEFORE persisting. To see what already exists, you may run `node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" list`. Do not silently clobber existing config.

5. PERSIST. Once confirmed, run exactly:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/momo.mjs" config-set --json '<structured JSON>'
   ```

   The runtime validates (provider protocols legal, base_url matches each protocol, model.provider exists, model.clients are known and protocol-compatible, each effort item legal for at least one client) and atomically writes the file. If it rejects the patch, relay the error to the user and fix the structured JSON — do not retry blindly.

Do not run `config-set` until the user has confirmed both the parsed structure and any overwrites. Show the runtime's success/error output to the user when done.
