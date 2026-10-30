// @ts-check
/**
 * LLM Stats model-strength ranking — matching + degradation tests.
 *
 * SOURCE OF TRUTH FOR THE EXPECTATIONS: a verified offline reference run
 * holds a verified reference run (our_models.json 82 ids, zer_eval_index.json 369
 * entries, match_results.json 24 matches = 18 exact + 6 sibling and the
 * must-not-match list). The ids below are copied VERBATIM from that fixture; the
 * module under test never reads it (it must work against the live endpoint), so
 * the fixture is only the oracle here.
 *
 * The user-facing contract: a model's rank is shown ONLY when the match is
 * genuinely the same model. A wrong rank is worse than no rank, so every hard
 * REJECT case below is an assertion that the row stays empty ("—").
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_PATH = path.join(root, 'src', 'gateway', 'llm-stats-ranking.mjs');

/** Import the module under test. Kept lazy so a missing file is a test failure. */
// Monotonic suffix: two imports in the same millisecond must still get fresh
// module instances (no WeakMap cache / call-counter state leaking between them).
let loadSeq = 0;
async function loadModule() {
  return import(`${pathToFileURLSafe(MODULE_PATH)}?t=${Date.now()}-${++loadSeq}`);
}

function pathToFileURLSafe(p) {
  return pathToFileURL(p);
}

/**
 * A faithful slice of the live index (the entries the 82-id catalogue can
 * actually reach), with the real model_id / rank / conservative values from the
 * verified fixture. `model_name` is included because the matcher must consider
 * BOTH id and name.
 */
const INDEX = {
  category_id: 'general',
  method: 'trueskill',
  models: [
    { model_id: 'kimi-k3', model_name: 'Kimi K3', organization_id: 'moonshotai', rank: 8, mu: 55.94, sigma: 9.87, conservative: 52.98 },
    { model_id: 'glm-5.3', model_name: 'GLM 5.3', organization_id: 'zai-org', rank: 9, mu: 56.16, sigma: 1.15, conservative: 52.71 },
    { model_id: 'glm-5.3-flash', model_name: 'GLM 5.3 Flash', organization_id: 'zai-org', rank: 18, mu: 54.12, sigma: 1.3, conservative: 50.23 },
    { model_id: 'deepseek-v4-flash-0731', model_name: 'DeepSeek V4 Flash', organization_id: 'deepseek', rank: 36, mu: 49.51, sigma: 1.6, conservative: 44.71 },
    { model_id: 'kimi-k2.6', model_name: 'Kimi K2.6', organization_id: 'moonshotai', rank: 38, mu: 46.38, sigma: 0.89, conservative: 43.7 },
    { model_id: 'nemotron-3-ultra-550b-a55b', model_name: 'Nemotron 3 Ultra (550B A55B)', organization_id: 'nvidia', rank: 79, mu: 39.29, sigma: 1.01, conservative: 36.27 },
    { model_id: 'muse-glimmer-30b', model_name: 'Muse Glimmer 30B', organization_id: 'meta', rank: 90, mu: 38.15, sigma: 1.07, conservative: 34.95 },
    { model_id: 'gemma-4-31b-it', model_name: 'Gemma 4 31B IT', organization_id: 'google', rank: 101, mu: 36.62, sigma: 1.17, conservative: 33.11 },
    { model_id: 'gpt-oss-120b-high', model_name: 'GPT-OSS 120B (high)', organization_id: 'openai', rank: 157, mu: 30.0, sigma: 1.0, conservative: 27.0 },
    { model_id: 'nemotron-3-super-120b-a12b', model_name: 'Nemotron 3 Super (120B A12B)', organization_id: 'nvidia', rank: 147, mu: 29.66, sigma: 0.95, conservative: 26.8 },
    { model_id: 'laguna-xs-2.1', model_name: 'Laguna XS 2.1', organization_id: 'poolside', rank: 163, mu: 30.73, sigma: 2.12, conservative: 24.38 },
    { model_id: 'nemotron-3.5-lightning-30b-a3b', model_name: 'Nemotron 3.5 Lightning (30B A3B)', organization_id: 'nvidia', rank: 178, mu: 26.02, sigma: 1.32, conservative: 22.06 },
    { model_id: 'nemotron-3-nano-30b-a3b', model_name: 'Nemotron 3 Nano (30B A3B)', organization_id: 'nvidia', rank: 190, mu: 24.48, sigma: 1.15, conservative: 21.04 },
    { model_id: 'diffusiongemma-26b-a4b-it', model_name: 'DiffusionGemma 26B A4B IT', organization_id: 'google', rank: 205, mu: 23.27, sigma: 1.28, conservative: 19.43 },
    { model_id: 'llama-3.1-nemotron-ultra-253b-v1', model_name: 'Llama 3.1 Nemotron Ultra 253B v1', organization_id: 'nvidia', rank: 206, mu: 24.41, sigma: 1.77, conservative: 19.11 },
    { model_id: 'gpt-oss-20b', model_name: 'GPT-OSS 20B', organization_id: 'openai', rank: 216, mu: 23.04, sigma: 1.69, conservative: 17.96 },
    { model_id: 'mistral-large-latest', model_name: 'Mistral Large', organization_id: 'mistral', rank: 271, mu: 14.74, sigma: 1.91, conservative: 9.02 },
    { model_id: 'mistral-large-2-2407', model_name: 'Mistral Large 2', organization_id: 'mistral', rank: 288, mu: 13.69, sigma: 2.1, conservative: 7.39 },
    { model_id: 'gemma-3-12b-it', model_name: 'Gemma 3 12B IT', organization_id: 'google', rank: 295, mu: 8.39, sigma: 0.94, conservative: 5.57 },
    { model_id: 'llama-3.2-90b-instruct', model_name: 'Llama 3.2 90B Instruct', organization_id: 'meta', rank: 297, mu: 7.4, sigma: 0.73, conservative: 5.22 },
    { model_id: 'phi-3.5-moe-instruct', model_name: 'Phi 3.5 MoE Instruct', organization_id: 'microsoft', rank: 318, mu: 5.01, sigma: 1.03, conservative: 1.91 },
    { model_id: 'jamba-1.5-large', model_name: 'Jamba 1.5 Large', organization_id: 'ai21', rank: 322, mu: 5.52, sigma: 1.54, conservative: 0.91 },
    { model_id: 'llama-3.1-nemotron-70b-instruct', model_name: 'Llama 3.1 Nemotron 70B Instruct', organization_id: 'nvidia', rank: 324, mu: 5.29, sigma: 1.64, conservative: 0.36 },
    { model_id: 'codestral-22b', model_name: 'Codestral 22B', organization_id: 'mistral', rank: 326, mu: 8.56, sigma: 2.85, conservative: 0.01 },
    { model_id: 'llama-3.2-11b-instruct', model_name: 'Llama 3.2 11B Instruct', organization_id: 'meta', rank: 334, mu: 2.5, sigma: 1.26, conservative: -1.29 },
    { model_id: 'gemma-3-4b-it', model_name: 'Gemma 3 4B IT', organization_id: 'google', rank: 337, mu: 1.12, sigma: 1.0, conservative: -1.87 },
    { model_id: 'mistral-nemo-instruct-2407', model_name: 'Mistral NeMo Instruct', organization_id: 'mistral', rank: 353, mu: 0.36, sigma: 1.71, conservative: -4.76 },
    // Traps: near-prefix candidates that must NEVER win.
    { model_id: 'gpt-oss-20b-high', model_name: 'GPT-OSS 20B (high)', organization_id: 'openai', rank: 141, mu: 31.4, sigma: 1.26, conservative: 27.62 },
    { model_id: 'deepseek-v4.1-flash', model_name: 'DeepSeek V4.1 Flash', organization_id: 'deepseek', rank: 13, mu: 55.0, sigma: 1.05, conservative: 51.84 },
    { model_id: 'deepseek-v4-flash-max', model_name: 'DeepSeek V4 Flash (max)', organization_id: 'deepseek', rank: 61, mu: 47.0, sigma: 1.2, conservative: 43.4 },
    { model_id: 'deepseek-v3.2', model_name: 'DeepSeek V3.2', organization_id: 'deepseek', rank: 100, mu: 40.0, sigma: 1.1, conservative: 36.7 },
    { model_id: 'deepseek-v2.5', model_name: 'DeepSeek V2.5', organization_id: 'deepseek', rank: 281, mu: 16.0, sigma: 1.2, conservative: 12.4 },
  ],
};

