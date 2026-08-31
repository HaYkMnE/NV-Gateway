// GATE RESIDUAL 2 — AN UNPAIRED SURROGATE THREW THE WRONG ERROR, AND THE
// CONTAINMENT BATTERY THAT PROVES CLOSING IT OPENED NOTHING.
//
// MEASURED against the built modules before this fix, feedback text containing a
// lone UTF-16 surrogate made `encodeURIComponent` throw `URIError: URI malformed`
// inside `openGitHubIssue`, BEFORE the allowlist was ever reached:
//
//   lone high \uD800 -> THREW URIError: URI malformed  (openedCount=0)
//   lone low  \uDC00 -> THREW URIError: URI malformed  (openedCount=0)
//   paired emoji     -> OPENED len=372
//
// `wrapIpcHandler` logs it and FeedbackModal's `.catch` swallows it, so it is not
// a crash — but the user loses the whole report to a meaningless generic toast,
// and the thrown type is a `URIError` from the URL builder rather than the
// allowlist's own rejection. Lone surrogates genuinely arrive from pastes (a
// clipboard source that split an astral character in half), so this is a real
// path, not a synthetic one.
//
// WHY SANITISE RATHER THAN SURFACE AN ERROR. The hard constraint is that no new
// user-visible string may be added: `src/renderer/i18n/resources.ts` has 7 locales
// at exactly 301 keys and two test files assert that number. There is no existing
// localised string that means "your text contains a character that cannot go in a
// URL", so "surface an existing localised error" can only reach the same generic
// `feedback_failed` toast the defect already produces — it would change nothing.
//
// So the text is sanitised: each lone surrogate becomes U+FFFD. WHAT THE USER
// LOSES is one replacement character per lone surrogate — and a lone surrogate is
// not a character. It is half of one, it has no rendering, and it only exists
// because a paste arrived broken. U+FFFD is not an invention of this fix: it is
// what UTF-8 encoding itself substitutes for a lone surrogate — MEASURED,
// Buffer.from('ab\uD800cd', 'utf8') is `6162 efbfbd 6364`. So the trade is one
// unrenderable half character against the ENTIRE report the defect discarded.
//
// SCOPE NOTE: `node --test` has no Electron runtime, so `electron` is pre-seeded
// in require.cache with a recording stub, as the neighbouring external-open tests
// do. What is proven here is WHICH STRING reaches `shell.openExternal` — not that
// Windows then resolved it. FeedbackModal is NOT rendered: there is no jsdom and
// no @testing-library/react in node_modules and installing them is forbidden.
import assert from 'node:assert/strict';
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
const { openGitHubIssue } = await import(built('feedback-service.js'));
const { openRepoUrl, REPO_ISSUES_URL } = await import(built('external-open.js'));

const ORIGIN = 'https://github.com';
const PATHNAME = '/HaYkMnE/NV-Gateway/issues/new';

/** A payload the renderer really produces, with one field swapped per case. */
const withDescription = (description) => ({
  type: 'bug',
  title: 'Rate limit confusion',
  description,
  email: 'a@b.test',
  attachDiagnostic: true
});

test('R2: a lone surrogate no longer throws URIError — the report still opens', async () => {
  // The RED case. Before the fix both of these threw `URIError: URI malformed`
  // from encodeURIComponent, with openedCount 0: the user lost the report.
  for (const [label, description] of [
    ['lone high surrogate', 'before\uD800after'],
    ['lone low surrogate', 'before\uDC00after'],
    ['lone high at end of string', 'trailing\uD800'],
    ['lone low at start of string', '\uDC00leading'],
    ['high surrogate followed by a plain BMP char', '\uD800A'],
    ['two lone highs in a row', '\uD800\uD800'],
    ['reversed pair (low then high)', '\uDC00\uD800'],
    ['lone surrogate amid real text', 'crash on \uD83D start-up']
  ]) {
    openedUrls.length = 0;
    await openGitHubIssue(withDescription(description));
    assert.equal(openedUrls.length, 1, `the report must still open: ${label}`);
    const opened = new URL(openedUrls[0]);
    assert.equal(opened.origin, ORIGIN, `origin stays pinned: ${label}`);
    assert.equal(opened.pathname, PATHNAME, `path stays pinned: ${label}`);
  }
});

