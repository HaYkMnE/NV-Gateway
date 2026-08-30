// The app shipped a DEAD repository slug to real users.
//
// MEASURED (2026-08-30, `gh api`): repos/susmnavorasem/nv-gateway -> HTTP 404,
// repos/HaYkMnE/NV-Gateway -> 200. Three separate places carried the dead slug
// or failed to reach the live one:
//
//   D1  src/main/feedback-service.ts  REPO_ISSUES_URL pointed at the dead slug
//       and was handed straight to shell.openExternal() from the main process
//       (ipcMain "feedback:open-github-issue"), so "Open GitHub issue" really
//       did land the user on a 404 page.
//   D2  src/main/index.ts  getAboutInfo().repoUrl hardcoded the dead slug and
//       AboutDialog renders it as visible text.
//   D3  AboutDialog.tsx used window.open(), which electron-security.ts denies
//       via setWindowOpenHandler(() => ({ action: "deny" })) -- a silent no-op.
//   D4  external-open.ts did not allow github.com at all, so even a correctly
//       IPC-routed repo link would have been rejected.
//
// This file pins all four so the dead slug cannot come back, and pins the URL
// to package.json so the value keeps ONE source of truth instead of a fourth
// hardcoded copy.
//
// NOTE ON SCOPE: there is no jsdom and no @testing-library/react in
// node_modules (and installing them is forbidden), so AboutDialog cannot be
// rendered here. The main-process pieces are asserted BEHAVIOURALLY against the
// compiled module; the renderer wiring is asserted STATICALLY over its source.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const src = (...parts) => join(root, 'src', ...parts);
const read = (p) => readFileSync(p, 'utf8');

const pkg = JSON.parse(read(join(root, 'package.json')));
const externalOpenSource = read(src('main', 'external-open.ts'));
const feedbackSource = read(src('main', 'feedback-service.ts'));
const indexSource = read(src('main', 'index.ts'));
const aboutSource = read(src('renderer', 'components', 'AboutDialog.tsx'));

// The live repository, derived from the ONE declaration that already exists.
// package.json:repository.url is "https://github.com/HaYkMnE/NV-Gateway.git".
const REPO_URL_FROM_PACKAGE = pkg.repository.url.replace(/\.git$/, '');

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

test('the dead slug is gone from every file under src/** (D1+D2)', () => {
  // Deliberately NOT asserted over electron-builder.yml: appId
  // com.susmnavorasem.nvgateway is the basis of the NSIS installer GUID, so
  // changing it would give existing users a second parallel installation
  // instead of an upgrade. It is kept on purpose.
  const offenders = [];
  for (const file of walkFiles(src())) {
    if (/susmnavorasem/i.test(read(file))) offenders.push(relative(root, file).split(sep).join('/'));
  }
  assert.deepEqual(offenders, [], `dead repo slug still present in: ${offenders.join(', ')}`);
});

test('the repo URL has ONE source of truth and equals the live repository', async () => {
  assert.equal(REPO_URL_FROM_PACKAGE, 'https://github.com/HaYkMnE/NV-Gateway');

  const { REPO_URL, REPO_ISSUES_URL } = await import(
    pathToFileURL(join(root, 'build', 'src', 'main', 'external-open.js')).href
  );
  assert.equal(REPO_URL, REPO_URL_FROM_PACKAGE, 'REPO_URL must match package.json:repository.url');
  assert.equal(REPO_ISSUES_URL, `${REPO_URL_FROM_PACKAGE}/issues/new`);

  // Compile-time constant, not a runtime package.json read: reading
  // package.json at runtime has to resolve INSIDE app.asar in a packaged
  // build, and a literal compiled into build/src/main/*.js has no filesystem
  // dependency at all, so it cannot fail there.
  assert.ok(
    !/readFileSync\([^)]*package\.json/.test(externalOpenSource),
    'the URL must not be read from package.json at runtime (app.asar path hazard)'
  );
});

