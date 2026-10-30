import * as net from 'node:net';

export async function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    // CR7-006: ANY bind error means the port is not usable. EADDRINUSE is the
    // common case, but EACCES (a Windows excluded port range) was reported
    // "free" and then failed when the gateway itself tried to bind.
    server.once('error', () => {
      resolve(true); // Port cannot be bound (in use, excluded, or denied)
    });
    
    // `server.close()` is ASYNCHRONOUS: it requests the close and returns, and the
    // callback fires once the socket is actually released. Resolving straight
    // after the call reported "port is free" while the handle could still be
    // bound, so a caller that binds immediately could race it. Resolve INSIDE the
    // callback so the promise settles only after the release.
    server.once('listening', () => {
      server.close(() => {
        resolve(false); // Port is free — only once the socket is released
      });
    });
    
    server.listen(port, '127.0.0.1');
  });
}

export async function checkPorts(ports: number[]): Promise<Record<number, boolean>> {
  const results: Record<number, boolean> = {};
  for (const port of ports) {
    results[port] = await checkPort(port);
  }
  return results;
}

export async function findFreePort(startPort = 12000, maxPort = 12200): Promise<number | null> {
  for (let p = startPort; p + 1 <= maxPort; p += 2) {
    const [pFree, p1Free] = await Promise.all([checkPort(p), checkPort(p + 1)]);
    if (!pFree && !p1Free) {
      return p;
    }
  }
  return null;
}
