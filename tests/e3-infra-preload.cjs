// Test-only preload for tests/e3-infra.test.mjs: routes each upstream request
// by the fake key in its Authorization header, so one key can hit a
// connect-time failure (DNS / refused) while another reaches the local fake
// upstream. Never loaded by production code. No route performs a real DNS lookup.
//
// GATEWAY_TEST_E3_ROUTES = JSON { "<fake key>": route }, route one of:
//   { "port": 12345 }                           -> 127.0.0.1:<port> (closed => ECONNREFUSED)
//   { "lookupError": { "delayMs", "code", "causeCode", "message" } }
//                                               -> net's own lookup error path, synthetic errno
// Keys without a route go to GATEWAY_TEST_LOCAL_UPSTREAM_PORT (like local-upstream-preload.cjs).
const http = require("node:http");
const https = require("node:https");

const originalRequest = https.request;
const originalGet = https.get;

function routes() {
  try { return JSON.parse(process.env.GATEWAY_TEST_E3_ROUTES || "{}"); } catch { return {}; }
}

function routedOptions(options) {
  const auth = String(options?.headers?.authorization ?? options?.headers?.Authorization ?? "");
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const route = routes()[key];
  const base = { ...options, protocol: "http:", hostname: "127.0.0.1", port: Number(process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT) };
  if (!route) return base;
  if (Number.isInteger(route.port)) return { ...base, port: route.port };
  if (route.lookupError) {
    const spec = route.lookupError;
    return {
      ...base,
      hostname: "nvgw-e3-lookup.invalid",
      lookup: (_host, _opts, callback) => setTimeout(() => {
        const err = new Error(spec.message || "synthetic lookup failure", spec.causeCode ? { cause: { code: spec.causeCode } } : undefined);
        if (spec.code) err.code = spec.code;
        callback(err);
      }, spec.delayMs || 0)
    };
  }
  return base;
}

// Test-only seam: MODELS_UPSTREAM_TIMEOUT_MS is a fixed 300 s constant (not
// env-configurable). When GATEWAY_TEST_E3_MODELS_TIMEOUT_MS is set, shorten ONLY a
// ClientRequest.setTimeout(300_000) call (server.mjs uses it solely for the models
// fetch; chat timeouts are socket.setTimeout with the env-configured values).
if (process.env.GATEWAY_TEST_E3_MODELS_TIMEOUT_MS) {
  const shortened = Number(process.env.GATEWAY_TEST_E3_MODELS_TIMEOUT_MS);
  const originalSetTimeout = http.ClientRequest.prototype.setTimeout;
  http.ClientRequest.prototype.setTimeout = function setTimeoutSeam(ms, callback) {
    return originalSetTimeout.call(this, ms === 300_000 && Number.isSafeInteger(shortened) && shortened > 0 ? shortened : ms, callback);
  };
}

https.request = function requestRoutedUpstream(options, callback) {
  if (process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT) return http.request(routedOptions(options), callback);
  return originalRequest.call(this, options, callback);
};

https.get = function getRoutedUpstream(options, callback) {
  if (process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT) return http.get(routedOptions(options), callback);
  return originalGet.call(this, options, callback);
};
