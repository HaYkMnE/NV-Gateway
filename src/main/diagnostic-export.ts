import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeDiagnosticEntry } from "./report-sanitizer";

export interface DiagnosticExportResult {
  success: boolean;
  path?: string;
  message: string;
}

/** Injection point for tests; production resolves Electron's userData dir. */
export interface DiagnosticExportOptions {
  userDataPath?: string;
}

// Reads the last ~50 lines of each JSONL log in %APPDATA%\NV-Gateway\logs\,
// sanitizes them and writes telemetry-bundle.json.
//
// The bundle is written LOCALLY and never transmitted — it exists so the user can
// inspect it and attach it somewhere themselves if they choose to.
//
// Sanitization goes through ./report-sanitizer (built on ./redaction). The
// regex-only rules that used to live here could not see gatewayToken/adminToken
// (random, unprefixed base64url) and inspected values only, never key names, so a
// field called `x-api-key` was copied into the bundle verbatim.

const LOG_FILES = ["gateway.jsonl", "app.jsonl", "gateway-stdio.jsonl"];
const MAX_ENTRIES = 50;

function logsDir(options?: DiagnosticExportOptions): string {
  return path.join(options?.userDataPath ?? app.getPath("userData"), "logs");
}

function diagnosticsDir(options?: DiagnosticExportOptions): string {
  return path.join(options?.userDataPath ?? app.getPath("userData"), "diagnostics");
}

/** Electron's version when running in the app; a placeholder under test. */
function resolveAppVersion(): string {
  try {
    return app?.getVersion?.() ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function collectEntries(options?: DiagnosticExportOptions): Record<string, unknown>[] {
  const dir = logsDir(options);
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
          entries.push(sanitizeDiagnosticEntry(parsed as Record<string, unknown>));
        }
      } catch {
        // Ignore malformed lines — JSONL is append-only and best-effort.
      }
    }
  }
  return entries;
}

export async function exportDiagnostic(options?: DiagnosticExportOptions): Promise<DiagnosticExportResult> {
  const entries = collectEntries(options);
  const dir = diagnosticsDir(options);
  fs.mkdirSync(dir, { recursive: true });

  const bundle = {
    timestamp: new Date().toISOString(),
    appVersion: resolveAppVersion(),
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
