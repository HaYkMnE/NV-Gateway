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
