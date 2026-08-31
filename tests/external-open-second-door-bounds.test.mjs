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
// far above anything the product can produce.
//
// CORRECTED (GATE F4). This comment, and the matching one in external-open.ts, used
// to say the worst case was "emoji, 12 characters per 2 UTF-16 units" MEASURED at
// 13,514 characters with "~4.8x headroom". That was wrong on the digit AND named the
// wrong script. Per UTF-16 CODE UNIT, a 3-byte BMP character such as CJK U+65E5 is
// ONE unit expanding to 9 URL characters, while a 4-byte astral emoji is TWO units
// expanding to 12, i.e. only 6 per unit — so CJK expands 1.5x further than emoji and
// emoji is the cheaper case. MEASURED over validator-accepted payloads:
//
//   emoji, no e-mail / no diagnostic    13,346
//   emoji, 320-unit e-mail + diagnostic 15,454
//   CJK,   no e-mail / no diagnostic    19,946
//   CJK,   320-unit e-mail + diagnostic 23,014   <- the true maximum
//
// Real headroom is therefore 65,536 / 23,014 = 2.85x, not 4.8x. Still ample, and the
// conclusion is unchanged — no legitimate report approaches the cap while a runaway
// payload is refused instead of handed to the OS — but a future reader sizing this cap
// must not be told emoji is the worst case. The figures are now pinned by assertion
// below rather than left as prose that can rot.
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

/**
 * The largest URL the product can actually generate, MEASURED over
 * validator-accepted payloads: a CJK title, a CJK description, a 320-unit CJK
 * e-mail and `attachDiagnostic = true`. The figure this file used to carry was
 * 13,514 with emoji named as the worst case; both were wrong (GATE F4).
 */
const UI_MAX_URL_MEASURED = 23_014;
/** The same payload shape in emoji, which is the CHEAPER case, not the worst. */
const UI_MAX_URL_EMOJI_MEASURED = 15_454;
const REPO_DOOR_CAP = 65_536;

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
  // CJK is included because it is the WORST case (GATE F4): 9 URL characters per
  // UTF-16 unit against emoji's 6. It was missing from this list, which is part of
  // why the stale 13,514 figure survived — the scenario that actually produces the
  // maximum was never exercised here.
  const scenarios = [
    ['UI-max ASCII with spaces', { title: 'T'.repeat(100), description: 'word '.repeat(400).trim() }],
    ['UI-max Cyrillic', { title: '\u0417'.repeat(100), description: '\u041E'.repeat(2000) }],
    ['UI-max emoji', { title: '\u{1F389}'.repeat(50), description: '\u{1F389}'.repeat(1000) }],
    ['UI-max CJK (the true worst case)', { title: '\u65E5'.repeat(100), description: '\u672C'.repeat(2000) }]
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
      openedUrls[0].length <= UI_MAX_URL_MEASURED,
      `measured ${openedUrls[0].length}; if this grew past the measured maximum ${UI_MAX_URL_MEASURED}, re-derive the cap: ${label}`
    );
  }
});

test('F4: the measured maxima are pinned, and CJK is the worst script — not emoji', async () => {
  // GATE F4. No behavioural RED test exists for a stale comment, so the figures are
  // pinned by assertion instead: if the maximum moves, this fails and the comments
  // must be re-derived rather than silently rotting.
  const ceiling = (script) => ({
    type: 'bug',
    title: script.title,
    description: script.description,
    email: script.email,
    attachDiagnostic: true
  });
  const cjk = {
    title: '\u65E5'.repeat(100),
    description: '\u672C'.repeat(2000),
    email: '\u65E5'.repeat(320)
  };
  const emoji = {
    title: '\u{1F389}'.repeat(50),
    description: '\u{1F389}'.repeat(1000),
    email: '\u{1F389}'.repeat(160)
  };

  openedUrls.length = 0;
  await openGitHubIssue(ceiling(cjk));
  const cjkLength = openedUrls[0].length;
  openedUrls.length = 0;
  await openGitHubIssue(ceiling(emoji));
  const emojiLength = openedUrls[0].length;

  assert.equal(cjkLength, UI_MAX_URL_MEASURED, `the CJK maximum moved (got ${cjkLength}); re-derive MAX_REPO_URL_LENGTH's comment`);
  assert.equal(emojiLength, UI_MAX_URL_EMOJI_MEASURED, `the emoji maximum moved (got ${emojiLength})`);
  assert.ok(cjkLength > emojiLength, 'CJK must be the worst case; the old comment naming emoji was backwards');

  // Per-unit arithmetic, which is WHY CJK is worse: 3 UTF-8 bytes in one UTF-16 unit
  // is 9 URL characters per unit; 4 bytes across two units is 12, i.e. 6 per unit.
  assert.equal(encodeURIComponent('\u65E5').length / '\u65E5'.length, 9);
  assert.equal(encodeURIComponent('\u{1F389}').length / '\u{1F389}'.length, 6);

  // The headroom the comment claims must be the real one.
  assert.ok(cjkLength < REPO_DOOR_CAP, `the maximum must fit the door cap ${REPO_DOOR_CAP}`);
  assert.equal(
    (REPO_DOOR_CAP / cjkLength).toFixed(2),
    '2.85',
    'the stated headroom must match the measurement (the old comment claimed 4.8x)'
  );

  // And the stale CLAIMS must be gone from the module that sizes the cap. Targeted at
  // the phrasing, not the digits: the file keeps a historical note saying the old
  // figure was wrong, which is what stops it being restored in good faith.
  const source = readFileSync(join(root, 'src', 'main', 'external-open.ts'), 'utf8');
  assert.doesNotMatch(source, /MEASURED at 13,514 characters/, 'the stale 13,514 claim must be gone');
  assert.doesNotMatch(source, /leaves roughly 4\.8x headroom/, 'the stale 4.8x headroom claim must be gone');
  assert.match(source, /2\.85x/, 'the corrected headroom must be stated');
  console.log(`\n  measured: CJK ${cjkLength}, emoji ${emojiLength}, door cap ${REPO_DOOR_CAP}, headroom ${(REPO_DOOR_CAP / cjkLength).toFixed(2)}x`);
});

