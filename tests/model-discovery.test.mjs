import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";

const {
    fetchAvailableModels,
    getCachedModels,
    refreshModels,
    resetCache,
    getCacheInfo,
    getFallbackModels
} = await import("../src/gateway/model-discovery.mjs");

test("getFallbackModels returns default model list", () => {
    const models = getFallbackModels();
    assert.ok(Array.isArray(models));
    assert.ok(models.some(m => m.id === "z-ai/glm-5.2"));
});
