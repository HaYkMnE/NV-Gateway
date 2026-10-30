import test from "node:test";
import assert from "node:assert/strict";
import { createDirectGlmProbeScheduler, DIRECT_GLM_PROBE_MAX_SUCCESS_BYTES, DIRECT_GLM_PROBE_TIMEOUT_MS, normalizeMaxSuccessBytes, runDirectGlmProbe, shouldScheduleDirectGlmProbe } from "../src/gateway/direct-glm-probe.mjs";

const KEY = "fake-key-never-log-this";
const KEY_ID = "fake-key-id-never-log-this";
const SENTINEL = "request-body-never-log-this";

function keyRecord(overrides = {}) {
    return {
        id: KEY_ID,
        key: KEY,
        status: "active",
        backoffUntil: 0,
        usage: { success: 2, fail: 3, tokens: 7, lastUsed: 11 },
        ...overrides
    };
}

function jsonResponse(status, value) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" }
    });
}

function fetchSequence(responses) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
    };
    return { calls, fetchImpl };
}

function assertSafe(value, forbidden = [KEY, KEY_ID, "Authorization", SENTINEL]) {
    const serialized = JSON.stringify(value);
    for (const item of forbidden) assert.equal(serialized.includes(item), false, `leaked ${item}`);
}

test("core probe behavior is available", async () => {
    const result = await runDirectGlmProbe({ envValue: undefined, keyRecords: [] });
    assert.equal(result, undefined);
});

test("default probe deadline is the bounded 300000ms maximum", () => {
    assert.equal(DIRECT_GLM_PROBE_TIMEOUT_MS, 300000);
});

test("success response cap defaults to 512 KiB and invalid injected values cannot disable it", () => {
    assert.equal(DIRECT_GLM_PROBE_MAX_SUCCESS_BYTES, 512 * 1024);
    for (const value of [Infinity, NaN, -1, 0, "1024", DIRECT_GLM_PROBE_MAX_SUCCESS_BYTES + 1]) {
        assert.equal(normalizeMaxSuccessBytes(value), DIRECT_GLM_PROBE_MAX_SUCCESS_BYTES);
    }
    assert.equal(normalizeMaxSuccessBytes(10), 10);
});

test("disabled env values do zero fetches, logs, or mutation", async () => {
    for (const value of [undefined, "0", "true", " 1 "]) {
        const records = [keyRecord()];
        const before = structuredClone(records);
        let fetches = 0;
        let logs = 0;
        const result = await runDirectGlmProbe({
            envValue: value,
            keyRecords: records,
            fetchImpl: async () => { fetches++; throw new Error("real network forbidden"); },
            logger: () => { logs++; }
        });
        assert.equal(result, undefined);
        assert.equal(fetches, 0);
        assert.equal(logs, 0);
        assert.deepEqual(records, before);
    }
});

