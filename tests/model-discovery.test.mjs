import assert from "node:assert/strict";
import test from "node:test";

import https from "node:https";

// Mock the https module before importing model-discovery
let mockResponse = { statusCode: 200, data: { data: [{ id: "model-1" }, { id: "model-2" }] } };
let mockError = null;
let getCallCount = 0;

const originalGet = https.get;
https.get = (options, callback) => {
    getCallCount++;
    if (mockError) {
        const req = { on: (event, cb) => { if (event === "error") cb(mockError); }, setTimeout: () => {}, destroy: () => {} };
        return req;
    }
    const res = {
        statusCode: mockResponse.statusCode,
        headers: {},
        on: (event, cb) => {
            if (event === "data") cb(JSON.stringify(mockResponse.data));
            if (event === "end") cb();
        }
    };
    callback(res);
    return { on: () => {}, setTimeout: () => {}, destroy: () => {} };
};

const {
    fetchAvailableModels,
    getCachedModels,
    refreshModels,
    resetCache,
    getCacheInfo,
    getFallbackModels
} = await import("../src/gateway/model-discovery.mjs");

test("fetchAvailableModels returns parsed models array", async () => {
    mockResponse = { statusCode: 200, data: { data: [{ id: "model-1" }, { id: "model-2" }] } };
    mockError = null;
    resetCache();

    const models = await fetchAvailableModels();
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "model-1");
    assert.equal(models[1].id, "model-2");
});

test("fetchAvailableModels filters disabled models from env", async () => {
    mockResponse = { statusCode: 200, data: { data: [{ id: "model-1" }, { id: "model-2" }, { id: "model-3" }] } };
    mockError = null;
    resetCache();

    process.env.GATEWAY_DISABLED_MODELS = "model-2";
    const models = await fetchAvailableModels();
    assert.equal(models.length, 2);
    assert.ok(models.find(m => m.id === "model-1"));
    assert.ok(models.find(m => m.id === "model-3"));
    assert.ok(!models.find(m => m.id === "model-2"));
    delete process.env.GATEWAY_DISABLED_MODELS;
});

test("fetchAvailableModels throws on non-2xx status", async () => {
    mockResponse = { statusCode: 500, data: {} };
    mockError = null;
    resetCache();

    await assert.rejects(
        () => fetchAvailableModels(),
        (err) => err.message.includes("500")
    );
});

test("getCachedModels returns cached data on second call", async () => {
    mockResponse = { statusCode: 200, data: { data: [{ id: "cached-model" }] } };
    mockError = null;
    resetCache();

    const first = await getCachedModels();
    assert.equal(first.length, 1);

    // Change mock response — should still get cached data
    mockResponse = { statusCode: 200, data: { data: [{ id: "different-model" }] } };
    const second = await getCachedModels();
    assert.equal(second.length, 1);
    assert.equal(second[0].id, "cached-model");
});

test("refreshModels forces fresh fetch", async () => {
    mockResponse = { statusCode: 200, data: { data: [{ id: "initial" }] } };
    mockError = null;
    resetCache();

    await getCachedModels();
    assert.equal(getCacheInfo().modelCount, 1);

    mockResponse = { statusCode: 200, data: { data: [{ id: "refreshed-1" }, { id: "refreshed-2" }] } };
    const result = await refreshModels();
    assert.equal(result.length, 2);
    assert.equal(getCacheInfo().modelCount, 2);
});

test("getCacheInfo returns correct state", async () => {
    resetCache();
    let info = getCacheInfo();
    assert.equal(info.hasCache, false);
    assert.equal(info.modelCount, null);

    mockResponse = { statusCode: 200, data: { data: [{ id: "m1" }, { id: "m2" }] } };
    await getCachedModels();

    info = getCacheInfo();
    assert.equal(info.hasCache, true);
    assert.equal(info.modelCount, 2);
    assert.ok(info.ageMs >= 0);
});

test("resetCache clears the cache", async () => {
    mockResponse = { statusCode: 200, data: { data: [{ id: "m1" }] } };
    await getCachedModels();
    assert.equal(getCacheInfo().hasCache, true);

    resetCache();
    assert.equal(getCacheInfo().hasCache, false);
});

