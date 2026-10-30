// D1 — THE PORT WAS NEVER CONSTRAINED.
//
// `isAllowedExternalUrl` checked scheme, host and path but never `url.port`, so
// `https://github.com:8080/HaYkMnE/NV-Gateway` and `https://ko-fi.com:8080/haykmne`
// were both ALLOWED. Severity LOW: the hostname is still the operator's, so
// neither can reach a third party's server, and in practice the connection just
// fails. But a control whose entire job is constraining the destination was
// leaving part of the destination unconstrained.
//
// This file also carries the hostile battery, because D1 is the only one of the
// three defects that changes an allow/reject OUTCOME — the other two change what
// is handed to the OS and which door the feedback path uses.
//
// SCOPE NOTE: there is no jsdom and no @testing-library/react in node_modules
// (installing is forbidden), so nothing here renders a component. The allowlist
// is asserted BEHAVIOURALLY against the compiled main-process module.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// D5 asserts the REPOSITORY door behaviourally, not only through the shared
// parser, so `electron`'s shell is pre-seeded with a recording stub — the same
// harness `external-open-validated-href.test.mjs` uses. Outside an Electron
// runtime `require('electron')` yields the executable PATH STRING, so `shell`
// would be undefined and the OS-facing argument unobservable.
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
    }
  }
};

const { isAllowedExternalUrl, openExternalUrl, openRepoUrl, REPO_URL, REPO_ISSUES_URL } = await import(
  pathToFileURL(join(root, 'build', 'src', 'main', 'external-open.js')).href
);
const externalOpenSource = readFileSync(join(root, 'src', 'main', 'external-open.ts'), 'utf8');

/** The seven links the product genuinely opens. */
const REAL_LINKS = [
  'https://ko-fi.com/haykmne',
  'https://www.patreon.com/c/HaYkMnE',
  'https://t.me/tribute/app?startapp=ep_7qt3bDGDd36LHQg4oAifvcqXhzifEM9RF0TMtb54EZbJQOdZX0',
  'https://telegram.org/',
  // Round E: the Models view's licence-required "Data by LLM Stats" attribution.
  'https://llm-stats.com/',
  REPO_URL,
  `${REPO_ISSUES_URL}?title=a&body=b`
];

test('D1: a non-default port is rejected on every allowlisted destination', () => {
  for (const rejected of [
    'https://github.com:8080/HaYkMnE/NV-Gateway',
    'https://ko-fi.com:8080/haykmne',
    'https://github.com:0/HaYkMnE/NV-Gateway',
    'https://t.me:1/x',
    'https://www.patreon.com:3000/c/HaYkMnE',
    'https://github.com:65535/HaYkMnE/NV-Gateway/issues/new',
    'https://telegram.org:80/',
    'https://llm-stats.com:8443/'
  ]) {
    assert.equal(isAllowedExternalUrl(rejected), false, `port must be constrained: ${rejected}`);
  }
});

test('D1: the real links carry no port and stay allowed; explicit :443 is the same destination', () => {
  // WHATWG URL strips the scheme's DEFAULT port, so `:443` on https parses to
  // port "" — an explicit :443 is an identical destination to the bare form,
  // which is why one `port === ""` rule covers both with no special case.
  assert.equal(new URL('https://github.com:443/HaYkMnE/NV-Gateway').port, '');
  assert.equal(isAllowedExternalUrl('https://github.com:443/HaYkMnE/NV-Gateway'), true);
  assert.equal(isAllowedExternalUrl('https://ko-fi.com:443/haykmne'), true);

  for (const link of REAL_LINKS) {
    assert.equal(new URL(link).port, '', `real link must carry no port: ${link}`);
    assert.equal(isAllowedExternalUrl(link), true, `real link must stay allowed: ${link}`);
  }
});

test('the LLM Stats attribution link is allowlisted, https-only and port-scoped', () => {
  // Round E added this link to the Models view; before the host was allowlisted,
  // openExternalUrl THREW "External URL is not on the allowlist." and the
  // renderer's `.catch(() => undefined)` turned the attribution into a silent
  // no-op. The positive case below is the regression guard.
  assert.equal(isAllowedExternalUrl('https://llm-stats.com/'), true);
  assert.equal(isAllowedExternalUrl('https://www.llm-stats.com/'), true, 'the www form is allowlisted too');
  assert.equal(isAllowedExternalUrl('http://llm-stats.com/'), false, 'https is required');
  assert.equal(isAllowedExternalUrl('https://llm-stats.com:8443/'), false, 'a non-default port must be rejected');
  assert.equal(isAllowedExternalUrl('https://llm-stats.com:443/'), true, 'an explicit default port is the same destination');
  assert.equal(isAllowedExternalUrl('https://evil-llm-stats.com/'), false, 'a lookalike host must not be admitted');
});

