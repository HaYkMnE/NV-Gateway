import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

// ───────────────────────────────────────────────────────────────────────────
// Shipped-size guard, Lever 1: only the packages the RUNTIME can actually
// reach may sit in package.json `dependencies`.
//
// Why this is a config test and not a deletion script: electron-builder packs
// the production dependency CLOSURE — it starts from package.json
// `dependencies` and walks each package's own `dependencies`, honouring NESTED
// node_modules (electron-updater carries its own copies of
// builder-util-runtime / fs-extra / jsonfile / semver / universalify because
// the hoisted root copies are different versions). A hand-maintained delete
// list at the top level would silently drop those nested copies and break
// auto-update in the packaged build ONLY. The declarative fix — demoting
// renderer-only packages to devDependencies — leaves the nested resolution
// to the tool that understands it.
//
// The renderer needs none of these at runtime: Vite inlines every renderer
// import into build/renderer at build time (verified: zero `node_modules`
// references in the emitted bundle), so they are build-time-only.
//
// Reachability was measured, not assumed: the compiled main process
// (build/src/main + build/src/preload) bare-requires exactly `electron`,
// `electron-updater` and `jsonc-parser`; everything else is `node:` builtins.
// The gateway bundle (build/gateway/server.mjs) imports `node:` builtins only.
// There is no dynamic require/createRequire/eval/import() in either.
// ───────────────────────────────────────────────────────────────────────────

/** The exact set of packages allowed in `dependencies`. Pinned, not pattern-matched. */
const ALLOWED_RUNTIME_DEPENDENCIES = Object.freeze(['electron-updater', 'jsonc-parser']);

/** Provided by the Electron runtime itself, so it is not (and must not be) packed. */
const RUNTIME_PROVIDED = new Set(['electron']);

/** Collect every bare (non-relative, non-`node:`) module specifier the shipped code loads. */
function shippedBareSpecifiers() {
  const specifiers = new Set();
  const scanFile = (file) => {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) specifiers.add(match[1]);
    for (const match of source.matchAll(/(?:^|[\s;])import\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g)) specifiers.add(match[1]);
    for (const match of source.matchAll(/(?:^|[\s;])export\s+[^'";]+?\s+from\s+["']([^"']+)["']/g)) specifiers.add(match[1]);
  };
  const scanTree = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) scanTree(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) scanFile(full);
    }
  };
  scanTree(path.join(root, 'build', 'src', 'main'));
  scanTree(path.join(root, 'build', 'src', 'preload'));
  scanFile(path.join(root, 'build', 'gateway', 'server.mjs'));
  for (const specifier of [...specifiers]) {
    if (specifier.startsWith('node:') || specifier.startsWith('.')) specifiers.delete(specifier);
  }
  return specifiers;
}

test('package.json ships only the reachable runtime closure in `dependencies`', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [...ALLOWED_RUNTIME_DEPENDENCIES].sort(),
    'renderer-only packages (react, lucide-react, i18next, qrcode, …) are build-time-only: '
    + 'Vite inlines them into build/renderer, so they belong in devDependencies, not in the shipped archive');
});

test('the pinned dependency set is exactly what the shipped code loads (non-vacuous both ways)', () => {
  const bundle = path.join(root, 'build', 'gateway', 'server.mjs');
  assert.equal(fs.existsSync(bundle), true, `engine bundle missing: ${bundle} (run npm run build)`);

  const specifiers = shippedBareSpecifiers();

  // Every bare specifier the shipped code loads must be declared or runtime-provided.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(manifest.dependencies));
  const undeclared = [...specifiers].filter((name) => !declared.has(name) && !RUNTIME_PROVIDED.has(name));
  assert.deepEqual(undeclared, [], 'shipped code loads packages that are not declared dependencies');

  // And every declared dependency must actually be loaded — a declared-but-unused
  // entry is exactly the oversize this guard exists to prevent.
  const unused = [...declared].filter((name) => !specifiers.has(name));
  assert.deepEqual(unused, [], 'declared dependencies that nothing in the shipped code loads');

  // Positive control: the scan really saw the two known roots.
  assert.ok(specifiers.has('electron-updater'), 'scan must see electron-updater (auto-update path)');
  assert.ok(specifiers.has('jsonc-parser'), 'scan must see jsonc-parser (opencode config sync)');
});

