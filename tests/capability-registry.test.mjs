import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

const {
    getCapability,
    getReasoningCapability,
    getCapabilityMetadata,
    registerFamilyPatterns,
    listKnownFamilies,
    resetCapabilityRegistry,
} = await import("../src/gateway/capability-registry.mjs");

beforeEach(() => resetCapabilityRegistry());

test("1. z-ai/glm-5.2 — full reasoning pattern, 7 modes, tools enabled", () => {
    const cap = getCapability("z-ai/glm-5.2");
    assert.equal(cap.reasoning.supported, true);
    assert.equal(cap.reasoning.modes.length, 7);
    assert.deepEqual(cap.reasoning.modes, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(cap.reasoning.controlKey, "reasoning_effort");
    assert.equal(cap.reasoning.defaultMode, "high");
    assert.equal(cap.tools, true);
    assert.equal(cap.vision, false);
    assert.equal(cap.audio, false);
    assert.equal(cap.family, "z-ai");
});

test("2. stepfun-ai/step-3.7-flash — chat_template_kwargs.thinking control", () => {
    const cap = getCapability("stepfun-ai/step-3.7-flash");
    assert.equal(cap.reasoning.supported, true);
    assert.equal(cap.reasoning.controlKey, "chat_template_kwargs.thinking");
    assert.equal(cap.family, "stepfun-ai");
});

test("3. qwen/qwen3.5-397b-a17b — enable_thinking control", () => {
    const cap = getCapability("qwen/qwen3.5-397b-a17b");
    assert.equal(cap.reasoning.supported, true);
    assert.equal(cap.reasoning.controlKey, "chat_template_kwargs.enable_thinking");
    assert.equal(cap.family, "qwen");
});

test("4. meta/llama-4-maverick — no reasoning, vision enabled", () => {
    const cap = getCapability("meta/llama-4-maverick-17b-128e-instruct");
    assert.equal(cap.reasoning.supported, false);
    assert.deepEqual(cap.reasoning.modes, []);
    assert.equal(cap.reasoning.controlKey, null);
    assert.equal(cap.vision, true);
    assert.equal(cap.family, "meta");
});

test("5. minimaxai/minimax-m3 — string-typed thinking_mode control", () => {
    const cap = getCapability("minimaxai/minimax-m3");
    assert.equal(cap.reasoning.supported, true);
    assert.equal(cap.reasoning.controlKey, "chat_template_kwargs.thinking_mode");
    assert.equal(cap.reasoning.type, "string");
    assert.equal(cap.reasoning.enableValue, "enabled");
    assert.equal(cap.reasoning.disableValue, "disabled");
    assert.equal(cap.reasoning.defaultMode, "enabled");
    assert.equal(cap.family, "minimaxai");
});

test("6. deepseek-ai/deepseek-v4-pro — reasoning_effort control", () => {
    const cap = getCapability("deepseek-ai/deepseek-v4-pro");
    assert.equal(cap.reasoning.supported, true);
    assert.equal(cap.reasoning.controlKey, "reasoning_effort");
    assert.equal(cap.family, "deepseek-ai");
});

test("7. listKnownFamilies — returns all built-in families", () => {
    const families = listKnownFamilies();
    assert.ok(Array.isArray(families));
    for (const expected of ["z-ai", "stepfun-ai", "qwen", "deepseek-ai", "deepseek", "minimaxai", "moonshotai", "meta", "nvidia"]) {
        assert.ok(families.includes(expected));
    }
});
