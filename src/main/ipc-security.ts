export interface IpcEventLike { sender?: unknown; senderFrame?: { url: string; parent: unknown } | null }

export function validateIpcSender(event: IpcEventLike, expectedSender: unknown, allowedUrls?: string[]): void {
  if (!allowedUrls) { allowedUrls = expectedSender as string[]; expectedSender = undefined; }
  if (expectedSender !== undefined && event.sender !== expectedSender) throw new Error('Invalid IPC sender webContents.');
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) throw new Error('Invalid IPC sender frame.');
  let senderUrl: URL;
  try { senderUrl = new URL(frame.url); } catch { throw new Error('Invalid IPC sender origin.'); }
  if (senderUrl.search || !allowedUrls.some((allowedUrl) => {
    try {
      const allowed = new URL(allowedUrl);
      return !allowed.search && !allowed.hash && senderUrl.origin === allowed.origin && senderUrl.pathname === allowed.pathname;
    } catch { return false; }
  })) throw new Error('Invalid IPC sender origin.');
}

export const validators: {
  port(value: unknown): asserts value is number;
  boolean(value: unknown): asserts value is boolean;
  ports(value: unknown): asserts value is number[];
  key(value: unknown): asserts value is string;
  uuid(value: unknown): asserts value is string;
  status(value: unknown): asserts value is string;
  reorder(value: unknown): asserts value is string[];
} = {
  port(value: unknown): asserts value is number {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65534) throw new Error('Invalid port.');
  },
  boolean(value: unknown): asserts value is boolean { if (typeof value !== 'boolean') throw new Error('Invalid boolean.'); },
  ports(value: unknown): asserts value is number[] {
    if (!Array.isArray(value) || value.length > 256) throw new Error('Invalid ports.');
    value.forEach(validators.port);
  },
  key(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length < 1 || value.length > 8192 || !/^[\x21-\x7e]+$/.test(value.trim())) throw new Error('Invalid key.'); },
  uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error('Invalid UUID.'); },
  status(value: unknown): asserts value is string { if (!['active', 'disabled', 'quota-exceeded'].includes(value as string)) throw new Error('Invalid status.'); },
  reorder(value: unknown): asserts value is string[] { if (!Array.isArray(value) || value.length > 1000 || new Set(value).size !== value.length) throw new Error('Invalid reorder.'); value.forEach(validators.uuid); }
};
