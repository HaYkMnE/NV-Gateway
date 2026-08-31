// D3 — A COMMENT ASSERTED AN INVARIANT THE CODE DID NOT HONOUR.
//
// `external-open.ts` stated that the renderer asks the main process over IPC and
// that the main process validates the URL against a strict allowlist BEFORE
// handing it to `shell.openExternal`. That was true of the `shell:open-external`
// route — and NOT true of `src/main/feedback-service.ts`, which called
// `shell.openExternal(url)` directly (reachable from the
// `feedback:open-github-issue` IPC handler) and never passed through
// `isAllowedExternalUrl`. The claim sits in the file that owns the allowlist, so
// it reads as a whole-app invariant. It was not one.
//
// Benign as measured, because that URL is built from the compiled
// REPO_ISSUES_URL constant plus encodeURIComponent'd user text. Fixed by making
// the invariant TRUE rather than by narrowing the comment: the constant could be
// edited later by someone who does not know the path is unvalidated.
//
// WHY A SEPARATE, UNCAPPED DOOR. `isAllowedExternalUrl` caps input at 2048
// characters. MEASURED at the renderer's own field limits (FeedbackModal
// TITLE_MAX = 100, DESCRIPTION_MAX = 2000) the prefilled issue URL is ~3.3 KB of
// ASCII and ~12.5 KB with Cyrillic text, so reusing that door would REJECT
// legitimate feedback and break "Open GitHub issue". The cap is a guard on
// arbitrary renderer-supplied input, which is not what this path carries: the URL
// is rooted in the compiled constant and every user byte goes through
// encodeURIComponent, which percent-encodes "/", ":", "?", "#" and "@" — so no
// amount of user text can move the authority or the path. `openRepoUrl` therefore
// validates the destination fully and skips only the length cap.
//
// SCOPE NOTE: `node --test` has no Electron runtime, so the `electron` module is
// pre-seeded in require.cache with a recording stub. FeedbackModal itself is NOT
// rendered — there is no jsdom and no @testing-library/react in node_modules and
// installing them is forbidden — so the renderer's field limits are honoured here
// as measured constants, not by driving the component.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Everything handed to shell.openExternal, in order. */
const openedUrls = [];
const nodeRequire = createRequire(import.meta.url);
const electronId = nodeRequire.resolve('electron');
nodeRequire.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    shell: {
      openExternal: async (url) => {
        openedUrls.push(url);
      }
    },
    app: {
      getPath: () => join(root, 'build', '.test-userdata-unused'),
      getVersion: () => '0.0.0-test',
      getName: () => 'nv-gateway-test'
    }
  }
};

const built = (name) => pathToFileURL(join(root, 'build', 'src', 'main', name)).href;
const { openRepoUrl, REPO_ISSUES_URL } = await import(built('external-open.js'));
const { openGitHubIssue } = await import(built('feedback-service.js'));

const externalOpenSource = readFileSync(join(root, 'src', 'main', 'external-open.ts'), 'utf8');
const feedbackSource = readFileSync(join(root, 'src', 'main', 'feedback-service.ts'), 'utf8');

