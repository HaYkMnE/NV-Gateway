import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function createMockStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    get length() {
      return map.size;
    },
    _raw: map
  };
}

function loadPetEngine(globals = {}) {
  const source = read('src/renderer/pet/petEngine.ts');
  const compiled = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  });
  const module = { exports: {} };
  const context = {
    Error,
    Math,
    Date,
    console,
    exports: module.exports,
    module,
    ...globals
  };
  vm.runInNewContext(compiled.outputText, context, { filename: 'src/renderer/pet/petEngine.ts' });
  return module.exports;
}

const noopOpts = () => ({
  isVip: () => false,
  onActivityChange: () => {},
  onCue: () => {}
});

test('petEngine source contract: reads from and writes to sessionStorage, cleans legacy localStorage, and docs refer to sessionStorage', () => {
  const source = read('src/renderer/pet/petEngine.ts');

  // Must read from sessionStorage
  assert.match(source, /sessionStorage\.getItem\(CHARACTER_STORAGE_KEY\)/);
  assert.doesNotMatch(source, /localStorage\.getItem\(CHARACTER_STORAGE_KEY\)/);

  // Must write to sessionStorage and clean legacy localStorage
  assert.match(source, /sessionStorage\.setItem\(CHARACTER_STORAGE_KEY/);
  assert.match(source, /localStorage\.removeItem\(CHARACTER_STORAGE_KEY\)/);

  // Doc comments must refer to sessionStorage, not localStorage nv_pet_character
  assert.match(source, /sessionStorage `nv_pet_character`/);
  assert.doesNotMatch(source, /localStorage `nv_pet_character`/);
});

test('cold starts without sessionStorage roll both characters over multiple runs', () => {
  const rolled = new Set();

  for (let i = 0; i < 50; i++) {
    const mockSession = createMockStorage();
    const mockLocal = createMockStorage();
    const { createPetEngine } = loadPetEngine({
      sessionStorage: mockSession,
      localStorage: mockLocal
    });

    const engine = createPetEngine(noopOpts());
    const character = engine.pickSessionCharacter();
    assert.ok(character === 'mascot' || character === 'hacker');
    rolled.add(character);

    // After cold start roll, it must be persisted in sessionStorage
    assert.equal(mockSession.getItem('nv_pet_character'), character);
  }

  // Over 50 runs with 50/50 roll, both mascot and hacker must have been rolled
  assert.ok(rolled.has('mascot'), 'Cold starts should roll mascot across runs');
  assert.ok(rolled.has('hacker'), 'Cold starts should roll hacker across runs');
});

test('sessionStorage keeps character fixed within a single session', () => {
  const mockSession = createMockStorage();
  const mockLocal = createMockStorage();
  const { createPetEngine } = loadPetEngine({
    sessionStorage: mockSession,
    localStorage: mockLocal
  });

  // First engine instantiation in this session
  const engine1 = createPetEngine(noopOpts());
  const initialCharacter = engine1.pickSessionCharacter();
  assert.ok(initialCharacter === 'mascot' || initialCharacter === 'hacker');
  assert.equal(mockSession.getItem('nv_pet_character'), initialCharacter);

  // Repeated calls on engine1 return the same character
  for (let i = 0; i < 10; i++) {
    assert.equal(engine1.pickSessionCharacter(), initialCharacter);
  }

  // Second engine instantiation reusing the same sessionStorage
  const engine2 = createPetEngine(noopOpts());
  assert.equal(engine2.pickSessionCharacter(), initialCharacter);
  assert.equal(mockSession.getItem('nv_pet_character'), initialCharacter);
});

test('pre-seeded sessionStorage character is respected without re-rolling', () => {
  for (const char of ['mascot', 'hacker']) {
    const mockSession = createMockStorage({ nv_pet_character: char });
    const mockLocal = createMockStorage();
    const { createPetEngine } = loadPetEngine({
      sessionStorage: mockSession,
      localStorage: mockLocal
    });

    const engine = createPetEngine(noopOpts());
    assert.equal(engine.pickSessionCharacter(), char);
  }
});

test('cold start cleans legacy localStorage key when persisting character', () => {
  const mockSession = createMockStorage();
  const mockLocal = createMockStorage({ nv_pet_character: 'mascot' });

  assert.equal(mockLocal.getItem('nv_pet_character'), 'mascot');

  const { createPetEngine } = loadPetEngine({
    sessionStorage: mockSession,
    localStorage: mockLocal
  });

  const engine = createPetEngine(noopOpts());
  const chosen = engine.pickSessionCharacter();

  // sessionStorage now holds the chosen character
  assert.equal(mockSession.getItem('nv_pet_character'), chosen);
  // localStorage legacy key has been removed
  assert.equal(mockLocal.getItem('nv_pet_character'), null);
});

test('resetSessionCharacter updates sessionStorage and removes legacy localStorage key', () => {
  const mockSession = createMockStorage({ nv_pet_character: 'mascot' });
  const mockLocal = createMockStorage({ nv_pet_character: 'mascot' });

  const { createPetEngine } = loadPetEngine({
    sessionStorage: mockSession,
    localStorage: mockLocal
  });

  const engine = createPetEngine(noopOpts());
  engine.resetSessionCharacter();

  const next = engine.pickSessionCharacter();
  assert.ok(next === 'mascot' || next === 'hacker');
  assert.equal(mockSession.getItem('nv_pet_character'), next);
  assert.equal(mockLocal.getItem('nv_pet_character'), null);
});
