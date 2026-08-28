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

function loadPetWidgetModule(mockStorage, customDate = Date) {
  const source = read('src/renderer/pet/PetWidget.tsx');
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
      jsx: typescript.JsxEmit.React
    }
  });

  const module = { exports: {} };
  const mockWindow = {
    localStorage: mockStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };

  const fakeRequire = (id) => {
    if (id === 'react') {
      return {
        useCallback: (fn) => fn,
        useEffect: () => {},
        useRef: (init) => ({ current: init }),
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}]
      };
    }
    if (id === 'react-i18next') {
      return { useTranslation: () => ({ t: (k) => k }) };
    }
    if (id === './audioEngine') {
      return { petAudio: {} };
    }
    if (id === './petEngine') {
      return { createPetEngine: () => ({}) };
    }
    return {};
  };

  const context = {
    Error,
    Number,
    Math,
    Date: customDate,
    console,
    require: fakeRequire,
    exports: module.exports,
    module,
    window: mockWindow,
  };

  vm.runInNewContext(compiled.outputText, context, { filename: 'src/renderer/pet/PetWidget.tsx' });
  return module.exports;
}

test('source contracts: DonationModal persists timestamp on ascension, PetWidget defines 7-day expiration window', () => {
  const donationSource = read('src/renderer/pet/DonationModal.tsx');
  const widgetSource = read('src/renderer/pet/PetWidget.tsx');

  // DonationModal must persist Date.now().toString() into nv_pet_vip
  assert.match(
    donationSource,
    /window\.localStorage\.setItem\(\s*['"]nv_pet_vip['"]\s*,\s*Date\.now\(\)\.toString\(\)\s*\)/,
    'DonationModal must store current timestamp on ascension'
  );
  assert.doesNotMatch(
    donationSource,
    /window\.localStorage\.setItem\(\s*['"]nv_pet_vip['"]\s*,\s*['"]1['"]\s*\)/,
    'DonationModal must not store legacy string literal 1'
  );

  // PetWidget must define the 7-day expiration window (7 * 24 * 60 * 60 * 1000)
  assert.match(
    widgetSource,
    /7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    'PetWidget must compute 7-day expiration window in ms'
  );
  assert.match(
    widgetSource,
    /window\.localStorage\.removeItem\(\s*VIP_STORAGE_KEY\s*\)/,
    'PetWidget must clean up expired or invalid VIP entries'
  );
});

test('readVipFlag: timestamp < 7 days is active VIP', () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const now = 1750000000000;

  class MockDate extends Date {
    static now() {
      return now;
    }
  }

  // Case 1: Just created (now)
  {
    const storage = createMockStorage({ nv_pet_vip: String(now) });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), true);
    assert.equal(storage.getItem('nv_pet_vip'), String(now));
  }

  // Case 2: 1 hour ago
  {
    const oneHourAgo = now - 3600 * 1000;
    const storage = createMockStorage({ nv_pet_vip: String(oneHourAgo) });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), true);
    assert.equal(storage.getItem('nv_pet_vip'), String(oneHourAgo));
  }

  // Case 3: 3 days ago
  {
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
    const storage = createMockStorage({ nv_pet_vip: String(threeDaysAgo) });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), true);
    assert.equal(storage.getItem('nv_pet_vip'), String(threeDaysAgo));
  }

  // Case 4: 6 days, 23 hours, 59 minutes, 59 seconds ago (< 7 days)
  {
    const justBeforeExpiry = now - (SEVEN_DAYS_MS - 1000);
    const storage = createMockStorage({ nv_pet_vip: String(justBeforeExpiry) });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), true);
    assert.equal(storage.getItem('nv_pet_vip'), String(justBeforeExpiry));
  }
});

