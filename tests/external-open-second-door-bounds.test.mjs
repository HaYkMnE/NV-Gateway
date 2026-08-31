// GATE FINDINGS on the D3 second door (`openRepoUrl`) — two defects.
//
// F1 (MEDIUM) — THE SECOND DOOR IS ENTIRELY UNBOUNDED, and its only real bound is
// an accident somewhere else.
//
// D3 introduced `openRepoUrl` as a door that skips the length cap the primary door
// enforces. The justification is sound as far as it goes: the URL is rooted in the
// compiled REPO_ISSUES_URL and every user byte goes through encodeURIComponent, so
// MEASURED, no user text can move the authority or the path. That part holds.
//
// But "cannot redirect" is not "bounded". MEASURED against the built module,
// `openRepoUrl` accepted a 10,000,054-character URL and handed all 10 MB straight
// to `shell.openExternal` without complaint (24 ms, no throw). The only reason the
// feedback path does not actually do that is `src/main/redaction.ts:83`, which ends
// `.slice(0, 16_384)` — a truncation that exists for redaction reasons, in a module
// that has nothing to do with URL length, and which the D3 reasoning never mentions.
// Raise or remove that slice and this door becomes unbounded again, silently.
//
// `parseAllowedUrl` already takes an optional `maxLength`. D3 passed `undefined`
// where it could have passed a generous explicit number for the same effort, so the
// door is uncapped by choice rather than by necessity. The cap here is deliberately
// far above anything the product can produce: the renderer caps the title at 100 and
// the description at 2000 characters, and the worst-case encoding of that (emoji, 12
// characters per 2 UTF-16 units) MEASURED at 13,514 characters. 65,536 leaves ~4.8x
// headroom over the largest URL the UI can generate, so no legitimate report is
// rejected, while a runaway payload is refused instead of handed to the OS.
//
// F2 (LOW) — THE "ONLY external-open MAY HOLD shell.openExternal" GUARD GREPS ONE
// SPELLING.
//
// `tests/external-open-feedback-route.test.mjs` asserts no other main-process module
// matches /shell\s*\.\s*openExternal/. MEASURED, that catches the naive regression
// but 9 of 15 spellings evade it, including ones a well-meaning developer could
// write by accident: `import { shell as s }` then `s.openExternal(u)`, destructuring
// `const { openExternal } = shell`, `shell["openExternal"](u)`, `shell?.openExternal(u)`,
// a namespace alias, and a re-export through another module.
//
// Every one of those bypasses needs the `shell` object in the module first, so this
// guards the IMPORT instead of the call spelling — a property that does not depend on
// enumerating syntax. It is additive: the author's call-site assertion is untouched.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

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

/** The largest URL the product can actually generate, measured, plus headroom. */
const UI_WORST_CASE_MEASURED = 13_514;

test('F1: the second door refuses a runaway payload instead of handing it to the OS', async () => {
  // 10 MB reached shell.openExternal before this fix.
  for (const size of [100_000, 1_000_000, 10_000_000]) {
    const runaway = `${REPO_ISSUES_URL}?body=${'a'.repeat(size)}`;
    openedUrls.length = 0;
    await assert.rejects(
      () => openRepoUrl(runaway),
      /not on the allowlist/,
      `openRepoUrl must refuse a ${size}-character payload`
    );
    assert.deepEqual(openedUrls, [], `nothing may reach the OS for a ${size}-character payload`);
  }
});

test('F1: the bound is far above anything the product can generate', async () => {
  // The cap must not be the thing that breaks real feedback. These are the
  // renderer's own limits (TITLE_MAX 100, DESCRIPTION_MAX 2000) in the worst
  // encodings, which is what made reusing the 2048 cap wrong in the first place.
  const scenarios = [
    ['UI-max ASCII with spaces', { title: 'T'.repeat(100), description: 'word '.repeat(400).trim() }],
    ['UI-max Cyrillic', { title: '\u0417'.repeat(100), description: '\u041E'.repeat(2000) }],
    ['UI-max emoji', { title: '\u{1F389}'.repeat(50), description: '\u{1F389}'.repeat(1000) }]
  ];
  for (const [label, fields] of scenarios) {
    openedUrls.length = 0;
    await openGitHubIssue({ type: 'bug', ...fields, email: 'a@b.test', attachDiagnostic: true });
    assert.equal(openedUrls.length, 1, `a maximum-length report must still open: ${label}`);
    const opened = new URL(openedUrls[0]);
    assert.equal(opened.origin, 'https://github.com', `origin stays pinned: ${label}`);
    assert.equal(opened.pathname, '/HaYkMnE/NV-Gateway/issues/new', `path stays pinned: ${label}`);
    // The point of the second door: still comfortably past the primary door's cap.
    assert.ok(openedUrls[0].length > 2048, `still exceeds the 2048 cap, as measured: ${label}`);
    assert.ok(
      openedUrls[0].length <= UI_WORST_CASE_MEASURED + 2000,
      `measured ${openedUrls[0].length}; if this grew, re-derive the cap: ${label}`
    );
  }
});

