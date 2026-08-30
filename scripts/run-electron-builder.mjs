#!/usr/bin/env node
// electron-builder launcher for every packaging entry point. It runs the
// publish env guard FIRST (fail fast on a missing NVGW_GH_OWNER), then applies
// the documented NVGW_GH_REPO default (NV-Gateway-releases) in-process so that
// electron-builder's ${env.NVGW_GH_REPO} substitution in electron-builder.yml
// — whose expansion is baked into resources/app-update.yml — always resolves.
// All remaining CLI arguments are forwarded to electron-builder verbatim and
// its exit code is propagated.

// THE CONFIG IS LOADED EXPLICITLY, and that is a security property rather than
// tidiness. Read out of the dependencies, not assumed:
//
//   app-builder-lib/out/packager.js:243-248
//     let configPath = null;
//     let configFromOptions = this.options.config;
//     if (typeof configFromOptions === "string") {
//       configPath = configFromOptions;   // a --config PATH lands here
//       configFromOptions = null;
//     }
//
//   read-config-file/out/main.js:75-82
//     function getConfig(request, configPath) {
//       if (configPath == null) {
//         return loadConfig(request);                                  // <- implicit
//       } else {
//         return readConfig(path.resolve(request.projectDir, configPath), request);
//       }
//     }
//
// With no --config the implicit branch runs loadConfig, and loadConfig short-
// circuits on package.json#build (main.js:71-72) before it ever looks at a file,
// then otherwise walks electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts} and
// takes the first hit (main.js:42). Either route can silently replace our config
// while every audit that inspects electron-builder.yml keeps passing.
//
// Naming the file makes readConfig the ONLY path taken: loadConfig is not called,
// so the package.json#build short-circuit and the sibling-extension walk cease to
// exist for this build. That removes the class of defect by construction instead
// of detecting it after the fact.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePublishEnvironment } from './packaging-env-guard.mjs';

/** The one config electron-builder is allowed to read. */
export const PACKAGING_CONFIG_FILE = 'electron-builder.yml';

/** CLI spellings that already name a config, so ours is not added twice. */
const CONFIG_FLAGS = Object.freeze(['--config', '-c']);

/**
 * Prepend the explicit config to the forwarded arguments.
 *
 * Ours goes FIRST on purpose: yargs lets the LAST occurrence win, so a caller who
 * passes their own --config still overrides this — the flag is a default, not a
 * lock. It is skipped entirely when the caller already named a config, so the
 * argument list never carries it twice.
 *
 * @param {string[]} forwarded Arguments received from the npm script.
 * @returns {string[]} Arguments to hand to electron-builder's CLI.
 */
export function buildElectronBuilderArgs(forwarded = []) {
  const args = (Array.isArray(forwarded) ? forwarded : []).filter((value) => typeof value === 'string');
  const alreadyNamed = args.some((value) =>
    CONFIG_FLAGS.includes(value) || CONFIG_FLAGS.some((flag) => value.startsWith(`${flag}=`)));
  return alreadyNamed ? [...args] : ['--config', PACKAGING_CONFIG_FILE, ...args];
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const publish = resolvePublishEnvironment(process.env);
  if (!publish.ok) {
    console.error(`[run-electron-builder] ${publish.error}`);
    process.exit(1);
  }
  process.env.NVGW_GH_OWNER = publish.owner;
  process.env.NVGW_GH_REPO = publish.repo;
  console.log(`[run-electron-builder] publish target: github.com/${publish.owner}/${publish.repo} (releaseType: release)`);

  const args = buildElectronBuilderArgs(process.argv.slice(2));
  console.log(`[run-electron-builder] config source: ${PACKAGING_CONFIG_FILE} (explicit; package.json#build cannot apply)`);

  const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(`[run-electron-builder] failed to launch electron-builder: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// Only run when invoked as a script, so the argument builder above stays
// importable by tests without launching a build (the pattern the packaged-*
// smoke scripts in this directory already use).
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
