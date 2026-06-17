// native.mjs — built-in "native" models: delegate to a CLI client using whatever
// auth that client already has on this machine (a subscription OAuth login, or a
// globally-configured custom provider via env). momo injects NO auth — pure
// pass-through. These are a worker capability, not user config: they need no
// provider/api_key/base_url and are not stored in ~/.momo/config.json.
//
// A native model:
//   - has no provider / base_url / api_key (auth is inherited from the client)
//   - has no pinned model_id by default (the client picks its own default model);
//     --effort still forwards when given, but no default effort is forced.

import { getClient } from "./clients/index.mjs";

// id -> { native:true, clients:[clientName], effort:[...] }. effort lists the client's
// full vocab so --effort validates; resolve never forces a default for native models.
export const NATIVE_MODELS = Object.freeze({
  claude: nativeFor("claude"),
  codex: nativeFor("codex"),
});

function nativeFor(clientName) {
  const adapter = getClient(clientName);
  const effort = adapter ? [...adapter.allowedEffort] : [];
  return Object.freeze({ native: true, clients: [clientName], effort });
}

export function isNativeModelName(name) {
  return Object.prototype.hasOwnProperty.call(NATIVE_MODELS, name);
}

export function getNativeModel(name) {
  return isNativeModelName(name) ? NATIVE_MODELS[name] : null;
}

export function nativeModelNames() {
  return Object.keys(NATIVE_MODELS);
}
