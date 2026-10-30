// Rest-mode GPU fix (art-director decision 01.10): the ease-in-out of the idle
// breathing is baked into the keyframes (17 stops, one every 6.25 %), awake runs
// them `linear`, rest quantises them with steps(6, jump-end) (~30 fps) so the
// compositor stops redrawing at the display rate. Same keyframes name, so
// entering rest never restarts the animation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/renderer/pet/pet.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function cssRules(text) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    rules.push({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2], index: m.index });
  }
  return rules;
}

// Original 5-stop breathing (pre-bake values): [translateY %, rotate deg, scaleX, scaleY].
const ORIGINAL = {
  0: [0, 0, 1, 1],
  25: [-3.3333, -1.5, 0.98, 1.02],
  50: [-0.8333, 0.5, 1, 1],
  75: [2.5, 1.2, 1.02, 0.98],
  100: [0, 0, 1, 1],
};

// cubic-bezier(.42,0,.58,1) evaluated at t (bisection on x(s), then y(s)).
function easeInOut(t) {
  const bez = (s, a, b) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (bez(mid, 0.42, 0.58) < t) lo = mid; else hi = mid;
  }
  return bez((lo + hi) / 2, 0, 1);
}

function keyframeStops() {
  const kf = css.match(/@keyframes nv-pet-mascotHoverPhysics \{([\s\S]*?)\n\}/);
  assert.ok(kf, '@keyframes nv-pet-mascotHoverPhysics (same name) must exist');
  const stops = new Map();
  const re = /([\d.%,\s]+)\{\s*transform: translateY\((-?[\d.]+)%\) rotate\((-?[\d.]+)deg\) scale\((-?[\d.]+), (-?[\d.]+)\); \}/g;
  let m;
  let count = 0;
  while ((m = re.exec(kf[1])) !== null) {
    count++;
    for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      assert.match(sel, /^[\d.]+%$/);
      stops.set(Number.parseFloat(sel), [m[2], m[3], m[4], m[5]].map(Number));
    }
  }
  const blocks = (kf[1].match(/\{/g) ?? []).length;
  assert.equal(count, blocks, 'every keyframe block is a translateY/rotate/scale transform');
  return stops;
}

test('breathing keyframes: 17 stops every 6.25 %, anchors equal the originals exactly', () => {
  const stops = keyframeStops();
  const pcts = [...stops.keys()].sort((a, b) => a - b);
  assert.deepEqual(pcts, Array.from({ length: 17 }, (_, i) => i * 6.25));
  for (const [pct, values] of Object.entries(ORIGINAL)) {
    assert.deepEqual(stops.get(Number(pct)), values, `${pct}% anchor unchanged`);
  }
});

test('breathing keyframes: interior stops are the ease-in-out progress, interpolated linearly', () => {
  const fractions = [0.25, 0.5, 0.75].map(easeInOut);
  assert.ok(Math.abs(fractions[0] - 0.129) < 1e-3 && Math.abs(fractions[1] - 0.5) < 1e-9 && Math.abs(fractions[2] - 0.871) < 1e-3);
  const stops = keyframeStops();
  const anchors = [0, 25, 50, 75, 100];
  for (let seg = 0; seg < 4; seg++) {
    const a = ORIGINAL[anchors[seg]];
    const b = ORIGINAL[anchors[seg + 1]];
    fractions.forEach((f, k) => {
      const pct = anchors[seg] + (k + 1) * 6.25;
      const got = stops.get(pct);
      a.forEach((av, j) => {
        const want = av + (b[j] - av) * f;
        assert.ok(Math.abs(got[j] - want) <= 1e-3, `${pct}% component ${j}: ${got[j]} vs ${want}`);
      });
    });
  }
});

test('awake breathing runs the baked keyframes linear (same name, 3.2 s, infinite)', () => {
  const rules = cssRules(css);
  const svg = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === '.nv-pet-wrap .mascot-svg');
  assert.ok(svg);
  assert.match(svg.body, /animation: nv-pet-mascotHoverPhysics 3\.2s linear infinite;/);
  assert.doesNotMatch(svg.body, /ease-in-out/);
});

const specificity = (sel) => {
  const classes = (sel.match(/\.[\w-]+|:(?!not\()[\w-]+|\[[^\]]*\]/g) ?? []).length;
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  return ids * 100 + classes;
};

test('rest quantises the breathing with steps(6, jump-end) and wins on specificity', () => {
  const rules = cssRules(css);
  // Keyframe stop blocks (0%, from, to) carry per-segment easing (spec 2026-10-26
  // §3.1 click joy); they are not overrides on .mascot-svg, so they are excluded.
  const rest = rules.filter((r) => /animation-timing-function/.test(r.body)
    && !r.selectors.every((s) => /^(from|to|\d+(\.\d+)?%)$/.test(s.trim())));
  assert.equal(rest.length, 1, 'exactly one timing-function override');
  assert.deepEqual(rest[0].selectors, ['.nv-pet-wrap.nv-pet-rest .mascot-svg']);
  assert.equal(rest[0].body.trim(), 'animation-timing-function: steps(6, jump-end);');
  assert.doesNotMatch(rest[0].body, /jump-none|animation:/);

  // Every other rule that sets `animation` on the svg without an activity class
  // (i.e. can apply alongside rest) must lose: lower specificity, or equal and earlier.
  const own = specificity(rest[0].selectors[0]);
  const svgAnimators = rules.filter((r) => r !== rest[0] && /(^|;)\s*animation\s*:/.test(r.body))
    .flatMap((r) => r.selectors.filter((s) => /\.mascot-svg$/.test(s) && !/\.act-/.test(s)).map((s) => ({ s, index: r.index })));
  assert.ok(svgAnimators.some((x) => x.s === '.nv-pet-wrap .mascot-svg'));
  for (const x of svgAnimators) {
    const sp = specificity(x.s);
    assert.ok(sp < own || (sp === own && x.index < rest[0].index), `${x.s} would override the rest timing`);
  }
});
