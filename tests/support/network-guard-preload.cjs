'use strict';
// Test-only network guard. Blocks (fail-fast) every TCP/TLS connect whose target
// is not loopback, and records each blocked attempt so the test file can fail
// loudly on a leak. Works in-process (`import './support/network-guard-preload.cjs'`
// as the FIRST import) and in spawned gateway children (`--require <this file>`).
//
// Every client path (http/https Agent, https.get, tls.connect, net.connect)
// funnels through net.Socket.prototype.connect, so that is the single choke point.
// A blocked socket is destroyed on the next tick with ECONNREFUSED, which callers
// already handle as "upstream unreachable" (the same offline-fallback path),
// but without any DNS lookup or wait for a real timeout.
//
// When NVGW_TEST_NET_GUARD_LOG is set, each blocked attempt is appended to that
// file as one JSON line ({ pid, host, port }) so a parent test can count
// violations that happened inside children.

const net = require('node:net');
const fs = require('node:fs');

const state = globalThis.__nvgwNetGuard__ || (globalThis.__nvgwNetGuard__ = {
  installed: false,
  loopbackConnects: 0,
  blocked: [],
  dnsBlocked: []
});

function isLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return true; // net default is localhost
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  // Only a REAL dotted IPv4 literal (optionally v4-mapped) in 127/8 counts;
  // net.isIP rejects invalid octets such as 127.999.999.999.
  const v4 = h.startsWith('::ffff:') ? h.slice('::ffff:'.length) : h;
  return net.isIP(v4) === 4 && v4.startsWith('127.');
}

/** Extract { host, port, pipe } from any Socket#connect call shape. */
function describeTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // pre-normalized [options, cb]
  if (first && typeof first === 'object') {
    if (typeof first.path === 'string' && first.path) return { pipe: true };
    return { host: first.host ?? first.hostname, port: first.port };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { pipe: true };
  return { host: typeof args[1] === 'string' ? args[1] : undefined, port: first };
}

if (!state.installed) {
  state.installed = true;
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = describeTarget(args);
    if (target.pipe || isLoopbackHost(target.host)) {
      state.loopbackConnects += 1;
      return originalConnect.apply(this, args);
    }
    const record = { pid: process.pid, host: String(target.host), port: Number(target.port) || null };
    state.blocked.push(record);
    const logPath = process.env.NVGW_TEST_NET_GUARD_LOG;
    if (logPath) {
      try { fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`); } catch { /* best effort */ }
    }
    const error = Object.assign(
      new Error(`network guard: blocked non-loopback connect to ${record.host}:${record.port}`),
      { code: 'ECONNREFUSED' }
    );
    process.nextTick(() => this.destroy(error));
    return this;
  };
  installDnsGuard();
}

// ── DNS guard ──────────────────────────────────────────────────────────────
// Direct DNS calls (dns.lookup / dns.promises.lookup / lookupService, every
// resolve* and reverse on the module, on dns.promises, and on both Resolver
// prototypes) are allowed ONLY for loopback names/literals. Anything else is
// rejected with ENOTFOUND before any query leaves the process, recorded in
// `state.dnsBlocked` and appended to the same log as { kind: 'dns', ... }.
// Allowed names go to the original implementation untouched, so Node's own
// net.connect -> dns.lookup path for 'localhost' keeps working.

function isLoopbackName(name) {
  if (name === undefined || name === null || name === '') return true; // Node resolves to localhost
  return typeof name === 'string' && isLoopbackHost(name);
}

function recordDnsBlock(api, name) {
  const record = { kind: 'dns', pid: process.pid, api, host: String(name) };
  state.dnsBlocked.push(record);
  const logPath = process.env.NVGW_TEST_NET_GUARD_LOG;
  if (logPath) {
    try { fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`); } catch { /* best effort */ }
  }
  return Object.assign(new Error(`network guard: blocked DNS ${api} ${record.host}`), {
    code: 'ENOTFOUND', errno: undefined, syscall: api, hostname: record.host
  });
}

/** Wrap a callback-style DNS function: (name, [...opts], callback). */
function wrapCallbackDns(target, key, api) {
  const original = target[key];
  if (typeof original !== 'function' || original.__nvgwGuarded__) return;
  const guarded = function guardedDns(name, ...rest) {
    if (isLoopbackName(name)) return original.call(this, name, ...rest);
    const error = recordDnsBlock(api, name);
    const callback = rest.reverse().find((arg) => typeof arg === 'function');
    if (callback) process.nextTick(callback, error);
    else throw error;
    return undefined;
  };
  guarded.__nvgwGuarded__ = true;
  target[key] = guarded;
}

/** Wrap a promise-style DNS function: (name, ...opts) => Promise. */
function wrapPromiseDns(target, key, api) {
  const original = target[key];
  if (typeof original !== 'function' || original.__nvgwGuarded__) return;
  const guarded = function guardedDnsPromise(name, ...rest) {
    if (isLoopbackName(name)) return original.call(this, name, ...rest);
    return Promise.reject(recordDnsBlock(api, name));
  };
  guarded.__nvgwGuarded__ = true;
  target[key] = guarded;
}

function isResolverMethod(key) {
  return /^(resolve|reverse)/.test(key);
}

function installDnsGuard() {
  const dns = require('node:dns');
  state.dnsBlocked = state.dnsBlocked || [];
  wrapCallbackDns(dns, 'lookup', 'lookup');
  wrapCallbackDns(dns, 'lookupService', 'lookupService');
  for (const key of Object.keys(dns).filter(isResolverMethod)) wrapCallbackDns(dns, key, key);
  for (const key of Object.getOwnPropertyNames(dns.Resolver.prototype).filter(isResolverMethod)) {
    wrapCallbackDns(dns.Resolver.prototype, key, `Resolver.${key}`);
  }
  const dnsPromises = dns.promises;
  wrapPromiseDns(dnsPromises, 'lookup', 'promises.lookup');
  wrapPromiseDns(dnsPromises, 'lookupService', 'promises.lookupService');
  for (const key of Object.keys(dnsPromises).filter(isResolverMethod)) wrapPromiseDns(dnsPromises, key, `promises.${key}`);
  for (const key of Object.getOwnPropertyNames(dnsPromises.Resolver.prototype).filter(isResolverMethod)) {
    wrapPromiseDns(dnsPromises.Resolver.prototype, key, `promises.Resolver.${key}`);
  }
  // Propagate the patched functions to `import { lookup } from 'node:dns'` too.
  require('node:module').syncBuiltinESMExports();
}

module.exports = state;