test('F1: the door is bounded by an explicit constant, not by redaction.ts truncation', () => {
  // The bound must be stated where the door is, so it cannot be removed by an
  // edit to an unrelated module. redaction.ts:83 currently ends `.slice(0, 16_384)`
  // for redaction reasons; that is not a URL-length control and must not be the
  // only thing standing between this door and a multi-megabyte command line.
  const source = readFileSync(join(root, 'src', 'main', 'external-open.ts'), 'utf8');
  assert.match(
    source,
    /MAX_REPO_URL_LENGTH\s*=\s*[\d_]+/,
    'external-open.ts must declare an explicit bound for the repository door'
  );
  assert.match(
    source,
    /parseAllowedUrl\(\s*value\s*,\s*isAllowedRepoUrl\s*,\s*MAX_REPO_URL_LENGTH\s*\)/,
    'openRepoUrl must pass its explicit bound to parseAllowedUrl'
  );
});

test('F1: the repository door stays STRICTLY NARROWER than the renderer-facing door', async () => {
  // Bounding it must not have widened it.
  for (const rejected of [
    'https://ko-fi.com/haykmne',
    'https://www.patreon.com/c/HaYkMnE',
    'https://t.me/tribute/app',
    'https://telegram.org/',
    'https://github.com/HaYkMnE/NV-Gateway-evil',
    'https://github.com:8080/HaYkMnE/NV-Gateway',
    'http://github.com/HaYkMnE/NV-Gateway'
  ]) {
    openedUrls.length = 0;
    await assert.rejects(() => openRepoUrl(rejected), /not on the allowlist/, `must reject: ${rejected}`);
    assert.deepEqual(openedUrls, [], `nothing may open for: ${rejected}`);
  }
  openedUrls.length = 0;
  await openRepoUrl(`${REPO_ISSUES_URL}?title=x&body=y`);
  assert.deepEqual(openedUrls, [`${REPO_ISSUES_URL}?title=x&body=y`]);
});

test('F2: no main-process module outside external-open.ts may IMPORT electron shell', () => {
  // Guarding the import rather than the call spelling. Every evasion of the
  // call-site grep — `import { shell as s }`, destructuring, `shell["openExternal"]`,
  // `shell?.openExternal`, a namespace alias, a re-export — still needs the object
  // in the module, so this holds without enumerating syntax.
  const mainDir = join(root, 'src', 'main');
  const offenders = [];
  for (const name of readdirSync(mainDir).filter((file) => file.endsWith('.ts'))) {
    if (name === 'external-open.ts') continue;
    const source = readFileSync(join(mainDir, name), 'utf8');
    // Strip comments so prose about `shell` is not mistaken for an import, and so
    // "PowerShell" in a comment cannot trip this.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*');
      })
      .join('\n');
    // Named or aliased import of `shell` from electron, in any order/whitespace.
    if (/import\s*\{[^}]*\bshell\b[^}]*\}\s*from\s*['"]electron['"]/.test(code)) offenders.push(`${name} (named import)`);
    // `import * as x from "electron"` followed by any use of `.shell`.
    if (/import\s*\*\s*as\s+(\w+)\s*from\s*['"]electron['"]/.test(code)) {
      const ns = code.match(/import\s*\*\s*as\s+(\w+)\s*from\s*['"]electron['"]/)[1];
      if (new RegExp(`\\b${ns}\\s*\\.\\s*shell\\b`).test(code)) offenders.push(`${name} (namespace .shell)`);
    }
    // `require("electron")` reaching for `.shell`, including destructuring.
    if (/require\(\s*['"]electron['"]\s*\)\s*\.\s*shell\b/.test(code)) offenders.push(`${name} (require().shell)`);
    if (/\{[^}]*\bshell\b[^}]*\}\s*=\s*require\(\s*['"]electron['"]\s*\)/.test(code)) offenders.push(`${name} (destructured require)`);
  }
  assert.deepEqual(
    offenders,
    [],
    `only external-open.ts may hold electron's shell, found: ${offenders.join(', ')}`
  );
});
