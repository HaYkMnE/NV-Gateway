// @ts-check
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const {
    getModelLimits,
    setModelLimits,
    resetModelLimitsCache,
} = await import("../src/gateway/model-limits.mjs");

test("injected limits take precedence and retain fallback", () => {
    resetModelLimitsCache();
    setModelLimits({ "moonshotai/kimi-k3": { context: 2000000, output: 999999 } });
    assert.deepEqual(getModelLimits("moonshotai/kimi-k3"), { context: 2000000, output: 999999 });
    resetModelLimitsCache();
});