/** The 18 exact matches: our id -> [their id, rank]. */
const EXACT_CASES = [
  ['moonshotai/kimi-k3', 'kimi-k3', 8],
  ['z-ai/glm-5.3', 'glm-5.3', 9],
  ['z-ai/glm-5.3-flash', 'glm-5.3-flash', 18],
  ['deepseek-ai/deepseek-v4-flash-0731', 'deepseek-v4-flash-0731', 36],
  ['moonshotai/kimi-k2.6', 'kimi-k2.6', 38],
  ['nvidia/nemotron-3-ultra-550b-a55b', 'nemotron-3-ultra-550b-a55b', 79],
  ['meta/muse-glimmer-30b', 'muse-glimmer-30b', 90],
  ['google/gemma-4-31b-it', 'gemma-4-31b-it', 101],
  ['nvidia/nemotron-3-super-120b-a12b', 'nemotron-3-super-120b-a12b', 147],
  ['poolside/laguna-xs-2.1', 'laguna-xs-2.1', 163],
  ['nvidia/nemotron-3.5-lightning-30b-a3b', 'nemotron-3.5-lightning-30b-a3b', 178],
  ['google/diffusiongemma-26b-a4b-it', 'diffusiongemma-26b-a4b-it', 205],
  ['nvidia/llama-3.1-nemotron-ultra-253b-v1', 'llama-3.1-nemotron-ultra-253b-v1', 206],
  ['openai/gpt-oss-20b', 'gpt-oss-20b', 216],
  ['google/gemma-3-12b-it', 'gemma-3-12b-it', 295],
  ['microsoft/phi-3.5-moe-instruct', 'phi-3.5-moe-instruct', 318],
  ['nvidia/llama-3.1-nemotron-70b-instruct', 'llama-3.1-nemotron-70b-instruct', 324],
  ['google/gemma-3-4b-it', 'gemma-3-4b-it', 337],
];

/** The 6 sibling matches: our id -> [their id, rank]. */
const SIBLING_CASES = [
  ['nvidia/nemotron-nano-3-30b-a3b', 'nemotron-3-nano-30b-a3b', 190],
  ['mistralai/mistral-large', 'mistral-large-latest', 271],
  ['mistralai/mistral-large-2-instruct', 'mistral-large-2-2407', 288],
  ['ai21labs/jamba-1.5-large-instruct', 'jamba-1.5-large', 322],
  ['mistralai/codestral-22b-instruct-v0.1', 'codestral-22b', 326],
  ['nv-mistralai/mistral-nemo-12b-instruct', 'mistral-nemo-instruct-2407', 353],
];

// ───────────────────────────────────────────────────────────────────────────
// Exact matches (18)
// ───────────────────────────────────────────────────────────────────────────

