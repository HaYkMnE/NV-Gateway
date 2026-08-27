import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const DONATION_MODAL_PATH = join(here, '..', 'src', 'renderer', 'pet', 'DonationModal.tsx');
const source = readFileSync(DONATION_MODAL_PATH, 'utf8');

const BTC_ADDRESS = 'bc1qmle5479683zdggfd0d3qfzm08dcff3dd8zufw5';
const EVM_ADDRESS = '0xEf3Ab19B35d770293107c1e54d8a6d5f1c6d00bA';
const SOL_ADDRESS = '2r7bD3n3yoRPCPg1bjDaJ7nxcE7oMwJy5cRVu5XsrZgG';
const TRON_ADDRESS = 'TPoeenevUvRwcTfXmCFweGVSbH37hiZpmr';
const TON_ADDRESS = 'UQCirhEjqFkjA8CAQcypCkFOBSOUooNKBTVHgiBikDRUhBGZ';

test('donation-wallets-guard: all 5 unique real wallets exist verbatim', () => {
  for (const address of [BTC_ADDRESS, EVM_ADDRESS, SOL_ADDRESS, TRON_ADDRESS, TON_ADDRESS]) {
    assert.ok(source.includes(address), `missing wallet address: ${address}`);
  }
});