/**
 * Drop comments so a prose MENTION of an API is not mistaken for a CALL to it.
 * Block comments first, then whole-line `//` and continuation `*` lines. An
 * inline `//` inside a string literal is deliberately left alone: stripping to
 * end-of-line there could delete real code and hide a violation.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

test('D3: feedback-service holds no unvalidated door at all', () => {
  // The load-bearing assertion: without the import there is no way to call it,
  // whatever any comment happens to say.
  assert.ok(
    !/import\s*\{[^}]*\bshell\b[^}]*\}\s*from\s*"electron"/.test(feedbackSource),
    'feedback-service.ts must not import shell from electron'
  );
  assert.ok(
    !/shell\s*\.\s*openExternal/.test(stripComments(feedbackSource)),
    'feedback-service.ts must not call shell.openExternal directly — it bypasses the allowlist'
  );
  assert.ok(
    /openRepoUrl/.test(feedbackSource) && /from "\.\/external-open"/.test(feedbackSource),
    'feedback-service.ts must route the issue page through external-open validation'
  );
});

test('D3: the "Open GitHub issue" flow still works, at the renderer field limits', async () => {
  // This is the regression guard: the flow genuinely opens a browser and is one
  // of the app's few outbound actions, so it must keep working for every shape
  // of user text — including at the maximum length the UI permits.
  const scenarios = [
    ['typical', { type: 'bug', title: 'Rate limit confusion', description: 'Cooldown reported.', attachDiagnostic: false }],
    ['quotes/newlines/spaces', { type: 'bug', title: 'He said "boom" & it broke', description: 'line one\nline two\n\t"quoted"  spaced', email: 'a@b.test', attachDiagnostic: true }],
    ['non-ASCII', { type: 'suggestion', title: 'Ошибка шлюза', description: 'Не работает — 日本語 — emoji 🎉', attachDiagnostic: false }],
    ['UI-max ASCII (100 / 2000)', { type: 'bug', title: 'T'.repeat(100), description: 'word '.repeat(400).trim(), email: 'a@b.test', attachDiagnostic: true }],
    ['UI-max Cyrillic (100 / 2000)', { type: 'bug', title: 'Заголовок'.repeat(11).slice(0, 100), description: 'Ошибка '.repeat(285).slice(0, 2000), attachDiagnostic: true }],
    ['suggestion without email', { type: 'suggestion', title: 'Add dark mode', description: 'It would help at night.', attachDiagnostic: false }]
  ];

  for (const [label, data] of scenarios) {
    openedUrls.length = 0;
    await openGitHubIssue(data);
    assert.equal(openedUrls.length, 1, `the issue page must open for: ${label}`);
    const opened = new URL(openedUrls[0]);
    assert.equal(opened.origin, 'https://github.com', `origin must be pinned for: ${label}`);
    assert.equal(opened.pathname, '/HaYkMnE/NV-Gateway/issues/new', `path must be pinned for: ${label}`);
    assert.equal(opened.port, '', `no port may appear for: ${label}`);
    assert.ok(opened.searchParams.get('body'), `body must be present for: ${label}`);
    assert.ok(opened.searchParams.get('title') !== null, `title must be present for: ${label}`);
  }
});

test('D3: the length cap does not apply here, and that is deliberate', async () => {
  // Documents the measurement that drove the design: at the UI limits the URL is
  // far past 2048 characters, so a capped door would reject real feedback.
  openedUrls.length = 0;
  await openGitHubIssue({
    type: 'bug',
    title: 'T'.repeat(100),
    description: 'word '.repeat(400).trim(),
    email: 'a@b.test',
    attachDiagnostic: true
  });
  assert.equal(openedUrls.length, 1, 'a maximum-length report must still open');
  assert.ok(
    openedUrls[0].length > 2048,
    `the real URL is expected to exceed the cap (measured ${openedUrls[0].length} characters)`
  );
  // Destination is still fully constrained despite the length.
  const opened = new URL(openedUrls[0]);
  assert.equal(opened.origin, 'https://github.com');
  assert.equal(opened.pathname, '/HaYkMnE/NV-Gateway/issues/new');
});

test('D3: user text survives byte-for-byte through validation and normalisation', async () => {
  openedUrls.length = 0;
  const title = 'Quote " apostrophe \' amp & hash # slash / colon : plus + пробел 日本語';
  const description = 'first\nsecond\n\t"tabbed"   three spaces\nampersand & equals = question ?';
  await openGitHubIssue({ type: 'bug', title, description, attachDiagnostic: false });
  assert.equal(openedUrls.length, 1);
  const opened = new URL(openedUrls[0]);
  // The path is untouched even though the user text contains "/" and ":".
  assert.equal(opened.pathname, '/HaYkMnE/NV-Gateway/issues/new');
  assert.equal(opened.searchParams.get('title'), title, 'the title must round-trip exactly');
  assert.ok(
    opened.searchParams.get('body').includes(description),
    'the description must round-trip exactly inside the body'
  );
});

test('D3: openRepoUrl is STRICTLY NARROWER than the renderer-facing door', async () => {
  // It is the repository door only. The donation hosts are unreachable through
  // it, so it adds no surface — it only removes an unvalidated one.
  for (const rejected of [
    'https://ko-fi.com/haykmne',
    'https://www.patreon.com/c/HaYkMnE',
    'https://t.me/tribute/app',
    'https://telegram.org/',
    'https://github.com/HaYkMnE/NV-Gateway-evil',
    'https://github.com/attacker/NV-Gateway',
    'https://github.com:8080/HaYkMnE/NV-Gateway',
    'http://github.com/HaYkMnE/NV-Gateway',
    'https://github.com.evil.test/HaYkMnE/NV-Gateway',
    'https://github.com@evil.test/HaYkMnE/NV-Gateway',
    'https://gist.github.com/HaYkMnE/NV-Gateway',
    'javascript:alert(1)',
    null,
    undefined,
    42
  ]) {
    openedUrls.length = 0;
    await assert.rejects(
      () => openRepoUrl(rejected),
      /not on the allowlist/,
      `openRepoUrl must reject: ${String(rejected)}`
    );
    assert.deepEqual(openedUrls, [], `nothing may open for: ${String(rejected)}`);
  }

  // And it opens the validated href for the destination it exists to serve.
  openedUrls.length = 0;
  await openRepoUrl(`${REPO_ISSUES_URL}?title=x&body=y`);
  assert.deepEqual(openedUrls, [`${REPO_ISSUES_URL}?title=x&body=y`]);
});

test('D3: the file header describes what is actually guaranteed', () => {
  const header = externalOpenSource.slice(0, externalOpenSource.indexOf('/** Hostnames'));
  assert.ok(header.length > 0, 'the header block must be locatable');
  // The old header implied a whole-app invariant while one route bypassed the
  // allowlist entirely. It must now name both doors and the file that used to
  // sit outside them.
  assert.ok(/openRepoUrl/.test(header), 'the header must name openRepoUrl');
  assert.ok(/openExternalUrl/.test(header), 'the header must name openExternalUrl');
  assert.ok(/feedback-service/.test(header), 'the header must name the feedback path it previously mis-described');
});

test('D3: no main-process module outside external-open.ts opens a URL unvalidated', () => {
  // The invariant, enforced going forward rather than asserted once:
  // external-open.ts is the ONLY module allowed to hold shell.openExternal.
  const mainDir = join(root, 'src', 'main');
  const { readdirSync } = nodeRequire('node:fs');
  const offenders = [];
  for (const name of readdirSync(mainDir).filter((file) => file.endsWith('.ts'))) {
    if (name === 'external-open.ts') continue;
    const source = readFileSync(join(mainDir, name), 'utf8');
    if (/shell\s*\.\s*openExternal/.test(stripComments(source))) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `only external-open.ts may call shell.openExternal, found: ${offenders.join(', ')}`
  );
});