test('every one of the 18 verified exact ids resolves to its own rank', async () => {
  const { matchRankingEntry } = await loadModule();

  for (const [ourId, theirId, rank] of EXACT_CASES) {
    const hit = matchRankingEntry(ourId, INDEX.models);
    assert.ok(hit, `${ourId} must match ${theirId} (nothing found)`);
    assert.equal(hit.model_id, theirId, `${ourId} matched the wrong entry`);
    assert.equal(hit.rank, rank, `${ourId} must carry the source rank`);
    assert.equal(hit.matched_via, 'exact', `${ourId} must be classified as an exact match`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Sibling matches (6) — deliberately accepted as the same model
// ───────────────────────────────────────────────────────────────────────────

test('the 6 verified sibling ids resolve to their documented counterpart', async () => {
  const { matchRankingEntry } = await loadModule();

  for (const [ourId, theirId, rank] of SIBLING_CASES) {
    const hit = matchRankingEntry(ourId, INDEX.models);
    assert.ok(hit, `${ourId} must match ${theirId} (nothing found)`);
    assert.equal(hit.model_id, theirId, `${ourId} matched the wrong entry`);
    assert.equal(hit.rank, rank, `${ourId} must carry the source rank`);
    assert.equal(hit.matched_via, 'sibling', `${ourId} must be classified as a sibling match`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Hard REJECT rules — the four traps named in the brief. A hit here would put
// a WRONG rank on a real model, so each must resolve to null.
// ───────────────────────────────────────────────────────────────────────────

test('a vision variant never inherits its text-only sibling rank', async () => {
  const { matchRankingEntry } = await loadModule();

  for (const ourId of ['meta/llama-3.2-90b-vision-instruct', 'meta/llama-3.2-11b-vision-instruct']) {
    const hit = matchRankingEntry(ourId, INDEX.models);
    assert.equal(hit, null, `${ourId} must NOT match the text-only llama sibling`);
  }
});

test('a minitron variant never inherits the base Mistral NeMo rank', async () => {
  const { matchRankingEntry } = await loadModule();

  assert.equal(
    matchRankingEntry('nvidia/mistral-nemo-minitron-8b-8k-instruct', INDEX.models),
    null,
    'mistral-nemo-minitron-8b-8k-instruct must NOT match mistral-nemo-instruct-2407',
  );
});

test('a coder model never inherits any deepseek-v4 rank', async () => {
  const { matchRankingEntry } = await loadModule();

  const hit = matchRankingEntry('deepseek-ai/deepseek-coder-6.7b-instruct', INDEX.models);
  assert.equal(hit, null, 'deepseek-coder-6.7b-instruct must NOT match any deepseek-v4* entry');
});

// ───────────────────────────────────────────────────────────────────────────
// Near-prefix traps stated by the brief: never fold a base model with its
// -flash / -high / -max variant (and vice versa).
// ───────────────────────────────────────────────────────────────────────────

test('glm-5.3 is never folded into glm-5.3-flash (and the reverse)', async () => {
  const { matchRankingEntry } = await loadModule();

  const base = matchRankingEntry('z-ai/glm-5.3', INDEX.models);
  const flash = matchRankingEntry('z-ai/glm-5.3-flash', INDEX.models);
  assert.equal(base?.model_id, 'glm-5.3');
  assert.equal(flash?.model_id, 'glm-5.3-flash');
  assert.notEqual(base?.model_id, flash?.model_id, 'the two variants must not collapse onto one entry');
});

test('gpt-oss-20b is never folded into gpt-oss-20b-high (and the reverse)', async () => {
  const { matchRankingEntry } = await loadModule();

  const base = matchRankingEntry('openai/gpt-oss-20b', INDEX.models);
  assert.equal(base?.model_id, 'gpt-oss-20b', 'the base model must pick its own entry, not the (high) variant');
  assert.notEqual(base?.rank, 141, 'the gpt-oss-20b-high rank (141) must never be attributed to gpt-oss-20b');
});

test('a date-coded flash id never collapses onto a flavour of the same family', async () => {
  const { matchRankingEntry } = await loadModule();

  const hit = matchRankingEntry('deepseek-ai/deepseek-v4-flash-0731', INDEX.models);
  assert.equal(hit?.model_id, 'deepseek-v4-flash-0731');
  assert.notEqual(hit?.rank, 13, 'the deepseek-v4.1-flash rank (13) is a different model');
});

// ───────────────────────────────────────────────────────────────────────────
// Generation tokens (v3 / v4 / v4.1) are model identity, not stage markers.
// Dropping them collapsed every DeepSeek id onto the kept set [deepseek], so an
// unindexed id silently inherited the best-ranked DeepSeek entry.
// ───────────────────────────────────────────────────────────────────────────

test('an unindexed deepseek-v3.1 never inherits the deepseek-v4.1-flash rank', async () => {
  const { matchRankingEntry } = await loadModule();

  const hit = matchRankingEntry('deepseek-ai/deepseek-v3.1', INDEX.models);
  assert.equal(hit, null, 'deepseek-v3.1 is not in the index: it must stay unranked (not rank 13)');
});

test('generation tokens separate models: v3 is never a sibling of v4, v3.1 never of v3.2', async () => {
  const { matchRankingEntry, isDroppedToken } = await loadModule();

  const v4Only = [{ model_id: 'deepseek-v4', model_name: 'DeepSeek V4', rank: 5 }];
  assert.equal(matchRankingEntry('deepseek-ai/deepseek-v3', v4Only), null, 'v3 must not inherit a v4 rank');
  assert.equal(matchRankingEntry('deepseek-ai/deepseek-v3', INDEX.models), null, 'v3 must not match any v2/v3.2/v4 entry');
  const v32Only = [{ model_id: 'deepseek-v3.2', model_name: 'DeepSeek V3.2', rank: 100 }];
  assert.equal(matchRankingEntry('deepseek-ai/deepseek-v3.1', v32Only), null, 'minor versions are distinct models');
  // Same generation + a dropped flavour token is still a sibling.
  const sameGen = matchRankingEntry('deepseek-ai/deepseek-v4-instruct', v4Only);
  assert.equal(sameGen?.model_id, 'deepseek-v4');
  assert.equal(sameGen?.matched_via, 'sibling');

  for (const t of ['v1', 'v3', 'v4', 'v4.1', 'v3.2']) assert.equal(isDroppedToken(t), false, `${t} carries identity`);
  for (const t of ['flash', 'instruct', '0731', '2407']) assert.equal(isDroppedToken(t), true, `${t} carries no identity`);
});

test('an 8-digit YYYYMMDD snapshot is a revision: kimi-k3 matches kimi-k3-20250711 as a sibling', async () => {
  const { matchRankingEntry, isDroppedToken } = await loadModule();

  const dated = [{ model_id: 'kimi-k3-20250711', model_name: 'Kimi K3', rank: 7 }];
  const hit = matchRankingEntry('moonshotai/kimi-k3', dated);
  assert.equal(hit?.model_id, 'kimi-k3-20250711', 'the date snapshot must not hide the rank');
  assert.equal(hit?.matched_via, 'sibling');

  assert.equal(isDroppedToken('20250711'), true, 'a real YYYYMMDD date carries no identity');
  assert.equal(isDroppedToken('20241231'), true);
  // 4-digit codes unchanged.
  for (const t of ['0731', '2407', '2512']) assert.equal(isDroppedToken(t), true, `${t} still a date code`);
  // An 8-digit token that is not a calendar date is NOT silently dropped.
  for (const t of ['12345678', '20251399', '99990101']) assert.equal(isDroppedToken(t), false, `${t} is not a date`);
  // 6-digit tokens are not treated as dates (no fixture/convention justifies it).
  assert.equal(isDroppedToken('250711'), false);
});

test('a variant token (flash/high) never lends its rank to the base model, or the reverse', async () => {
  const { matchRankingEntry } = await loadModule();

  const flashOnly = [{ model_id: 'glm-5.3-flash', model_name: 'GLM 5.3 Flash', rank: 18 }];
  const baseOnly = [{ model_id: 'glm-5.3', model_name: 'GLM 5.3', rank: 9 }];
  assert.equal(matchRankingEntry('z-ai/glm-5.3', flashOnly), null, 'unindexed glm-5.3 must not borrow the flash rank');
  assert.equal(matchRankingEntry('z-ai/glm-5.3-flash', baseOnly), null, 'unindexed glm-5.3-flash must not borrow the base rank');
  const highOnly = [{ model_id: 'gpt-oss-20b-high', model_name: 'GPT-OSS 20B (high)', rank: 141 }];
  assert.equal(matchRankingEntry('openai/gpt-oss-20b', highOnly), null, 'a reasoning tier is a different score');
  // Noise tokens stay dropped: same variant + packaging difference is a sibling.
  const sameVariant = matchRankingEntry('z-ai/glm-5.3-flash-instruct', flashOnly);
  assert.equal(sameVariant?.model_id, 'glm-5.3-flash');
  assert.equal(sameVariant?.matched_via, 'sibling');
});

test('v1.0 equals v1, and a bare id matches only the first (v1) release', async () => {
  const { matchRankingEntry } = await loadModule();

  const v1 = [{ model_id: 'foo-bar-v1', model_name: 'Foo Bar v1', rank: 7 }];
  assert.equal(matchRankingEntry('acme/foo-bar-v1.0', v1)?.model_id, 'foo-bar-v1', 'v1.0 is the same release as v1');
  const bare = matchRankingEntry('nvidia/llama-3.1-nemotron-ultra-253b', INDEX.models);
  assert.equal(bare?.model_id, 'llama-3.1-nemotron-ultra-253b-v1');
  assert.equal(bare?.rank, 206);
  assert.equal(bare?.matched_via, 'sibling');
  const bareEntry = [{ model_id: 'llama-3.1-nemotron-ultra-253b', model_name: 'Llama 3.1 Nemotron Ultra 253B', rank: 206 }];
  assert.equal(matchRankingEntry('nvidia/llama-3.1-nemotron-ultra-253b-v1', bareEntry)?.rank, 206, 'the rule is symmetric');
  const v2 = [{ model_id: 'llama-3.1-nemotron-ultra-253b-v2', model_name: 'Llama 3.1 Nemotron Ultra 253B v2', rank: 50 }];
  assert.equal(matchRankingEntry('nvidia/llama-3.1-nemotron-ultra-253b', v2), null, 'a bare id never takes a later (v2) release');
  assert.equal(matchRankingEntry('nvidia/llama-3.1-nemotron-ultra-253b-v1', v2), null, 'v1 is never a sibling of v2');
});

test('a variant spelled only in the entry id or only in its name blocks an exact match', async () => {
  const { matchRankingEntry } = await loadModule();

  // Auditor case: the NAME looks like the base model, the ID is the flash variant.
  const nameHidesVariant = [{ model_id: 'glm-5.3-flash', model_name: 'GLM 5.3', rank: 18 }];
  assert.equal(matchRankingEntry('z-ai/glm-5.3', nameHidesVariant), null, 'the flash entry must not rank glm-5.3');
  // Reverse: the source spells the variant only in the human name.
  const idHidesVariant = [{ model_id: 'gpt-oss-20b', model_name: 'GPT-OSS 20B (high)', rank: 141 }];
  assert.equal(matchRankingEntry('openai/gpt-oss-20b', idHidesVariant), null, 'a (high) entry must not rank the base model');
  // A legitimate name-only exact match (no variant anywhere) still works.
  // (The id alone does not pair with ours: vendor fused into the id, no slash.)
  const nameOnly = matchRankingEntry('moonshotai/kimi-k3', [{ model_id: 'moonshotai-kimi-k3', model_name: 'Kimi K3', rank: 8 }]);
  assert.equal(nameOnly?.model_id, 'moonshotai-kimi-k3');
  assert.equal(nameOnly?.matched_via, 'exact');
  // The same variant on both sides still matches exactly.
  assert.equal(matchRankingEntry('z-ai/glm-5.3-flash', nameHidesVariant)?.matched_via, 'exact');
  // gpt-oss-120b is only indexed as its -high tier: it stays unranked, not #157.
  assert.equal(matchRankingEntry('openai/gpt-oss-120b', INDEX.models), null);
});

test('matchCatalog normalises each id and each entry once: O(ids + entries), not O(ids x entries)', async () => {
  const { matchCatalog, __TEST_ONLY_normalizeCallCount } = await loadModule();

  const entries = [];
  for (let i = 0; i < 120; i++) {
    entries.push({ model_id: `fam${i % 30}-${(i % 4) + 1}-${(i % 3) * 8 + 8}b${i % 5 === 0 ? '-flash' : ''}`, model_name: `Fam ${i}`, rank: i + 1 });
  }
  const ids = [];
  for (let i = 0; i < 60; i++) ids.push(`vendor/fam${i % 35}-${(i % 4) + 1}-${(i % 3) * 8 + 8}b`);

  const c0 = __TEST_ONLY_normalizeCallCount();
  const first = matchCatalog(ids, entries);
  const c1 = __TEST_ONLY_normalizeCallCount();
  assert.ok(c1 - c0 <= ids.length + 2 * entries.length, `cold call: ${c1 - c0} normalisations > ids + 2*entries`);
  const second = matchCatalog(ids, entries);
  const c2 = __TEST_ONLY_normalizeCallCount();
  assert.ok(c2 - c1 <= ids.length, `warm call: ${c2 - c1} normalisations > ids (entry cache not reused)`);
  assert.deepEqual([...second], [...first], 'the cache must not change the result');

  // Staleness guard: an entry mutated in place is re-normalised, not served stale.
  const target = [{ model_id: 'glm-5.3', model_name: 'GLM 5.3', rank: 9 }];
  assert.equal(matchCatalog(['z-ai/glm-5.3'], target).get('z-ai/glm-5.3')?.rank, 9);
  target[0].model_id = 'glm-5.3-flash';
  target[0].model_name = 'GLM 5.3 Flash';
  assert.equal(matchCatalog(['z-ai/glm-5.3'], target).size, 0, 'a mutated entry must be re-read');
});

test('every VERIFIED_SIBLINGS pair still resolves to its documented counterpart', async () => {
  const { matchRankingEntry, VERIFIED_SIBLINGS } = await loadModule();

  for (const [ourId, theirId] of VERIFIED_SIBLINGS) {
    const hit = matchRankingEntry(ourId, INDEX.models);
    assert.equal(hit?.model_id, theirId, `${ourId} must still match ${theirId}`);
    assert.equal(hit?.matched_via, 'sibling');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// No candidate / empty / hostile input
// ───────────────────────────────────────────────────────────────────────────

test('a model absent from the index gets no rank at all', async () => {
  const { matchRankingEntry } = await loadModule();

  for (const ourId of ['google/deplot', 'nvidia/nvclip', 'writer/palmyra-med-70b', 'adept/fuyu-8b']) {
    assert.equal(matchRankingEntry(ourId, INDEX.models), null, `${ourId} must stay unranked`);
  }
});

test('hostile and empty inputs never throw and never fabricate a match', async () => {
  const { matchRankingEntry, matchCatalog } = await loadModule();

  for (const bad of [undefined, null, '', '   ', 42, {}, [], 'a/'.repeat(200)]) {
    assert.equal(matchRankingEntry(bad, INDEX.models), null, `${String(bad)} must yield null`);
  }
  for (const badIndex of [undefined, null, {}, 'models', [], [null], [{ model_id: 42 }], [{}]]) {
    assert.equal(matchRankingEntry('z-ai/glm-5.3', badIndex), null, 'a malformed index must yield null');
  }
  assert.deepEqual([...matchCatalog([], INDEX.models)], [], 'an empty catalogue matches nothing');
  assert.deepEqual([...matchCatalog(undefined, INDEX.models)], [], 'a missing catalogue matches nothing');
});

test('an entry missing a usable rank is not a match (no invented score)', async () => {
  const { matchRankingEntry } = await loadModule();

  // The endpoint could start omitting rank; a rankless entry carries no claim.
  const index = { models: [{ model_id: 'glm-5.3', model_name: 'GLM 5.3', conservative: 52.71 }] };
  assert.equal(matchRankingEntry('z-ai/glm-5.3', index.models), null,
    'an entry without a numeric rank must not produce a ranking row');
});

// ───────────────────────────────────────────────────────────────────────────
// Catalogue-wide matching + the empty-cache degradation contract
// ───────────────────────────────────────────────────────────────────────────

test('matchCatalog returns only ranked models, keyed by our exact id', async () => {
  const { matchCatalog } = await loadModule();

  const catalogue = [
    'moonshotai/kimi-k3',
    'z-ai/glm-5.3',
    'google/deplot',
    'mistralai/mistral-large',
  ];
  const matched = matchCatalog(catalogue, INDEX.models);

  assert.equal(matched.size, 3, 'exactly the three rankable ids must be present');
  assert.equal(matched.get('moonshotai/kimi-k3').rank, 8);
  assert.equal(matched.get('z-ai/glm-5.3').rank, 9);
  assert.equal(matched.get('mistralai/mistral-large').rank, 271);
  assert.equal(matched.has('google/deplot'), false, 'an unmatched model must have NO entry');
});

test('folding 82 catalogue ids over this index yields exactly 24 matches', async () => {
  const { matchCatalog } = await loadModule();

  const allOurIds = [
    ...EXACT_CASES.map(([our]) => our),
    ...SIBLING_CASES.map(([our]) => our),
    'google/deplot', 'nvidia/nvclip', 'adept/fuyu-8b', 'meta/llama-3.2-90b-vision-instruct',
    'meta/llama-3.2-11b-vision-instruct', 'nvidia/mistral-nemo-minitron-8b-8k-instruct',
    'deepseek-ai/deepseek-coder-6.7b-instruct',
  ];
  const matched = matchCatalog(allOurIds, INDEX.models);
  assert.equal(matched.size, 24, 'exactly 24 of the sampled catalogue must resolve');
});

// ───────────────────────────────────────────────────────────────────────────
// Module shape: import-free-ish (node builtins only) and no invented data
// ───────────────────────────────────────────────────────────────────────────

test('the ranking module never reads the sandbox fixture at runtime', async () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.doesNotMatch(source, /llm-coverage-check|our_models\.json|match_results\.json|zer_eval_index/,
    'the module must depend on the live endpoint, never on the sandbox reference data');
});

test('the ranking module declares the licence-required attribution and source URL', async () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.match(source, /llm-stats\.com/, 'the module must carry the source URL for attribution');
  assert.match(source, /Data by LLM Stats/i, 'the module must carry the required attribution string');
});

// ───────────────────────────────────────────────────────────────────────────
// Caller-supplied logger seam (D2) + failure backoff.
//
// GET /admin/models passes `{ logger: (outcome) => logInfo('llm_stats_ranking', outcome) }`
// into getCatalogRanking(), expecting fetch failures to land in gateway.jsonl.
// The module used to read ONLY `options.force`, so the caller's logger was
// silently dropped and a failed fetch produced NO gateway log entry at all —
// despite the doc comment claiming it was logged honestly.
//
// These tests drive the PUBLIC api (getCatalogRanking) exactly as admin-api.mjs
// does, so they fail if the wiring regresses even though __setLoggerForTests__
// still exists for unit-level capture.
// ───────────────────────────────────────────────────────────────────────────

test('a failed fetch is reported through the caller-supplied logger seam', async () => {
  const mod = await loadModule();
  mod.__resetForTests__();

  const seen = [];
  mod.__setFetcherForTests__(async () => {
    throw new Error('LLM Stats index returned HTTP 403');
  });

  const ranking = await mod.getCatalogRanking(['z-ai/glm-5.3'], {
    force: true,
    logger: (outcome) => seen.push(outcome),
  });

  assert.equal(ranking.size, 0, 'a failed fetch with no cache must rank nothing');

  const failure = seen.find((entry) => entry && entry.event === 'llm_stats_index_failed');
  assert.ok(failure,
    'the caller-supplied logger must receive the failure event: the caller passes it precisely so a 403/timeout ' +
    'lands in gateway.jsonl, and silently dropping it hides upstream breakage');
  assert.match(String(failure.error), /403/, 'the logged error must be the honest upstream failure');
  assert.equal(failure.usingCache, false, 'with no cache the failure must say so');
});

test('a successful fetch is still reported through the caller-supplied logger seam', async () => {
  const mod = await loadModule();
  mod.__resetForTests__();

  const seen = [];
  mod.__setFetcherForTests__(async () => ({
    models: [{ model_id: 'glm-5.3', model_name: 'GLM 5.3', rank: 9, conservative: 52.71 }],
  }));

  const ranking = await mod.getCatalogRanking(['z-ai/glm-5.3'], {
    force: true,
    logger: (outcome) => seen.push(outcome),
  });

  assert.equal(ranking.get('z-ai/glm-5.3')?.rank, 9, 'the genuine match must still resolve');
  const refreshed = seen.find((entry) => entry && entry.event === 'llm_stats_index_refreshed');
  assert.ok(refreshed, 'a successful refresh must be reported through the same caller seam');
  assert.equal(refreshed.count, 1, 'the refresh event must carry the entry count');
});

test('a failed refresh is backed off instead of retried on every call', async () => {
  const mod = await loadModule();
  mod.__resetForTests__();

  let fetchAttempts = 0;
  mod.__setFetcherForTests__(async () => {
    fetchAttempts += 1;
    throw new Error('LLM Stats index timeout');
  });

  // Mirrors /admin/models being hit repeatedly while the upstream is down.
  await mod.getCatalogRanking(['z-ai/glm-5.3']);
  await mod.getCatalogRanking(['z-ai/glm-5.3']);
  await mod.getCatalogRanking(['z-ai/glm-5.3']);

  assert.equal(fetchAttempts, 1,
    'after a failure the module must observe a bounded backoff window: three /admin/models calls inside the ' +
    'grace period must produce ONE upstream attempt, not three');

  // `force` is an explicit operator action (manual refresh) and must bypass the
  // backoff so a human can retry immediately.
  await mod.getCatalogRanking(['z-ai/glm-5.3'], { force: true });
  assert.equal(fetchAttempts, 2, 'an explicit forced refresh must bypass the failure backoff');
});

// ───────────────────────────────────────────────────────────────────────────
// Bounded response body (AGENTS.md invariant: no unbounded memory buffers).
//
// The non-stream path must collect the body through createBoundedBuffer() and
// reject — never silently truncate and never OOM — once it exceeds
// MAX_RESPONSE_BYTES. These tests drive the REAL defaultFetchIndex by
// redirecting the module's own node:https import; the fake response streams more
// than the 4 MiB cap one 256 KiB chunk at a time.
// ───────────────────────────────────────────────────────────────────────────

test('a response body over MAX_RESPONSE_BYTES is destroyed with an honest error, not silently truncated', async () => {
  const mod = await loadModule();
  mod.__resetForTests__(); // restores the real fetcher as the default

  const originalGet = https.get;
  const chunk = Buffer.from('x'.repeat(256 * 1024));
  const CHUNKS = 20; // 20 * 256 KiB = 5 MiB > 4 MiB cap
  const req = /** @type {any} */ (new EventEmitter());
  req.destroy = (error) => { if (error) req.emit('error', error); };
  req.setTimeout = () => {};
  /** @type {any} */ (https).get = (_url, _options, callback) => {
    const res = /** @type {any} */ (new EventEmitter());
    res.statusCode = 200;
    res.resume = () => {};
    callback(res);
    // Stream past the cap on a later tick so the data handler chain is attached.
    setImmediate(() => {
      for (let i = 0; i < CHUNKS; i++) res.emit('data', chunk);
      res.emit('end');
    });
    return req;
  };

  try {
    // The bounded collector must reject the fetch itself. getCatalogRanking()
    // swallows fetch failures (returns the cache / null) by design, so the
    // observable proof is the recorded failure event carrying the honest error.
    const seen = [];
    const models = await mod.getRankingEntries({ force: true, logger: (outcome) => seen.push(outcome) });
    assert.equal(models, null, 'an oversized response must not yield entries');
    const failure = seen.find((entry) => entry && entry.event === 'llm_stats_index_failed');
    assert.ok(failure, 'the oversized fetch must be reported as a failure');
    assert.match(String(failure.error), /too large/i, 'the failure must name the size cap, not a parse error');
  } finally {
    https.get = originalGet;
  }
});

test('a response body within MAX_RESPONSE_BYTES still parses successfully', async () => {
  const mod = await loadModule();
  mod.__resetForTests__();

  const originalGet = https.get;
  const body = JSON.stringify({ models: [{ model_id: 'glm-5.3', model_name: 'GLM 5.3', rank: 9, conservative: 52.71 }] });
  const req = /** @type {any} */ (new EventEmitter());
  req.destroy = () => {};
  req.setTimeout = () => {};
  /** @type {any} */ (https).get = (_url, _options, callback) => {
    const res = /** @type {any} */ (new EventEmitter());
    res.statusCode = 200;
    res.resume = () => {};
    callback(res);
    setImmediate(() => {
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });
    return req;
  };

  try {
    const models = await mod.getRankingEntries({ force: true });
    assert.equal(models?.[0]?.model_id, 'glm-5.3', 'an in-bounds body must still parse through the bounded collector');
  } finally {
    https.get = originalGet;
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Cache-first accessor (/admin/models must not block on the upstream fetch).
// ───────────────────────────────────────────────────────────────────────────

test('getCatalogRankingFromCache ranks from the loaded index without awaiting the fetch', async () => {
  const mod = await loadModule();
  mod.__resetForTests__();

  // Seed the in-memory index.
  mod.__setFetcherForTests__(async () => ({
    models: [{ model_id: 'glm-5.3', model_name: 'GLM 5.3', rank: 9, conservative: 52.71 }],
  }));
  await mod.getRankingEntries({ force: true });

  // Expire the TTL so the accessor kicks off a refresh, and make that refresh
  // hang. The cache-first ranking must return immediately regardless.
  mod.__setTtlMsForTests__(1);
  await new Promise((resolve) => setTimeout(resolve, 5));

  let backgroundStarted = false;
  mod.__setFetcherForTests__(() => { backgroundStarted = true; return new Promise(() => {}); });

  const startedAt = Date.now();
  const ranking = await mod.getCatalogRankingFromCache(['z-ai/glm-5.3']);
  const elapsed = Date.now() - startedAt;
  assert.equal(ranking.get('z-ai/glm-5.3')?.rank, 9,
    'the already-loaded index must be served immediately');
  assert.ok(elapsed < 200, `the call must not await the hanging fetch (took ${elapsed}ms)`);
  assert.equal(backgroundStarted, true, 'the refresh must still be kicked off in the background');
});

test('getCatalogRankingFromCache kicks off a refresh when the index is stale', async () => {
  const mod = await loadModule();
  mod.__resetForTests__();

  mod.__setFetcherForTests__(async () => ({
    models: [{ model_id: 'glm-5.3', model_name: 'GLM 5.3', rank: 9, conservative: 52.71 }],
  }));
  await mod.getRankingEntries({ force: true });

  // Expire the TTL so the background call is not short-circuited by freshness.
  mod.__setTtlMsForTests__(1);
  await new Promise((resolve) => setTimeout(resolve, 5));

  let backgroundStarted = false;
  mod.__setFetcherForTests__(async () => {
    backgroundStarted = true;
    return { models: [{ model_id: 'glm-5.3', model_name: 'GLM 5.3', rank: 9, conservative: 52.71 }] };
  });

  const ranking = await mod.getCatalogRankingFromCache(['z-ai/glm-5.3']);
  assert.equal(ranking.get('z-ai/glm-5.3')?.rank, 9, 'the stale-but-present index is still served immediately');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(backgroundStarted, true, 'a stale index must trigger the background refresh');
});

test('getCatalogRankingFromCache returns an empty map (never a fabricated rank) when nothing is loaded', async () => {
  const mod = await loadModule();
  mod.__resetForTests__();

  mod.__setFetcherForTests__(async () => {
    throw new Error('LLM Stats index timeout');
  });

  const ranking = await mod.getCatalogRankingFromCache(['z-ai/glm-5.3']);
  assert.equal(ranking.size, 0, 'with no index every model stays unranked');
  assert.equal(ranking.get('z-ai/glm-5.3'), undefined, 'no rank may be invented');
});

test('getCatalogRankingFromCache serves a persisted cache on the FIRST (cold) call', async () => {
  // Cold start: a fresh module instance (no in-memory state) with a valid cache
  // file on disk. The FIRST call must load that cache synchronously — reading
  // state.models without ensureLoaded() yielded an empty map until the
  // fire-and-forget refresh happened to land, defeating the cache-first design.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvgw-llm-stats-cold-'));
  const cachePath = path.join(cacheDir, 'llm-stats-ranking.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 1,
    fetched_at: Date.now(),
    models: [{ model_id: 'glm-5.3', model_name: 'GLM 5.3', organization_id: 'zai-org', rank: 9, conservative: 52.71 }],
  }), 'utf8');

  const previousCachePath = process.env.GATEWAY_LLM_STATS_CACHE_PATH;
  process.env.GATEWAY_LLM_STATS_CACHE_PATH = cachePath;
  let mod;
  try {
    mod = await loadModule(); // fresh module state; cachePath resolved from the env var
    mod.__setFetcherForTests__(async () => {
      throw new Error('LLM Stats index timeout');
    });

    const ranking = await mod.getCatalogRankingFromCache(['z-ai/glm-5.3']);
    assert.equal(ranking.get('z-ai/glm-5.3')?.rank, 9,
      'the persisted cache must be served on the very first call, before any refresh');
    assert.equal(mod.getLlmStatsSnapshot().fromCache, true,
      'the served index must be the persisted one, not an invented in-memory state');
  } finally {
    if (previousCachePath === undefined) delete process.env.GATEWAY_LLM_STATS_CACHE_PATH;
    else process.env.GATEWAY_LLM_STATS_CACHE_PATH = previousCachePath;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// --- Audit H1-H3: a mid-body upstream reset (only aborted/close fire) must not hang ---
import http from "node:http";


async function startHangServer(mode) {
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits++;
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        if (mode === "overflow") { res.write(Buffer.alloc(300 * 1024, 0x78)); return; } // never ends
        res.write('{"partial":[');
        setTimeout(() => req.socket.destroy(), 30);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return { port, hits: () => hits, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

function withinMs(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("HANG")), ms); })])
        .finally(() => clearTimeout(timer));
}
test("H2: a mid-body index reset settles getRankingEntries within 2 s and a second fetch can start", async () => {
    const mod = await loadModule();
    mod.__resetForTests__();
    const server = await startHangServer("reset");
    const originalGet = https.get;
    https.get = (url, options, cb) => http.get(`http://127.0.0.1:${server.port}${new URL(url).pathname}`, options, cb);
    try {
        const seen = [];
        const first = await withinMs(mod.getRankingEntries({ force: true, logger: (o) => seen.push(o) }), 2000);
        assert.equal(first, null);
        assert.ok(seen.some((e) => e && e.event === "llm_stats_index_failed"), "the reset must surface as a failed refresh");
        await withinMs(mod.getRankingEntries({ force: true, logger: () => {} }), 2000);
        assert.equal(server.hits(), 2, "refreshInFlight must clear so the next fetch reaches upstream");
    } finally {
        https.get = originalGet;
        mod.__resetForTests__();
        await server.close();
    }
});

// --- Audit LOW: pin the res "close" listener. Only aborted + close fire: no error, no end. ---
function closeOnlyMock() {
    let calls = 0;
    const fake = (...args) => {
        calls++;
        const cb = args.find((a) => typeof a === "function");
        const req = new EventEmitter();
        req.setTimeout = () => req; req.destroy = () => {}; req.end = () => {};
        const res = new EventEmitter();
        res.statusCode = 200; res.headers = {}; res.resume = () => {}; res.destroy = () => {};
        queueMicrotask(() => {
            cb(res);
            setImmediate(() => { res.emit("data", Buffer.from('{"partial":[')); res.emit("aborted"); res.emit("close"); });
        });
        return req;
    };
    return { fake, calls: () => calls };
}
test("H2 close-only: aborted+close without error/end fails the index fetch and clears refreshInFlight", async () => {
    const mod = await loadModule();
    mod.__resetForTests__();
    const mock = closeOnlyMock();
    const originalGet = https.get;
    https.get = mock.fake;
    try {
        const seen = [];
        assert.equal(await withinMs(mod.getRankingEntries({ force: true, logger: (o) => seen.push(o) }), 1000), null);
        const failure = seen.find((e) => e && e.event === "llm_stats_index_failed");
        assert.match(String(failure?.error), /closed before end/);
        await withinMs(mod.getRankingEntries({ force: true, logger: () => {} }), 1000);
        assert.equal(mock.calls(), 2, "a second fetch must reach upstream");
    } finally {
        https.get = originalGet;
        mod.__resetForTests__();
    }
});
