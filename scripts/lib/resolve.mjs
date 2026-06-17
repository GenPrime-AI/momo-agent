// resolve.mjs — (model, client?, effort?) → full execution context.
// Contains ALL SPEC §8 fail-fast validation. Every error lists the available
// options so the caller (and the user) can self-correct.
//
// Returned execution context (the contract other modules rely on):
//
//   {
//     model,            // model name as given
//     modelId,          // model.model_id (what the client actually receives)
//     provider,         // provider name
//     protocol,         // protocol the chosen client speaks (== adapter.protocol)
//     client,           // resolved client name
//     adapter,          // the client adapter object (SPEC §5 interface)
//     effort,           // resolved effort (legal for client)
//     baseUrl,          // provider.base_url[protocol]
//     apiKey,           // provider.api_key (plaintext)
//     binaryPath,       // absolute path to the client binary (PATH-resolved)
//     cwd,              // absolute working dir
//     threadKey,        // sha1(cwd|model|client) — resume/serialization key
//   }
//
// On any validation failure throws a ResolveError with a `.code` and a message
// that already enumerates the valid alternatives.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  getModel,
  getProvider,
  providerForModel,
  defaultClient,
  defaultEffortForClient,
  compatibleClients,
  clientValidForModel,
  listModels,
} from "./registry.mjs";
import { getClient } from "./clients/index.mjs";

export class ResolveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResolveError";
    this.code = code;
  }
}

// thread_key = sha1(cwd|model|client). resume + same-thread serialization key.
export function threadKey(cwd, model, client) {
  return createHash("sha1").update(`${cwd}|${model}|${client}`).digest("hex");
}

