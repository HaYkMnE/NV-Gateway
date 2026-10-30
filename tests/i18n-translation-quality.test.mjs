// Translation-quality regressions (CodeRabbit pass 4). Same bare-vm transpile
// loader the i18n parity tests use; resources.ts is import-free.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadResources() {
  const source = fs.readFileSync(path.join(root, 'src/renderer/i18n/resources.ts'), 'utf8');
  const compiled = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: 'resources.ts' });
  return module.exports;
}

test('zh models_info_strength_rank says "strength rank" (EN: "Strength rank"), not "top rank"', () => {
  const { en, zh } = loadResources();
  assert.equal(en.models_info_strength_rank, 'Strength rank');
  assert.equal(zh.models_info_strength_rank, '强度排名');
});

test('ru settings_tips_help is a verb phrase like EN "Show ..." (not a bare noun phrase)', () => {
  const { en, ru } = loadResources();
  assert.match(en.settings_tips_help, /^Show /);
  assert.match(ru.settings_tips_help, /^Показывать короткие подсказки под питомцем/);
});

test('ar mode_night_help uses the dual for 2 attempts (no numeral + plural)', () => {
  const { ar } = loadResources();
  assert.ok(ar.mode_night_help.includes('ومحاولتان للتجاوز'), 'dual form expected');
  assert.ok(!ar.mode_night_help.includes('2 محاولات'), '"2 + plural" is ungrammatical in Arabic');
});
