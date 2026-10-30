#!/usr/bin/env node
// Refuse to republish a tag that already has a release.
//
// WHY THIS EXISTS (measured, not assumed)
// ---------------------------------------
// On a re-run of an already-published tag, action-gh-release does NOT fail: it logs
//
//   ⚠️ GitHub Releases requires a tag
//   ... asset "NV-Gateway-Setup-0.1.1.exe" already exists and overwrite_files is false
//
// and returns `null` from the upload path. `fail_on_unmatched_files` does not
// apply either — the glob DID match local files; the refusal happens server-side
// per asset. The step therefore reports SUCCESS while nothing was published, and
// a "re-run failed jobs" green tick means only "we tried".
//
// That is the exact shape of failure this repository has been burned by before: a
// green run that published nothing. So the decision is made BEFORE any upload, by
// asking the API the same question the upload would ask:
//
//   GET /repos/{owner}/{repo}/releases/tags/{tag}
//     404 -> the tag has no release here, publishing is allowed
//     any other non-2xx -> FAIL. An unknown answer is not permission. This
//                          includes 401/403 (bad or under-scoped token), 5xx, and
//                          a network error: all of them would otherwise be read as
//                          "no release yet" and re-open the silent-success hole.
//     200 -> a release exists. FAIL. Publishing it again would either be a no-op
//            behind a green check (overwrite_files: false) or replace already
//            published bytes (overwrite_files: true) — both are wrong.
//
// The release has ONE destination - this repository, which is also the update
// feed - so exactly that repository is queried.
//
// Direct run:
//   NVGW_RELEASE_TAG=v1.2.3 NVGW_GH_OWNER=... NVGW_FEED_REPOSITORY=... \
//   GITHUB_TOKEN=... \
//     node scripts/republish-guard.mjs
// Exit 1 names the repository and the HTTP status that blocked it.

import { pathToFileURL } from 'node:url';

/** Environment variable carrying the tag being published. */
export const RELEASE_TAG_ENV = 'NVGW_RELEASE_TAG';
/** Owner of the destination repository. */
export const OWNER_ENV = 'NVGW_GH_OWNER';
/** `owner/repo` of the release destination: this repository, the update feed installed copies poll. */
export const FEED_REPOSITORY_ENV = 'NVGW_FEED_REPOSITORY';
/** Token used to query the repository: the workflow's built-in GITHUB_TOKEN. */
export const TOKEN_ENV = 'GITHUB_TOKEN';

/**
 * The tag format the release pipeline accepts: `v` + three numeric components.
 *
 * Case-SENSITIVE on purpose. Git refs are case-sensitive, and the comparison
 * against package.json below is built from a literal "v", so `V1.2.3` must be
 * rejected here rather than slipping through and producing a release whose tag
 * never equals the version string.
 */
export const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

/**
 * Is this a tag the release pipeline is allowed to publish?
 * @param {unknown} tag
 * @returns {boolean}
 */
export function isReleaseTag(tag) {
  return typeof tag === 'string' && RELEASE_TAG_PATTERN.test(tag);
}

/**
 * The version string the tag must equal: a literal "v" followed by the version
 * from package.json, unchanged. Not normalised, not trimmed, not lower-cased — a
 * tag is compared byte for byte with what the package says it is.
 *
 * @param {string} version package.json `version`
 * @returns {string}
 */
export function expectedTagForVersion(version) {
  return `v${version}`;
}

/**
 * A release lookup result, normalised so the decision cannot be made on a raw
 * status that a caller might misread.
 *
 * @typedef {{repository: string, status: number | null, error?: string}} ReleaseProbe
 */

/**
 * Query one repository for a release of `tag`.
 *
 * 404 is the ONLY status that means "not published". Everything else is an
 * unknown, and an unknown is reported as an error rather than as permission.
 *
 * A stalled connection is bounded by `timeoutMs` (default 15 s). The abort
 * lands in the catch below, so a timeout is an unknown, never "proceed".
 *
 * @param {{repository: string, tag: string, token: string, fetchImpl?: typeof fetch, apiBase?: string, timeoutMs?: number}} options
 * @returns {Promise<ReleaseProbe>}
 */
