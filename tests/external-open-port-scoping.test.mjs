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
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { isAllowedExternalUrl, REPO_URL, REPO_ISSUES_URL } = await import(
  pathToFileURL(join(root, 'build', 'src', 'main', 'external-open.js')).href
);
const externalOpenSource = readFileSync(join(root, 'src', 'main', 'external-open.ts'), 'utf8');

/** The six links the product genuinely opens. */
const REAL_LINKS = [
  'https://ko-fi.com/haykmne',
  'https://www.patreon.com/c/HaYkMnE',
  'https://t.me/tribute/app?startapp=ep_7qt3bDGDd36LHQg4oAifvcqXhzifEM9RF0TMtb54EZbJQOdZX0',
  'https://telegram.org/',
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
    'https://telegram.org:80/'
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
  // Whatever is allowed must land on exactly one of: an allowlisted donation
  // host, or the one repository path. This restates the property the 77-input
  // gate measured, so it holds for every future edit rather than only today.
  const ALLOWED_HOSTS = new Set([
    'patreon.com', 'www.patreon.com', 'ko-fi.com', 'www.ko-fi.com',
    't.me', 'www.t.me', 'telegram.org', 'www.telegram.org'
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
    const onRepo = url.hostname === 'github.com' &&
      (url.pathname === '/HaYkMnE/NV-Gateway' || url.pathname.startsWith('/HaYkMnE/NV-Gateway/'));
    assert.ok(
      ALLOWED_HOSTS.has(url.hostname) || onRepo,
      `allowed input escaped the intended surface: ${probe} -> ${url.href}`
    );
  }
});
