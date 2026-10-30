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

test("21. registerFamilyPatterns must not let a __proto__/constructor key pollute", () => {
    // A config override is data. `Object.keys` happily yields "__proto__" from a
    // JSON.parse'd object, and a plain `target[key] = value` on that key invokes
    // the Object.prototype setter — polluting the prototype of EVERY object in
    // the process, not just the registry. The same hazard exists for the
    // top-level family key. Both paths must drop the dangerous key.
    const poisonedDeep = JSON.parse('{"reasoning":{"__proto__":{"registryPolluted":"YES"}}}');
    registerFamilyPatterns({ "z-ai": poisonedDeep });
    assert.equal(
        ({}).registryPolluted,
        undefined,
        "a nested __proto__ override must not reach Object.prototype via deepMerge"
    );
    assert.equal(
        getCapability("z-ai/glm-5.2").reasoning.registryPolluted,
        undefined,
        "the polluted key must not surface through a read either"
    );

    // The __proto__ value must also not become an OWN key of the merged pattern,
    // which would smuggle its contents into the capability answer.
    assert.equal(
        Object.prototype.hasOwnProperty.call(getCapability("z-ai/glm-5.2").reasoning, "__proto__"),
        false,
        "__proto__ must not be materialised as an own data property"
    );

    resetCapabilityRegistry();
    registerFamilyPatterns(JSON.parse('{"__proto__":{"familyKeyPolluted":"YES"}}'));
    assert.equal(
        ({}).familyKeyPolluted,
        undefined,
        "a top-level __proto__ family key must not reach Object.prototype"
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(getCapability("unknown/x"), "familyKeyPolluted"),
        false,
        "the polluted key must not surface through a read either"
    );
});

test("22. moonshotai/kimi-k3 — reasoning_effort control, low/high/max modes, default max", () => {
    const cap = getCapability("moonshotai/kimi-k3");
    assert.equal(cap.reasoning.supported, true);
    assert.deepEqual(cap.reasoning.modes, ["low", "high", "max"]);
    assert.equal(cap.reasoning.controlKey, "reasoning_effort");
    // The gateway sends "high" when the client states no preference (upstream
    // "max" caused 140-180 s first-byte waits), so the advertised default must
    // be the same value. The rest of the moonshotai family keeps "max".
    assert.equal(cap.reasoning.defaultMode, "high");
    assert.equal(getCapability("moonshotai/kimi-k2").reasoning.defaultMode, "max");
    assert.equal(cap.tools, true);
    assert.equal(cap.vision, true); // NVIDIA Kimi K3 page: input types Text, Image (per-model override)
    assert.equal(cap.audio, false);
    assert.equal(cap.family, "moonshotai");

    // /v1/models enrichment shape (clean metadata, no internal knobs).
    const meta = getCapabilityMetadata("moonshotai/kimi-k3");
    assert.equal(meta.reasoning.supported, true);
    assert.deepEqual(meta.reasoning.modes, ["low", "high", "max"]);
    assert.equal(meta.reasoning.controlKey, "reasoning_effort");
    assert.equal(meta.reasoning.defaultMode, "high");
});

test("23. registerFamilyPatterns — NEW family with a PARTIAL override keeps the complete required shape", () => {
    // Regression: before the fix, a new family whose override was a plain object
    // was stored VERBATIM. `{ modes: ["high"] }` produced a family with no
    // `reasoning`/`tools`/`vision`/`audio`: getReasoningCapability() returned
    // undefined and getCapabilityMetadata() threw on `r.supported`. The override
    // must start from the DEFAULT shape and merge into it.
    registerFamilyPatterns({ "brand-new": { reasoning: { modes: ["high"] } } });

    const cap = getCapability("brand-new/model");
    // The override's value is applied...
    assert.deepEqual(cap.reasoning.modes, ["high"]);
    // ...and every required field the readers touch is present.
    assert.equal(cap.reasoning.supported, false, "omitted `supported` falls back to the DEFAULT_FAMILY value");
    assert.equal(cap.reasoning.controlKey, null);
    assert.equal(cap.tools, true);
    assert.equal(cap.vision, false);
    assert.equal(cap.audio, false);

    // getReasoningCapability must not return undefined for a field it promises.
    const reasoning = getReasoningCapability("brand-new/model");
    assert.equal(typeof reasoning, "object");
    assert.equal(reasoning.supported, false);
    assert.deepEqual(reasoning.modes, ["high"]);
    assert.equal(reasoning.controlKey, null);

    // getCapabilityMetadata must not throw and must expose clean metadata.
    const meta = getCapabilityMetadata("brand-new/model");
    assert.equal(meta.reasoning.supported, false);
    assert.deepEqual(meta.reasoning.modes, ["high"]);
    assert.equal(meta.reasoning.controlKey, null);
    assert.equal(meta.tools, true);
    assert.equal(meta.vision, false);
    assert.equal(meta.audio, false);
});

