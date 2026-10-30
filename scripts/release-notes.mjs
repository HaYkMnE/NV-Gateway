// Extracts the CHANGELOG.md section for package.json's version into
// build/release-notes.md.
//
// That one file feeds both places a user reads "what's new":
//   * electron-builder.yml `releaseInfo.releaseNotesFile` -> latest.yml
//     `releaseNotes` (app-builder-lib/out/publish/updateInfoBuilder.js:13-22)
//     -> electron-updater UpdateInfo.releaseNotes -> the in-app offer dialog;
//   * build/release-body.md (written alongside) -> .github/workflows/release.yml
//     `body_path` -> the GitHub release body: a short "which file / install /
//     verify" block for users, then the same section under "## What changed".
//     The in-app dialog keeps the plain section: the user has already installed.
//
// CHANGELOG.md follows Keep a Changelog: `## [x.y.z] - YYYY-MM-DD`. A release
// whose version has no section (or an empty one) fails here, loudly, before
// any packaging time is spent.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CHANGELOG_FILE = 'CHANGELOG.md';
export const RELEASE_NOTES_FILE = path.join('build', 'release-notes.md');
export const RELEASE_BODY_FILE = path.join('build', 'release-body.md');
export const REPOSITORY_URL = 'https://github.com/HaYkMnE/NV-Gateway';

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Returns the body of the `## [version]` section: everything after its heading
 * up to (not including) the next `## [` heading, trimmed. Throws when the
 * section is missing or empty.
 */
export function extractReleaseNotes(changelog, version) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('release-notes: package.json has no version');
  }
  const lines = String(changelog).replace(/\r\n?/g, '\n').split('\n');
  const heading = new RegExp(`^##\\s+\\[${escapeRegExp(version.trim())}\\](?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) {
    throw new Error(`release-notes: ${CHANGELOG_FILE} has no "## [${version}] - YYYY-MM-DD" section`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+\[/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (body === '') {
    throw new Error(`release-notes: the ${CHANGELOG_FILE} section for ${version} is empty`);
  }
  return body;
}

/**
 * The GitHub release body: a user block (which asset to download, the one-line
 * install, how to verify) followed by the CHANGELOG section. Asset names match
 * what release.yml uploads; the installer name is also what latest.yml names.
 */
export function renderReleaseBody(version, notes) {
  const v = String(version).trim();
  return [
    `**Which file?** Most people: \`NV-Gateway-Setup-${v}.exe\` (installer). No install: \`NV-Gateway-${v}-win-x64.zip\` (portable). Ignore \`latest.yml\` and \`.blockmap\` (used by auto-update).`,
    '',
    `**Install in one command (no browser warning):** \`irm https://raw.githubusercontent.com/HaYkMnE/NV-Gateway/main/install.ps1 | iex\`. Details in [INSTALL.md](${REPOSITORY_URL}/blob/main/INSTALL.md).`,
    '',
    `**Verify:** compare with SHA256SUMS.txt (\`Get-FileHash .\\NV-Gateway-Setup-${v}.exe -Algorithm SHA256\`).`,
    '',
    '## What changed',
    '',
    String(notes).trim(),
    ''
  ].join('\n');
}

/** Reads <root>/CHANGELOG.md + <root>/package.json, writes <root>/build/release-notes.md and <root>/build/release-body.md. */
export function writeReleaseNotes(root) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelogPath = path.join(root, CHANGELOG_FILE);
  if (!fs.existsSync(changelogPath)) {
    throw new Error(`release-notes: ${CHANGELOG_FILE} not found at ${changelogPath}`);
  }
  const notes = extractReleaseNotes(fs.readFileSync(changelogPath, 'utf8'), version);
  const outPath = path.join(root, RELEASE_NOTES_FILE);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${notes}\n`, 'utf8');
  const bodyPath = path.join(root, RELEASE_BODY_FILE);
  fs.writeFileSync(bodyPath, renderReleaseBody(version, notes), 'utf8');
  return { version, outPath, bodyPath, length: notes.length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { version, outPath, bodyPath, length } = writeReleaseNotes(path.resolve(import.meta.dirname, '..'));
    console.log(`release-notes: wrote ${length} chars for ${version} to ${outPath} and the release body to ${bodyPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
