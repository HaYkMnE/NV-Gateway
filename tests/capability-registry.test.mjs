// @ts-check
/**
 * Tests for the capability registry — pure-logic, no network, no I/O.
 *
 * Each test starts from a clean built-in registry (resetCapabilityRegistry in
 * beforeEach) so config overrides applied in one test never leak into another.
 */
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

// Reset the in-memory registry before every test so override/merge mutations
// (registerFamilyPatterns) are isolated per test.
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

test("7. unknown-family/some-model — falls back to DEFAULT_FAMILY, family preserved", () => {
    const cap = getCapability("unknown-family/some-model");
    assert.equal(cap.reasoning.supported, false);
    assert.deepEqual(cap.reasoning.modes, []);
    assert.equal(cap.reasoning.controlKey, null);
    assert.equal(cap.tools, true);
    assert.equal(cap.vision, false);
    assert.equal(cap.audio, false);
    assert.equal(cap.family, "unknown-family");
});

test("8. getCapability(null) — no crash, returns DEFAULT_FAMILY", () => {
    const cap = getCapability(null);
    assert.equal(cap.reasoning.supported, false);
    assert.equal(cap.tools, true);
    assert.equal(cap.vision, false);
    assert.equal(cap.audio, false);
    assert.equal(cap.family, null);
});

test("9. getCapability('') — no crash, returns DEFAULT_FAMILY", () => {
    const cap = getCapability("");
    assert.equal(cap.reasoning.supported, false);
    assert.equal(cap.tools, true);
    assert.equal(cap.vision, false);
    assert.equal(cap.audio, false);
    assert.equal(cap.family, null);
});

test("10. getCapability(123) — non-string input, no crash", () => {
    const cap = getCapability(123);
    assert.equal(cap.reasoning.supported, false);
    assert.deepEqual(cap.reasoning.modes, []);
    assert.equal(cap.reasoning.controlKey, null);
    assert.equal(cap.tools, true);
    assert.equal(cap.vision, false);
    assert.equal(cap.audio, false);
    assert.equal(cap.family, null);
});

test("11. getReasoningCapability('z-ai/glm-5.2') — reasoning sub-object with alternateControl", () => {
    const r = getReasoningCapability("z-ai/glm-5.2");
    assert.equal(r.supported, true);
    assert.ok(r.alternateControl, "expected alternateControl on z-ai reasoning");
    assert.equal(r.alternateControl.key, "chat_template_kwargs.enable_thinking");
    assert.equal(r.alternateControl.type, "boolean");
    assert.equal(r.alternateControl.enableValue, true);
    assert.equal(r.alternateControl.disableValue, false);
    // The function returns ONLY the reasoning sub-object — no top-level modalities.
    assert.ok(!("tools" in r), "reasoning object must not expose tools");
    assert.ok(!("vision" in r), "reasoning object must not expose vision");
    assert.ok(!("audio" in r), "reasoning object must not expose audio");
    assert.ok(!("family" in r), "reasoning object must not expose family");
});

