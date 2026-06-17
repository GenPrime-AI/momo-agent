// config.mjs — read/write ~/.momo/config.json
// Atomic write (temp file + rename), write lock, refuse-to-overwrite-on-parse-error,
// structural validation (SPEC §3, §6.1).
//
// Zero third-party deps. Node built-ins only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLIENTS } from "./clients/index.mjs";

export const CONFIG_VERSION = 1;

export function momoHome() {
  return process.env.MOMO_HOME || path.join(os.homedir(), ".momo");
}

export function configPath() {
  return path.join(momoHome(), "config.json");
}

function lockPath() {
  return configPath() + ".lock";
}

function ensureHome() {
  fs.mkdirSync(momoHome(), { recursive: true });
}

function emptyConfig() {
  return { version: CONFIG_VERSION, providers: {}, models: {} };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Returns the parsed config, or an empty skeleton if the file does not exist.
// Throws (with a clear message) if the file exists but cannot be parsed — the
// caller must NOT then write back, so we never clobber a hand-broken file.
export function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return emptyConfig();
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(`无法读取配置文件 ${p}: ${err.message}`);
  }
  if (raw.trim() === "") return emptyConfig();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `配置文件 ${p} 解析失败(可能被手动改坏): ${err.message}。已保留原文件,未做任何覆盖。请修复后重试,或删除该文件重新 /momo:config。`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${p} 顶层不是对象,已保留原文件未覆盖。`);
  }
  if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
  if (!parsed.models || typeof parsed.models !== "object") parsed.models = {};
  if (typeof parsed.version !== "number") parsed.version = CONFIG_VERSION;
  return parsed;
}

// ---------------------------------------------------------------------------
// Write lock (advisory, file-based). Serializes concurrent writers.
// ---------------------------------------------------------------------------

function acquireLock({ timeoutMs = 5000, staleMs = 30000 } = {}) {
  ensureHome();
  const lp = lockPath();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lp, "wx"); // exclusive create
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return lp;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Stale-lock reclaim.
      try {
        const st = fs.statSync(lp);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(lp, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished; retry
      }
      if (Date.now() > deadline) {
        throw new Error(`获取配置写锁超时(${lp})。可能有并发写入,或残留锁文件。`);
      }
      sleepSync(40);
    }
  }
}

function releaseLock(lp) {
  try {
    fs.rmSync(lp, { force: true });
  } catch {
    /* best effort */
  }
}

function sleepSync(ms) {
  // Busy-ish wait without third-party deps; ms here is tiny (40ms).
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Atomics-based sleep to avoid pure spin.
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, end - Date.now()));
    } catch {
      /* fall through to loop check */
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

// Persists `config` atomically. Validates before writing. Holds the write lock
// for the whole read-merge-write cycle when `mutate` is provided.
export function saveConfig(config) {
  const errors = validateConfig(config);
  if (errors.length) {
    throw new Error("配置校验失败:\n  - " + errors.join("\n  - "));
  }
  ensureHome();
  const lp = acquireLock();
  try {
    // SPEC §3:若磁盘上已有 config 且被手改坏(无法解析),拒绝覆盖、报错保留原文件。
    const cp = configPath();
    if (fs.existsSync(cp)) {
      const raw = fs.readFileSync(cp, "utf8");
      if (raw.trim()) {
        try {
          JSON.parse(raw);
        } catch (e) {
          throw new Error(
            `现有 ~/.momo/config.json 解析失败(疑似被手改坏):${e.message}。` +
              `为避免覆盖已拒绝写入,请先修复或删除该文件后重试。`
          );
        }
      }
    }
    atomicWrite(cp, JSON.stringify(config, null, 2) + "\n");
  } finally {
    releaseLock(lp);
  }
  return config;
}

// Deep-merge a partial patch into a base config object (plain objects merged
// recursively; arrays and scalars replaced wholesale). Used so /momo:config can
// send only the fields being edited without wiping untouched providers/models.
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// /momo:config persistence: merge a partial patch into the existing config,
// then validate + atomically write (refuses if the on-disk file is unparseable).
export function patchConfig(patch) {
  if (!isPlainObject(patch)) {
    throw new Error("config patch 必须是对象");
  }
  return updateConfig((current) => deepMerge(current, patch));
}

// Read-modify-write under a single lock. `mutator(cfg)` mutates and/or returns
// the new config object. Refuses to proceed if the on-disk file is unparseable.
export function updateConfig(mutator) {
  ensureHome();
  const lp = acquireLock();
  try {
    const current = loadConfig(); // throws on parse error → no overwrite
    const next = mutator(current) || current;
    const errors = validateConfig(next);
    if (errors.length) {
      throw new Error("配置校验失败:\n  - " + errors.join("\n  - "));
    }
    atomicWrite(configPath(), JSON.stringify(next, null, 2) + "\n");
    return next;
  } finally {
    releaseLock(lp);
  }
}

function atomicWrite(target, content) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target); // atomic on same filesystem
}

// ---------------------------------------------------------------------------
// Structural validation (SPEC §3, §6.1)
// ---------------------------------------------------------------------------

const KNOWN_CLIENTS = new Set(Object.keys(CLIENTS));
// protocol → set of clients that speak it
const PROTOCOL_CLIENTS = (() => {
  const m = {};
  for (const [cname, adapter] of Object.entries(CLIENTS)) {
    if (!m[adapter.protocol]) m[adapter.protocol] = new Set();
    m[adapter.protocol].add(cname);
  }
  return m;
})();

// Returns array of human-readable error strings ([] === valid).
export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["配置顶层必须是对象。"];
  }
  const providers = config.providers;
  const models = config.models;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    errors.push("providers 必须是对象。");
  }
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    errors.push("models 必须是对象。");
  }
  if (errors.length) return errors;

  // ---- providers ----
  for (const [pname, prov] of Object.entries(providers)) {
    const tag = `provider "${pname}"`;
    if (!prov || typeof prov !== "object") {
      errors.push(`${tag} 必须是对象。`);
      continue;
    }
    if (!Array.isArray(prov.protocols) || prov.protocols.length === 0) {
      errors.push(`${tag} 必须有非空 protocols 数组。`);
    } else {
      for (const proto of prov.protocols) {
        if (!PROTOCOL_CLIENTS[proto]) {
          errors.push(
            `${tag} 声明了未知协议 "${proto}"。已知协议:${Object.keys(PROTOCOL_CLIENTS).join(", ")}。`
          );
        }
      }
    }
    if (!prov.base_url || typeof prov.base_url !== "object" || Array.isArray(prov.base_url)) {
      errors.push(`${tag} 必须有 base_url 对象(按协议映射)。`);
    } else if (Array.isArray(prov.protocols)) {
      for (const proto of prov.protocols) {
        const u = prov.base_url[proto];
        if (!u || typeof u !== "string") {
          errors.push(`${tag} 协议 "${proto}" 缺少对应 base_url。`);
        }
      }
    }
    if (typeof prov.api_key !== "string" || prov.api_key.trim() === "") {
      errors.push(`${tag} 缺少 api_key。`);
    }
  }

  // ---- models ----
  for (const [mname, model] of Object.entries(models)) {
    const tag = `model "${mname}"`;
    if (!model || typeof model !== "object") {
      errors.push(`${tag} 必须是对象。`);
      continue;
    }
    const prov = providers[model.provider];
    if (!model.provider || typeof model.provider !== "string") {
      errors.push(`${tag} 缺少 provider。`);
    } else if (!prov) {
      errors.push(`${tag} 引用了不存在的 provider "${model.provider}"。`);
    }
    if (typeof model.model_id !== "string" || model.model_id.trim() === "") {
      errors.push(`${tag} 缺少 model_id。`);
    }
    if (!Array.isArray(model.clients) || model.clients.length === 0) {
      errors.push(`${tag} 必须有非空 clients 数组(有序,第一个=默认)。`);
    } else {
      for (const c of model.clients) {
        if (!KNOWN_CLIENTS.has(c)) {
          errors.push(
            `${tag} 声明了未知 client "${c}"。已知 client:${[...KNOWN_CLIENTS].join(", ")}。`
          );
          continue;
        }
        // protocol compatibility: client.protocol ∈ provider.protocols
        if (prov && Array.isArray(prov.protocols)) {
          const clientProto = CLIENTS[c].protocol;
          if (!prov.protocols.includes(clientProto)) {
            errors.push(
              `${tag} 的 client "${c}" 说 ${clientProto} 协议,但其 provider "${model.provider}" 只暴露 [${prov.protocols.join(", ")}]。`
            );
          }
        }
      }
    }
    if (!Array.isArray(model.effort) || model.effort.length === 0) {
      errors.push(`${tag} 必须有非空 effort 数组。`);
    } else if (Array.isArray(model.clients) && model.clients.length) {
      // At least one effort entry must be legal for at least one known client.
      const validClients = model.clients.filter((c) => KNOWN_CLIENTS.has(c));
      const anyLegal = model.effort.some((e) =>
        validClients.some((c) => CLIENTS[c].allowedEffort.has(e))
      );
      if (validClients.length && !anyLegal) {
        errors.push(
          `${tag} 的 effort 列表 [${model.effort.join(", ")}] 没有任何一项对其 clients 合法。`
        );
      }
    }
  }

  return errors;
}
