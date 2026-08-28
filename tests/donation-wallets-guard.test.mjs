import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const DONATION_MODAL_PATH = join(here, '..', 'src', 'renderer', 'pet', 'DonationModal.tsx');
const source = readFileSync(DONATION_MODAL_PATH, 'utf8');
const EXTERNAL_OPEN_PATH = join(here, '..', 'src', 'main', 'external-open.ts');
const externalOpenSource = readFileSync(EXTERNAL_OPEN_PATH, 'utf8');

const BTC_ADDRESS = 'bc1qmle5479683zdggfd0d3qfzm08dcff3dd8zufw5';
const EVM_ADDRESS = '0xEf3Ab19B35d770293107c1e54d8a6d5f1c6d00bA';
const SOL_ADDRESS = '2r7bD3n3yoRPCPg1bjDaJ7nxcE7oMwJy5cRVu5XsrZgG';
const TRON_ADDRESS = 'TPoeenevUvRwcTfXmCFweGVSbH37hiZpmr';
const TON_ADDRESS = 'UQCirhEjqFkjA8CAQcypCkFOBSOUooNKBTVHgiBikDRUhBGZ';

test('donation-wallets-guard: all 5 unique real wallets exist verbatim in DonationModal.tsx', () => {
  for (const address of [BTC_ADDRESS, EVM_ADDRESS, SOL_ADDRESS, TRON_ADDRESS, TON_ADDRESS]) {
    assert.ok(source.includes(address), `missing wallet address: ${address}`);
  }
});

test('donation-wallets-guard: QR payloads use the correct URI schemes', () => {
  // Payloads are built as template literals over the *_ADDRESS constants,
  // so assert the exact template source text (it resolves to e.g.
  // "bitcoin:bc1qmle5479683zdggfd0d3qfzm08dcff3dd8zufw5" at runtime).
  assert.ok(source.includes('qr: `bitcoin:${BTC_ADDRESS}`'), 'BTC QR payload must use bitcoin: scheme');
  assert.ok(source.includes('qr: `ethereum:${EVM_ADDRESS}@1`'), 'ETH QR payload must use ethereum:...@1 (mainnet)');
  assert.ok(source.includes('qr: `ethereum:${EVM_ADDRESS}@56`'), 'BSC QR payload must use ethereum:...@56 (BSC)');
  assert.ok(source.includes('qr: `solana:${SOL_ADDRESS}`'), 'SOL QR payload must use solana: scheme');
  assert.ok(source.includes('qr: `ton://transfer/${TON_ADDRESS}`'), 'TON QR payload must use ton://transfer/ scheme');
  // Tron has no URI scheme — the plain address itself is the QR payload.
  assert.ok(/qr:\s*TRON_ADDRESS\s*[,}]/.test(source), 'TRON QR payload must be the plain address (qr: TRON_ADDRESS)');
});

test('donation-wallets-guard: crypto rows contain no placeholder / stray addresses', () => {
  // Scope to the crypto rows only — other tabs (world/rucis/stars) are still placeholders by design.
  const cryptoStart = source.indexOf('crypto: [');
  const cryptoEnd = source.indexOf('world: [');
  assert.ok(cryptoStart > 0 && cryptoEnd > cryptoStart, 'crypto rows block must be locatable');
  const cryptoBlock = source.slice(cryptoStart, cryptoEnd);
  assert.ok(!cryptoBlock.includes('PLACEHOLDER'), 'no placeholder values may remain in crypto rows');
  assert.ok(!cryptoBlock.includes('TXp'), 'old TRC-20 placeholder prefix must be gone');
  assert.ok(!cryptoBlock.includes('UQBx'), 'old TON placeholder prefix must be gone');
  assert.ok(!cryptoBlock.includes('•••'), 'no ••• placeholder markers may remain in crypto rows');
  // Address literals live in the *_ADDRESS constants above the row table;
  // the whole file must contain ONLY the 5 real ones — no foreign lookalikes.
  const bech32Like = source.match(/bc1[a-z0-9]{11,}/gi) ?? [];
  assert.deepEqual([...new Set(bech32Like)], [BTC_ADDRESS], 'only the real BTC bech32 address may appear');
  const ethLike = source.match(/0x[0-9A-Fa-f]{40}/g) ?? [];
  assert.deepEqual([...new Set(ethLike)], [EVM_ADDRESS], 'only the real EVM address may appear');
  // The crypto tab must define exactly the 6 expected row ids.
  for (const id of ['btc', 'eth', 'bsc', 'sol', 'tron', 'ton']) {
    assert.ok(source.includes(`id: '${id}'`), `crypto row id '${id}' missing`);
  }
  // EVM address constant must be shared by both the ETH and BSC rows.
  const evmUsages = source.split('EVM_ADDRESS').length - 1;
  assert.ok(evmUsages >= 5, `EVM_ADDRESS reused across rows (found ${evmUsages} references)`);
});