test('R2: a lone surrogate in the TITLE is handled too (it is emitted twice)', async () => {
  // The title goes into BOTH the `title` query parameter and the body, so a lone
  // surrogate there hit encodeURIComponent on two separate strings.
  openedUrls.length = 0;
  await openGitHubIssue({
    type: 'bug',
    title: 'broken\uD800title',
    description: 'ordinary text',
    email: 'a@b.test',
    attachDiagnostic: true
  });
  assert.equal(openedUrls.length, 1, 'a report with a lone surrogate in the title must open');
  const opened = new URL(openedUrls[0]);
  assert.equal(opened.origin, ORIGIN);
  assert.equal(opened.pathname, PATHNAME);
  assert.equal(opened.searchParams.get('title'), 'broken\uFFFDtitle', 'the half character becomes U+FFFD');
  assert.ok(opened.searchParams.get('body').includes('broken\uFFFDtitle'), 'and the body agrees with the query parameter');
});

test('R2: the substitution is U+FFFD, and it costs exactly one position', async () => {
  // Stating the loss precisely: the surrounding text is untouched and the length
  // is preserved, so nothing is silently dropped or shifted.
  openedUrls.length = 0;
  await openGitHubIssue(withDescription('alpha\uD800omega'));
  const body = new URL(openedUrls[0]).searchParams.get('body');
  assert.ok(body.includes('alpha\uFFFDomega'), 'the lone surrogate is replaced in place, not deleted');
  assert.ok(!body.includes('\uD800'), 'no lone surrogate may survive into the URL');
});