test("enabled tests never fall through to real network", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
        called = true;
        throw new Error("unexpected real network");
    };
    try {
        const result = await runDirectGlmProbe({ envValue: "1", keyRecords: [keyRecord()] });
        assert.equal(result.result, "indeterminate");
        assert.equal(called, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("no eligible key returns safe result and zero fetches", async () => {
    let fetches = 0;
    const result = await runDirectGlmProbe({
        envValue: "1",
        keyRecords: [keyRecord({ status: "disabled" })],
        fetchImpl: async () => { fetches++; throw new Error("network forbidden"); }
    });
    assert.equal(result.result, "no_eligible_key");
    assert.equal(fetches, 0);
    assertSafe(result);
});

test("successful catalog, sanity, and long request use one key and emit numeric usage only", async () => {
    const records = [keyRecord()];
    const before = structuredClone(records);
    const { calls, fetchImpl } = fetchSequence([
        jsonResponse(200, { data: [{ id: "z-ai/glm-5.2" }, { id: "other" }] }),
        jsonResponse(200, { choices: [{ message: { content: "provider text" } }], usage: { prompt_tokens: 4, completion_tokens: 1 } }),
        jsonResponse(200, { choices: [{ message: { content: "provider text" } }], usage: { prompt_tokens: 230005, completion_tokens: 1 } })
    ]);
    const logs = [];
    const result = await runDirectGlmProbe({ envValue: "1", keyRecords: records, fetchImpl, logger: entry => logs.push(entry) });
    assert.equal(calls.length, 3);
    assert.equal(result.result, "success");
    assert.equal(result.model_listed, true);
    assert.equal(result.prompt_tokens, 230005);
    assert.equal(result.completion_tokens, 1);
    assert.deepEqual(records, before);
    assert.equal(logs.length, 1);
    assertSafe(result);
    assertSafe(logs);
    assert.equal(JSON.stringify(result).includes("provider text"), false);
    assert.equal(JSON.stringify(logs).includes("provider text"), false);
    assert.deepEqual(Object.keys(result).sort(), ["completion_tokens", "duration_ms", "host", "model", "model_listed", "path", "prompt_tokens", "result", "status", "step"].sort());
});

test("fixed URL/model and local authorization are used without logging request data", async () => {
    const { calls, fetchImpl } = fetchSequence([
        jsonResponse(200, { data: [{ id: "z-ai/glm-5.2" }] }),
        jsonResponse(200, { usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        jsonResponse(200, { usage: { prompt_tokens: 2, completion_tokens: 1 } })
    ]);
    const logs = [];
    await runDirectGlmProbe({ envValue: "1", keyRecords: [keyRecord()], fetchImpl, logger: entry => logs.push(entry) });
    assert.equal(calls[0].url, "https://integrate.api.nvidia.com/v1/models");
    assert.equal(calls[1].url, "https://integrate.api.nvidia.com/v1/chat/completions");
    assert.equal(calls[2].url, calls[1].url);
    assert.equal(calls[1].options.body.includes('"model":"z-ai/glm-5.2"'), true);
    assert.equal(calls[1].options.headers.authorization, `Bearer ${KEY}`);
    assert.equal(calls[2].options.body.match(/ the/g).length, 230000);
    assertSafe(logs);
});

test("catalog, sanity, and long errors stop at the correct step without fallback", async () => {
    for (const scenario of [
        { responses: [jsonResponse(401, { secret: SENTINEL })], expected: 1 },
        { responses: [jsonResponse(200, { data: [{ id: "z-ai/glm-5.2" }] }), jsonResponse(429, { secret: SENTINEL })], expected: 2 },
        { responses: [jsonResponse(200, { data: [{ id: "z-ai/glm-5.2" }] }), jsonResponse(200, {}), jsonResponse(503, { secret: SENTINEL })], expected: 3 }
    ]) {
        const { calls, fetchImpl } = fetchSequence(scenario.responses);
        const result = await runDirectGlmProbe({ envValue: "1", keyRecords: [keyRecord(), keyRecord({ id: "second" })], fetchImpl });
        assert.equal(calls.length, scenario.expected);
        assert.equal(result.result, "indeterminate");
        assertSafe(result);
    }
});

test("non-2xx responses are classified from status and canceled without reading body", async () => {
    let canceled = 0;
    const response = {
        status: 401,
        body: {
            cancel: () => { canceled++; return Promise.resolve(); },
            getReader: () => { throw new Error("body must not be read"); }
        },
        text: () => { throw new Error("text must not be called"); },
        json: () => { throw new Error("json must not be called"); }
    };
    const result = await runDirectGlmProbe({ envValue: "1", keyRecords: [keyRecord()], fetchImpl: async () => response });
    assert.equal(canceled, 1);
    assert.equal(result.result, "indeterminate");
    assertSafe(result);
});

test("key selection is isolated from later source mutations", async () => {
    const records = [keyRecord()];
    const before = structuredClone(records);
    const { fetchImpl } = fetchSequence([
        jsonResponse(200, { data: [{ id: "z-ai/glm-5.2" }] }),
        jsonResponse(200, { usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        jsonResponse(200, { usage: { prompt_tokens: 2, completion_tokens: 1 } })
    ]);
    let first = true;
    const authorizationSeenOnlyInsideFake = [];
    const mutatingFetch = async (...args) => {
        authorizationSeenOnlyInsideFake.push(args[1].headers.authorization);
        if (first) {
            first = false;
            records[0].key = "mutated-key";
            records[0].id = "mutated-id";
            records[0].status = "disabled";
            records[0].backoffUntil = Date.now() + 100000;
            records[0].usage.lastUsed = 999;
        }
        return fetchImpl(...args);
    };
    const result = await runDirectGlmProbe({ envValue: "1", keyRecords: records, fetchImpl: mutatingFetch });
    assert.equal(result.result, "success");
    assert.deepEqual(authorizationSeenOnlyInsideFake, [`Bearer ${KEY}`, `Bearer ${KEY}`, `Bearer ${KEY}`]);
    assertSafe(result);
    assert.notEqual(records[0].key, before[0].key);
});

test("success response size and malformed payload are sanitized failures", async () => {
    const oversized = new Response("x".repeat(100), { status: 200 });
    const { fetchImpl } = fetchSequence([oversized]);
    const result = await runDirectGlmProbe({ envValue: "1", keyRecords: [keyRecord()], fetchImpl, maxSuccessBytes: 10 });
    assert.equal(result.result, "indeterminate");
    assertSafe(result);
});

function fakeReadableResponse(chunks, { failRead = false } = {}) {
    let index = 0;
    let locked = false;
    let cancellationCount = 0;
    let canceledWhileLocked = false;
    const reader = {
        async read() {
            if (failRead && index === chunks.length) throw new Error("synthetic stream failure");
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
        },
        async cancel() {
            cancellationCount++;
            canceledWhileLocked ||= locked;
            if (!locked) throw new Error("reader was released before cancel");
        },
        releaseLock() {
            if (!locked) throw new Error("reader already released");
            locked = false;
        }
    };
    return {
        status: 200,
        body: {
            getReader() {
                locked = true;
                return reader;
            }
        },
        get cancellationCount() { return cancellationCount; },
        get canceledWhileLocked() { return canceledWhileLocked; }
    };
}

test("bounded success cleanup cancels oversized, malformed, and incomplete streams exactly once while locked", async () => {
    const encoder = new TextEncoder();
    const cases = [
        fakeReadableResponse([encoder.encode("1234567890")]),
        fakeReadableResponse([encoder.encode("nope")]),
        fakeReadableResponse([encoder.encode("{")], { failRead: true })
    ];
    for (const response of cases) {
        const result = await runDirectGlmProbe({
            envValue: "1",
            keyRecords: [keyRecord()],
            fetchImpl: async () => response,
            maxSuccessBytes: 4
        });
        assert.equal(result.result, "indeterminate");
        assert.equal(response.cancellationCount, 1);
        assert.equal(response.canceledWhileLocked, true);
        assertSafe(result);
    }
});

test("hung reader cancellation is cleanup-bounded, unlocks, and does not block later probe scheduling", async () => {
    let locked = false;
    let cancellationCount = 0;
    let released = false;
    let cleanupAbortedTransport = false;
    const never = new Promise(() => {});
    const response = {
        status: 200,
        body: {
            getReader() {
                locked = true;
                return {
                    async read() { return { done: false, value: new Uint8Array(8) }; },
                    cancel() { cancellationCount++; return never; },
                    releaseLock() { assert.equal(locked, true); locked = false; released = true; }
                };
            }
        }
    };
    const logs = [];
    const probe = runDirectGlmProbe({
        envValue: "1",
        keyRecords: [keyRecord()],
        fetchImpl: async (_url, { signal }) => {
            signal.addEventListener("abort", () => { cleanupAbortedTransport = true; }, { once: true });
            return response;
        },
        logger: entry => logs.push(entry),
        maxSuccessBytes: 1,
        cleanupTimeoutMs: 5
    });
    const result = await Promise.race([
        probe,
        new Promise((_, reject) => setTimeout(() => reject(new Error("probe did not settle")), 50))
    ]);
    assert.equal(result.result, "indeterminate");
    assert.equal(cancellationCount, 1);
    assert.equal(released, true);
    assert.equal(locked, false);
    assert.equal(cleanupAbortedTransport, true);
    assertSafe(result);
    assertSafe(logs);
    const nextScheduler = createDirectGlmProbeScheduler({ probe: async () => { logs.push({ step: "next" }); } });
    nextScheduler.schedule(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.at(-1).step, "next");
});

test("rejecting reader cancellation aborts transport, unlocks, and stays sanitized", async () => {
    let locked = false;
    let released = false;
    let aborts = 0;
    const logs = [];
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.once("unhandledRejection", onUnhandled);
    try {
        const result = await runDirectGlmProbe({
            envValue: "1",
            keyRecords: [keyRecord()],
            maxSuccessBytes: 1,
            logger: entry => logs.push(entry),
            fetchImpl: async (_url, { signal }) => {
                signal.addEventListener("abort", () => { aborts++; }, { once: true });
                return {
                    status: 200,
                    body: {
                        getReader() {
                            locked = true;
                            return {
                                async read() { return { done: false, value: new Uint8Array(8) }; },
                                cancel() { return Promise.reject(new Error("cancel-sentinel-request-body")); },
                                releaseLock() { assert.equal(locked, true); locked = false; released = true; }
                            };
                        }
                    }
                };
            }
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(result.result, "indeterminate");
        assert.equal(aborts, 1);
        assert.equal(released, true);
        assert.equal(locked, false);
        assert.deepEqual(unhandled, []);
        assertSafe(result, [KEY, KEY_ID, "Authorization", SENTINEL, "cancel-sentinel-request-body"]);
        assertSafe(logs, [KEY, KEY_ID, "Authorization", SENTINEL, "cancel-sentinel-request-body"]);
        let nextRuns = 0;
        const scheduler = createDirectGlmProbeScheduler({ probe: async () => { nextRuns++; } });
        scheduler.schedule(true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(nextRuns, 1);
    } finally {
        process.removeListener("unhandledRejection", onUnhandled);
    }
});

test("invalid success-cap injections stop an oversized stream at the fixed application cap", async () => {
    for (const value of [Infinity, NaN, -1, 0, "1024", DIRECT_GLM_PROBE_MAX_SUCCESS_BYTES + 1]) {
        let reads = 0;
        let canceled = 0;
        let locked = false;
        const response = {
            status: 200,
            body: {
                getReader() {
                    locked = true;
                    return {
                        async read() {
                            reads++;
                            if (reads === 1) return { done: false, value: new Uint8Array(DIRECT_GLM_PROBE_MAX_SUCCESS_BYTES + 1) };
                            throw new Error("read continued past configured cap");
                        },
                        async cancel() { canceled++; assert.equal(locked, true); },
                        releaseLock() { locked = false; }
                    };
                }
            }
        };
        const result = await runDirectGlmProbe({ envValue: "1", keyRecords: [keyRecord()], fetchImpl: async () => response, maxSuccessBytes: value });
        assert.equal(result.result, "indeterminate");
        assert.equal(reads, 1);
        assert.equal(canceled, 1);
        assertSafe(result);
    }
});

test("timeout aborts the actual fetch and does not reject the probe", async () => {
    let timer;
    let aborted = false;
    const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    });
    const resultPromise = runDirectGlmProbe({ envValue: "1", keyRecords: [keyRecord()], fetchImpl, timeoutMs: 10, setTimeoutImpl: callback => { timer = callback; return 1; }, clearTimeoutImpl: () => {} });
    timer();
    const result = await resultPromise;
    assert.equal(aborted, true);
    assert.equal(result.result, "indeterminate");
    assertSafe(result);
});

test("scheduler is fire-and-forget, single-flight, and starts only after successful authenticated init", async () => {
    let runs = 0;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const scheduler = createDirectGlmProbeScheduler({ probe: async () => { runs++; await pending; } });
    scheduler.schedule(false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 0);
    assert.equal(scheduler.schedule(true), undefined);
    scheduler.schedule();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 1);
    release();
    await new Promise(resolve => setImmediate(resolve));
});

test("state:init decision seam requires valid challenge, credentials, and exact opt-in", async () => {
    const base = {
        type: "state:init",
        challenge: "expected-challenge",
        state: { credentials: { gatewayToken: "gateway", adminToken: "admin" } }
    };
    let runs = 0;
    const logs = [];
    const scheduler = createDirectGlmProbeScheduler({ probe: async () => { runs++; }, logger: value => logs.push(value) });
    for (const message of [
        { ...base, challenge: "wrong-challenge" },
        { ...base, state: { credentials: { gatewayToken: "gateway" } } },
        base
    ]) {
        const envValue = message === base ? "1" : "1";
        if (shouldScheduleDirectGlmProbe({ message, expectedChallenge: "expected-challenge", envValue })) scheduler.schedule(true);
    }
    assert.equal(runs, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 1);
    assert.deepEqual(logs, []);
    assert.equal(shouldScheduleDirectGlmProbe({ message: base, expectedChallenge: "expected-challenge", envValue: "0" }), false);
    assert.equal(shouldScheduleDirectGlmProbe({ message: base, expectedChallenge: "expected-challenge", envValue: "true" }), false);
    assert.equal(shouldScheduleDirectGlmProbe({ message: base, expectedChallenge: "expected-challenge", envValue: " 1 " }), false);
});
