import * as net from 'node:net';

export async function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true); // Port is in use
      } else {
        resolve(false);
      }
    });
    
    server.once('listening', () => {
      server.close();
      resolve(false); // Port is free
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
