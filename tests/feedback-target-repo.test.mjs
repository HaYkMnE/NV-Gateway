// Feedback target repo (owner decision, ход 17).
//
// In-app feedback targets the public source repo HaYkMnE/NV-Gateway, which is
// also the release and update-feed repo. REPO_URL (pinned to
// package.json:repository.url, the About dialog's repoUrl) and FEEDBACK_REPO_URL
// are the same URL, so the allowlist admits exactly ONE repo path and rejects its
// siblings, including the pre-rename NV-Gateway-releases name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const openedUrls = [];
const nodeRequire = createRequire(import.meta.url);
const electronId = nodeRequire.resolve('electron');
nodeRequire.cache[electronId] = {
  id: electronId, filename: electronId, loaded: true, children: [], paths: [],
  exports: {
    shell: { openExternal: async (url) => { openedUrls.push(url); } },
    app: {
      getPath: () => join(root, 'build', '.test-userdata-unused'),
      getVersion: () => '0.0.0-test',
      getName: () => 'nv-gateway-test'
    }
  }
};

const built = (name) => pathToFileURL(join(root, 'build', 'src', 'main', name)).href;
const { REPO_URL, FEEDBACK_REPO_URL, REPO_ISSUES_URL, isAllowedExternalUrl, openRepoUrl } = await import(built('external-open.js'));
const { openGitHubIssue } = await import(built('feedback-service.js'));

test('feedback and About both target the public source repo', () => {
  assert.equal(FEEDBACK_REPO_URL, 'https://github.com/HaYkMnE/NV-Gateway');
  assert.equal(FEEDBACK_REPO_URL, REPO_URL, 'feedback and About share one repository');
  assert.equal(REPO_ISSUES_URL, 'https://github.com/HaYkMnE/NV-Gateway/issues/new');
  assert.equal(REPO_URL, 'https://github.com/HaYkMnE/NV-Gateway');
  const indexSource = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8');
  assert.ok(indexSource.includes('repoUrl: REPO_URL'), 'About keeps the source repo URL');
});

test('openGitHubIssue opens the source repo issues page', async () => {
  openedUrls.length = 0;
  await openGitHubIssue({ type: 'idea', title: 'Idea', description: 'Body text', attachDiagnostic: false });
  assert.equal(openedUrls.length, 1);
  const opened = new URL(openedUrls[0]);
  assert.equal(opened.origin, 'https://github.com');
  assert.equal(opened.pathname, '/HaYkMnE/NV-Gateway/issues/new');
});

test('allowlist: exactly the one repo path (and below); its siblings are rejected', async () => {
  for (const allowed of [
    'https://github.com/HaYkMnE/NV-Gateway/issues/new?title=a&body=b',
    'https://github.com/HaYkMnE/NV-Gateway',
    'https://github.com/HaYkMnE/NV-Gateway/issues/new'
  ]) {
    assert.equal(isAllowedExternalUrl(allowed), true, `must be allowed: ${allowed}`);
  }
  const rejected = [
    // The pre-rename name: GitHub redirects it, but the app links the canonical
    // repo only, so the allowlist must not grow a second door for it.
    'https://github.com/HaYkMnE/NV-Gateway-releases',
    'https://github.com/HaYkMnE/NV-Gateway-releases/issues/new',
    'https://github.com/HaYkMnE/NV-Gateway-releases-evil',
    'https://github.com/HaYkMnE/NV-Gateway-releases-evil/issues/new',
    'https://github.com/HaYkMnE/NV-Gateway-releasesevil',
    'https://github.com/HaYkMnE/NV-Gateway-release',
    'https://github.com/HaYkMnE/NV-Gateway-evil',
    'https://github.com/haykmne/nv-gateway-releases',
    'https://github.com/haykmne/nv-gateway',
    'https://github.com/HaYkMnE/NV-Gatewayevil',
    'https://github.com/attacker/NV-Gateway',
    'https://github.com/HaYkMnE/NV-Gateway/../../attacker/repo',
    'https://github.com:8080/HaYkMnE/NV-Gateway',
    'http://github.com/HaYkMnE/NV-Gateway',
    'https://attacker:pw@github.com/HaYkMnE/NV-Gateway',
    'https://gist.github.com/HaYkMnE/NV-Gateway',
    'https://github.com.evil.test/HaYkMnE/NV-Gateway',
    'https://github.com/attacker/NV-Gateway-releases',
    'https://github.com/HaYkMnE/NV-Gateway-releases/../../attacker/repo',
    'https://github.com:8080/HaYkMnE/NV-Gateway-releases',
    'http://github.com/HaYkMnE/NV-Gateway-releases',
    'https://attacker:pw@github.com/HaYkMnE/NV-Gateway-releases',
    'https://gist.github.com/HaYkMnE/NV-Gateway-releases',
    'https://github.com.evil.test/HaYkMnE/NV-Gateway-releases'
  ];
  for (const url of rejected) {
    assert.equal(isAllowedExternalUrl(url), false, `renderer door must reject: ${url}`);
    openedUrls.length = 0;
    await assert.rejects(() => openRepoUrl(url), /not on the allowlist/, `repo door must reject: ${url}`);
    assert.deepEqual(openedUrls, [], `nothing may open for: ${url}`);
  }
});
