import test from "node:test";
import assert from "node:assert/strict";
import { createDirectGlmProbeScheduler, DIRECT_GLM_PROBE_MAX_SUCCESS_BYTES, DIRECT_GLM_PROBE_TIMEOUT_MS, normalizeMaxSuccessBytes, runDirectGlmProbe, shouldScheduleDirectGlmProbe } from "../src/gateway/direct-glm-probe.mjs";

test("core probe behavior is available", async () => {
    const result = await runDirectGlmProbe({ envValue: undefined, keyRecords: [] });
    assert.equal(result, undefined);
});
