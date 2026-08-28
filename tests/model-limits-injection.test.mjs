// @ts-check
/**
 * Tests for runtime-injected model limits (model-limits.mjs setModelLimits).
 *
 * Contract under test:
 *  - Injected entries win BEFORE any file/env resolution; file-based lookups
 *    still work for models that were NOT injected (merge-over, not replace).
 *  - Sanitization is strict: positive safe integers ONLY, bounded key length,
 *    record capped at 512 entries; malformed arguments are ignored entirely
 *    (previous injection retained).
 *  - resetModelLimitsCache() clears both the file cache AND injections so
 *    tests never leak limits into each other.
 *
 * Each test resets the cache in a finally block — no cross-test pollution.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const {
    getModelLimits,
    setModelLimits,
    resetModelLimitsCache,
} = await import("../src/gateway/model-limits.mjs");

/** Point file-based resolution at the repo's example config (has kimi-k3 + wildcard). */
function useExampleConfig() {
    process.env.GATEWAY_CONFIG_PATH = path.join(projectRoot, "config", "config.example.json");
}

test("injected limits win over file-based resolution and keep non-injected file lookups working", () => {
    useExampleConfig();
    try {
        resetModelLimitsCache();
        // File path alone already resolves kimi-k3 from the example config…
        assert.deepEqual(getModelLimits("moonshotai/kimi-k3"), { context: 1048576, output: 131072 });
        // …but the INJECTED record must take precedence over both file and fallback.
        setModelLimits({ "moonshotai/kimi-k3": { context: 2000000, output: 999999 } });
        assert.deepEqual(getModelLimits("moonshotai/kimi-k3"), { context: 2000000, output: 999999 });
        // Merge-over: a model absent from the injection still resolves via file.
        assert.deepEqual(getModelLimits("z-ai/glm-5.2"), { context: 202752, output: 131072 });
    } finally {
        delete process.env.GATEWAY_CONFIG_PATH;
        resetModelLimitsCache();
    }
});

test("malformed injections are ignored entirely; valid-but-empty clears prior injection", () => {
    useExampleConfig();
    try {
        resetModelLimitsCache();
        setModelLimits({ "some/model": { context: 123456, output: 65432 } });
        assert.deepEqual(getModelLimits("some/model"), { context: 123456, output: 65432 });

        // Non-object garbage: previous injection RETAINED.
        for (const garbage of [undefined, null, 42, "limits", ["not", "a", "record"]]) {
            setModelLimits(garbage);
        }
        assert.deepEqual(getModelLimits("some/model"), { context: 123456, output: 65432 });

        // Valid empty object: explicit clear.
        setModelLimits({});
        assert.notEqual(getModelLimits("some/model").context, 123456);
    } finally {
        delete process.env.GATEWAY_CONFIG_PATH;
        resetModelLimitsCache();
    }
});

test("sanitizer keeps positive safe integers only and drops malformed entries", () => {
    useExampleConfig();
    try {
        resetModelLimitsCache();
        setModelLimits({
            "good/model": { context: 1048576, output: 131072 },
            "stringy/model": { context: "1048576", output: "131072" },   // strings rejected
            "floaty/model": { context: 10.5, output: 20 },               // non-integer rejected
            "negative/model": { context: -100, output: 100 },            // non-positive rejected
            "partial/model": { context: 1000 },                          // missing field rejected
            "array/model": [1048576, 131072],                            // array entry rejected
        });
        assert.deepEqual(getModelLimits("good/model"), { context: 1048576, output: 131072 });
        const hardFallback = { context: 131072, output: 4096 };
        assert.deepEqual(getModelLimits("stringy/model"), hardFallback);
        assert.deepEqual(getModelLimits("floaty/model"), hardFallback);
        assert.deepEqual(getModelLimits("negative/model"), hardFallback);
        assert.deepEqual(getModelLimits("partial/model"), hardFallback);
        assert.deepEqual(getModelLimits("array/model"), hardFallback);
    } finally {
        delete process.env.GATEWAY_CONFIG_PATH;
        resetModelLimitsCache();
    }
});

test("injected wildcard '*' beats file wildcard; injected exact beats injected wildcard", () => {
    useExampleConfig(); // example config has "*" -> {131072,4096}
    try {
        resetModelLimitsCache();
        setModelLimits({
            "*": { context: 555555, output: 4444 },
            "exact/wins": { context: 111111, output: 2222 },
        });
        assert.deepEqual(getModelLimits("unknown-family/whatever"), { context: 555555, output: 4444 });
        assert.deepEqual(getModelLimits("exact/wins"), { context: 111111, output: 2222 });
    } finally {
        delete process.env.GATEWAY_CONFIG_PATH;
        resetModelLimitsCache();
    }
});

test("record is capped at 512 entries and oversized keys are dropped", () => {
    try {
        resetModelLimitsCache();
        /** @type {Record<string, { context: number, output: number }>} */
        const big = {};
        for (let i = 0; i < 600; i += 1) big[`vendor-${i}/model`] = { context: i + 1, output: i + 1 };
        setModelLimits(big);
        assert.equal(getModelLimits("vendor-0/model").context, 1);
        assert.equal(getModelLimits("vendor-511/model").context, 512);
        // Entries beyond the cap are ignored.
        assert.notEqual(getModelLimits("vendor-512/model").context, 513);

        resetModelLimitsCache();
        setModelLimits({ ["x".repeat(300)]: { context: 1, output: 1 }, "ok/key": { context: 7, output: 8 } });
        assert.deepEqual(getModelLimits("ok/key"), { context: 7, output: 8 });
        assert.deepEqual(getModelLimits("x".repeat(300)), { context: 131072, output: 4096 });
    } finally {
        resetModelLimitsCache();
    }
});