test("getCachedModels returns fallback models when discovery fails on cold start", async () => {
    mockError = new Error("Network unreachable");
    resetCache();

    const models = await getCachedModels();
    assert.ok(Array.isArray(models), "must return array");
    assert.ok(models.length > 0, "fallback models must be non-empty");
    assert.ok(models.some((m) => m.id === "z-ai/glm-5.2"), "known model must be present");
    mockError = null;
});

test("getFallbackModels filters disabled models from env", async () => {
    process.env.GATEWAY_DISABLED_MODELS = "z-ai/glm-5.2";
    const models = getFallbackModels();
    assert.ok(!models.some((m) => m.id === "z-ai/glm-5.2"));
    delete process.env.GATEWAY_DISABLED_MODELS;
});

test("fetchAvailableModels rejects an oversized body instead of accumulating it unbounded (B3)", async () => {
    // B3: the model list fetch used to accumulate the whole response body into a
    // growing string (`data += chunk`). It must now use the shared bounded buffer.
    // Drive a body larger than the 4 MiB cap through the mocked https.get.
    resetCache();
    mockError = null;
    const oversized = "x".repeat(5 * 1024 * 1024);
    const originalMock = https.get;
    https.get = (_options, callback) => {
        const errorHandlers = [];
        const req = {
            on: (event, cb) => { if (event === "error") errorHandlers.push(cb); },
            setTimeout: () => {},
            destroy: (err) => { queueMicrotask(() => errorHandlers.forEach((cb) => cb(err))); }
        };
        const res = {
            statusCode: 200,
            headers: {},
            on: (event, cb) => {
                // Defer to a microtask so `req` is assigned before the data
                // handler runs — mirroring node:https, whose callback is async.
                if (event === "data") queueMicrotask(() => cb(oversized));
                if (event === "end") queueMicrotask(() => cb());
            }
        };
        queueMicrotask(() => callback(res));
        return req;
    };
    try {
        await assert.rejects(
            () => fetchAvailableModels(),
            /too large/,
            "an oversized models body must reject, not accumulate"
        );
    } finally {
        https.get = originalMock;
    }
});

test("F6: the cold-start timeout timer is CLEARED after a fast success (no live timer leak)", async () => {
    // getCachedModels/refreshModels race the fetch against a setTimeout. Before
    // the fix the handle was never cleared, so every FAST call left a live
    // 2.5s/3s timer behind — an unbounded timer leak for the lifetime of the
    // process. This pins the clearTimeout on the success path by counting the
    // timers still pending after settle.
    mockResponse = { statusCode: 200, data: { data: [{ id: "fast-model" }] } };
    mockError = null;
    resetCache();

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.clearTimeout = (handle) => { cleared += 1; return originalClearTimeout(handle); };
    try {
        await getCachedModels();
        const afterCached = cleared;
        assert.equal(afterCached >= 1, true,
            "getCachedModels must clearTimeout the cold-start timer on a fast success");

        resetCache();
        await refreshModels();
        assert.equal(cleared > afterCached, true,
            "refreshModels must clearTimeout the cold-start timer on a fast success");
    } finally {
        globalThis.clearTimeout = originalClearTimeout;
        globalThis.setTimeout = originalSetTimeout;
    }
});

test("F6: the cold-start timeout still rejects/fails over when the fetch never settles", async () => {
    // The clearTimeout must not defeat the timeout itself: an upstream that never
    // answers must still resolve to the fallback within the bound.
    resetCache();
    const originalMock = https.get;
    https.get = () => {
        const req = { on: () => {}, setTimeout: () => {}, destroy: () => {} };
        return req; // never calls the callback -> the fetch never settles
    };
    try {
        const models = await getCachedModels({ timeoutMs: 50 });
        assert.ok(Array.isArray(models), "a never-settling fetch must fall back, not hang");
        assert.ok(models.length > 0, "the fallback catalogue must be non-empty");
    } finally {
        https.get = originalMock;
    }
});

