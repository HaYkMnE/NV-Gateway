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

test("in-flight requests are deduplicated so concurrent getCachedModels and refreshModels trigger only one upstream fetch", async () => {
    mockResponse = { statusCode: 200, data: { data: [{ id: "dedup-model" }] } };
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
