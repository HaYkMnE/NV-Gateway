import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { extractReleaseNotes, writeReleaseNotes, renderReleaseBody, RELEASE_NOTES_FILE, RELEASE_BODY_FILE } from '../scripts/release-notes.mjs';

// CHANGELOG.md -> build/release-notes.md -> latest.yml releaseNotes (in-app
// dialog), and build/release-body.md (user block + section) -> the GitHub
// release body. Fixture changelogs only: the real
// CHANGELOG.md content is owned by the docs writer.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURE = [
  '# Changelog',
  '',
  'All notable changes to this project will be documented in this file.',
  '',
  '## [Unreleased]',
  '',
  '- work in progress',
  '',
  '## [0.2.0] - 2026-10-01',
  '',
  '### Added',
  '- Periodic update check',
  '',
  '### Fixed',
  '- Tray flicker',
  '',
  '## [0.1.0] - 2026-09-01',
  '',
  '- First release',
  ''
].join('\r\n');

test('extracts exactly the section for the requested version', () => {
  assert.equal(extractReleaseNotes(FIXTURE, '0.2.0'), '### Added\n- Periodic update check\n\n### Fixed\n- Tray flicker');
  assert.equal(extractReleaseNotes(FIXTURE, '0.1.0'), '- First release', 'the last section runs to end of file');
});

test('stops at the next "## [" heading and does not match a version prefix', () => {
  const out = extractReleaseNotes(FIXTURE, '0.2.0');
  assert.doesNotMatch(out, /First release|0\.1\.0/);
  const tricky = '## [1.0.10] - 2026-01-02\n- ten\n## [1.0.1] - 2026-01-01\n- one\n';
  assert.equal(extractReleaseNotes(tricky, '1.0.1'), '- one', '1.0.1 must not match the 1.0.10 heading');
  assert.equal(extractReleaseNotes('## [1.0.0] - 2026-01-01\n### Added\n- x\n## [0.9.0]\n- y', '1.0.0'), '### Added\n- x', '### subsections stay; the next ## [ ends it');
});

test('fails clearly on a missing or empty version section', () => {
  assert.throws(() => extractReleaseNotes(FIXTURE, '9.9.9'), /no "## \[9\.9\.9\] - YYYY-MM-DD" section/);
  assert.throws(() => extractReleaseNotes('## [1.0.0] - 2026-01-01\n\n## [0.9.0]\n- y', '1.0.0'), /section for 1\.0\.0 is empty/);
  assert.throws(() => extractReleaseNotes(FIXTURE, ''), /no version/);
});

test('writeReleaseNotes writes build/release-notes.md for package.json\'s version, and fails without a section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvgw-release-notes-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    assert.throws(() => writeReleaseNotes(dir), /CHANGELOG\.md not found/);
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), FIXTURE);
    const result = writeReleaseNotes(dir);
    assert.equal(result.version, '0.2.0');
    assert.equal(fs.readFileSync(path.join(dir, RELEASE_NOTES_FILE), 'utf8'), '### Added\n- Periodic update check\n\n### Fixed\n- Tray flicker\n');
    assert.equal(fs.readFileSync(path.join(dir, RELEASE_BODY_FILE), 'utf8'),
      renderReleaseBody('0.2.0', '### Added\n- Periodic update check\n\n### Fixed\n- Tray flicker'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '3.0.0' }));
    assert.throws(() => writeReleaseNotes(dir), /no "## \[3\.0\.0\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the generated build/release-notes.md and build/release-body.md are gitignored', () => {
  const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
  assert.ok(lines.includes('build/release-notes.md'), '.gitignore must list build/release-notes.md');
  assert.ok(lines.includes('build/release-body.md'), '.gitignore must list build/release-body.md');
});

test('the release body starts with a user block templated with the version, then "## What changed"', () => {
  const body = renderReleaseBody('1.2.3', '### Fixed\n- Tray flicker\n');
  const lines = body.split('\n');
  assert.match(lines[0], /^\*\*Which file\?\*\* Most people: `NV-Gateway-Setup-1\.2\.3\.exe` \(installer\)\. No install: `NV-Gateway-1\.2\.3-win-x64\.zip` \(portable\)\. Ignore `latest\.yml` and `\.blockmap`/);
  assert.match(body, /irm https:\/\/raw\.githubusercontent\.com\/HaYkMnE\/NV-Gateway\/main\/install\.ps1 \| iex/);
  assert.match(body, /\(https:\/\/github\.com\/HaYkMnE\/NV-Gateway\/blob\/main\/INSTALL\.md\)/);
  assert.match(body, /Get-FileHash \.\\NV-Gateway-Setup-1\.2\.3\.exe -Algorithm SHA256/);
  assert.ok(body.endsWith('## What changed\n\n### Fixed\n- Tray flicker\n'), 'the CHANGELOG section follows, trimmed');
  assert.doesNotMatch(body.split('## What changed')[0], /token|releases-repository|differential/i, 'no maintainer jargon in the user block');
  assert.doesNotMatch(body, /0\.2\.0/, 'no literal version leaks into the template');
});

test('the release build generates the notes and both consumers read the same file', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['prebuild:release'], 'node scripts/release-notes.mjs', 'npm runs it before build:release');

  const builder = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  assert.equal(builder.releaseInfo?.releaseNotesFile, 'build/release-notes.md', 'latest.yml releaseNotes come from the generated file');
  assert.equal(builder.directories?.buildResources, undefined, 'buildResources stays at the default build/ that the path is relative to');
  assert.equal(RELEASE_NOTES_FILE.replace(/\\/g, '/'), 'build/release-notes.md');

  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8'));
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const uploads = steps.filter((step) => typeof step.uses === 'string' && step.uses.startsWith('softprops/action-gh-release@'));
  assert.equal(uploads.length, 1, 'releases are published once, into this repository');
  for (const step of uploads) {
    assert.equal(step.with.body_path, 'build/release-body.md', `${step.name}: release body = user block + the same CHANGELOG section`);
  }
  const buildAt = steps.findIndex((step) => typeof step.run === 'string' && step.run.includes('npm run build:release'));
  const firstUpload = steps.indexOf(uploads[0]);
  assert.ok(buildAt >= 0 && buildAt < firstUpload, 'the notes are generated (build:release) before any upload');
});
