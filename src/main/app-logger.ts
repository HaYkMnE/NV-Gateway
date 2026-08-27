import * as fs from "node:fs";
import * as path from "node:path";
import { redact } from "./redaction";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ROTATED_FILES = 3;

let logPath: string;
let protectFile: (filePath: string) => void = () => {};

export function initAppLogger(filePath: string, protect: (filePath: string) => void = () => {}): void {
  logPath = filePath;
  protectFile = protect;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.closeSync(fs.openSync(logPath, "a", 0o600));
  protectFile(logPath);
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_FILE_SIZE) return;
  } catch {
    return;
  }

  // Remove oldest rotation first
  const baseName = filePath.replace(/\.jsonl$/, "");
  const oldestPath = `${baseName}.${MAX_ROTATED_FILES}.jsonl`;
  try { fs.unlinkSync(oldestPath); } catch { /* ignore */ }

  // Shift existing rotations and current file.
  // i=2: .2 -> .3, i=1: .1 -> .2, current (treated as i=0) -> .1
  // We process from highest to lowest to avoid overwriting.
  for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
    // i=1 moves current (the log file) to .1; i>1 moves (i-1) to i
    const oldPath = i === 1 ? filePath : `${baseName}.${i - 1}.jsonl`;
    const newPath = `${baseName}.${i}.jsonl`;
    try { fs.renameSync(oldPath, newPath); protectFile(newPath); } catch { /* ignore */ }
  }
}

export function logAppEvent(level: string, event: string, data: Record<string, unknown> = {}): void {
  if (!logPath) {
    console.error("APP_LOGGER_NOT_INITIALIZED");
    return;
  }

  const entry = redact({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data
  });
  const line = JSON.stringify(entry) + "\n";

  try {
    rotateIfNeeded(logPath);
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    console.error("APP_LOG_WRITE_FAILED");
  }
}

export function appLogPath(): string {
  return logPath;
}
