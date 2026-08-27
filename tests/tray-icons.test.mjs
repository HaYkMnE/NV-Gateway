import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

test('trayIconForState maps each gateway lifecycle state to its tray asset per ICONS.md', async () => {
  const { trayIconForState } = await import(built('tray-icons.js'));
  assert.equal(trayIconForState('running'), 'tray-running');
  assert.equal(trayIconForState('starting'), 'tray-starting');
  assert.equal(trayIconForState('stopped'), 'tray-stopped');
  assert.equal(trayIconForState('error'), 'tray-error');
  assert.equal(trayIconForState('bogus'), 'tray-stopped');
});
