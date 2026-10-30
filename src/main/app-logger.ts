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
    // F3: the active path is missing (deleted externally, or already renamed
    // away). rotateIfNeeded is a no-op here, but the append that follows will
    // RE-CREATE the file at the process default mode with no ACL — so that
    // re-creation must be protected. Guarded + isolated so a protector failure
    // can never escape into logAppEvent.
    try {
      fs.closeSync(fs.openSync(filePath, "a", 0o600));
      protectFile(filePath);
    } catch { /* best-effort, like every other protect path here */ }
    return;
  }

  // Remove oldest rotation first
  const baseName = filePath.replace(/\.jsonl$/, "");
  const oldestPath = `${baseName}.${MAX_ROTATED_FILES}.jsonl`;
  try { fs.unlinkSync(oldestPath); } catch { /* ignore */ }

  // Shift existing rotations and current file.
  // i=2: .2 -> .3, i=1: .1 -> .2, current (treated as i=0) -> .1
  // We process from highest to lowest to avoid overwriting.
  let activeRotated = false;
  for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
    // i=1 moves current (the log file) to .1; i>1 moves (i-1) to i
    const oldPath = i === 1 ? filePath : `${baseName}.${i - 1}.jsonl`;
    const newPath = `${baseName}.${i}.jsonl`;
    try { fs.renameSync(oldPath, newPath); if (i === 1) activeRotated = true; protectFile(newPath); } catch { /* ignore */ }
  }

  // The rename moved the protected file OUT of the active path, and the append
  // that follows re-creates it with the process default mode and no ACL. That
  // re-created file is the one the app keeps writing to, so it gets the same
  // 0o600 open and the same protector initAppLogger applied at startup.
  // Best-effort: a failed re-protection must not cost the log entry below.
  //
  // F3: the guard is `activeRotated || !fs.existsSync(filePath)`, NOT
  // `activeRotated` alone. If an intermediate step above THREW after the active
  // file was renamed away (e.g. protectFile(newPath) rejected an AV handle), the
  // `catch` swallowed it and `activeRotated` was never set — yet the active path
  // is already gone, so the append below would re-create it UNPROTECTED. The
  // existence check makes the re-protection unavoidable in that case: whatever
  // route we took, the active file must end up 0o600 + protected.
  if (activeRotated || !fs.existsSync(filePath)) {
    try {
      fs.closeSync(fs.openSync(filePath, "a", 0o600));
      protectFile(filePath);
    } catch { /* ignore */ }
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
