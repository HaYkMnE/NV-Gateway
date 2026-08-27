import { TextDecoder } from "node:util";

function fail(): never { throw new Error("OPENCODE_CONFIG_MALFORMED"); }

/** Decodes OpenCode config bytes only when they are strict UTF-8, retaining a permitted leading UTF-8 BOM. */
export function decodeStrictUtf8OpenCodeConfig(buffer: Buffer): string {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) || buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) fail();
  try {
    // `ignoreBOM: true` retains EF BB BF as U+FEFF so the locator can apply its one-leading-BOM policy.
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    if (source.indexOf("\ufeff", source.charCodeAt(0) === 0xfeff ? 1 : 0) !== -1) fail();
    return source;
  } catch { fail(); }
}