test('the https-only gate, the 2048 cap and the path scoping all survive', () => {
  assert.ok(externalOpenSource.includes('protocol === "https:"'), 'the https-only spelling must be preserved');
  assert.ok(externalOpenSource.includes('2048'), 'the length cap must be preserved');

  const prefix = `${REPO_ISSUES_URL}?body=`;
  const under = `${prefix}${'x'.repeat(2048 - prefix.length)}`;
  assert.equal(under.length, 2048);
  assert.equal(isAllowedExternalUrl(under), true, 'exactly 2048 characters must be allowed');
  assert.equal(isAllowedExternalUrl(`${under}x`), false, '2049 characters must be rejected');

  // Path scoping keeps the trailing-slash discrimination that rejects a sibling repo.
  assert.equal(isAllowedExternalUrl('https://github.com/HaYkMnE/NV-Gateway'), true);
  assert.equal(isAllowedExternalUrl('https://github.com/HaYkMnE/NV-Gateway/issues/new'), true);
  assert.equal(isAllowedExternalUrl('https://github.com/HaYkMnE/NV-Gateway-evil'), false);
});

// D5 — USERINFO WAS NEVER CONSTRAINED.
//
// `parseAllowedUrl` checked scheme (`protocol === "https:"`) and port
// (`port === ""`) and then delegated the host to `hostRuleMatches`, but it never
// looked at `url.username` / `url.password`. MEASURED against the built module
// before the fix:
//
//   isAllowedExternalUrl('https://attacker:pw@github.com/HaYkMnE/NV-Gateway') === true
//   isAllowedExternalUrl('https://u:p@ko-fi.com/') === true
//
// Both pass because WHATWG keeps `url.hostname` at the real host and puts the
// credentials in a SEPARATE field: `new URL('https://attacker:pw@github.com/…')`
// gives `hostname === 'github.com'`, `username === 'attacker'`, `password === 'pw'`.
// So BOTH doors — the host allowlist (`matchesExternalHostRule`) and the repo
// path rule (`isAllowedRepoUrl`) — saw only the host they were meant to see, and
// the credentials survived into `url.href`, which is the string handed to
// `shell.openExternal`. A URL that visibly reads as `attacker:pw@github.com` was
// therefore opened by the OS as-is.
//
// The rule is the narrowest one available: reject ANY url carrying userinfo.
// Nothing the product opens carries it — all seven real links are bare. This is
// checked inside `parseAllowedUrl`, so it applies to both doors at once rather
// than being re-implemented at each call site.
test('D5: userinfo is rejected on the repository door (the credentials cannot ride along)', async () => {
  for (const rejected of [
    'https://attacker:pw@github.com/HaYkMnE/NV-Gateway',
    'https://attacker:pw@github.com/HaYkMnE/NV-Gateway/issues/new',
    'https://user@github.com/HaYkMnE/NV-Gateway',
    'https://:pw@github.com/HaYkMnE/NV-Gateway',
    'https://%40@github.com/HaYkMnE/NV-Gateway'
  ]) {
    assert.equal(isAllowedExternalUrl(rejected), false, `userinfo must be rejected: ${rejected}`);
    openedUrls.length = 0;
    await assert.rejects(
      () => openRepoUrl(rejected),
      /not on the allowlist/,
      `the repository door must reject: ${rejected}`
    );
    assert.deepEqual(openedUrls, [], `nothing may reach the OS for: ${rejected}`);
  }
});

test('D5: userinfo is rejected on the allowlisted-host door', async () => {
  for (const rejected of [
    'https://u:p@ko-fi.com/',
    'https://u:p@ko-fi.com/haykmne',
    'https://user@www.patreon.com/c/HaYkMnE',
    'https://:pw@t.me/tribute/app',
    'https://u:p@llm-stats.com/'
  ]) {
    assert.equal(isAllowedExternalUrl(rejected), false, `userinfo must be rejected: ${rejected}`);
    openedUrls.length = 0;
    await assert.rejects(
      () => openExternalUrl(rejected),
      /not on the allowlist/,
      `the renderer-facing door must reject: ${rejected}`
    );
    assert.deepEqual(openedUrls, [], `nothing may reach the OS for: ${rejected}`);
  }
});