test('readVipFlag: timestamp >= 7 days expires and cleans up localStorage', () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const now = 1750000000000;

  class MockDate extends Date {
    static now() {
      return now;
    }
  }

  // Case 1: Exactly 7 days old
  {
    const exactlySevenDays = now - SEVEN_DAYS_MS;
    const storage = createMockStorage({ nv_pet_vip: String(exactlySevenDays) });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), false);
    assert.equal(storage.getItem('nv_pet_vip'), null, 'Expired timestamp must be removed from localStorage');
  }

  // Case 2: 7 days and 1 second old
  {
    const pastSevenDays = now - (SEVEN_DAYS_MS + 1000);
    const storage = createMockStorage({ nv_pet_vip: String(pastSevenDays) });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), false);
    assert.equal(storage.getItem('nv_pet_vip'), null, 'Expired timestamp must be removed from localStorage');
  }

  // Case 3: 30 days old
  {
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const storage = createMockStorage({ nv_pet_vip: String(thirtyDaysAgo) });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), false);
    assert.equal(storage.getItem('nv_pet_vip'), null, 'Expired timestamp must be removed from localStorage');
  }
});

test("readVipFlag: legacy '1' is supported, migrated to Date.now().toString(), and returns true", () => {
  const now = 1750000000000;

  class MockDate extends Date {
    static now() {
      return now;
    }
  }

  const storage = createMockStorage({ nv_pet_vip: '1' });
  const { readVipFlag } = loadPetWidgetModule(storage, MockDate);

  // First call should recognize legacy '1', migrate to current timestamp, and return true
  assert.equal(readVipFlag(), true);
  assert.equal(storage.getItem('nv_pet_vip'), String(now), 'Legacy "1" must be migrated to Date.now().toString()');

  // Second call with migrated timestamp should still return true
  assert.equal(readVipFlag(), true);
  assert.equal(storage.getItem('nv_pet_vip'), String(now));
});

test('readVipFlag: invalid and absent values return false and clean up localStorage', () => {
  const now = 1750000000000;

  class MockDate extends Date {
    static now() {
      return now;
    }
  }

  // Case 1: Absent (null)
  {
    const storage = createMockStorage({});
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), false);
    assert.equal(storage.getItem('nv_pet_vip'), null);
  }

  // Case 2: Empty string
  {
    const storage = createMockStorage({ nv_pet_vip: '' });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), false);
    assert.equal(storage.getItem('nv_pet_vip'), null, 'Empty string must be removed');
  }

  // Case 3: Arbitrary invalid strings
  for (const invalid of ['abc', 'NaN', 'undefined', 'null', 'true', 'false', '{}', '[]', 'vip']) {
    const storage = createMockStorage({ nv_pet_vip: invalid });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), false, `Expected false for invalid value: "${invalid}"`);
    assert.equal(storage.getItem('nv_pet_vip'), null, `Invalid value "${invalid}" must be removed`);
  }

  // Case 4: Negative numbers and 0
  for (const num of ['0', '-1', '-1000', '-1750000000000']) {
    const storage = createMockStorage({ nv_pet_vip: num });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), false, `Expected false for value: "${num}"`);
    assert.equal(storage.getItem('nv_pet_vip'), null, `Value "${num}" must be removed`);
  }

  // Case 5: Non-finite numbers
  for (const nonFinite of ['Infinity', '-Infinity']) {
    const storage = createMockStorage({ nv_pet_vip: nonFinite });
    const { readVipFlag } = loadPetWidgetModule(storage, MockDate);
    assert.equal(readVipFlag(), false, `Expected false for non-finite value: "${nonFinite}"`);
    assert.equal(storage.getItem('nv_pet_vip'), null, `Non-finite value "${nonFinite}" must be removed`);
  }
});

test('readVipFlag: gracefully handles storage exceptions without throwing', () => {
  const throwingStorage = {
    getItem() {
      throw new Error('Access denied (SecurityError)');
    },
    setItem() {
      throw new Error('Quota exceeded');
    },
    removeItem() {
      throw new Error('Storage error');
    }
  };

  const { readVipFlag } = loadPetWidgetModule(throwingStorage);
  assert.doesNotThrow(() => {
    const result = readVipFlag();
    assert.equal(result, false);
  });
});