export async function probeRelease({ repository, tag, token, fetchImpl = fetch, apiBase = 'https://api.github.com', timeoutMs = 15_000 }) {
  const url = `${apiBase}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'nv-gateway-republish-guard'
      }
    });
  } catch (error) {
    // A network failure is NOT a 404. Treating it as "no release" would let the
    // pipeline publish into an unknown state, which is the defect this removes.
    return { repository, status: null, error: error?.message ?? String(error) };
  }
  return { repository, status: typeof response?.status === 'number' ? response.status : null };
}

/**
 * Decide whether this run may publish.
 *
 * @param {ReleaseProbe[]} probes
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function decideRepublish(probes) {
  if (!Array.isArray(probes) || probes.length === 0) {
    return { ok: false, error: 'no destination repository was queried, so nothing proves this tag is unpublished' };
  }

  for (const probe of probes) {
    if (probe.status === 404) continue;
    if (probe.status === 200) {
      return {
        ok: false,
        error: [
          `${probe.repository} already has a release for this tag, so this run would republish it.`,
          '',
          'action-gh-release does NOT fail in that case: it logs "already exists and overwrite_files is false"',
          'per asset and returns null, so the step goes green having published nothing.',
          '`fail_on_unmatched_files` does not apply either — the local globs did match.',
          '',
          'Publish a NEW version instead of re-running an old tag.'
        ].join('\n')
      };
    }
    if (probe.status === null) {
      return {
        ok: false,
        error: `could not query ${probe.repository} for this tag (${probe.error ?? 'no response'}), so it is unknown whether this tag is already published`
      };
    }
    return {
      ok: false,
      error: `querying ${probe.repository} for this tag returned HTTP ${probe.status}, which is neither 404 (unpublished) nor 200 (published). An unknown answer is not permission to publish`
    };
  }

  return { ok: true };
}

/**
 * Read + validate the guard's inputs from the environment.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ok: true, tag: string, repositories: string[], token: string} | {ok: false, error: string}}
 */
export function readGuardEnvironment(env = process.env) {
  const tag = typeof env[RELEASE_TAG_ENV] === 'string' ? env[RELEASE_TAG_ENV].trim() : '';
  const owner = typeof env[OWNER_ENV] === 'string' ? env[OWNER_ENV].trim() : '';
  const feed = typeof env[FEED_REPOSITORY_ENV] === 'string' ? env[FEED_REPOSITORY_ENV].trim() : '';
  const token = typeof env[TOKEN_ENV] === 'string' ? env[TOKEN_ENV].trim() : '';

  if (!isReleaseTag(tag)) {
    return { ok: false, error: `${RELEASE_TAG_ENV} must match ${RELEASE_TAG_PATTERN} (case-sensitive), got ${JSON.stringify(tag)}` };
  }
  if (owner === '') return { ok: false, error: `${OWNER_ENV} is required to build the destination repository` };
  if (feed === '') return { ok: false, error: `${FEED_REPOSITORY_ENV} is required: it is the repository this release publishes to` };
  if (token === '') return { ok: false, error: `${TOKEN_ENV} is required: without it the lookup cannot distinguish "unpublished" from "not allowed to see it"` };

  // A bare repository name is resolved against the owner.
  const repositories = [feed.includes('/') ? feed : `${owner}/${feed}`];
  return { ok: true, tag, repositories, token };
}

async function main() {
  const config = readGuardEnvironment(process.env);
  if (!config.ok) {
    console.error(`[republish-guard] ${config.error}`);
    process.exitCode = 1;
    return;
  }

  const probes = [];
  for (const repository of config.repositories) {
    probes.push(await probeRelease({ repository, tag: config.tag, token: config.token }));
  }

  const decision = decideRepublish(probes);
  if (!decision.ok) {
    console.error(`[republish-guard] ${decision.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[republish-guard] tag ${config.tag} has no release in ${config.repositories.join(', ')}; publishing is allowed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
