import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const files = {
  layout: read('src/renderer/components/Layout.tsx'),
  dashboard: read('src/renderer/views/Dashboard.tsx'),
  wizard: read('src/renderer/views/Wizard.tsx'),
  endpoint: read('src/renderer/views/Endpoint.tsx'),
  models: read('src/renderer/views/Models.tsx'),
  logs: read('src/renderer/views/Logs.tsx'),
  settings: read('src/renderer/views/Settings.tsx'),
  about: read('src/renderer/components/AboutDialog.tsx'),
  feedback: read('src/renderer/components/FeedbackModal.tsx'),
  donation: read('src/renderer/pet/DonationModal.tsx'),
};

test('RTL layout uses logical inline-side utilities at interactive seams', () => {
  assert.match(files.layout, /border-s-2/);
  assert.match(files.layout, /border-e\b/);
  assert.match(files.layout, /\bme-1\b/);
  assert.match(files.layout, /\bms-auto\b/);
  assert.match(files.layout, /\bstart-0\b/);

  assert.match(files.dashboard, /\bpe-10\b/);
  assert.match(files.dashboard, /\bend-2\b/);
  assert.match(files.dashboard, /\bms-2\b/);
  assert.match(files.wizard, /\bme-3\b/);
  assert.match(files.endpoint, /\bpe-10\b/);
  assert.match(files.endpoint, /\bend-2\.5\b/);
  assert.match(files.endpoint, /\btext-start\b/);
  assert.match(files.models, /\bstart-3\b/);
  assert.match(files.models, /\bend-9\b/);
  assert.match(files.models, /\bms-auto\b/);
  assert.match(files.models, /\bme-0\.5\b/);
  assert.match(files.logs, /\bme-1\b/);
  assert.match(files.logs, /\bms-3\b/);
  assert.match(files.donation, /\bpe-1\b/);
});

test('technical values are explicitly isolated from Arabic bidi flow', () => {
  assert.match(files.layout, /<bdi dir="ltr">\{status\.port \?\? gatewayPort\}<\/bdi>/);
  assert.match(files.dashboard, /id="new-key"[^>]*dir="ltr"/);
  assert.match(files.dashboard, /<code dir="ltr"[^>]*>\{key\.key\}<\/code>/);
  assert.match(files.wizard, /id="custom-port"[^>]*dir="ltr"/);
  assert.match(files.endpoint, /<code dir="ltr"[^>]*>\s*\{baseUrl\}/);
  assert.match(files.endpoint, /dir="ltr"\s*\n\s*type=\{showToken \? 'text' : 'password'\}/);
  assert.match(files.endpoint, /<pre dir="ltr"/);
  assert.match(files.models, /<input[^>]*dir="auto"[\s\S]*?models_search_placeholder/);
  assert.match(files.models, /<kbd[^>]*dir="ltr"/);
  assert.match(files.models, /<pre dir="ltr"/);
  assert.match(files.models, /<code dir="ltr"/);
  assert.match(files.logs, /<ol[\s\S]*?dir="ltr"[\s\S]*?role="log"/);
  assert.match(files.about, /<dd dir="ltr"/);
  assert.match(files.feedback, /id="feedback-email"[^>]*dir="ltr"/);
  assert.match(files.donation, /<span dir="ltr"[^>]*title=\{row\.value\}/);
  assert.match(files.settings, /<dd dir="ltr" className="font-mono">\{query\.data\.status\.port/);
});

test('custom model switch mirrors its physical thumb translation in RTL', () => {
  assert.match(files.models, /translate-x-6 rtl:-translate-x-6/);
  assert.match(files.models, /translate-x-1 rtl:-translate-x-1/);
});
