import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('node compilation includes fixture support while the builder explicitly excludes it from app.asar', () => {
  const nodeConfig = JSON.parse(read('tsconfig.node.json'));
  assert.equal(nodeConfig.include.includes('src/test-support/**/*'), true);

  const builder = read('electron-builder.yml');
  assert.match(builder, /^  - build\/src\/test-support\/\*\*\/\*$/m);
  assert.match(builder, /^  - "!build\/src\/test-support\/\*\*\/\*"$/m);
  assert.match(read('package.json'), /clean-node-build\.mjs/);
  assert.match(read('package.json'), /"pretest": "npm run build"/);
});

test('production migration modules have no test-only configurable legacy-source API', () => {
  const productionWorkflow = read('src/main/final-migration-workflow.ts');
  const productionLegacy = read('src/main/legacy-nvidia-migration.ts');
  for (const source of [productionWorkflow, productionLegacy]) {
    assert.doesNotMatch(source, /runLegacyNvidiaMigrationForTests|prepareLegacyNvidiaMigrationForTests|migrateLegacyNvidiaForTests|readStrictLegacySourceForTests/);
  }
  assert.match(productionWorkflow, /prepareLegacyNvidiaMigration\(/);
  assert.match(productionLegacy, /LEGACY_NVIDIA_SOURCE/);
});

test('packaged migration smoke checks the real test-support exclusion and scans ASAR contents', () => {
  const smoke = read('scripts/packaged-migration-smoke.mjs');
  assert.match(smoke, /!build\/src\/test-support\/\*\*\/\*/);
  assert.match(smoke, /extractFile/);
  assert.match(smoke, /runLegacyNvidiaMigrationForTests/);
  assert.match(smoke, /prepareLegacyNvidiaMigrationForTests/);
});

test('package build wiring runs static credential audit after creating package output', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['package:dir'], /package:audit/);
  assert.match(packageJson.scripts['build:portable'], /package:audit/);
  assert.match(packageJson.scripts['package:audit'], /test:packaged-credentials/);
  assert.equal(packageJson.scripts['test:packaged-credentials'], 'node scripts/packaged-credential-smoke.mjs');
  const smoke = read('scripts/packaged-credential-smoke.mjs');
  assert.match(smoke, /listPackage/);
  assert.match(smoke, /extractFile/);
  assert.doesNotMatch(smoke, /child_process|spawn\(|exec\(/);
});