// Resolve a client binary on PATH (honours a leading test/mock-bin override).
// Returns absolute path or null. No execution — just existence + executable bit.
export function resolveBinary(command, env = process.env) {
  if (command.includes(path.sep)) {
    return isExecutable(command) ? path.resolve(command) : null;
  }
  const PATH = env.PATH || "";
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Main entry. SPEC §8 ordered fail-fast.
//   opts = { model, client?, effort?, taskPrompt?, cwd?, env? }
// taskPrompt is validated here (§8.7) when provided; resolve is also usable for
// `continue`/dry checks by passing a non-empty taskPrompt.
export function resolve(config, opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();

  // §8.1 — --model missing
  const model = opts.model;
  if (!model || typeof model !== "string" || model.trim() === "") {
    throw new ResolveError("model-missing", "缺少 --model。请用 --model <name> 指定模型。");
  }

  // §8.2 — model not in config
  const modelDef = getModel(config, model);
  if (!modelDef) {
    const known = listModels(config);
    throw new ResolveError(
      "model-unknown",
      `未知 model "${model}"。已知 model:${known.length ? known.join(", ") : "(无,请先 /momo:config)"}。`
    );
  }

  const providerName = modelDef.provider;
  const provider = getProvider(config, providerName);
  if (!provider) {
    throw new ResolveError(
      "provider-missing",
      `model "${model}" 引用的 provider "${providerName}" 不存在。请检查配置或 /momo:config。`
    );
  }

  // §8.3 — resolve client
  let client = opts.client;
  if (client) {
    const check = clientValidForModel(config, model, client);
    if (!check.ok) {
      const avail = compatibleClients(config, model);
      let why;
      if (check.reason === "not-in-model-clients") {
        why = `client "${client}" 不在 model "${model}" 的 clients 列表里`;
      } else if (check.reason === "unknown-client") {
        why = `未知 client "${client}"`;
      } else if (check.reason === "protocol-incompatible") {
        const adapter = getClient(client);
        why = `client "${client}" 说 ${adapter ? adapter.protocol : "?"} 协议,与 provider "${providerName}" 暴露的协议不兼容`;
      } else {
        why = `client "${client}" 不可用`;
      }
      throw new ResolveError(
        "client-invalid",
        `${why}。该 model 可用 client:${avail.length ? avail.join(", ") : "(无)"}。`
      );
    }
  } else {
    client = defaultClient(modelDef);
    if (!client) {
      throw new ResolveError("client-missing", `model "${model}" 没有配置任何 client。`);
    }
    // default client must still be protocol-compatible
    const check = clientValidForModel(config, model, client);
    if (!check.ok) {
      const avail = compatibleClients(config, model);
      throw new ResolveError(
        "client-invalid",
        `model "${model}" 的默认 client "${client}" 不可用(${check.reason})。可用 client:${avail.length ? avail.join(", ") : "(无)"}。`
      );
    }
  }

  const adapter = getClient(client);
  const protocol = adapter.protocol;

  // §8.4 — client binary installed?
  const binaryPath = resolveBinary(client, env);
  if (!binaryPath) {
    const avail = compatibleClients(config, model).filter((c) => resolveBinary(c, env));
    throw new ResolveError(
      "client-not-installed",
      `client "${client}" 未安装(PATH 上找不到可执行 "${client}")。请安装它,或改用已安装的 client:${avail.length ? avail.join(", ") : "(无可用)"}。`
    );
  }

  // §8.5 — resolve effort
  let effort = opts.effort;
  if (effort) {
    const inModel = Array.isArray(modelDef.effort) && modelDef.effort.includes(effort);
    const legalForClient = adapter.allowedEffort.has(effort);
    if (!inModel || !legalForClient) {
      const legal = (modelDef.effort || []).filter((e) => adapter.allowedEffort.has(e));
      throw new ResolveError(
        "effort-invalid",
        `effort "${effort}" 对 model "${model}" + client "${client}" 非法。合法值:${legal.length ? legal.join(", ") : "(无 — 该 model 的 effort 列表对 client " + client + " 无合法项)"}。`
      );
    }
  } else {
    effort = defaultEffortForClient(modelDef, client);
    if (!effort) {
      throw new ResolveError(
        "effort-missing",
        `model "${model}" 的 effort 列表 [${(modelDef.effort || []).join(", ")}] 没有任何一项对 client "${client}" 合法。`
      );
    }
  }

  // §8.6 — provider api_key / base_url present
  const baseUrl = provider.base_url && provider.base_url[protocol];
  if (!baseUrl) {
    throw new ResolveError(
      "base-url-missing",
      `provider "${providerName}" 缺少 ${protocol} 协议的 base_url。请运行 /momo:config 补全。`
    );
  }
  if (typeof provider.api_key !== "string" || provider.api_key.trim() === "") {
    throw new ResolveError(
      "api-key-missing",
      `provider "${providerName}" 缺少 api_key。请运行 /momo:config 补全。`
    );
  }

  // §8.7 — task prompt non-empty (only checked when provided)
  if (opts.taskPrompt !== undefined) {
    if (typeof opts.taskPrompt !== "string" || opts.taskPrompt.trim() === "") {
      throw new ResolveError("task-empty", "任务正文为空。请在 `--` 之后给出任务内容。");
    }
  }

  // 可选 wire_api(仅 openai 协议/codex client 用):model 优先,其次 provider,
  // 缺省让适配器决定(codex 默认 chat)。
  const wireApi = modelDef.wire_api ?? provider.wire_api ?? null;

  // 可选 per-model/provider 超时(毫秒)。缺省返回 null,由上层兜到 DEFAULT_TIMEOUT_MS。
  const timeoutMs = Number.isFinite(modelDef.timeout_ms)
    ? modelDef.timeout_ms
    : Number.isFinite(provider.timeout_ms)
      ? provider.timeout_ms
      : null;

  return {
    timeoutMs,
    model,
    modelId: modelDef.model_id,
    provider: providerName,
    protocol,
    client,
    adapter,
    effort,
    baseUrl,
    apiKey: provider.api_key,
    binaryPath,
    cwd,
    threadKey: threadKey(cwd, model, client),
    wireApi,
  };
}
