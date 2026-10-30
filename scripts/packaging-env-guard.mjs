#!/usr/bin/env node
// Packaging-time publish guard. electron-builder.yml declares the GitHub
// Releases publish provider with a LITERAL owner/repo (HaYkMnE/NV-Gateway).
// electron-builder BAKES those values into resources/app-update.yml, which
// electron-updater reads at runtime. Releases are published into the same
// repository, so the feed, the upload target and the source repo are one.
//
// NVGW_GH_OWNER is still required at package time: it is the owner the release
// pipeline publishes as (github.repository_owner in CI), and the guard refuses to
// package when it disagrees with the baked block. A mismatch would build an app
// that polls a repository this pipeline never publishes to.
//
// Direct run (`node scripts/packaging-env-guard.mjs`):
//   - exit 1 with a clear message when NVGW_GH_OWNER is missing/blank;
//   - exit 1 when the electron-builder.yml publish block is not the literal
//     github block for the resolved owner/repo (NVGW_GH_REPO defaults to
//     NV-Gateway when unset);
//   - exit 0 and print the effective publish target otherwise.
// The pure resolvePublishEnvironment is exported for run-electron-builder.mjs
// and for tests.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_RELEASE_REPOSITORY = 'NV-Gateway';

export function resolvePublishEnvironment(env = process.env) {
  const owner = typeof env.NVGW_GH_OWNER === 'string' ? env.NVGW_GH_OWNER.trim() : '';
  if (!owner) {
    return {
      ok: false,
      error: 'NVGW_GH_OWNER is required at package time: set it to the GitHub owner (user or org) of the public repository the app checks for updates, for example `$env:NVGW_GH_OWNER = "octo-org"`. Repository name comes from NVGW_GH_REPO and defaults to "' + DEFAULT_RELEASE_REPOSITORY + '" when unset.'
    };
  }
  const repo = typeof env.NVGW_GH_REPO === 'string' && env.NVGW_GH_REPO.trim() ? env.NVGW_GH_REPO.trim() : DEFAULT_RELEASE_REPOSITORY;
  return { ok: true, owner, repo };
}

/**
 * The literal publish block electron-builder.yml must carry for this target.
 * Exported so the tests assert the same fragments the guard enforces.
 */
export function expectedPublishFragments({ owner, repo }) {
  return ['provider: github', `owner: ${owner}`, `repo: ${repo}`, 'releaseType: release'];
}

export function validateBuilderWiring(root, publish) {
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n');
  const block = builder.match(/^publish:\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? '';
  const lines = block.split('\n').map((line) => line.trim().replace(/^- /, ''));
  const missing = expectedPublishFragments(publish).filter((fragment) => !lines.includes(fragment));
  if (missing.length > 0) {
    return { ok: false, error: `electron-builder.yml publish block does not bake the release target github.com/${publish.owner}/${publish.repo} (missing: ${missing.join(', ')}); the packaged app would poll a repository this pipeline does not publish to.` };
  }
  return { ok: true };
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const publish = resolvePublishEnvironment(process.env);
  if (!publish.ok) {
    console.error(`[packaging-env-guard] ${publish.error}`);
    process.exitCode = 1;
    return;
  }
  const wiring = validateBuilderWiring(root, publish);
  if (!wiring.ok) {
    console.error(`[packaging-env-guard] ${wiring.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[packaging-env-guard] publish target: github.com/${publish.owner}/${publish.repo} (releaseType: release)` +
    (process.env.NVGW_GH_REPO ? '' : ` — NVGW_GH_REPO unset, using default "${DEFAULT_RELEASE_REPOSITORY}"`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
