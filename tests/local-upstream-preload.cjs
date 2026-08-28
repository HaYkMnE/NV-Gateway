const http = require("node:http");
const https = require("node:https");

const originalRequest = https.request;

https.request = function requestLocalUpstream(options, callback) {
  if (process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT) {
    return http.request({
      ...options,
      hostname: "127.0.0.1",
      port: Number(process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT),
      protocol: "http:"
    }, callback);
  }

  return originalRequest.call(this, options, callback);
};

// Also redirect https.get so consumers that use it (model-discovery.mjs
// fetchAvailableModels, which backs getCachedModels and /v1/models/cached +
// /admin/models) reach the local fake upstream in tests. https.get internally
// calls the module-local `request` binding via closure — it does NOT pick up the
// `https.request` property patch above — so a dedicated `https.get` patch is
// required for preload parity. Identical redirect logic to `request` above.
const originalGet = https.get;

https.get = function getLocalUpstream(options, callback) {
  if (process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT) {
    return http.get({
      ...options,
      hostname: "127.0.0.1",
      port: Number(process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT),
      protocol: "http:"
    }, callback);
  }

  return originalGet.call(this, options, callback);
};