test('neither feedback-service nor index.ts re-hardcodes the repo URL (single source)', () => {
  const declarations = externalOpenSource.match(/https:\/\/github\.com\/HaYkMnE\/NV-Gateway/g) ?? [];
  assert.ok(declarations.length >= 1, 'external-open.ts must declare the repo URL');

  assert.ok(
    !/https:\/\/github\.com/.test(feedbackSource),
    'feedback-service.ts must import the shared constant, not hardcode a GitHub URL'
  );
  assert.ok(
    /REPO_ISSUES_URL/.test(feedbackSource) && /from "\.\/external-open"/.test(feedbackSource),
    'feedback-service.ts must import REPO_ISSUES_URL from ./external-open'
  );

  const aboutInfoBlock = indexSource.slice(
    indexSource.indexOf('function getAboutInfo'),
    indexSource.indexOf('function migrationPhaseAuditPath')
  );
  assert.ok(aboutInfoBlock.includes('repoUrl: REPO_URL'), 'getAboutInfo must use the shared REPO_URL');
  assert.ok(
    !/https:\/\/github\.com/.test(aboutInfoBlock),
    'getAboutInfo must not hardcode a GitHub URL'
  );
});

test('"Open GitHub issue" builds a URL on the LIVE issues page (D1)', async () => {
  const { REPO_ISSUES_URL } = await import(
    pathToFileURL(join(root, 'build', 'src', 'main', 'external-open.js')).href
  );
  // The handler appends ?title=&body= to this constant; assert the base that
  // shell.openExternal actually receives resolves to the real issues page.
  const built = new URL(`${REPO_ISSUES_URL}?title=x&body=y`);
  assert.equal(built.origin, 'https://github.com');
  assert.equal(built.pathname, '/HaYkMnE/NV-Gateway/issues/new');
  assert.ok(feedbackSource.includes('${REPO_ISSUES_URL}?title='), 'issue URL must be built from the shared constant');
});

test('AboutDialog opens the repo over IPC, never window.open (D3)', () => {
  assert.ok(
    !/window\.open\s*\(/.test(aboutSource),
    'window.open is denied by electron-security.ts setWindowOpenHandler; it is a silent no-op'
  );
  assert.ok(
    /electronAPI\??\.openExternal\(/.test(aboutSource),
    'the repo link must go through window.electronAPI.openExternal (the IPC route)'
  );
  // The deny-all handler that makes window.open useless must stay in place.
  const securitySource = read(src('main', 'electron-security.ts'));
  assert.ok(
    securitySource.includes('setWindowOpenHandler(() => ({ action: "deny" }))'),
    'the deny-all window.open handler is a deliberate security control and must remain'
  );
});

test('the external-open allowlist admits the two repo links and NOTHING else on github.com (D4)', async () => {
  const { isAllowedExternalUrl } = await import(
    pathToFileURL(join(root, 'build', 'src', 'main', 'external-open.js')).href
  );

  // The two links this change actually needs.
  assert.equal(isAllowedExternalUrl('https://github.com/HaYkMnE/NV-Gateway'), true);
  assert.equal(isAllowedExternalUrl('https://github.com/HaYkMnE/NV-Gateway/issues/new?title=a&body=b'), true);

  // NARROW: the entry is scoped to the owner's repository path, not the whole
  // host. Any other github.com destination stays rejected.
  for (const rejected of [
    'https://github.com',
    'https://github.com/',
    'https://github.com/HaYkMnE',
    'https://github.com/HaYkMnE/other-repo',
    'https://github.com/HaYkMnE/NV-Gateway-evil',
    'https://github.com/HaYkMnE/NV-Gatewayevil/issues',
    'https://github.com/attacker/NV-Gateway',
    'https://gist.github.com/HaYkMnE/NV-Gateway',
    'https://raw.githubusercontent.com/HaYkMnE/NV-Gateway/main/x',
    'https://github.com.evil.test/HaYkMnE/NV-Gateway',
    'http://github.com/HaYkMnE/NV-Gateway',
    'javascript:alert(1)//github.com/HaYkMnE/NV-Gateway'
  ]) {
    assert.equal(isAllowedExternalUrl(rejected), false, `must be rejected: ${rejected}`);
  }

  // Pre-existing donation destinations keep working (no allowlist regression).
  for (const kept of ['https://patreon.com/x', 'https://ko-fi.com/x', 'https://t.me/x', 'https://telegram.org/x']) {
    assert.equal(isAllowedExternalUrl(kept), true, `must stay allowed: ${kept}`);
  }

  // The https-only gate and the length cap must survive untouched.
  assert.ok(externalOpenSource.includes('protocol === "https:"'), 'allowlist must stay https-only');
  assert.equal(isAllowedExternalUrl(`https://github.com/HaYkMnE/NV-Gateway/issues/new?body=${'x'.repeat(2100)}`), false);
  assert.equal(isAllowedExternalUrl(null), false);
  assert.equal(isAllowedExternalUrl(undefined), false);
});
