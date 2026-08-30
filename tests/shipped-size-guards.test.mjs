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
