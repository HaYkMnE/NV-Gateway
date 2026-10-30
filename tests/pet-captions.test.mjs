// PET-SPEC 2026-10-26 section 2 (activity captions, donation hint) and 9.2
// (the old CTA / jar rows are gone). The pure caption helpers exported by
// PetWidget.tsx are run for real; the JSX wiring is pinned at source level.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const SRC = read('src/renderer/pet/PetWidget.tsx');
const ENGINE = read('src/renderer/pet/petEngine.ts');
const LOCALES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];
const OLD_KEYS = ['pet_cta_main', 'pet_cta_sub', 'pet_jar_title', 'pet_jar_subtitle'];

function loadWidget() {
  const compiled = typescript.transpileModule(SRC, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React },
  }).outputText;
  const stubs = {
    react: {}, 'react-i18next': {}, '@tanstack/react-query': {}, 'react-router-dom': {}, 'lucide-react': {},
    '../lib/api': {}, '../lib/modal-context': {}, './tips': {}, './pet.css': {}, './audioEngine': { petAudio: {} }, './petEngine': {},
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, console, performance, Math, Number,
    window: { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    require: (id) => { if (id in stubs) return stubs[id]; throw new Error(`unexpected require: ${id}`); },
  }, { filename: 'src/renderer/pet/PetWidget.tsx' });
  return mod.exports;
}

function loadResources() {
  const compiled = typescript.transpileModule(read('src/renderer/i18n/resources.ts'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: 'resources.ts' });
  return module.exports;
}