test('F4b: openRepoUrl states the REAL sizes, not the stale 13.5 KB / emoji-is-worst claim', async () => {
  // GATE F4 corrected the MAX_REPO_URL_LENGTH block. The SAME stale figure survived
  // 96 lines below it, in openRepoUrl's own doc comment, spelled as "about 13.5 KB
  // with Cyrillic or emoji text" — the stale 13,514 in KB form, and the wrong
  // worst-case script again, in the very file that sizes the cap. It was unchanged
  // from b1a9dfd, and nothing pinned it. Measured here so the prose cannot restate it.
  const at = async (title, description, email, attachDiagnostic) => {
    openedUrls.length = 0;
    await openGitHubIssue({ type: 'bug', title, description, email, attachDiagnostic });
    return openedUrls[0].length;
  };
  const asciiBare = await at('T'.repeat(100), 'w'.repeat(2000), undefined, false);
  const cyrillicFull = await at('\u0417'.repeat(100), '\u041E'.repeat(2000), '\u0417'.repeat(320), true);
  const emojiFull = await at('\u{1F389}'.repeat(50), '\u{1F389}'.repeat(1000), '\u{1F389}'.repeat(160), true);

  assert.equal(asciiBare, 2346, `the ASCII UI-max moved (got ${asciiBare})`);
  // Cyrillic and emoji cost the SAME per UTF-16 unit — 2 UTF-8 bytes in one unit and
  // 4 bytes across two units are both 6 URL characters per unit — so lumping them
  // together is fair, but 13.5 KB is not the figure and neither is the worst case.
  assert.equal(cyrillicFull, UI_MAX_URL_EMOJI_MEASURED, `the Cyrillic UI-max moved (got ${cyrillicFull})`);
  assert.equal(emojiFull, UI_MAX_URL_EMOJI_MEASURED, `the emoji UI-max moved (got ${emojiFull})`);
  assert.ok(cyrillicFull > 13.5 * 1024, `"about 13.5 KB" understates Cyrillic/emoji, measured ${cyrillicFull}`);
  assert.ok(UI_MAX_URL_MEASURED > cyrillicFull, 'CJK must remain the worst case');

  const source = readFileSync(join(root, 'src', 'main', 'external-open.ts'), 'utf8');
  assert.doesNotMatch(
    source,
    /about 13\.5 KB with/,
    'openRepoUrl must not restate the stale 13.5 KB figure that GATE F4 corrected above it'
  );
  // NON-VACUITY: the pattern really does match the text it replaces, taken from
  // b1a9dfd, where the sentence wrapped after "13.5 KB with".
  const stale = [
    ' * prefilled issue URL runs to about 2.5 KB of ASCII and about 13.5 KB with',
    ' * Cyrillic or emoji text, so applying 2048 here would reject legitimate feedback'
  ].join('\n');
  assert.match(stale, /about 13\.5 KB with/, 'the 13.5 KB pattern must match the text it replaced');
  console.log(`\n  openRepoUrl sizes: ASCII ${asciiBare}, Cyrillic/emoji ${cyrillicFull}, CJK ${UI_MAX_URL_MEASURED}`);
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