test("12. getCapabilityMetadata('z-ai/glm-5.2') — clean metadata for /v1/models", () => {
    const meta = getCapabilityMetadata("z-ai/glm-5.2");
    assert.equal(meta.reasoning.supported, true);
    assert.deepEqual(meta.reasoning.modes, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(meta.reasoning.controlKey, "reasoning_effort");
    assert.equal(meta.reasoning.defaultMode, "high");
    assert.equal(meta.tools, true);
    assert.equal(meta.vision, false);
    assert.equal(meta.audio, false);
    // Metadata must omit internal-only reasoning knobs.
    assert.ok(!("alternateControl" in meta.reasoning), "metadata must omit alternateControl");
    assert.ok(!("type" in meta.reasoning), "metadata must omit type");
    assert.ok(!("enableValue" in meta.reasoning), "metadata must omit enableValue");
    assert.ok(!("disableValue" in meta.reasoning), "metadata must omit disableValue");
    assert.ok(!("family" in meta), "metadata must omit family");
});

test("13. registerFamilyPatterns — adds a new family pattern", () => {
    registerFamilyPatterns({
        "foo-bar": {
            reasoning: { supported: true, modes: ["on", "off"], controlKey: "x", defaultMode: "on" },
            tools: true,
            vision: false,
            audio: false,
        },
    });
    const cap = getCapability("foo-bar/model");
    assert.equal(cap.family, "foo-bar");
    assert.equal(cap.reasoning.supported, true);
    assert.deepEqual(cap.reasoning.modes, ["on", "off"]);
    assert.equal(cap.reasoning.controlKey, "x");
    assert.equal(cap.reasoning.defaultMode, "on");
    assert.equal(cap.tools, true);
    assert.equal(cap.vision, false);
    assert.equal(cap.audio, false);
});

test("14. registerFamilyPatterns — overrides a built-in family", () => {
    registerFamilyPatterns({
        "z-ai": {
            reasoning: { supported: true, modes: ["custom"], controlKey: "custom", defaultMode: "custom" },
        },
    });
    const cap = getCapability("z-ai/glm-5.2");
    assert.deepEqual(cap.reasoning.modes, ["custom"]);
    assert.equal(cap.reasoning.controlKey, "custom");
    assert.equal(cap.reasoning.defaultMode, "custom");
});

test("15. listKnownFamilies — returns all built-in families", () => {
    const families = listKnownFamilies();
    assert.ok(Array.isArray(families), "listKnownFamilies must return an array");
    for (const expected of ["z-ai", "stepfun-ai", "qwen", "deepseek-ai", "deepseek", "minimaxai", "moonshotai", "meta", "nvidia"]) {
        assert.ok(families.includes(expected), `expected family "${expected}" in listKnownFamilies()`);
    }
});

test("16. deepseek vs deepseek-ai are separate families", () => {
    const cap = getCapability("deepseek/some-model");
    assert.equal(cap.family, "deepseek");
    assert.equal(cap.reasoning.supported, true);
    assert.equal(cap.reasoning.controlKey, "reasoning_effort");

    const families = listKnownFamilies();
    assert.ok(families.includes("deepseek"), "'deepseek' must be a known family");
    assert.ok(families.includes("deepseek-ai"), "'deepseek-ai' must be a known family");
    assert.notEqual(cap.family, "deepseek-ai");
});

test("17. registerFamilyPatterns deep-merge — partial override keeps reasoning intact", () => {
    // Before override: built-in z-ai vision is false.
    assert.equal(getCapability("z-ai/glm-5.2").vision, false);

    registerFamilyPatterns({ "z-ai": { vision: true } });

    const cap = getCapability("z-ai/glm-5.2");
    assert.equal(cap.vision, true, "vision should be overridden to true");
    // Reasoning pattern must remain the built-in one — only vision changed.
    assert.equal(cap.reasoning.supported, true);
    assert.equal(cap.reasoning.controlKey, "reasoning_effort");
    assert.equal(cap.reasoning.modes.length, 7);
    assert.equal(cap.reasoning.defaultMode, "high");
    assert.ok(cap.reasoning.alternateControl, "alternateControl must survive a partial override");
    assert.equal(cap.tools, true);
    assert.equal(cap.audio, false);
});

test("18. getCapabilityMetadata output is JSON-serializable (no functions, no undefined)", () => {
    const zMeta = getCapabilityMetadata("z-ai/glm-5.2");
    const json = JSON.stringify(zMeta);
    assert.equal(typeof json, "string");
    assert.deepEqual(JSON.parse(json), zMeta, "round-trip must be lossless");

    // No undefined values sneaking through on a reasoning-capable family.
    assert.notEqual(zMeta.reasoning.controlKey, undefined);
    assert.notEqual(zMeta.reasoning.defaultMode, undefined);

    // Non-reasoning family: nullable fields must be null, never undefined.
    const metaMeta = getCapabilityMetadata("meta/llama-4-maverick-17b-128e-instruct");
    const metaJson = JSON.stringify(metaMeta);
    assert.equal(typeof metaJson, "string");
    assert.deepEqual(JSON.parse(metaJson), metaMeta);
    assert.equal(metaMeta.reasoning.supported, false);
    assert.deepEqual(metaMeta.reasoning.modes, []);
    assert.equal(metaMeta.reasoning.controlKey, null);
    assert.equal(metaMeta.reasoning.defaultMode, null);
    assert.notEqual(metaMeta.reasoning.controlKey, undefined);
    assert.notEqual(metaMeta.reasoning.defaultMode, undefined);

    // Unknown family metadata must also serialize cleanly.
    const unkMeta = getCapabilityMetadata("totally-unknown/family-model");
    assert.equal(typeof JSON.stringify(unkMeta), "string");
    assert.equal(unkMeta.reasoning.controlKey, null);
    assert.notEqual(unkMeta.reasoning.controlKey, undefined);
});

test("19. registerFamilyPatterns arrays are not aliased to the caller (defensive copy)", () => {
    const callerModes = ["custom-mode"];
    registerFamilyPatterns({ "z-ai": { reasoning: { modes: callerModes } } });
    // Mutate the caller's array *after* registration — must NOT leak into the registry.
    callerModes.push("backdoor");
    callerModes[0] = "MUTATED";
    const cap = getCapability("z-ai/glm-5.2");
    assert.deepEqual(
        cap.reasoning.modes,
        ["custom-mode"],
        "caller mutation must not leak into registry; deepMerge must defensively clone arrays"
    );
});

test("20. resetCapabilityRegistry clears overrides and restores exactly the 9 built-ins", () => {
    registerFamilyPatterns({
        "temp-fam": { reasoning: { supported: true, modes: ["x"], controlKey: "x" } },
    });
    registerFamilyPatterns({ "z-ai": { reasoning: { modes: ["custom"] } } });
    assert.ok(listKnownFamilies().includes("temp-fam"), "temp-fam must be registered before reset");
    assert.deepEqual(getCapability("z-ai/glm-5.2").reasoning.modes, ["custom"]);

    resetCapabilityRegistry();

    assert.ok(!listKnownFamilies().includes("temp-fam"), "non-builtin families must be cleared");
    assert.equal(listKnownFamilies().length, 9, "must restore exactly 9 built-in families");
    assert.equal(
        getCapability("z-ai/glm-5.2").reasoning.modes.length,
        7,
        "built-in z-ai modes restored"
    );
});

test("21. moonshotai/kimi-k3 — reasoning_effort control, low/high/max modes, default max", () => {
    const cap = getCapability("moonshotai/kimi-k3");
    assert.equal(cap.reasoning.supported, true);
    assert.deepEqual(cap.reasoning.modes, ["low", "high", "max"]);
    assert.equal(cap.reasoning.controlKey, "reasoning_effort");
    assert.equal(cap.reasoning.defaultMode, "max");
    assert.equal(cap.tools, true);
    assert.equal(cap.vision, false); // unverified-assumption: no NVIDIA Build page to confirm
    assert.equal(cap.audio, false);
    assert.equal(cap.family, "moonshotai");

    // /v1/models enrichment shape (clean metadata, no internal knobs).
    const meta = getCapabilityMetadata("moonshotai/kimi-k3");
    assert.equal(meta.reasoning.supported, true);
    assert.deepEqual(meta.reasoning.modes, ["low", "high", "max"]);
    assert.equal(meta.reasoning.controlKey, "reasoning_effort");
    assert.equal(meta.reasoning.defaultMode, "max");
});