/** Activity ids of a `const NAME: readonly ...[] = [ ... ];` pool in petEngine.ts. */
function enginePool(name) {
  const start = ENGINE.indexOf(`const ${name}:`);
  assert.ok(start >= 0, `petEngine.ts must declare ${name}`);
  const block = ENGINE.slice(start, ENGINE.indexOf('];', start));
  return [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}

const W = loadWidget();
const res = loadResources();
const ACTIVITIES = [...enginePool('MASCOT_ACTIVITIES'), ...enginePool('HACKER_ACTIVITIES'), ...enginePool('VIP_ACTIVITIES')];

function seeded(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

test('engine pools: 7 mascot + 7 hacker + 5 VIP activities, all with a caption icon', () => {
  assert.equal(ACTIVITIES.length, 19);
  for (const activity of ACTIVITIES) assert.ok(activity in W.CAPTION_ICONS, `${activity} has a caption icon (spec 2.3)`);
});

test('pickCaptionVariant never repeats back to back (200 draws per activity, several seeds)', () => {
  for (const seed of [1, 7, 42]) {
    const random = seeded(seed);
    for (const activity of ACTIVITIES) {
      let last = null;
      for (let i = 0; i < 200; i += 1) {
        const next = W.pickCaptionVariant(activity, last, random);
        assert.ok(Number.isInteger(next) && next >= 0 && next < W.CAPTION_VARIANT_COUNT, `${activity}: variant ${next} in range`);
        if (last !== null) assert.notEqual(next, last, `${activity}: draw ${i} repeated variant ${last}`);
        last = next;
      }
    }
  }
  // Edge values of the random source stay in range and still avoid the last variant.
  assert.equal(W.pickCaptionVariant('bug-hunter', 0, () => 0.999999999), 1);
  assert.equal(W.pickCaptionVariant('bug-hunter', 1, () => 0), 0);
  assert.equal(W.pickCaptionVariant('bug-hunter', null, () => Number.NaN), 0);
  assert.equal(W.pickCaptionVariant('unknown-activity', 0, () => 0.5), 0, 'unknown activity -> variant 0');
});

test('every engine activity has its caption keys in EN, and the special/hint keys exist', () => {
  for (const activity of ACTIVITIES) {
    for (let n = 0; n < W.CAPTION_VARIANT_COUNT; n += 1) {
      const key = W.captionKey(activity, n);
      assert.equal(key, `pet_caption_${activity.replace(/-/g, '_')}_${n}`);
      assert.ok(typeof res.en[key] === 'string' && res.en[key].trim() !== '', `en.${key}`);
    }
  }
  assert.equal(res.en.pet_hint_donate, 'click to support the gateway');
  assert.ok(res.en.pet_caption_joy && res.en.pet_caption_celebration);
});

test('captions are at most 28 characters in every locale; hint and caption keys in all 7', () => {
  const captionKeys = Object.keys(res.en).filter((key) => key.startsWith('pet_caption_'));
  assert.equal(captionKeys.length, 40, '38 activity captions + joy + celebration (spec 2.3)');
  for (const locale of LOCALES) {
    const dict = res[locale];
    for (const key of captionKeys) {
      assert.ok(typeof dict[key] === 'string' && dict[key].trim() !== '', `${locale}.${key}`);
      assert.ok([...dict[key]].length <= 28, `${locale}.${key} is ${[...dict[key]].length} chars: "${dict[key]}"`);
    }
    assert.ok(typeof dict.pet_hint_donate === 'string' && dict.pet_hint_donate.trim() !== '', `${locale}.pet_hint_donate`);
  }
});

test('the 4 obsolete CTA/jar keys are gone from every locale and from src/renderer', () => {
  for (const locale of LOCALES) {
    for (const key of OLD_KEYS) assert.equal(key in res[locale], false, `${locale}.${key} must be removed (spec 2.2)`);
  }
  for (const key of OLD_KEYS) assert.doesNotMatch(SRC, new RegExp(key), `PetWidget no longer references ${key}`);
  assert.doesNotMatch(SRC, /context-cta|cta-subtext|jar-title|jar-subtitle/);
  const css = read('src/renderer/pet/pet.css');
  assert.doesNotMatch(css, /\.context-cta|\.cta-text|\.cta-subtext|\.jar-title|\.jar-subtitle/, 'old CSS rules removed (spec 9.2)');
});

test('widget JSX: decorative caption + hint inside .widget-btn, which keeps its accessible name', () => {
  const btn = SRC.slice(SRC.indexOf('ref={widgetBtnRef}'), SRC.indexOf('</button>', SRC.indexOf('{character === \'mascot\' && caption}')));
  assert.match(btn, /aria-label=\{t\('pet_support_aria'\)\}/);
  assert.match(btn, /\{character === 'mascot' && caption\}/);
  assert.match(btn, /<div className="pet-hint" aria-hidden="true">\s*<Heart size=\{11\} aria-hidden="true" \/>\s*<span>\{t\('pet_hint_donate'\)\}<\/span>/);
  assert.match(SRC, /<div className="jar-box">[\s\S]{0,2000}?\{caption\}\s*<\/div>/, 'hacker: caption sits next to the jar art');
  assert.match(SRC, /<div className=\{`pet-caption pet-caption-\$\{character\}`\} aria-hidden="true">/);
  assert.match(SRC, /<span key=\{captionText\} className="pet-caption-text">\{captionText\}<\/span>/);
  // The variant is picked in the same commit as the activity, per activity.
  const change = SRC.slice(SRC.indexOf('const handleActivityChange'), SRC.indexOf('const handleCue'));
  assert.ok(change.indexOf('setActivity(next)') < change.indexOf('setCaptionIndex(variant)'));
  assert.match(change, /pickCaptionVariant\(next, lastCaptionRef\.current\[next\] \?\? null\)/);
});

test('pet.css: caption/hint values per spec 2.1/2.2 and an opacity-only reduced-motion fade', () => {
  const css = read('src/renderer/pet/pet.css');
  const rule = (sel) => {
    const m = css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `missing ${sel}`);
    return m[1];
  };
  const cap = rule('.nv-pet-wrap .pet-caption');
  for (const decl of ['gap: 6px', 'margin-top: 6px', 'width: 100%', 'height: 30px', 'contain: layout paint', 'padding-inline: 6px', 'color: var(--pet-cyan)', 'forced-color-adjust: auto']) {
    assert.ok(cap.includes(decl), `.pet-caption ${decl}`);
  }
  assert.ok(rule('.nv-pet-wrap .pet-caption-hacker').includes('color: var(--pet-neon)'));
  const text = rule('.nv-pet-wrap .pet-caption-text');
  for (const decl of ['font-size: 11px', 'line-height: 14px', 'font-weight: 700', 'letter-spacing: 0.4px', '-webkit-line-clamp: 2', 'overflow-wrap: anywhere']) {
    assert.ok(text.includes(decl), `.pet-caption-text ${decl}`);
  }
  assert.doesNotMatch(text, /text-transform/);
  const hint = rule('.nv-pet-wrap .pet-hint');
  // PET-SPEC §11.5: was 8px / 11px / var(--pet-dim) / 0.4px -> 11px / 14px / #7A8CA0 / 0.2px.
  for (const decl of ['font-size: 11px', 'line-height: 14px', 'font-weight: 400', 'letter-spacing: 0.2px', 'color: #7A8CA0', 'margin-top: 2px', 'gap: 4px']) {
    assert.ok(hint.includes(decl), `.pet-hint ${decl}`);
  }
  assert.match(css, /--pet-dim: #7A8CA0;/);
  assert.ok(rule('.nv-pet-wrap .widget-btn:hover .pet-hint').includes('color: var(--pet-txt)'));
  assert.ok(rule('.nv-pet-wrap .widget-btn:hover .pet-hint svg').includes('color: var(--pet-danger)'));
  const rm = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce) {', css.indexOf('@keyframes nv-pet-rmFade')));
  assert.match(rm, /\.pet-caption-text \{\s*animation: nv-pet-captionFade 200ms ease-in-out 1 !important;/);
  assert.match(css, /@keyframes nv-pet-captionFade \{\s*0% \{ opacity: 0; \}\s*100% \{ opacity: 1; \}\s*\}/, 'no translate under reduced motion');
});