test('D5: the empty-userinfo spellings the parser NORMALISES AWAY stay allowed', async () => {
  // WHATWG drops an empty userinfo entirely, so `https://@github.com/…` and
  // `https://:@github.com/…` come back as `username === "" && password === ""`
  // with an href identical to the bare form. MEASURED:
  //   new URL('https://@github.com/HaYkMnE/NV-Gateway').href === 'https://github.com/HaYkMnE/NV-Gateway'
  // Rejecting on `@`-presence would be wrong; the check is on the PARSED fields,
  // which is why these must still open — and open the normalised, credential-free
  // href.
  for (const [raw, expected] of [
    ['https://@github.com/HaYkMnE/NV-Gateway', 'https://github.com/HaYkMnE/NV-Gateway'],
    ['https://:@github.com/HaYkMnE/NV-Gateway', 'https://github.com/HaYkMnE/NV-Gateway'],
    ['https://@ko-fi.com/haykmne', 'https://ko-fi.com/haykmne']
  ]) {
    const parsed = new URL(raw);
    assert.equal(parsed.username, '', `no credentials survive parsing: ${raw}`);
    assert.equal(parsed.password, '', `no password survives parsing: ${raw}`);
    assert.equal(isAllowedExternalUrl(raw), true, `normalised-empty userinfo must stay allowed: ${raw}`);
    openedUrls.length = 0;
    await openExternalUrl(raw);
    assert.deepEqual(openedUrls, [expected], `the OS must receive the credential-free href for: ${raw}`);
  }
});

test('D5: the real links and the plain forms are unchanged', async () => {
  // The fix must not weaken the existing scheme/port/host checks, and must not
  // reject anything the product really opens.
  for (const link of REAL_LINKS) {
    assert.equal(new URL(link).username, '', `a real link must carry no userinfo: ${link}`);
    assert.equal(new URL(link).password, '', `a real link must carry no password: ${link}`);
    assert.equal(isAllowedExternalUrl(link), true, `a real link must stay allowed: ${link}`);
  }
  assert.equal(isAllowedExternalUrl('https://github.com/HaYkMnE/NV-Gateway'), true);
  assert.equal(isAllowedExternalUrl('https://github.com/HaYkMnE/NV-Gateway/issues/new'), true);
  assert.equal(isAllowedExternalUrl('https://ko-fi.com/haykmne'), true);
  assert.equal(isAllowedExternalUrl('https://ko-fi.com/'), true);

  // The userinfo check must be additive, not a replacement: the pre-existing
  // scheme and port rejections still hold.
  assert.equal(isAllowedExternalUrl('http://github.com/HaYkMnE/NV-Gateway'), false, 'https is still required');
  assert.equal(isAllowedExternalUrl('https://github.com:8080/HaYkMnE/NV-Gateway'), false, 'a non-default port is still rejected');
  assert.equal(isAllowedExternalUrl('https://github.com/HaYkMnE/NV-Gateway-evil'), false, 'path scoping still holds');
});

test('D5: the userinfo check is present in the source and covers both doors', () => {
  assert.ok(
    /url\.username\s*!==\s*""/.test(externalOpenSource) && /url\.password\s*!==\s*""/.test(externalOpenSource),
    'external-open.ts must reject a URL that carries userinfo'
  );
  // It must live in `parseAllowedUrl`, which both doors call — not be duplicated
  // at one call site, where the other door would keep the hole.
  const parseStart = externalOpenSource.indexOf('function parseAllowedUrl');
  const parseEnd = externalOpenSource.indexOf('\n}', parseStart);
  assert.ok(parseStart > 0, 'parseAllowedUrl must be locatable');
  const body = externalOpenSource.slice(parseStart, parseEnd);
  assert.ok(body.includes('url.username'), 'the userinfo check must live inside parseAllowedUrl');
  assert.ok(body.includes('url.password'), 'the password check must live inside parseAllowedUrl');
});