test('R2: a PAIRED surrogate is untouched — real emoji must not be mangled', async () => {
  // The cost of the fix must fall only on broken input. A well-formed astral
  // character is a character the user really typed and must round-trip exactly.
  for (const [label, text] of [
    ['party popper', 'ship it \u{1F389}'],
    ['astral CJK extension B', '\u{20BB7}'],
    ['emoji with a variation selector', '\u2764\uFE0F'],
    ['ZWJ family sequence', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
    ['skin-tone modifier', '\u{1F44D}\u{1F3FD}'],
    ['flag (regional indicators)', '\u{1F1E6}\u{1F1F2}']
  ]) {
    openedUrls.length = 0;
    await openGitHubIssue(withDescription(text));
    assert.equal(openedUrls.length, 1, `must open: ${label}`);
    const body = new URL(openedUrls[0]).searchParams.get('body');
    assert.ok(body.includes(text), `a well-formed astral sequence must round-trip exactly: ${label}`);
    assert.ok(!body.includes('\uFFFD'), `nothing may be replaced for: ${label}`);
  }
});

test('R2: the surrogate fix did not become a new way to fail', async () => {
  // A lone surrogate must not reach the allowlist as a rejection either: the
  // point is that the report OPENS, not that it fails differently.
  openedUrls.length = 0;
  await assert.doesNotReject(
    () => openGitHubIssue(withDescription('\uD800'.repeat(500))),
    'a description made entirely of lone surrogates must still open'
  );
  assert.equal(openedUrls.length, 1);
  assert.equal(new URL(openedUrls[0]).pathname, PATHNAME);
});

// ---------------------------------------------------------------------------
// CONTAINMENT BATTERY. Re-run in full, because closing the two residuals must
// not open a hole. Every case asserts the SAME two things: the origin the OS is
// handed is `https://github.com` and the path is `/HaYkMnE/NV-Gateway/issues/new`.
// That holds because encodeURIComponent percent-encodes "/", ":", "?", "#", "@".
// ---------------------------------------------------------------------------

const BATTERY = [
  ['hash', '#'],
  ['question mark', '?'],
  ['ampersand', '&'],
  ['forward slash', '/'],
  ['colon', ':'],
  ['at sign', '@'],
  ['percent', '%'],
  ['encoded slash', '%2F'],
  ['double-encoded slash', '%252F'],
  ['literal newline', 'line one\nline two'],
  ['CRLF', 'line one\r\nline two'],
  ['tab', 'before\tafter'],
  ['NUL', 'before\u0000after'],
  ['unpaired high surrogate', 'before\uD800after'],
  ['unpaired low surrogate', 'before\uDC00after'],
  ['paired surrogate emoji', 'party \u{1F389} time'],
  ['RTL override', 'before\u202Eafter'],
  ['text that looks like a URL', 'https://evil.test/'],
  ['query-string injection attempt', '?title=evil&body=evil'],
  ['path traversal', '../../../attacker'],
  ['backslash', 'C:\\evil\\path'],
  ['very long run', 'a'.repeat(5000)],
  ['authority injection attempt', '//evil.test/'],
  ['scheme injection attempt', 'javascript:alert(1)'],
  ['CRLF header injection attempt', 'x\r\nLocation: https://evil.test/'],
  ['fullwidth g homograph', 'https://\uFF47ithub.com/evil']
];

test('CONTAINMENT: no feedback text moves the origin or the path (description)', async () => {
  const table = [];
  for (const [label, text] of BATTERY) {
    openedUrls.length = 0;
    await openGitHubIssue(withDescription(text));
    assert.equal(openedUrls.length, 1, `must open: ${label}`);
    const opened = new URL(openedUrls[0]);
    table.push(`${label.padEnd(34)} len=${String(openedUrls[0].length).padEnd(6)} origin=${opened.origin} path=${opened.pathname}`);
    assert.equal(opened.origin, ORIGIN, `ORIGIN MOVED for: ${label}`);
    assert.equal(opened.pathname, PATHNAME, `PATH MOVED for: ${label}`);
    assert.equal(opened.port, '', `a port appeared for: ${label}`);
    assert.equal(opened.username, '', `credentials appeared for: ${label}`);
    assert.equal(opened.password, '', `credentials appeared for: ${label}`);
    assert.equal(opened.protocol, 'https:', `protocol changed for: ${label}`);
  }
  console.log('\n--- containment battery (description) ---\n' + table.join('\n'));
});

test('CONTAINMENT: the same battery through the TITLE, which is emitted twice', async () => {
  for (const [label, text] of BATTERY) {
    openedUrls.length = 0;
    // The title is bounded at 100 UTF-16 units by the validator, so the long run
    // is exercised in the description case above rather than truncated here.
    if (text.length > 100) continue;
    await openGitHubIssue({
      type: 'suggestion',
      title: text,
      description: 'ordinary description',
      attachDiagnostic: false
    });
    assert.equal(openedUrls.length, 1, `must open: ${label}`);
    const opened = new URL(openedUrls[0]);
    assert.equal(opened.origin, ORIGIN, `ORIGIN MOVED via title for: ${label}`);
    assert.equal(opened.pathname, PATHNAME, `PATH MOVED via title for: ${label}`);
  }
});

test('CONTAINMENT: the same battery through the EMAIL field', async () => {
  for (const [label, text] of BATTERY) {
    if (text.length > 254) continue;
    openedUrls.length = 0;
    await openGitHubIssue({
      type: 'bug',
      title: 'ordinary title',
      description: 'ordinary description',
      email: text,
      attachDiagnostic: false
    });
    assert.equal(openedUrls.length, 1, `must open: ${label}`);
    const opened = new URL(openedUrls[0]);
    assert.equal(opened.origin, ORIGIN, `ORIGIN MOVED via email for: ${label}`);
    assert.equal(opened.pathname, PATHNAME, `PATH MOVED via email for: ${label}`);
  }
});

test('CONTAINMENT: openRepoUrl still cannot reach the donation hosts or a non-repo path', async () => {
  // The second door must stay STRICTLY narrower than the renderer-facing one.
  for (const rejected of [
    'https://ko-fi.com/haykmne',
    'https://www.ko-fi.com/haykmne',
    'https://patreon.com/c/HaYkMnE',
    'https://www.patreon.com/c/HaYkMnE',
    'https://t.me/tribute/app',
    'https://www.t.me/tribute/app',
    'https://telegram.org/',
    'https://www.telegram.org/',
    'https://github.com/',
    'https://github.com/HaYkMnE',
    'https://github.com/HaYkMnE/NV-Gateway-evil',
    'https://github.com/HaYkMnE/NV-Gateway-evil/issues/new',
    'https://github.com/attacker/NV-Gateway',
    'https://gist.github.com/HaYkMnE/NV-Gateway',
    'https://github.com.evil.test/HaYkMnE/NV-Gateway',
    'https://github.com@evil.test/HaYkMnE/NV-Gateway',
    'https://github.com:8080/HaYkMnE/NV-Gateway',
    'https://github.com:443/HaYkMnE/NV-Gateway'.replace(':443', ':80'),
    'http://github.com/HaYkMnE/NV-Gateway',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
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
    assert.deepEqual(openedUrls, [], `nothing may reach the OS for: ${String(rejected)}`);
  }

  // And it still opens the one destination it exists to serve, as the validated href.
  openedUrls.length = 0;
  await openRepoUrl(`${REPO_ISSUES_URL}?title=x&body=y`);
  assert.deepEqual(openedUrls, [`${REPO_ISSUES_URL}?title=x&body=y`]);
});
