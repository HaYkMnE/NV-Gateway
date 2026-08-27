import os from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

test('main and shared redactors sanitize embedded http URLs without changing ordinary text', async () => {
  const main = await import(built('redaction.js'));
  const shared = await import(pathToFileURL(path.join(root, 'src', 'shared', 'redaction.mjs')).href);
  const ordinary = 'ordinary diagnostic text has no URL';
  assert.equal(main.redact(ordinary), ordinary);
  assert.equal(shared.redact(ordinary), ordinary);
});
