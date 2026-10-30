import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

// ───────────────────────────────────────────────────────────────────────────
// The updater must not notify its status observer once per network chunk.
//
// auto-update.ts throttles its OWN log to one record per integer percent, and
// says so:
//   // Transient progress: one log record per integer-percent change keeps
//   // ~100 records per download instead of a record per electron-updater tick.
// but setState() called onStatusChanged() on EVERY tick, so the throttle was
// defeated one layer down.
//
// MEASURED against the built module with a fake updater, 5,000 download-progress
// ticks carrying fractional percents (electron-updater emits per network chunk,
// not per percent):
//
//   downloadProgressTicks            5000
//   inModuleThrottledLogRecords       101   <- the throttle working as documented
//   onStatusChangedCalls             5000   <- unthrottled: 49.5x amplification
//
// Production wires `onStatusChanged: () => updateTray()` (src/main/index.ts), and
// ONE updateTray() performs a synchronous readAppConfig() (readFileSync +
// JSON.parse), a Menu.buildFromTemplate plus setImage/setToolTip/setContextMenu,
// and one unthrottled `tray_status_update` log line. Measured cost of the
// amplified portion of a single download:
//
//   5,000 synchronous config reads = 5,339.6 ms on the MAIN THREAD (~1.07 ms each)
//   5,000 x 120 B tray_status_update records = 600,000 bytes of log
//
// app-logger.ts rotates at 5 MB keeping 3 files, so this is log EVICTION of real
// diagnostics rather than unbounded growth — which is why it is a correctness and
// responsiveness defect rather than a disk-exhaustion one.
//
// percent is already rounded by readPercent(), so two ticks inside the same
// integer percent are indistinguishable to every consumer: getStatus() returns
// the freshly assigned status either way, and the tray label (getUpdateMenuText)
// renders only state/version/percent.
// ───────────────────────────────────────────────────────────────────────────

function fakeUpdater() {
  const listeners = new Map();
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: null,
    on(event, fn) { listeners.set(event, fn); return this; },
    once(event, fn) { listeners.set(event, fn); return this; },
    checkForUpdates: async () => null,
    downloadUpdate: async () => null,
    quitAndInstall() {},
    setFeedURL() {},
    emit: (event, payload) => listeners.get(event)?.(payload)
  };
}

async function harness() {
  const { createAutoUpdateService } = await import(built('auto-update.js'));
  const updater = fakeUpdater();
  const states = [];
  const logs = [];
  const service = createAutoUpdateService({
    updater,
    dialog: { showMessageBox: async () => ({ response: 1 }) }, // always "Later"
    getLanguage: () => 'en',
    log: (level, event, data) => logs.push({ level, event, data }),
    setQuitting() {},
    stopGateway: async () => {},
    onStatusChanged: (status) => states.push(status),
    enabled: true
  });
  return { service, updater, states, logs };
}

test('repeated progress ticks inside one integer percent notify the observer ONCE', async () => {
  const { updater, states } = await harness();
  states.length = 0;

  // 500 ticks that all round to the same integer percent. Before the fix this
  // produced 500 notifications, each one a full updateTray() in production.
  for (let i = 0; i < 500; i += 1) updater.emit('download-progress', { percent: 42.4 });

  assert.equal(states.length, 1,
    `500 ticks at the same rounded percent must notify once, got ${states.length}`);
  assert.deepEqual(states[0], { state: 'downloading', version: null, percent: 42 });
});

test('a full download notifies about once per integer percent, not per tick', async () => {
  const { updater, states, logs } = await harness();
  states.length = 0;

  const TICKS = 5000;
  for (let i = 0; i < TICKS; i += 1) updater.emit('download-progress', { percent: (i / TICKS) * 100 });

  const progressLogs = logs.filter((entry) => entry.event === 'update_download_progress');
  // The observer must now track the throttled log, not the raw tick count.
  assert.equal(states.length, progressLogs.length,
    'onStatusChanged must fire exactly as often as the documented per-percent log');
  assert.ok(states.length <= 101,
    `a download must notify at most once per integer percent (<=101), got ${states.length}`);
  assert.ok(states.length < TICKS / 10,
    `notifications must not scale with tick count: got ${states.length} for ${TICKS} ticks`);
});

test('every genuine status change still reaches the observer', async () => {
  const { service, updater, states } = await harness();
  states.length = 0;

  await service.checkForUpdates({ manual: true });
  updater.emit('update-available', { version: '1.1.0' });
  updater.emit('download-progress', { percent: 10.2 });
  updater.emit('download-progress', { percent: 55.7 });
  updater.emit('update-downloaded', { version: '1.1.0' });

  assert.deepEqual(states.map((s) => [s.state, s.version, s.percent]), [
    ['checking', null, null],
    ['available', '1.1.0', null],
    ['downloading', '1.1.0', 10],
    ['downloading', '1.1.0', 56],
    ['ready', '1.1.0', null]
  ], 'suppression must apply ONLY to identical consecutive statuses');
});

test('getStatus stays exact even for a suppressed notification', async () => {
  const { service, updater } = await harness();

  updater.emit('download-progress', { percent: 42.4 });
  assert.deepEqual(service.getStatus(), { state: 'downloading', version: null, percent: 42 });
  // Suppressed notification, but the reported status must still be correct and
  // fresh — get-update-status is polled by the renderer every 2s.
  updater.emit('download-progress', { percent: 42.6 });
  assert.equal(service.getStatus().percent, 43, 'progress percent is still rounded and current');
  updater.emit('download-progress', { percent: 42.6 });
  assert.equal(service.getStatus().percent, 43, 'an identical tick must not corrupt the status');
});

test('the documented per-percent log throttle is still in place', async () => {
  // Guards the other half of the pair: if this throttle were removed, the
  // observer-count assertions above would silently start allowing tick-rate
  // notifications again.
  const { updater, logs } = await harness();
  for (let i = 0; i < 300; i += 1) updater.emit('download-progress', { percent: 7.1 });
  const progressLogs = logs.filter((entry) => entry.event === 'update_download_progress');
  assert.equal(progressLogs.length, 1,
    `300 ticks at one percent must log once, got ${progressLogs.length}`);
});
