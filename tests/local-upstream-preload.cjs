const http = require("node:http");
const https = require("node:https");

const originalRequest = https.request;
const originalGet = https.get;

// Local-only timer seam: production enforces a minimum 300s stream duration.
// Shorten ONLY the timer installed by server.mjs for max stream duration in
// explicitly opted-in fake-upstream tests, never arbitrary 300s timers.
if (process.env.GATEWAY_TEST_MAX_STREAM_TIMER_MS) {
  const originalSetTimeout = global.setTimeout;
  const shortened = Number(process.env.GATEWAY_TEST_MAX_STREAM_TIMER_MS);
  if (Number.isSafeInteger(shortened) && shortened > 0) {
    global.setTimeout = (callback, ms, ...args) => {
      const isStreamDuration = ms === 300_000 && new Error().stack?.includes('server.mjs');
      return originalSetTimeout(callback, isStreamDuration ? shortened : ms, ...args);
    };
  }
}

// Node's http/https accept THREE call shapes, and the seam has to survive all of
// them: get(url, cb), get(url, options, cb) and get(options, cb). The earlier
// seam assumed (options, cb) only. MEASURED against the pre-fix seam, per shape:
//   get(options, cb)      worked;
//   get(url, cb)          did NOT throw, but the URL string was spread into an
//                         options object, so it produced {"0":"h","1":"t",...} and
//                         `path` was lost — the redirect silently requested "/"
//                         instead of the real endpoint;
//   get(url, options, cb) THREW `TypeError: The "listener" argument must be of
//                         type function. Received an instance of Object`, because
//                         `callback` was bound to the OPTIONS object.
// So only the 3-argument form threw; the 2-argument form failed silently, which
// is why both are handled explicitly below rather than inferred from a throw.
function normalizeOptions(urlOrOptions, extraOptions) {
  let base;
  if (typeof urlOrOptions === "string" || urlOrOptions instanceof URL) {
    const parsed = new URL(urlOrOptions);
    base = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      auth: parsed.username ? `${parsed.username}:${parsed.password}` : undefined
    };
  } else {
    base = urlOrOptions ?? {};
  }
  return extraOptions ? { ...base, ...extraOptions } : { ...base };
}

function splitArguments(args) {
  const [first, second, third] = args;
  if (typeof second === "function") return { options: normalizeOptions(first), callback: second };
  if (typeof third === "function") return { options: normalizeOptions(first, second), callback: third };
  return { options: normalizeOptions(first, second), callback: undefined };
}

function redirectTarget(options) {
  const localPort = process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT;
  if (!localPort) return null;
  return {
    ...options,
    hostname: "127.0.0.1",
    port: Number(localPort),
    protocol: "http:"
  };
}

https.request = function requestLocalUpstream(...args) {
  const { options, callback } = splitArguments(args);
  const target = redirectTarget(options);
  if (!target) return originalRequest.apply(this, args);

  return http.request(target, (response) => {
    if (process.env.GATEWAY_TEST_UPSTREAM_BODY_BARRIER === '1' && options.path === '/v1/chat/completions') {
      response.once('data', () => {
        process.send?.({ type: 'test:upstream-first-body', authorization: options.headers?.authorization });
      });
    }
    callback?.(response);
  });
};

// Also redirect https.get so consumers that use it (model-discovery.mjs
// fetchAvailableModels, which backs getCachedModels and /v1/models/cached +
// /admin/models) reach the local fake upstream in tests. https.get internally
// calls the module-local `request` binding via closure — it does NOT pick up the
// `https.request` property patch above — so a dedicated `https.get` patch is
// required for preload parity. Identical redirect logic to `request` above.
https.get = function getLocalUpstream(...args) {
  const { options, callback } = splitArguments(args);
  const target = redirectTarget(options);
  if (!target) return originalGet.apply(this, args);
  return callback ? http.get(target, callback) : http.get(target);
};
