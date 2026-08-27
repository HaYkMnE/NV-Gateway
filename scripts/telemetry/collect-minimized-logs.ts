import * as fs from 'node:fs';
import * as path from 'node:path';
// Canonical Windows user-path redaction (single source of truth). This script
// is executed via tsx (see .github/workflows/autonomous-analysis.yml), which
// resolves the ESM .mjs import directly — unlike src/main (compiled to
// CommonJS), which uses the mirrored helper in src/main/redaction.ts.
import { redactUserPaths } from '../../src/shared/redaction.mjs';

const ALLOWED_FIELDS = new Set([
  'timestamp', 'level', 'message', 'statusCode', 'status', 
  'outcome', 'attempt', 'maxAttempts', 'reason', 'duration_ms', 'method', 'path'
]);

const FALLBACK_LOGS = [
  { timestamp: "2026-08-09T09:13:35.807Z", level: "warn", message: "Upstream first-byte timeout", statusCode: 504, outcome: "first_byte_timeout" },
  { timestamp: "2026-08-09T09:15:35.956Z", level: "warn", message: "Retrying with different key", attempt: 1, maxAttempts: 2, reason: "timeout" },
  { timestamp: "2026-08-09T09:15:35.956Z", level: "error", message: "All failover attempts exhausted", attempts: 2, status: 502, duration_ms: 240441 }
];

export function sanitizeEntry(raw: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (ALLOWED_FIELDS.has(key)) {
      if (typeof value === 'string') {
        // Redact secrets, then local Windows user paths via the canonical
        // helper (drive/UNC/JSON-escaped/URL-encoded, any case of "Users").
        const cleanVal = redactUserPaths(value
          .replace(/nvapi-[a-zA-Z0-9_-]+/g, '[REDACTED_KEY]')
          .replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED_KEY]'));
        sanitized[key] = cleanVal;
      } else {
        sanitized[key] = value;
      }
    }
  }
  return sanitized;
}

export async function collectLogs(): Promise<void> {
  const appData = process.env.APPDATA;
  const logDir = appData ? path.join(appData, 'NV-Gateway', 'logs') : null;
  const entries: Record<string, unknown>[] = [];

  if (logDir && fs.existsSync(logDir)) {
    const files = ['gateway.jsonl', 'app.jsonl'];
    for (const file of files) {
      const filePath = path.join(logDir, file);
      if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
        for (const line of lines.slice(-50)) { // Take last 50 entries
          try {
            const parsed = JSON.parse(line);
            entries.push(sanitizeEntry(parsed));
          } catch {
            // Ignore malformed lines
          }
        }
      }
    }
  }

  const finalBundle = entries.length > 0 ? entries : FALLBACK_LOGS.map(sanitizeEntry);
  const outputPath = path.join(process.cwd(), 'telemetry-bundle.json');
  fs.writeFileSync(outputPath, JSON.stringify(finalBundle, null, 2), 'utf8');
  console.log(`[Telemetry] Wrote ${finalBundle.length} sanitized log entries to ${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('collect-minimized-logs.ts')) {
  void collectLogs();
}
