// Error reporter for the NV-Gateway main process.
//
// Writes JSONL entries to %APPDATA%\NV-Gateway\logs\errors.log, applies
// secret / local-path / email sanitization, expires entries older than 10
// days, keeps an on-disk report snapshot, and uploads a bundle to the
// Cloudflare Worker reporting endpoint (/v1/error).
//
// Sanitization (applied before writing and again before sending):
//   nvapi-<...>      -> nvapi-***
//   sk-<...>         -> sk-***   (word boundary + min 20 chars to avoid
//                              matching "disk", "task", "risk", etc.)
//   Windows user paths (drive/UNC/JSON-escaped/URL-encoded, any case of
//   "Users")        -> C:\Users\***   via redactUserPaths (canonical
//                              implementation: src/shared/redaction.mjs,
//                              mirrored in ./redaction)
//   <addr>@<domain>  -> ***@***.***

import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import { REPORTS_BASE_URL } from "./reports-endpoint";
import { redactUserPaths } from "./redaction";

// Reporting endpoint of the deployed Cloudflare Worker (POST /v1/error).
// No auth headers — the worker accepts unauthenticated writes.
const REPORT_ENDPOINT = `${REPORTS_BASE_URL}/v1/error`;
// The worker rejects serialized `report` bodies above this size; oversized
// bundles drop their oldest entries until they fit (see fitReportForWorker).
const MAX_REPORT_BODY_BYTES = 65536;
const SEND_TIMEOUT_MS = 15000;

const RETENTION_DAYS = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const RE_NVAPI = /nvapi-[A-Za-z0-9_-]+/g;
// Word boundary + minimum 20 chars so common words like "disk", "task",
// "risk", "ask-" are not matched.
const RE_SK = /\bsk-[A-Za-z0-9_-]{20,}/g;
const RE_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export interface ErrorEntry {
  timestamp: string;
  type: "uncaughtException" | "unhandledRejection" | "gateway" | "renderer";
  message: string;
  stack?: string;
  source?: string;
}

export interface ErrorReportResult {
  success: boolean;
  count: number;
  message: string;
  reportPath?: string;
}

let initialized = false;

function dataDir(): string {
  // app.getPath("userData") resolves to %APPDATA%\NV-Gateway once the app
  // name is aligned with electron-builder productName.
  return app.getPath("userData");
}

function errorsLogPath(): string {
  return path.join(dataDir(), "logs", "errors.log");
}

function reportsDir(): string {
  return path.join(dataDir(), "reports");
}

function sanitizeText(value: string): string {
  return redactUserPaths(value
    .replace(RE_NVAPI, "nvapi-***")
    .replace(RE_SK, "sk-***")
    .replace(RE_EMAIL, "***@***.***"));
}

function sanitizeEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    safe[key] = typeof value === "string" ? sanitizeText(value) : value;
  }
  return safe;
}

// Clamps the report bundle to the worker's serialized-size limit by dropping
// the oldest entries first.  Mutates the report in place; `count` is kept
// consistent with the retained entries.  A single entry larger than the
// limit is still sent once — the HTTP failure path handles that gracefully.
function fitReportForWorker(report: { timestamp: string; count: number; errors: unknown[] }): void {
  while (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_REPORT_BODY_BYTES && report.errors.length > 1) {
    report.errors.shift();
    report.count = report.errors.length;
  }
}

function readErrors(): Record<string, unknown>[] {
  const file = errorsLogPath();
  if (!fs.existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // Ignore malformed lines — JSONL is append-only and best-effort.
    }
  }
  return out;
}

function appendEntry(entry: Record<string, unknown>): void {
  const file = errorsLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

function withinRetention(entry: Record<string, unknown>): boolean {
  const ts = entry?.timestamp ? Date.parse(String(entry.timestamp)) : NaN;
  return Number.isFinite(ts) && ts >= Date.now() - RETENTION_DAYS * MS_PER_DAY;
}

// ---- Public API ----

export function init(): void {
  if (initialized) return;
  initialized = true;

  try {
    fs.mkdirSync(path.dirname(errorsLogPath()), { recursive: true });
  } catch {
    // Directory creation is best-effort.
  }

  try {
    cleanupOldErrors();
  } catch {
    // Cleanup must never block startup.
  }

  process.on("uncaughtException", (err: unknown) => {
    // The existing main-process handler owns fatal shutdown; this listener
    // only records the structured error entry for the report bundle.
    try {
      logError({
        type: "uncaughtException",
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
        source: "main"
      });
    } catch {
      // A logger must never throw.
    }
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error && reason.stack ? reason.stack : undefined;
    try {
      logError({
        type: "unhandledRejection",
        message,
        ...(stack ? { stack } : {}),
        source: "main"
      });
    } catch {
      // Best-effort.
    }
  });
}

export function logError(entry: Partial<ErrorEntry> & { message?: string }): void {
  const source = entry && typeof entry === "object" ? entry : {};
  const record = sanitizeEntry({
    timestamp: source.timestamp || new Date().toISOString(),
    type: source.type || "renderer",
    message: typeof source.message === "string" ? source.message : String(source.message ?? ""),
    ...(typeof source.stack === "string" && source.stack ? { stack: source.stack } : {}),
    ...(typeof source.source === "string" && source.source ? { source: source.source } : {})
  });
  try {
    appendEntry(record);
  } catch {
    // Logging must never throw into the caller.
  }
}

export function getErrorCount(): number {
  return readErrors().filter(withinRetention).length;
}

export function previewErrors(): ErrorEntry[] {
  return readErrors().filter(withinRetention).map((entry) => sanitizeEntry(entry) as unknown as ErrorEntry);
}

export function cleanupOldErrors(): number {
  const entries = readErrors();
  const kept = entries.filter(withinRetention);
  if (kept.length === entries.length) return 0;
  const file = errorsLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = kept.map((entry) => JSON.stringify(entry)).join("\n");
  fs.writeFileSync(file, kept.length ? body + "\n" : "", "utf8");
  return entries.length - kept.length;
}

export async function sendErrors(): Promise<ErrorReportResult> {
  const errors = previewErrors();
  const count = errors.length;

  // ALWAYS persist a local snapshot of the report bundle — independent of
  // whether the upload path is configured or succeeds, so an operator always
  // has an on-disk copy to send manually.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let reportPath = "";
  try {
    const dir = reportsDir();
    fs.mkdirSync(dir, { recursive: true });
    reportPath = path.join(dir, `report-${stamp}.json`);
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ timestamp: new Date().toISOString(), count, errors }, null, 2),
      "utf8"
    );
  } catch {
    // Best-effort snapshot.
  }

  // Network copy of the bundle — trimmed to the worker's size limit.  The
  // local snapshot above intentionally keeps every entry regardless.
  const report = { timestamp: new Date().toISOString(), count, errors };
  fitReportForWorker(report);
  try {
    const response = await fetch(REPORT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ report, appVersion: app.getVersion() || "0.0.0" }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (response.status >= 200 && response.status < 300) {
      return { success: true, count, message: `Sent ${count} errors`, ...(reportPath ? { reportPath } : {}) };
    }
    return { success: false, count, message: `HTTP ${response.status}`, ...(reportPath ? { reportPath } : {}) };
  } catch (err: unknown) {
    return {
      success: false,
      count,
      message: `HTTP request failed: ${err instanceof Error ? err.message : String(err)}`,
      ...(reportPath ? { reportPath } : {})
    };
  }
}
