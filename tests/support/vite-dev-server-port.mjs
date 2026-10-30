import net from 'node:net';

// Starts a Vite dev server on a port of its own, never a hard-coded one.
//
// Why not a fixed port: Windows (Hyper-V / WinNAT) may reserve dynamic TCP
// ranges that change over time (e.g. 5161-5260 on the dev machine, see
// `netsh interface ipv4 show excludedportrange protocol=tcp`), including
// Vite's default 5173. A bind inside a reserved range fails with EACCES, not
// EADDRINUSE, so Vite's `strictPort: false` fallback never engages.
//
// Why not `port: 0`: Vite 5 treats a falsy port as "unset" and falls back to
// DEFAULT_DEV_PORT 5173 (startServer in vite/dist/node/chunks/dep-*.js), which
// is itself inside that reserved range and is also the developer's own dev port.
//
// So the OS picks a free ephemeral loopback port, Vite binds it strictly, and a
// lost race (someone grabbed it in between) or a reserved port is retried on a
// brand-new server instance.

const HOST = '127.0.0.1';
export const VITE_START_MAX_ATTEMPTS = 8;

/** A port the OS just handed out as free on 127.0.0.1. */
function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function isRetryableBindError(error) {
  // strictPort turns EADDRINUSE into a plain Error without a code.
  return error?.code === 'EACCES'
    || error?.code === 'EADDRINUSE'
    || /is already in use/.test(error?.message ?? '');
}

/**
 * @param {typeof import('vite').createServer} createServer
 * @param {import('vite').InlineConfig} config  Everything except server.port/host/strictPort.
 * @returns {Promise<{ server: import('vite').ViteDevServer, base: string }>}
 *   `base` is built from the port the HTTP server actually bound.
 */
export async function startViteDevServerOnFreePort(createServer, config) {
  let lastError;
  for (let attempt = 1; attempt <= VITE_START_MAX_ATTEMPTS; attempt += 1) {
    const port = await ephemeralPort();
    const server = await createServer({
      ...config,
      server: { ...config.server, port, strictPort: true, host: HOST }
    });
    try {
      await server.listen();
      const bound = server.httpServer.address();
      return { server, base: `http://${HOST}:${bound.port}` };
    } catch (error) {
      await server.close().catch(() => {});
      if (!isRetryableBindError(error)) throw error;
      lastError = error;
    }
  }
  throw new Error(`Vite dev server could not bind a free loopback port after ${VITE_START_MAX_ATTEMPTS} attempts`,
    { cause: lastError });
}
