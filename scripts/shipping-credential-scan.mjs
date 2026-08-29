import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DENIED_CREDENTIAL_LITERALS = [
  'test-gateway-token',
  'test-admin-token',
  'fake-nvidia-key-not-real',
  'fake-gateway-token-not-real',
  'fake-admin-token-not-real'
];

const EXPECTED_FILES_RULES = [
  'build/src/main/**/*',
  'build/src/test-support/**/*',
  '!build/src/test-support/**/*',
  'build/src/preload/**/*',
  'build/renderer/**/*',
  // The engine bundle moved INTO app.asar so ASAR integrity validation covers
  // it; it used to be an extraResource, i.e. outside the integrity envelope.
  'build/gateway/**/*',
  'package.json'
];
// Only inert image assets ship OUTSIDE app.asar now. The engine bundle moved into
// the archive (see EXPECTED_FILES_RULES) so ASAR integrity validation covers it,
// and src/shared is not shipped at all — redaction.mjs is inlined into the bundle.
// Nothing executable is left in resources/.
const EXPECTED_EXTRA_RESOURCE_RULES = [
  'build/assets -> assets'
];

export function runShippingCredentialScan({
  root = path.resolve(import.meta.dirname, '..'),
  readFile = fs.readFileSync,
  afterSnapshot = () => {}
} = {}) {
  const scannedRoots = deriveScannedRoots(root);
  const files = collectRegularFiles(root, scannedRoots);
  const snapshots = files.map((file) => {
    const content = Buffer.from(readFile(file));
    return { file, content, sha256: sha256(content) };
  });
  afterSnapshot();

  let matchCount = 0;
  for (const { content } of snapshots) {
    for (const literal of DENIED_CREDENTIAL_LITERALS) {
      if (content.includes(Buffer.from(literal, 'utf8'))) matchCount += 1;
    }
  }
  assert.equal(matchCount, 0, 'SHIPPING_CREDENTIAL_LITERAL_FOUND');

  for (const snapshot of snapshots) {
    if (sha256(Buffer.from(readFile(snapshot.file))) !== snapshot.sha256) {
      throw new Error('SHIPPING_CREDENTIAL_SCAN_CHANGED');
    }
  }
  return {
    scannedRoots,
    scannedFileCount: snapshots.length,
    testSupportExcluded: true
  };
}

export function deriveScannedRoots(root) {
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.deepEqual(extractListSection(builder, 'files'), EXPECTED_FILES_RULES, 'PACKAGING_FILES_RULES_CHANGED');
  assert.deepEqual(extractExtraResources(builder), EXPECTED_EXTRA_RESOURCE_RULES, 'PACKAGING_EXTRA_RESOURCES_RULES_CHANGED');
  const roots = [
    'build/src/main', 'build/src/preload', 'build/renderer', 'package.json',
    'build/gateway', 'build/assets'
  ];
  for (const relative of roots) assert.equal(fs.existsSync(path.join(root, relative)), true, `PACKAGING_PAYLOAD_MISSING:${relative}`);
  return roots;
}

function extractListSection(builder, section) {
  const match = builder.match(new RegExp(`^${section}:\\r?\\n([\\s\\S]*?)(?=^[A-Za-z][^:\\r\\n]*:|(?![\\s\\S]))`, 'm'));
  assert.notEqual(match, null, `PACKAGING_SECTION_MISSING:${section}`);
  return match[1].split(/\r?\n/)
    .map((line) => line.match(/^  -\s+"?(.+?)"?\s*$/)?.[1])
    .filter((value) => value !== undefined);
}

function extractExtraResources(builder) {
  const match = builder.match(/^extraResources:\r?\n([\s\S]*?)(?=^[A-Za-z][^:\r\n]*:|(?![\s\S]))/m);
  assert.notEqual(match, null, 'PACKAGING_SECTION_MISSING:extraResources');
  const resources = [];
  let from = null;
  for (const line of match[1].split(/\r?\n/)) {
    const fromMatch = line.match(/^  - from:\s+(.+)$/);
    if (fromMatch) { from = fromMatch[1]; continue; }
    const toMatch = line.match(/^    to:\s+(.+)$/);
    if (toMatch && from !== null) { resources.push(`${from} -> ${toMatch[1]}`); from = null; }
  }
  return resources;
}

function collectRegularFiles(root, roots) {
  const files = [];
  for (const relative of roots) visit(path.join(root, relative));
  return files.sort((left, right) => left.localeCompare(right));

  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isFile()) { files.push(file); return; }
    assert.equal(stat.isDirectory(), true, `PACKAGING_PAYLOAD_NOT_REGULAR:${path.relative(root, file)}`);
    for (const entry of fs.readdirSync(file, { withFileTypes: true })) visit(path.join(file, entry.name));
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = runShippingCredentialScan();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'SHIPPING_CREDENTIAL_SCAN_FAILED');
    process.exitCode = 1;
  }
}