test("in-flight requests are deduplicated so concurrent getCachedModels and refreshModels trigger only one upstream fetch", async () => {    mockResponse = { statusCode: 200, data: { data: [{ id: "dedup-model" }] } };
    mockError = null;
    resetCache();
    const countBefore = getCallCount;

    const [first, second, third] = await Promise.all([
        getCachedModels(),
        getCachedModels(),
        refreshModels()
    ]);

    assert.equal(getCallCount - countBefore, 1, "only 1 network request made for concurrent calls");
    assert.deepEqual(first, second);
    assert.deepEqual(second, third);
    assert.equal(first[0].id, "dedup-model");
});

// --- CodeRabbit D2: response-stream errors and single-settle on overflow ---
import { EventEmitter } from "node:events";

function installEmitterMock(drive) {
    const originalMock = https.get;
    const destroyCalls = [];
    https.get = (_options, callback) => {
        const req = new EventEmitter();
        req.setTimeout = () => {};
        // Record only: a destroy that never re-emits proves the fetch settles on its own.
        req.destroy = (err) => { destroyCalls.push(err); };
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        queueMicrotask(() => { callback(res); queueMicrotask(() => drive(req, res)); });
        return req;
    };
    return { destroyCalls, restore: () => { https.get = originalMock; } };
}

function withinMs(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("HANG")), ms); })])
        .finally(() => clearTimeout(timer));
}

async function noUncaught(fn) {
    const seen = [];
    const onErr = (err) => seen.push(err);
    process.on("uncaughtException", onErr);
    try { await fn(); await new Promise((r) => setTimeout(r, 20)); } finally { process.off("uncaughtException", onErr); }
    assert.deepEqual(seen.map(String), [], "no uncaught error may escape the fetch");
}

test("D2(a): a response stream error rejects, without an unhandled error or a hang", async () => {
    const mock = installEmitterMock((_req, res) => { res.emit("data", "{\"data\":"); res.emit("error", new Error("socket reset")); });
    try {
        await noUncaught(() => assert.rejects(() => withinMs(fetchAvailableModels(), 1000), /socket reset/));
    } finally { mock.restore(); }
});

test("D2(b): an overflow rejects with the size-limit error once and destroys the request once", async () => {
    const big = "x".repeat(4 * 1024 * 1024 + 1);
    const mock = installEmitterMock((_req, res) => { res.emit("data", big); res.emit("data", big); });
    try {
        await noUncaught(() => assert.rejects(() => withinMs(fetchAvailableModels(), 1000), /NVIDIA models response too large/));
        assert.equal(mock.destroyCalls.length, 1, "overflow must be handled exactly once");
        assert.match(String(mock.destroyCalls[0]), /too large/);
    } finally { mock.restore(); }
});

test("D2(c): overflow followed by res error, res end and req error still settles exactly once", async () => {
    const big = "x".repeat(4 * 1024 * 1024 + 1);
    const mock = installEmitterMock((req, res) => {
        res.emit("data", big);
        res.emit("error", new Error("late res error"));
        res.emit("end");
        req.emit("error", new Error("late req error"));
    });
    try {
        await noUncaught(() => assert.rejects(() => withinMs(fetchAvailableModels(), 1000), /NVIDIA models response too large/));
        assert.equal(mock.destroyCalls.length, 1);
    } finally { mock.restore(); }
});

test("D2(d): a response that ends with only aborted+close rejects; close after a normal end stays a no-op", async () => {
    const cut = installEmitterMock((_req, res) => { res.emit("data", "{\"data\":["); res.emit("aborted"); res.emit("close"); });
    try {
        await noUncaught(() => assert.rejects(() => withinMs(fetchAvailableModels(), 1000), /closed before end/));
    } finally { cut.restore(); }
    const ok = installEmitterMock((_req, res) => { res.emit("data", JSON.stringify({ data: [{ id: "close-after-end" }] })); res.emit("end"); res.emit("close"); });
    try {
        const models = await withinMs(fetchAvailableModels(), 1000);
        assert.deepEqual(models.map((m) => m.id), ["close-after-end"], "a close after end must not override the result");
    } finally { ok.restore(); }
});
