import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DiagnosticExportResult {
  success: boolean;
  path?: string;
  message: string;
}

// Reuses the minimization approach from scripts/telemetry/collect-minimized-logs.ts:
// read the last ~50 lines of each JSONL log in %APPDATA%\NV-Gateway\logs\,
// parse, sanitize and write a telemetry-bundle.json.  Sanitization rules
// match src/main/error-reporter.ts (nvapi-*** / sk-*** / C:\Users\***\ /
// ***@***.***).

const LOG_FILES = ["gateway.jsonl", "app.jsonl", "gateway-stdio.jsonl"];
const MAX_ENTRIES = 50;

function sanitizeText(value: string): string {
  return value
    .replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-***")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/C:\\Users\\[^\\]+\\/g, "C:\\Users\\***\\")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "***@***.***");
}

function sanitizeEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    out[key] = typeof value === "string" ? sanitizeText(value) : value;
  }
  return out;
}

function logsDir(): string {
  return path.join(app.getPath("userData"), "logs");
}

function diagnosticsDir(): string {
  return path.join(app.getPath("userData"), "diagnostics");
}

function collectEntries(): Record<string, unknown>[] {
  const dir = logsDir();
  const entries: Record<string, unknown>[] = [];
  if (!fs.existsSync(dir)) return entries;

  for (const file of LOG_FILES) {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const recent = lines.slice(-MAX_ENTRIES);
    for (const line of recent) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          entries.push(sanitizeEntry(parsed as Record<string, unknown>));
        }
      } catch {
        // Ignore malformed lines — JSONL is append-only and best-effort.
      }
    }
  }
  return entries;
}

export async function exportDiagnostic(): Promise<DiagnosticExportResult> {
  const entries = collectEntries();
  const dir = diagnosticsDir();
  fs.mkdirSync(dir, { recursive: true });

  const bundle = {
    timestamp: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    entryCount: entries.length,
    entries
  };

  const outputPath = path.join(dir, "telemetry-bundle.json");
  try {
    fs.writeFileSync(outputPath, JSON.stringify(bundle, null, 2), "utf8");
  } catch {
    return { success: false, message: "Failed to write diagnostic bundle." };
  }

  return { success: true, path: outputPath, message: "Diagnostic bundle exported" };
}