test('hostile battery: nothing reaches a destination outside the intended surface', () => {
  const LONG = 'x'.repeat(2100);
  // Every expectation below was MEASURED against the module, not reasoned from
  // the spec; four of them contradicted the obvious reading and are marked.
  const cases = [
    ['https://github.com/HaYkMnE/NV-Gateway%2F..%2Fattacker%2Frepo', false, 'MEASURED: %2F stays a literal byte, so the path is not below the repo path'],
    ['https://github.com/HaYkMnE%2FNV-Gateway', false, 'encoded slash does not reconstruct the repo path'],
    ['https://github.com/HaYkMnE/NV-Gateway%252F..', false, 'MEASURED: double-encoded slash is likewise a literal byte'],
    ['https://GITHUB.COM/HaYkMnE/NV-Gateway', true, 'host case folds to the allowlisted host'],
    ['https://github.com/haykmne/nv-gateway', false, 'path is case-SENSITIVE; a different repo'],
    ['https://github.com/HaYkMnE/NV-Gateway/../../attacker/repo', false, 'traversal resolves OUT of the repo path'],
    ['https://github.com/HaYkMnE/NV-Gateway/./issues', true, '/./ resolves inside the repo path'],
    ['https://github.com//HaYkMnE/NV-Gateway', false, 'double slash is a different path'],
    ['https://github.com@evil.test/HaYkMnE/NV-Gateway', false, 'userinfo authority: real host is evil.test'],
    ['https://github.com.@evil.test/', false, 'userinfo with trailing dot'],
    ['https://attacker:pw@github.com/HaYkMnE/NV-Gateway', false, 'D5: userinfo on the repo host'],
    ['https://user@github.com/HaYkMnE/NV-Gateway', false, 'D5: username only'],
    ['https://:pw@github.com/HaYkMnE/NV-Gateway', false, 'D5: password only'],
    ['https://%40@github.com/HaYkMnE/NV-Gateway', false, 'D5: percent-encoded userinfo'],
    ['https://u:p@ko-fi.com/haykmne', false, 'D5: userinfo on an allowlisted host'],
    ['https://u:p@llm-stats.com/', false, 'D5: userinfo on the attribution host'],
    ['https://@github.com/HaYkMnE/NV-Gateway', true, 'D5: empty userinfo is normalised away by the parser'],
    ['https://:@github.com/HaYkMnE/NV-Gateway', true, 'D5: empty user:password is normalised away'],
    ['https://github.com./HaYkMnE/NV-Gateway', false, 'trailing-dot host is not the allowlisted host'],
    ['https://www.github.com/HaYkMnE/NV-Gateway', false, 'www. subdomain is not allowlisted for the repo'],
    ['https://api.github.com/HaYkMnE/NV-Gateway', false, 'api. subdomain'],
    ['https://gist.github.com/HaYkMnE/NV-Gateway', false, 'gist. subdomain'],
    ['https://raw.githubusercontent.com/HaYkMnE/NV-Gateway/main/x', false, 'different host entirely'],
    ['https://github.com.evil.test/HaYkMnE/NV-Gateway', false, 'suffix-appended lookalike host'],
    ['https://xn--ithub-8m4a.com/HaYkMnE/NV-Gateway', false, 'punycode homoglyph host'],
    ['https://\uFF47ithub.com/HaYkMnE/NV-Gateway', true, 'UTS46 maps fullwidth g to the real host; href is normalised'],
    ['https://g\u0456thub.com/HaYkMnE/NV-Gateway', false, 'Cyrillic i homoglyph maps to a punycode host'],
    ['https:\\\\github.com\\HaYkMnE\\NV-Gateway', true, 'MEASURED: WHATWG maps backslash to slash for special schemes, normalising to the real repo'],
    ['https://github.com/HaYkMnE/NV-Gateway\\..\\attacker', false, 'MEASURED: backslash becomes slash, then .. resolves OUT to /HaYkMnE/attacker'],
    ['https://github.com /HaYkMnE/NV-Gateway', false, 'embedded space in the authority'],
    ['https://github.com/HaYkMnE/NV-Gateway\u0000', true, 'NUL is stripped by the parser; href is normalised'],
    ['https://github.com/HaYkMnE/NV\u0000-Gateway', false, 'NUL inside the slug is not the repo path'],
    ['https://github.com/HaYkMnE/NV-Gateway\t/issues', true, 'tab is stripped by the parser; href is normalised'],
    [`https://github.com/HaYkMnE/NV-Gateway/issues/new?body=${LONG}`, false, 'over the 2048 cap'],
    ['', false, 'empty string'],
    [null, false, 'null'],
    [undefined, false, 'undefined'],
    [42, false, 'non-string number'],
    [{}, false, 'non-string object'],
    [['https://github.com/HaYkMnE/NV-Gateway'], false, 'array, not a string'],
    ['HTTPS://github.com/HaYkMnE/NV-Gateway', true, 'scheme case folds to https:'],
    ['//github.com/HaYkMnE/NV-Gateway', false, 'scheme-relative has no base and does not parse'],
    ['javascript:alert(1)//github.com/HaYkMnE/NV-Gateway', false, 'javascript: scheme'],
    ['data:text/html,<script>1</script>', false, 'data: scheme'],
    ['file:///C:/Windows/System32/calc.exe', false, 'file: scheme'],
    ['blob:https://github.com/HaYkMnE/NV-Gateway', false, 'blob: scheme'],
    ['vscode://ms-vscode.remote/x', false, 'vscode: custom scheme'],
    ['http://github.com/HaYkMnE/NV-Gateway', false, 'plain http is not https'],
    ['https://github.com:8080/HaYkMnE/NV-Gateway', false, 'D1: non-default port'],
    ['https://ko-fi.com:8080/haykmne', false, 'D1: non-default port on a donation host'],
    ['https://github.com:443/HaYkMnE/NV-Gateway', true, 'explicit default port normalises to no port'],
    ['https://ko-fi.com/haykmne', true, 'real donation link'],
    ['https://www.patreon.com/c/HaYkMnE', true, 'real donation link'],
    ['https://t.me/tribute/app?startapp=ep_7qt3bDGDd36LHQg4oAifvcqXhzifEM9RF0TMtb54EZbJQOdZX0', true, 'real donation link'],
    ['https://telegram.org/', true, 'allowlisted host'],
    ['https://github.com/HaYkMnE/NV-Gateway', true, 'real repo link'],
    ['https://github.com/HaYkMnE/NV-Gateway/issues/new?title=a&body=b', true, 'real issues link']
  ];

  // JSON.stringify(undefined) returns the VALUE undefined, not a string, and
  // `undefined` is one of the inputs — so the label is built defensively.
  const label = (input) => (input === undefined ? 'undefined' : String(JSON.stringify(input)));

  const rows = [];
  const failures = [];
  for (const [input, expected, why] of cases) {
    const actual = isAllowedExternalUrl(input);
    rows.push(
      `${(actual ? 'ALLOWED ' : 'REJECTED').padEnd(9)}| ${expected === actual ? 'ok  ' : 'FAIL'} | ` +
      `${label(input).slice(0, 62).padEnd(64)}| ${why}`
    );
    if (actual !== expected) failures.push(`${label(input)} => ${actual}, expected ${expected} (${why})`);
  }
  console.log('\nHOSTILE BATTERY (result | correct? | input | why)\n' + rows.join('\n') + '\n');
  assert.deepEqual(failures, [], `battery regressions:\n${failures.join('\n')}`);
});

