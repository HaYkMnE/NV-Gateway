// CR7 frontend findings (CodeRabbit full-program review, renderer side).
// 003 OpenCode snippet shape, 007 dead pet-audio depth gains, 008 caught
// openExternal rejections, 009 fake "Reset to Defaults" removed, 010 Settings
// models section fed by the shared models query.
// No jsdom in this repo: 003 is behavioral (pure module transpiled + run in a
// vm context); the rest pin the source wiring.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function loadOpenCodeConfig() {
  const source = read('src/renderer/views/opencodeConfig.ts');
  const js = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports });
  return module.exports.buildOpenCodeConfig;
}

// The README's OpenCode block is the documented contract the app must match.
function readmeOpenCodeBlock() {
  const readme = read('README.md');
  const at = readme.indexOf('"provider": {');
  assert.ok(at > 0, 'README OpenCode provider block');
  const start = readme.lastIndexOf('{', readme.lastIndexOf('"$schema"', at));
  const end = readme.indexOf('```', at);
  return JSON.parse(readme.slice(start, end));
}

test('CR7-003: the copied OpenCode config is a valid provider.<id> block with options and models keyed by id', () => {
  const build = loadOpenCodeConfig();
  const models = [{ id: 'z-ai/glm-5.2', name: 'GLM-5.2' }, { id: 'meta/llama-3.3-70b-instruct' }];
  const parsed = JSON.parse(build('http://127.0.0.1:12000/v1', 'tok-123', models));
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  assert.deepEqual(Object.keys(parsed.provider), ['nvidia-gateway']);
  const p = parsed.provider['nvidia-gateway'];
  assert.equal(p.npm, '@ai-sdk/openai-compatible');
  assert.equal(p.name, 'NV-Gateway');
  assert.equal(p.options.baseURL, 'http://127.0.0.1:12000/v1');
  assert.equal(p.options.apiKey, 'tok-123');
  assert.equal(p.baseURL, undefined, 'baseURL lives under options');
  assert.equal(p.apiKey, undefined, 'apiKey lives under options');
  assert.ok(p.models && !Array.isArray(p.models), 'models is an object');
  assert.deepEqual(p.models, { 'z-ai/glm-5.2': { name: 'GLM-5.2' }, 'meta/llama-3.3-70b-instruct': { name: 'meta/llama-3.3-70b-instruct' } });
  assert.equal(parsed['NV-Gateway'], undefined, 'no bare top-level provider key');
});

test('CR7-003: the snippet shape agrees with the README OpenCode block', () => {
  const doc = readmeOpenCodeBlock();
  const docId = Object.keys(doc.provider)[0];
  const docP = doc.provider[docId];
  const app = JSON.parse(loadOpenCodeConfig()(docP.options.baseURL, docP.options.apiKey,
    Object.entries(docP.models).map(([id, m]) => ({ id, name: m.name }))));
  assert.deepEqual(app, doc);
});

test('CR7-003: Endpoint renders and copies the OpenCode tab from buildOpenCodeConfig', () => {
  const src = read('src/renderer/views/Endpoint.tsx');
  // The builder must come from ./opencodeConfig and be the thing that produces
  // the tab content. The import also carries hasUnresolvedPlaceholder (W4 copy
  // guard), so match the module + the builder name rather than an exact list.
  const imported = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/opencodeConfig';/);
  assert.ok(imported, 'Endpoint must import from ./opencodeConfig');
  assert.match(imported[1], /\bbuildOpenCodeConfig\b/, 'buildOpenCodeConfig is imported from that module');
  assert.match(src, /content: buildOpenCodeConfig\(baseUrl, gatewayToken, models\),/);
  assert.doesNotMatch(src, /'NV-Gateway': \{/);
});

test('CR7-007: dead pet-audio depth gains are gone; the direct frequency connections stay', () => {
  const src = read('src/renderer/pet/audioEngine.ts');
  assert.doesNotMatch(src, /\blfoG\b/);
  assert.doesNotMatch(src, /\bvibG\b/);
  assert.equal(src.split("// depth = oscillator's native ±1 Hz (intentionally subtle)").length - 1, 3);
  assert.equal(src.split('lfo.connect(drone.frequency);').length - 1, 1);
  assert.equal(src.split('vib.connect(osc.frequency);').length - 1, 2);
});

test('CR7-008: every renderer openExternal call handles its rejection', () => {
  const dir = path.join(root, 'src/renderer');
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.tsx?$/.test(f));
  let calls = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of src.split('\n')) {
      if (!/\.openExternal\(/.test(line)) continue;
      calls += 1;
      assert.match(line, /\.openExternal\([^;]*\)\.catch\(\(\) => undefined\)/, `${f}: ${line.trim()}`);
    }
  }
  assert.ok(calls >= 4, `found ${calls} openExternal calls`);
});

test('CR7-009: Settings has no fake Reset to Defaults and no models_reset key remains', () => {
  const src = read('src/renderer/views/Settings.tsx');
  assert.doesNotMatch(src, /resetMutation/);
  assert.doesNotMatch(src, /models_reset/);
  assert.match(src, /const isPending = refreshMutation\.isPending;/);
  assert.doesNotMatch(read('src/renderer/i18n/resources.ts'), /models_reset/);
});

test('CR7-010: Settings models section is fed by the shared models query on first visit', () => {
  const src = read('src/renderer/views/Settings.tsx');
  const section = src.slice(src.indexOf('function ModelsSection()'), src.indexOf('const refreshMutation'));
  assert.match(section, /const modelsQuery = useQuery\(\{ queryKey: queryKeys\.models, queryFn: api\.models \}\);/);
  assert.match(section, /useEffect\(\(\) => \{\s*const list = modelsQuery\.data\?\.models;\s*if \(Array\.isArray\(list\)\) setModels\(list as ModelEntry\[\]\);\s*\}, \[modelsQuery\.data, setModels\]\);/);
  // Same key + fetcher as Models.tsx, so TanStack dedupes/caches one fetch.
  assert.match(read('src/renderer/views/Models.tsx'), /useQuery\(\{ queryKey: queryKeys\.models, queryFn: api\.models,/);
});
