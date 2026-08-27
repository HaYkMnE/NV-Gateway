#!/usr/bin/env node
// electron-builder launcher for every packaging entry point. It runs the
// publish env guard FIRST (fail fast on a missing NVGW_GH_OWNER), then applies
// the documented NVGW_GH_REPO default (NV-Gateway) in-process so that
// electron-builder's ${env.NVGW_GH_REPO} substitution in electron-builder.yml
// — whose expansion is baked into resources/app-update.yml — always resolves.
// All remaining CLI arguments are forwarded to electron-builder verbatim and
// its exit code is propagated.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolvePublishEnvironment } from './packaging-env-guard.mjs';

const root = path.resolve(import.meta.dirname, '..');
const publish = resolvePublishEnvironment(process.env);
if (!publish.ok) {
  console.error(`[run-electron-builder] ${publish.error}`);
  process.exit(1);
}
process.env.NVGW_GH_OWNER = publish.owner;
process.env.NVGW_GH_REPO = publish.repo;
console.log(`[run-electron-builder] publish target: github.com/${publish.owner}/${publish.repo} (releaseType: release)`);

const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit'
});
if (result.error) {
  console.error(`[run-electron-builder] failed to launch electron-builder: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
