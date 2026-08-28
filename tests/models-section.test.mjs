import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// ── Models store: shape and actions ──────────────────────────────────────────
test('models store defines the expected state shape and actions', () => {
  const source = read('src/renderer/stores/models.ts');

  // Zustand create pattern matching config.ts
  assert.match(source, /import \{ create \} from 'zustand'/);
  assert.match(source, /export const useModelsStore = create<ModelsState>\(\)/);

  // State fields
  assert.match(source, /models: ModelEntry\[\]/);
  assert.match(source, /loading: boolean/);
  assert.match(source, /error: string \| null/);
  assert.match(source, /lastRefreshed: number \| null/);

  // Actions
  assert.match(source, /setModels: \(models: ModelEntry\[\]\) => void/);
  assert.match(source, /setLoading: \(loading: boolean\) => void/);
  assert.match(source, /setError: \(error: string \| null\) => void/);
  assert.match(source, /setLastRefreshed: \(timestamp: number \| null\) => void/);

  // ModelEntry interface
  assert.match(source, /export interface ModelEntry/);
  assert.match(source, /id: string/);
  assert.match(source, /name: string/);
  assert.match(source, /enabled: boolean/);
  assert.match(source, /mode: 'day' \| 'night' \| 'auto'/);
  assert.match(source, /deprecated: boolean/);
});

// ── Preload: new IPC methods ─────────────────────────────────────────────────
test('preload exposes getModels, refreshModels, updateModelSettings, toggleModel, bulkToggleModels routing through invokeAdmin (bridge-safe error.name reconstruction)', () => {
  const source = read('src/preload/index.ts');

  // The models channels route through invokeAdmin (NOT raw ipcRenderer.invoke)
  // so the {ok:false,error:{code,message}} envelope returned by models-ipc.ts is
  // reconstructed in the renderer as a thrown Error whose .name === code — the
  // same convention used by the admin channels below (admin-list-keys et al.).
  // This guarantees error.name fidelity (GATEWAY_NOT_RUNNING) across the
  // contextBridge regardless of Electron's thrown-error serialization quirks.
  assert.match(source, /getModels: \(\) => invokeAdmin\('get-models'\)/);
  assert.match(source, /refreshModels: \(\) => invokeAdmin\('refresh-models'\)/);
  assert.match(source, /updateModelSettings: \(id: string, settings: \{ enabled\?: boolean; mode\?: 'day' \| 'night' \| 'auto' \}\) => invokeAdmin\('update-model-settings', id, settings\)/);
  assert.match(source, /toggleModel: \(id: string, enabled: boolean\) => invokeAdmin\('toggle-model', id, enabled\)/);
  assert.match(source, /bulkToggleModels: \(enabled: boolean\) => invokeAdmin\('bulk-toggle-models', enabled\)/);
});

// ── global.d.ts: new electronAPI type declarations ───────────────────────────
test('global.d.ts declares the new electronAPI methods and ModelConfig interface', () => {
  const source = read('src/renderer/global.d.ts');

  assert.match(source, /getModels: \(\) => Promise<\{ models: ModelConfig\[\] \}>/);
  assert.match(source, /refreshModels: \(\) => Promise<\{ models: ModelConfig\[\] \}>/);
  assert.match(source, /updateModelSettings: \(id: string, settings: \{ enabled\?: boolean; mode\?: 'day' \| 'night' \| 'auto' \}\) => Promise<ModelConfig>/);
  assert.match(source, /toggleModel: \(id: string, enabled: boolean\) => Promise<ModelConfig>/);
  assert.match(source, /bulkToggleModels: \(enabled: boolean\) => Promise<ModelConfig\[\]>/);

  // ModelConfig interface
  assert.match(source, /interface ModelConfig/);
  assert.match(source, /id: string/);
  assert.match(source, /name: string/);
  assert.match(source, /enabled: boolean/);
  assert.match(source, /mode: 'day' \| 'night' \| 'auto'/);
  assert.match(source, /deprecated: boolean/);
});

// ── api.ts: new query key and API functions ──────────────────────────────────
test('api.ts exposes models query key and getModels/refreshModels functions', () => {
  const source = read('src/renderer/lib/api.ts');

  assert.match(source, /models: \['models'\] as const/);
  assert.match(source, /models: \(\) => window\.electronAPI\.getModels\(\)/);
  assert.match(source, /refreshModels: \(\) => window\.electronAPI\.refreshModels\(\)/);
});

// ── i18n: new translation keys in both EN and RU ────────────────────────────
test('i18n resources include all new model-related keys in EN and RU', () => {
  const source = read('src/renderer/i18n/resources.ts');

  const requiredKeys = [
    'models_title',
    'models_refresh',
    'models_reset',
    'models_available',
    'models_deprecated',
    'models_enabled',
    'mode_day',
    'mode_night',
    'mode_auto',
  ];

  for (const key of requiredKeys) {
    // EN: key appears as key:'value'
    const enPattern = new RegExp(`${key}:'[^']*'`);
    assert.match(source, enPattern, `EN must define ${key}`);

    // RU: key appears in the ru object
    const ruPattern = new RegExp(`${key}:'[^']*'`);
    assert.match(source, ruPattern, `RU must define ${key}`);
  }

  // RU contract: Record<keyof typeof en, string>
  assert.match(source, /Record<keyof typeof en, string>/);
});

// ── Settings.tsx: ModelsSection integration ──────────────────────────────────
test('Settings.tsx renders the ModelsSection component', () => {
  const source = read('src/renderer/views/Settings.tsx');

  // Import
  assert.match(source, /import \{ useModelsStore \} from '\.\.\/stores\/models'/);

  // Component definition
  assert.match(source, /function ModelsSection\(\)/);

  // Uses the store
  assert.match(source, /const \{ [^}]*models[^}]* \} = useModelsStore\(\)/);

  // Renders translated title
  assert.match(source, /t\('models_title'\)/);

  // Refresh and Reset buttons
  assert.match(source, /t\('models_refresh'\)/);
  assert.match(source, /t\('models_reset'\)/);

  // Mode selector options
  assert.match(source, /t\('mode_day'\)/);
  assert.match(source, /t\('mode_night'\)/);
  assert.match(source, /t\('mode_auto'\)/);

  // Enabled toggle label
  assert.match(source, /t\('models_enabled'\)/);

  // Deprecated badge
  assert.match(source, /t\('models_deprecated'\)/);

  // Loading and error states
  assert.match(source, /role="status"/);
  assert.match(source, /role="alert"/);

  // Component is rendered inside Settings
  assert.match(source, /<ModelsSection \/>/);
});
