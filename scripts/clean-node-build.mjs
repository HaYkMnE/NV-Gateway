import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The SHIPPED directories `npm run build` writes, and therefore the directories that
 * can hold a stale artifact when the build is skipped, interrupted, or served from
 * incremental state. Each name was read off the producing step, not guessed:
 *   build/src/{main,preload,test-support,renderer/lib}  tsc -p tsconfig.node.json (outDir ./build)
 *   build/gateway                                       scripts/build-gateway-bundle.mjs
 *   build/renderer                                      vite build (vite.config.ts: build.outDir)
 *
 * NOT a complete list of what tsc writes, and deliberately so: tsconfig.node.json
 * also emits `build/vite.config.js` and `build/vite.config.d.ts` at the outDir ROOT
 * (vite.config.ts is an `include` of that project). They are removed here only
 * incidentally — `rm -rf build/src` does not touch them, so in practice they
 * SURVIVE this clean step. That is harmless because electron-builder.yml ships
 * `build/src/**`, `build/gateway/**` and `build/renderer/**` and nothing else from
 * build/, so a stale `build/vite.config.js` is never packaged and never verified
 * against sources by scripts/verify-build-freshness.mjs. Adding them here would
 * delete a file this list cannot regenerate on its own (the tsc emit does), and
 * claiming otherwise was the inaccuracy this comment used to carry.
 *
 * build/renderer was MISSING from this list, and it ships (electron-builder.yml
 * `files:` build/renderer/**\/*). Measured before the fix: the shipped bundle
 * carried no `endpoint_creds_error` string while src/renderer/i18n/resources.ts:142
 * defines it in all 7 locales, so users saw a raw key instead of a message.
 */
export const CLEANED_PATHS = Object.freeze([
  'build/src/main',
  'build/src/preload',
  'build/src/test-support',
  // Also emitted by the same tsc run (tsconfig.node.json includes
  // src/renderer/lib/frontend-behavior.ts), so it is generated output too and was
  // the one tsc target the old list left behind.
  'build/src/renderer/lib',
  'build/gateway',
  'build/renderer'
]);

// Never descended into: node_modules is huge, .git is not build output, and dist
// is electron-builder's own output directory (removed by packaging, not by tsc).
const SCAN_SKIP = new Set(['node_modules', '.git', 'dist']);

/**
 * Delete `*.tsbuildinfo` anywhere under `root` (outside the skipped trees).
 *
 * Incremental state is the root cause of a stale artifact surviving a rebuild.
 * With a tsbuildinfo on disk, `tsc -p` may conclude the output is already current
 * and exit 0 WITHOUT rewriting it: measured empirically, a deliberately corrupted
 * build/src file survived a plain `tsc -p tsconfig.node.json` (exit 0, corrupt
 * bytes intact). `npm run build` only escaped that because this script ran first,
 * so any direct `tsc -p` or editor emit could still ship stale code.
 *
 * Every file is removed, not just the one tsconfig.node.json writes: no project in
 * the tree may begin a release build believing an artifact is up to date.
 */
function removeTypeScriptBuildInfo(directory) {
  const removed = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SCAN_SKIP.has(entry.name)) removed.push(...removeTypeScriptBuildInfo(absolute));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) {
      fs.rmSync(absolute, { force: true });
      removed.push(absolute);
    }
  }
  return removed;
}

/**
 * Clean generated build output. Returns what was touched so callers (and tests)
 * can assert on it without guessing.
 */
export function cleanNodeBuild({ root = DEFAULT_ROOT } = {}) {
  const removedPaths = [];
  for (const relativePath of CLEANED_PATHS) {
    const absolute = path.join(root, ...relativePath.split('/'));
    fs.rmSync(absolute, { recursive: true, force: true });
    removedPaths.push(absolute);
  }
  return { removedPaths, removedBuildInfo: removeTypeScriptBuildInfo(root) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  cleanNodeBuild();
}
