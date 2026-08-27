import * as http from "node:http";

export interface AdminRequest { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown }
export function requestAdmin(port: number, token: string, request: AdminRequest): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = request.body === undefined ? "" : JSON.stringify(request.body);
    const req = http.request({ host: "127.0.0.1", port: port + 1, path: request.path, method: request.method, agent: false, timeout: 15_000, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks: Buffer[] = []; let length = 0;
      res.on("data", (chunk: Buffer) => { length += chunk.length; if (length <= 2 * 1024 * 1024) chunks.push(chunk); else res.destroy(); });
      res.on("end", () => { try { const data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); res.statusCode && res.statusCode < 400 ? resolve(data) : reject(new Error(data.error || "Admin operation failed.")); } catch { reject(new Error("Invalid admin response.")); } });
    });
    req.on("timeout", () => req.destroy(new Error("Admin operation timed out."))); req.on("error", reject); req.end(body);
  });
}