// ---- World Cards tab (real links) ----

const PATREON_URL = 'https://www.patreon.com/c/HaYkMnE';
const KOFI_URL = 'https://ko-fi.com/haykmne';

test('donation-wallets-guard: world-tab links exist verbatim (Patreon, Ko-fi)', () => {
  assert.ok(source.includes(PATREON_URL), `missing Patreon URL: ${PATREON_URL}`);
  assert.ok(source.includes(KOFI_URL), `missing Ko-fi URL: ${KOFI_URL}`);
  // The QR payload must be the exact URL itself (plain URL string).
  assert.ok(source.includes(`qr: '${PATREON_URL}'`), 'Patreon QR payload must be the exact URL');
  assert.ok(source.includes(`qr: '${KOFI_URL}'`), 'Ko-fi QR payload must be the exact URL');
});

// ---- Tribute (Telegram) support link ----

const TRIBUTE_URL =
  'https://t.me/tribute/app?startapp=ep_7qt3bDGDd36LHQg4oAifvcqXhzifEM9RF0TMtb54EZbJQOdZX0';

test('donation-wallets-guard: Tribute link exists verbatim with exact QR payload', () => {
  assert.ok(source.includes(TRIBUTE_URL), `missing Tribute URL: ${TRIBUTE_URL}`);
  assert.ok(source.includes(`qr: '${TRIBUTE_URL}'`), 'Tribute QR payload must be the exact URL');
  assert.ok(/id:\s*'tribute'/.test(source), "Tribute row id 'tribute' missing");
  assert.ok(source.includes('Tribute (Telegram)'), 'Tribute row label missing');
});

test('donation-wallets-guard: modal is 2 tabs; no RU-CIS / Telegram-Stars remnants', () => {
  assert.ok(source.includes("type TabKey = 'crypto' | 'world';"), 'TabKey must be exactly crypto|world');
  assert.ok(!/rucis/i.test(source), "RU-CIS tab remnants ('rucis') must be gone");
  assert.ok(!source.includes('Boosty') && !source.includes('boosty'), 'Boosty row must be gone');
  assert.ok(!/stars/i.test(source), 'Telegram Stars tab/row remnants must be gone');
  assert.ok(!/tgstars/i.test(source), 'tgstars row ids must be gone');
});

test('donation-wallets-guard: external-open allowlist covers t.me, https-only', () => {
  assert.ok(externalOpenSource.includes('"t.me"'), 'allowlist must include t.me');
  assert.ok(externalOpenSource.includes('"telegram.org"'), 'allowlist must include telegram.org');
  assert.ok(externalOpenSource.includes('protocol === "https:"'), 'allowlist must be https-only');
  // Every allowlisted host is a bare hostname (exact-host matching, no wildcards).
  const blockStart = externalOpenSource.indexOf('ALLOWED_EXTERNAL_HOSTS');
  const blockEnd = externalOpenSource.indexOf(']);', blockStart);
  const allowlistBlock = externalOpenSource.slice(blockStart, blockEnd);
  const hosts = [...allowlistBlock.matchAll(/"([a-z.]+)"/g)].map((m) => m[1]);
  assert.ok(hosts.includes('t.me'), 't.me must be inside the allowlist set');
  for (const host of hosts) {
    assert.match(host, /^[a-z]+(\.[a-z]+)+$/, `suspicious allowlist entry: ${host}`);
  }
});

test('donation-wallets-guard: Buy Me a Coffee row fully removed; world rows clean; no window.open', () => {
  assert.ok(!source.includes('bmac'), 'bmac row id must be removed');
  assert.ok(!/buymeacoffee/i.test(source), 'Buy Me a Coffee must be gone entirely');
  const worldStart = source.indexOf('world: [');
  const worldEnd = source.indexOf('};', worldStart);
  assert.ok(worldStart > 0 && worldEnd > worldStart, 'world rows block must be locatable');
  const worldBlock = source.slice(worldStart, worldEnd);
  assert.ok(!worldBlock.includes('PLACEHOLDER'), 'no placeholder values may remain in world rows');
  assert.ok(!worldBlock.includes('•••'), 'no ••• placeholder markers may remain in world rows');
  // External opens must go through the safe IPC channel — never window.open.
  assert.ok(!source.includes('window.open'), 'DonationModal must never use window.open');
  assert.ok(source.includes('openExternal'), 'link rows must open via electronAPI.openExternal');
});