test("24. registerFamilyPatterns — missing reasoning on a NEW family is materialised, not left absent", () => {
    // The sharpest form of the defect: an object override that touches only
    // top-level modality flags still needs a `reasoning` sub-object, because
    // every reader dereferences it.
    registerFamilyPatterns({ "brand-new-2": { vision: true } });

    assert.equal(getCapability("brand-new-2/model").vision, true, "the override wins");
    assert.equal(typeof getReasoningCapability("brand-new-2/model"), "object");
    const meta = getCapabilityMetadata("brand-new-2/model");
    assert.equal(meta.reasoning.supported, false);
    assert.deepEqual(meta.reasoning.modes, []);
    assert.equal(meta.reasoning.controlKey, null);
    assert.equal(meta.reasoning.defaultMode, null);
    assert.equal(meta.vision, true);
});

test("25. registerFamilyPatterns — deep-merge path for an EXISTING family is unchanged", () => {
    // Guard the pre-existing behaviour against the new-family branch: an
    // existing family keeps its full built-in pattern, merge overlays only.
    registerFamilyPatterns({ "z-ai": { reasoning: { modes: ["only"] } } });
    const cap = getCapability("z-ai/glm-5.2");
    assert.deepEqual(cap.reasoning.modes, ["only"], "override applies");
    // Untouched sibling fields from the built-in survive the deep merge.
    assert.equal(cap.reasoning.supported, true);
    assert.equal(cap.reasoning.controlKey, "reasoning_effort");
    assert.equal(cap.reasoning.defaultMode, "high");
    assert.ok(cap.reasoning.alternateControl, "alternateControl survives");
    assert.equal(cap.tools, true);
    assert.equal(cap.audio, false);
});

test("26. registerFamilyPatterns — prototype-pollution guards still hold on the NEW-family path", () => {
    // The new-family branch merges into a clone of DEFAULT_FAMILY via deepMerge;
    // a poisoned nested key must still be dropped, and a top-level __proto__
    // family key must be skipped entirely (no own key materialised).
    const poisoned = JSON.parse('{"vision":true,"__proto__":{"registryPolluted":"YES"}}');
    registerFamilyPatterns({ "brand-new-3": poisoned });
    assert.equal(({}).registryPolluted, undefined, "nested __proto__ must not reach Object.prototype");
    assert.equal(getCapability("brand-new-3/model").vision, true, "legitimate override still applied");
    assert.equal(
        Object.prototype.hasOwnProperty.call(getCapability("brand-new-3/model"), "__proto__"),
        false,
        "__proto__ must not become an own data property"
    );

    registerFamilyPatterns(JSON.parse('{"__proto__":{"newFamilyKeyPolluted":"YES"}}'));
    assert.equal(({}).newFamilyKeyPolluted, undefined, "top-level __proto__ family key must be dropped");
});

test("27. registerFamilyPatterns — a NON-object override is ignored, never poisons the readers", () => {
    // A primitive/array/null override cannot be a valid family pattern (readers
    // dereference pattern.reasoning). It must be dropped rather than stored.
    registerFamilyPatterns({ "brand-new-4": 123 });
    assert.equal(listKnownFamilies().includes("brand-new-4"), false, "a primitive override must not create a family");
    assert.equal(getCapability("brand-new-4/model").reasoning.supported, false, "falls back to DEFAULT_FAMILY cleanly");

    registerFamilyPatterns({ "z-ai": "not-an-object" });
    const cap = getCapability("z-ai/glm-5.2");
    assert.equal(cap.reasoning.supported, true, "an invalid override must not clobber a valid built-in family");
    assert.equal(cap.reasoning.controlKey, "reasoning_effort");
    assert.equal(typeof getCapabilityMetadata("z-ai/glm-5.2").reasoning.supported, "boolean");
});

test("24. deepseek-ai/deepseek-v4.1-flash - vision on, unverified string effort control disabled", () => {
    const v41 = getCapability("deepseek-ai/deepseek-v4.1-flash");
    assert.equal(v41.vision, true);
    assert.equal(v41.tools, true);
    assert.equal(v41.family, "deepseek-ai");
    assert.deepEqual(v41.reasoning, { supported: true, modes: [], controlKey: null });
    assert.deepEqual(getCapabilityMetadata("deepseek-ai/deepseek-v4.1-flash").reasoning,
        { supported: true, modes: [], controlKey: null, defaultMode: null });
    assert.notDeepEqual(v41.reasoning, getCapability("deepseek-ai/deepseek-v4-flash").reasoning,
        "siblings keep the generic string effort control");
    assert.equal(getCapabilityMetadata("deepseek-ai/deepseek-v4.1-flash").vision, true);
    assert.equal(getCapabilityMetadata("DeepSeek-AI/DeepSeek-V4.1-Flash").vision, true);
    // The override is per model: siblings and the family keep vision off.
    for (const id of ["deepseek-ai/deepseek-v4-flash", "deepseek-ai/deepseek-v4-pro", "deepseek-ai/deepseek-v4.1-flash-x", "deepseek/deepseek-v4.1-flash"]) {
        assert.equal(getCapability(id).vision, false, id);
    }
    // Returned objects are clones: mutating one never changes the registry.
    v41.vision = false;
    assert.equal(getCapability("deepseek-ai/deepseek-v4.1-flash").vision, true);
    // resetCapabilityRegistry keeps the built-in override.
    registerFamilyPatterns({ "deepseek-ai": { vision: false } });
    resetCapabilityRegistry();
    assert.equal(getCapability("deepseek-ai/deepseek-v4.1-flash").vision, true);
    assert.equal(getCapability("deepseek-ai/deepseek-v4.1-flash").reasoning.controlKey, null);
});
