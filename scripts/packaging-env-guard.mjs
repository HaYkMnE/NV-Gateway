#!/usr/bin/env node
// Packaging-time publish guard. electron-builder.yml declares the GitHub
// Releases publish provider with ${env.NVGW_GH_OWNER} / ${env.NVGW_GH_REPO}
// macros; electron-builder expands them when it resolves the publish config
// and BAKES the expanded values into resources/app-update.yml, which
// electron-updater reads at runtime. A missing env variable aborts packaging
// with ERR_ELECTRON_BUILDER_ENV_NOT_DEFINED later (after a full compile), so
// this guard fails fast with an actionable message instead.
//
// Direct run (`node scripts/packaging-env-guard.mjs`):
//   - exit 1 with a clear message when NVGW_GH_OWNER is missing/blank;
//   - exit 0 and print the effective publish target otherwise
//     (NVGW_GH_REPO falls back to NV-Gateway-releases when unset);
//   - also verifies electron-builder.yml still carries the env-macro publish
//     block so config drift breaks packaging loudly, not silently.
// The pure resolvePublishEnvironment is exported for run-electron-builder.mjs
// and for tests.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_RELEASE_REPOSITORY = 'NV-Gateway-releases';

export function resolvePublishEnvironment(env = process.env) {
  const owner = typeof env.NVGW_GH_OWNER === 'string' ? env.NVGW_GH_OWNER.trim() : '';
  if (!owner) {
    return {
      ok: false,
      error: 'NVGW_GH_OWNER is required at package time: set it to the GitHub owner (user or org) of the PUBLIC releases repository the app checks for updates, for example `$env:NVGW_GH_OWNER = "octo-org"`. Repository name comes from NVGW_GH_REPO and defaults to "' + DEFAULT_RELEASE_REPOSITORY + '" when unset.'
    };
  }
  const repo = typeof env.NVGW_GH_REPO === 'string' && env.NVGW_GH_REPO.trim() ? env.NVGW_GH_REPO.trim() : DEFAULT_RELEASE_REPOSITORY;
  return { ok: true, owner, repo };
}

function validateBuilderWiring(root) {
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  const required = ['provider: github', 'owner: ${env.NVGW_GH_OWNER}', 'repo: ${env.NVGW_GH_REPO}', 'releaseType: release'];
  const missing = required.filter((fragment) => !builder.includes(fragment));
  if (missing.length > 0) {
    return { ok: false, error: `electron-builder.yml no longer declares the env-macro github publish block (missing: ${missing.join(', ')}); restore publish.owner/repo ${'${env.NVGW_GH_*}'} macros so app-update.yml can be generated.` };
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
  const wiring = validateBuilderWiring(root);
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
