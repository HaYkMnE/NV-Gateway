import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFile, listPackage, statFile } from '@electron/asar';
import { DENIED_CREDENTIAL_LITERALS } from './shipping-credential-scan.mjs';

export { DENIED_CREDENTIAL_LITERALS };

export function runPackagedCredentialSmoke({
  root = path.resolve(import.meta.dirname, '..'),
  packageOutputDirectory = process.env.NVGW_PACKAGE_OUTPUT_DIRECTORY || path.join(root, 'dist')
} = {}) {
  const unpacked = path.join(packageOutputDirectory, 'win-unpacked');
  if (!fs.existsSync(unpacked)) throw new Error('PACKAGED_CREDENTIAL_AUDIT_OUTPUT_MISSING');
  const archive = path.join(unpacked, 'resources', 'app.asar');
  if (!fs.existsSync(archive)) throw new Error('PACKAGED_CREDENTIAL_AUDIT_ASAR_MISSING');

  const counts = { appAsarArchive: 1, appAsarEntries: 0, resources: 0, other: 0 };
  let matches = 0;
  matches += countDeniedMatches(fs.readFileSync(archive));
  for (const entry of listPackage(archive, {})) {
    const normalized = entry.replace(/^[\\/]+/, '');
    if (!normalized || !isAsarRegularFile(archive, normalized)) continue;
    matches += countDeniedMatches(extractFile(archive, normalized));
    counts.appAsarEntries += 1;
  }
  for (const file of collectRegularFiles(unpacked)) {
    if (path.resolve(file) === path.resolve(archive)) continue;
    matches += countDeniedMatches(fs.readFileSync(file));
    if (file.startsWith(path.join(unpacked, 'resources') + path.sep)) counts.resources += 1;
    else counts.other += 1;
  }
  if (matches !== 0) throw new Error(`PACKAGED_CREDENTIAL_AUDIT_FAILED count=${matches} categories=app-asar,resources,other`);
  return { scannedFileCount: counts.appAsarArchive + counts.appAsarEntries + counts.resources + counts.other, categories: counts, matches: 0 };
}

function isAsarRegularFile(archive, entry) {
  const metadata = statFile(archive, entry);
  return !('files' in metadata) && !('link' in metadata);
}

function collectRegularFiles(directory) {
  const files = [];
  visit(directory);
  return files;
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isFile()) { files.push(file); return; }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(file, { withFileTypes: true })) visit(path.join(file, entry.name));
  }
}

function countDeniedMatches(content) {
  const bytes = Buffer.from(content);
  return DENIED_CREDENTIAL_LITERALS.reduce((count, literal) => count + Number(bytes.includes(Buffer.from(literal, 'utf8'))), 0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(runPackagedCredentialSmoke()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'PACKAGED_CREDENTIAL_AUDIT_FAILED');
    process.exitCode = 1;
  }
}