test('hostile battery: no allowed input escapes the intended destinations', () => {
  // Whatever is allowed must land on exactly one of: an allowlisted host, or
  // the one repository path. This restates the property the battery measured,
  // so it holds for every future edit rather than only today.
  const ALLOWED_HOSTS = new Set([
    'patreon.com', 'www.patreon.com', 'ko-fi.com', 'www.ko-fi.com',
    't.me', 'www.t.me', 'telegram.org', 'www.telegram.org',
    'llm-stats.com', 'www.llm-stats.com'
  ]);
  const probes = [
    'https://github.com/HaYkMnE/NV-Gateway/./issues',
    'https://\uFF47ithub.com/HaYkMnE/NV-Gateway',
    'https://github.com:443/HaYkMnE/NV-Gateway',
    'HTTPS://github.com/HaYkMnE/NV-Gateway',
    'https://github.com/HaYkMnE/NV-Gateway\u0000',
    'https:\\\\github.com\\HaYkMnE\\NV-Gateway',
    ...REAL_LINKS
  ];
  for (const probe of probes) {
    if (!isAllowedExternalUrl(probe)) continue;
    const url = new URL(probe);
    assert.equal(url.protocol, 'https:', `allowed input must be https: ${probe}`);
    assert.equal(url.port, '', `allowed input must carry no port: ${probe}`);
    // D5: whatever is allowed must be free of credentials, so the string handed
    // to the OS can never read as a different authority than the one validated.
    assert.equal(url.username, '', `allowed input must carry no username: ${probe}`);
    assert.equal(url.password, '', `allowed input must carry no password: ${probe}`);
    const onRepo = url.hostname === 'github.com' &&
      ['/HaYkMnE/NV-Gateway'].some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`));
    assert.ok(
      ALLOWED_HOSTS.has(url.hostname) || onRepo,
      `allowed input escaped the intended surface: ${probe} -> ${url.href}`
    );
  }
});
