#!/usr/bin/env node
// Baked-update-feed guard. It answers ONE question, after packaging and BEFORE
// any artifact is uploaded: did electron-builder actually BAKE the update feed
// into the packaged output, and does it name the repository the app must poll?
//
// Why this has to exist
// ---------------------
// resources/app-update.yml is the ONLY thing that tells electron-updater where to
// look on the user's machine. It is not written unconditionally — read out of the
// dependency rather than assumed:
//
//   app-builder-lib/out/publish/PublishManager.js:81-84
//     else if (packager.platform === index_1.Platform.WINDOWS) {
//       if (!event.targets.some(it => isSuitableWindowsTarget(it))) {
//         return;                                  // <- no app-update.yml at all
//       }
//     }
//
//   app-builder-lib/out/publish/PublishManager.js:361-366
//     function isSuitableWindowsTarget(target) {
//       if (target.name === "appx" && ... electronUpdaterAware) return true;
//       return target.name === "nsis" || target.name.startsWith("nsis-");
//     }
//
// So the file is produced for nsis / nsis-* (and updater-aware appx) and for
// NOTHING else. A `--dir` build therefore never writes it, which is why the CI
// `Packaged audit` job — which uses `--dir` on purpose — structurally CANNOT
// observe it. That is a real blind spot: the packaged audit is otherwise the job
// that catches broken packages, and this is the one release-critical file it can
// never see.
//
// MEASURED, which is why this guard exists rather than a comment: the owner's
// INSTALLED build has no app-update.yml at all, so auto-update on that copy is
// impossible. Nothing failed when that shipped. An absent feed produces no error,
// no warning and no failing step — the installer works, the app runs, and update
// checks simply never find anything for the rest of that install's life.
//
// The guard is deliberately placed AFTER packaging and BEFORE upload, so a build
// that cannot auto-update never becomes a published release.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { resolvePublishEnvironment } from './packaging-env-guard.mjs';

/** Relative location electron-builder writes, and electron-updater reads. */
export const APP_UPDATE_FILE = path.join('win-unpacked', 'resources', 'app-update.yml');

/**
 * Verify the packaged output carries a correct, baked update feed.
 *
 * @param {{root?: string, packageOutputDirectory?: string, env?: Record<string, string | undefined>}} [options]
 * @returns {{ok: true, feed: string, file: string} | {ok: false, error: string}}
 */
export function verifyBakedUpdateFeed({
  root = path.resolve(import.meta.dirname, '..'),
  packageOutputDirectory = process.env.NVGW_PACKAGE_OUTPUT_DIRECTORY || path.join(root, 'dist'),
  env = process.env
} = {}) {
  const publish = resolvePublishEnvironment(env);
  if (!publish.ok) return { ok: false, error: publish.error };

  const file = path.join(packageOutputDirectory, APP_UPDATE_FILE);
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      error: [
        `the packaged output has no ${APP_UPDATE_FILE}, so this build CANNOT auto-update and must not be published.`,
        '',
        'electron-updater reads that file at runtime to learn which repository to poll. Without it an update',
        'check finds nothing, silently, forever — no error on the user\'s machine and no failing step here.',
        '',
        'electron-builder only writes it for an updater-aware target',
        '(app-builder-lib/out/publish/PublishManager.js:81-84 + isSuitableWindowsTarget): nsis, nsis-*, or',
        'updater-aware appx. A `--dir` build never writes it.',
        '',
        'LIKELY CAUSES:',
        '  * the nsis target was removed from win.target in electron-builder.yml;',
        '  * this guard ran against a --dir build instead of the real release build;',
        '  * the publish block was dropped, so getAppUpdatePublishConfiguration returned null.'
      ].join('\n')
    };
  }

  let document;
  try {
    document = yaml.load(fs.readFileSync(file, 'utf8'), { filename: APP_UPDATE_FILE });
  } catch (error) {
    return { ok: false, error: `${APP_UPDATE_FILE} is not parseable YAML: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}` };
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, error: `${APP_UPDATE_FILE} did not parse to a mapping, so the baked feed cannot be read.` };
  }

  // The baked values must match the SAME resolution the packaging wrapper used.
  // A mismatch means the app would poll a repository the release never reaches.
  const expected = { provider: 'github', owner: publish.owner, repo: publish.repo };
  const mismatched = Object.entries(expected)
    .filter(([key, value]) => String(document[key] ?? '') !== String(value))
    .map(([key, value]) => `${key}: expected "${value}", baked "${document[key] ?? '(absent)'}"`);
  if (mismatched.length > 0) {
    return {
      ok: false,
      error: `${APP_UPDATE_FILE} does not name the expected update feed — installed copies would poll the wrong repository:\n  ${mismatched.join('\n  ')}`
    };
  }

  // releaseType decides whether drafts/prereleases are served to users.
  if (String(document.releaseType ?? '') !== 'release') {
    return {
      ok: false,
      error: `${APP_UPDATE_FILE} has releaseType "${document.releaseType ?? '(absent)'}" instead of "release", so users could be served drafts or prereleases.`
    };
  }

  return { ok: true, feed: `${publish.owner}/${publish.repo}`, file };
}

function main() {
  const result = verifyBakedUpdateFeed();
  if (!result.ok) {
    console.error(`[verify-baked-update-feed] ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[verify-baked-update-feed] baked update feed: github.com/${result.feed} (releaseType: release) in ${APP_UPDATE_FILE}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
