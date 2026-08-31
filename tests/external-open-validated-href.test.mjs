// D2 — VALIDATE ONE STRING, USE ANOTHER.
//
// `openExternalUrl` validated the parsed `URL` object and then handed
// `shell.openExternal` the RAW input string, so the representation that was
// checked and the representation the OS received could differ.
//
// MEASURED: an input carrying a fullwidth `ｇ` (`https://ｇithub.com/...`) is
// validated as host `github.com`, because UTS46 maps it — while the OS received
// the literal fullwidth bytes. Same for tab, newline and NUL, which the URL
// parser strips out entirely.
//
// Not exploitable as measured: browsers apply the same normalisation, so the
// destination did not actually differ. But "validate one representation, use a
// different one" is precisely how this class of control eventually fails, so the
// OS is now handed the `url.href` that was actually validated.
//
// SCOPE NOTE: `node --test` has no Electron runtime, and `require("electron")`
// outside one yields the executable PATH STRING rather than the API object, so
// `shell` would be undefined. The `electron` module is therefore pre-seeded in
// require.cache with a recording stub, which is what makes the OS-facing
// argument observable at all. No component is rendered: there is no jsdom and no
// @testing-library/react in node_modules, and installing them is forbidden.
import assert from 'node:assert/strict';
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
    }
  }
};

const { openExternalUrl, REPO_URL, REPO_ISSUES_URL } = await import(
  pathToFileURL(join(root, 'build', 'src', 'main', 'external-open.js')).href
);

/** The six links the product genuinely opens. */
const REAL_LINKS = [
  'https://ko-fi.com/haykmne',
  'https://www.patreon.com/c/HaYkMnE',
  'https://t.me/tribute/app?startapp=ep_7qt3bDGDd36LHQg4oAifvcqXhzifEM9RF0TMtb54EZbJQOdZX0',
  'https://telegram.org/',
  REPO_URL,
  `${REPO_ISSUES_URL}?title=a&body=b`
];

test('D2: the OS receives the NORMALISED href, never the raw input', async () => {
  openedUrls.length = 0;
  // Validated as host github.com (UTS46 maps the fullwidth g); the raw string
  // kept the fullwidth bytes, and that is what used to reach the OS.
  await openExternalUrl('https://\uFF47ithub.com/HaYkMnE/NV-Gateway');
  assert.deepEqual(openedUrls, ['https://github.com/HaYkMnE/NV-Gateway']);

  for (const raw of [
    'https://git\thub.com/HaYkMnE/NV-Gateway',
    'https://github.com/HaYkMnE/NV-Gateway\n',
    'https://github.com/HaYkMnE/NV-Gateway\u0000',
    'https://GITHUB.COM/HaYkMnE/NV-Gateway',
    'https://github.com:443/HaYkMnE/NV-Gateway'
  ]) {
    openedUrls.length = 0;
    await openExternalUrl(raw);
    assert.equal(openedUrls.length, 1, `exactly one open for ${JSON.stringify(raw)}`);
    assert.equal(
      openedUrls[0],
      new URL(raw).href,
      `the OS must receive the parsed href for ${JSON.stringify(raw)}`
    );
    assert.ok(
      !/[\t\n\u0000\uFF47]/.test(openedUrls[0]),
      `no raw control or fullwidth byte may reach the OS: ${JSON.stringify(openedUrls[0])}`
    );
    // The explicit default port must not survive into the OS-facing string either.
    assert.ok(!openedUrls[0].includes(':443'), 'a default port must be normalised away');
  }
});

test('D2: normalisation changes NOTHING for any of the six real links (byte-for-byte)', async () => {
  // The guarantee that makes this a safe change: `URL.href` can add a trailing
  // slash or re-encode a query, so every link the product actually opens is
  // checked byte-for-byte, including the long Telegram ?startapp= payload.
  for (const link of REAL_LINKS) {
    assert.equal(new URL(link).href, link, `URL.href must not rewrite a real link: ${link}`);
    openedUrls.length = 0;
    await openExternalUrl(link);
    assert.deepEqual(openedUrls, [link], `the OS must receive the real link verbatim: ${link}`);
  }

  const tribute = REAL_LINKS[2];
  openedUrls.length = 0;
  await openExternalUrl(tribute);
  assert.ok(
    openedUrls[0].endsWith('?startapp=ep_7qt3bDGDd36LHQg4oAifvcqXhzifEM9RF0TMtb54EZbJQOdZX0'),
    'the Tribute startapp parameter must survive normalisation intact'
  );
});

test('D2: a rejected URL reaches the OS not at all', async () => {
  openedUrls.length = 0;
  for (const rejected of [
    'https://evil.test/',
    'https://github.com:8080/HaYkMnE/NV-Gateway',
    'https://github.com/HaYkMnE/NV-Gateway-evil',
    'http://github.com/HaYkMnE/NV-Gateway',
    'javascript:alert(1)',
    null,
    undefined,
    42
  ]) {
    await assert.rejects(() => openExternalUrl(rejected), /not on the allowlist/, `must reject: ${String(rejected)}`);
  }
  assert.deepEqual(openedUrls, [], 'nothing may be opened for a rejected input');
});
