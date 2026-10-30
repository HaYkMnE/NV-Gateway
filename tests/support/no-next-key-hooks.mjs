// Test-only ESM loader hook (registered in the spawned gateway child via
// `--import`). It rewrites src/gateway/rotation.mjs so getNextKey() always
// returns null. That is the only way to reach the failover loop's
// "No available keys to service request" exit (server.mjs), which the real
// rotation invariants make unreachable over HTTP: an unattempted active key is
// always selectable. Production code is not modified.
const MARKER = 'export function getNextKey(';

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/src/gateway/rotation.mjs')) return result;
  const source = String(result.source);
  if (!source.includes(MARKER)) throw new Error('no-next-key hook: getNextKey export not found in rotation.mjs');
  return {
    ...result,
    source: source.replace(MARKER, 'export function getNextKey() { return null; }\nfunction originalGetNextKey('),
    shortCircuit: true
  };
}