// ───────────────────────────────────────────────────────────────────────────
// Shipped-size guard, Lever 2: source maps must not ship.
//
// A .map file is a build-time debugging aid; nothing at runtime reads one (a
// missing map is a silent devtools 404, never an error). Measured before this
// guard: 1,992 .map entries = 59.6% of asar entry bytes. Lever 1 removes most
// of them with the packages that carried them, but the 17 packages that stay
// still hold ~1.1 MiB of maps (64 files), and any future dependency can add
// more — so the exclusion is declared once, globally.
//
// The pattern lands in `files:` because electron-builder applies the main
// matcher's patterns to the collected production node_modules as well
// (app-builder-lib/out/util/appFileCopier.js:168-170, "use main matcher
// patterns, so, user can exclude some files in such hoisted node modules").
// ───────────────────────────────────────────────────────────────────────────

test('the packaging config excludes source maps from app.asar', () => {
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(builder, /^  - "!\*\*\/\*\.map"$/m,
    'files: must carry a global "!**/*.map" negation so no shipped package can reintroduce source maps');
});

// ───────────────────────────────────────────────────────────────────────────
// Shipped-size guard, Lever 3: ship only the Chromium locale packs the app
// can actually offer.
//
// These .pak files carry CHROMIUM's own UI strings (context menus, error
// pages, the PDF viewer, accessibility) — never app strings, which i18next
// loads from the renderer bundle. Trimming therefore degrades Chromium's
// built-in UI to the en-US fallback under an OS locale the app does not
// support; it cannot break an app string.
//
// electron-builder deletes every locales/*.pak whose basename is not listed
// in electronLanguages with an EXACT match (app-builder-lib/out/electron/
// ElectronFramework.js, removeUnusedLanguagesIfNeeded), so variant packs must
// be named in full: en-GB, es-419, zh-CN, zh-TW. 55 paks ship without the
// list; the 10 below are the ones matching VALID_APP_LANGUAGES
// (src/main/gateway-runtime.ts), measured 6,683,361 B of 40,139,718 B.
//
// `ru` is load-bearing beyond the language list: the owner's own processes
// launch with --lang=ru. en-US is Chromium's fallback and stays regardless.
// ───────────────────────────────────────────────────────────────────────────

/** The exact Chromium pak basenames (sans .pak) allowed to ship. */
const EXPECTED_ELECTRON_LANGUAGES = Object.freeze([
  'ar', 'en-GB', 'en-US', 'es', 'es-419', 'fr', 'hi', 'ru', 'zh-CN', 'zh-TW'
]);

test('electronLanguages ships exactly the packs for the languages the app offers', async () => {
  const { default: yaml } = await import('js-yaml');
  const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  assert.deepEqual([...(config.electronLanguages ?? [])].sort(), [...EXPECTED_ELECTRON_LANGUAGES].sort(),
    'electronLanguages must name the exact pak basenames for VALID_APP_LANGUAGES plus their variant sets');

  // The two non-negotiable entries, called out so a trim cannot drop them silently.
  assert.ok(config.electronLanguages.includes('ru'), 'ru must ship: the owner launches with --lang=ru');
  assert.ok(config.electronLanguages.includes('en-US'), 'en-US must ship: it is Chromium\'s fallback');

  // Non-vacuous: every listed name must be a real pack in the Electron dist.
  const localesDir = path.join(root, 'node_modules', 'electron', 'dist', 'locales');
  assert.equal(fs.existsSync(localesDir), true, `Electron locales directory missing: ${localesDir}`);
  for (const language of config.electronLanguages) {
    assert.equal(fs.existsSync(path.join(localesDir, `${language}.pak`)), true,
      `electronLanguages entry ${language} has no matching locales/${language}.pak`);
  }

  // Coverage: each language the app offers keeps at least one pack variant.
  const runtime = fs.readFileSync(path.join(root, 'src', 'main', 'gateway-runtime.ts'), 'utf8');
  const offered = [...runtime.matchAll(/"((?:en|ru|zh|hi|es|fr|ar))"/g)].map((match) => match[1]);
  assert.ok(offered.length >= 7, 'VALID_APP_LANGUAGES must be readable from gateway-runtime.ts');
  for (const language of new Set(offered)) {
    assert.ok(
      config.electronLanguages.some((kept) => kept === language || kept.startsWith(`${language}-`)),
      `app offers ${language} but no locales/${language}*.pak would ship`
    );
  }
});
