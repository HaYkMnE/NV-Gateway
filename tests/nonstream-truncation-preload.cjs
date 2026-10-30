// Test-only preload for tests/nonstream-truncation.test.mjs. Never loaded by
// production code. Keeps the local-upstream redirect for everything, and for
// POST /v1/chat/completions (only when GATEWAY_TEST_NST_MODE is set) hands the
// real gateway path a fake upstream response that commits 200 + a partial
// body and then fires EXACTLY ONE terminal event, so each body handler in
// server.mjs is pinned on its own:
//   close-only -> Readable.destroy() without an error: 'close', no 'error'/'end', complete=false
//   error-only -> a bare 'error' emit: no 'close', no 'end'
require("./local-upstream-preload.cjs");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const mode = process.env.GATEWAY_TEST_NST_MODE;
const partial = process.env.GATEWAY_TEST_NST_PARTIAL || "";
const localRequest = https.request;

https.request = function nstRequest(options, callback) {
  if (!mode || options?.path !== "/v1/chat/completions") return localRequest.call(this, options, callback);
  const req = new EventEmitter();
  req.socket = null;
  req.write = () => true;
  req.setTimeout = () => req;
  req.destroy = () => { req.destroyed = true; return req; };
  req.end = () => {
    setImmediate(() => {
      const res = new Readable({ read() {} });
      res.statusCode = 200;
      res.headers = { "content-type": "application/json", "transfer-encoding": "chunked" };
      res.complete = false;
      callback?.(res);
      setTimeout(() => {
        res.push(partial);
        setTimeout(() => {
          if (mode === "close-only") res.destroy();
          else res.emit("error", new Error("fake upstream body error"));
        }, 80);
      }, 30);
    });
    return req;
  };
  return req;
};
