import fs from "node:fs";
import path from "node:path";
import { redact } from "../shared/redaction.mjs";

const LOG_FILE = process.env.GATEWAY_LOG_PATH;
if (!LOG_FILE) {
    throw new Error("GATEWAY_LOG_PATH is required.");
}

const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ROTATED_FILES = 3;

let logBuffer = [];
let debounceTimer = null;
const MAX_MEM_LOGS = 100;
const memLogs = [];

// FIX 1 — suppression ledger (O(1), content never queued — same discipline as
// error-reporter.ts:361-372). A failing append must NOT escape flushLogs: it
// runs inside the debounce timer callback and the gateway child has no
// uncaughtException handler, so one throw kills the gateway mid-service.
let suppressedBatches = 0;
let suppressedEntries = 0;
let suppressedSince = "";
let suppressedUntil = "";

function rotateLogIfNeeded() {
    try {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size < MAX_LOG_FILE_SIZE) return;
    } catch {
        return; // File does not exist yet
    }

    const baseName = LOG_FILE.replace(/\.jsonl$/, "");

    // Remove oldest rotation first
    const oldestPath = `${baseName}.${MAX_ROTATED_FILES}.jsonl`;
    try { fs.unlinkSync(oldestPath); } catch { /* ignore */ }

    // Shift: i=2 moves .1 -> .2, i=1 moves current -> .1
    for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
        const oldPath = i === 1 ? LOG_FILE : `${baseName}.${i - 1}.jsonl`;
        const newPath = `${baseName}.${i}.jsonl`;
        try { fs.renameSync(oldPath, newPath); } catch { /* ignore */ }
    }
}

export function log(level, message, meta = {}) {
    const safeMeta = redact(meta);
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...safeMeta
    };
    const logStr = JSON.stringify(entry);

    memLogs.push(entry);
    if (memLogs.length > MAX_MEM_LOGS) {
        memLogs.shift();
    }

    logBuffer.push(logStr);

    if (!debounceTimer) {
        debounceTimer = setTimeout(flushLogs, 1000);
    }
}

export function info(message, meta) { log("info", message, meta); }
export function warn(message, meta) { log("warn", message, meta); }
export function error(message, meta) { log("error", message, meta); }

export function getRecentLogs() {
    return redact(memLogs);
}

export function flushLogs() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (logBuffer.length === 0) {
        debounceTimer = null;
        return;
    }

    const data = logBuffer.join("\n") + "\n";
    const batchSize = logBuffer.length;
    debounceTimer = null;
    logBuffer = [];

    try {
        rotateLogIfNeeded();
    } catch {
        // Rotation failure is not fatal — proceed with append
    }

    try {
        // ONE summary marker on the first flush after recovery (same
        // `[log-suppressed: ...]` spirit as error-reporter). Counters reset
        // ONLY on a successful write, so a still-failing disk retries the
        // notice later instead of losing the gap silently.
        if (suppressedBatches > 0) {
            const now = new Date().toISOString();
            const notice = JSON.stringify({
                timestamp: now,
                level: "warn",
                message: `[log-suppressed: ${suppressedBatches} batches / ${suppressedEntries} entries between ${suppressedSince} and ${suppressedUntil} were dropped: log write failed]`
            }) + "\n";
            fs.appendFileSync(LOG_FILE, notice + data, { encoding: "utf8" });
            suppressedBatches = 0;
            suppressedEntries = 0;
            suppressedSince = "";
            suppressedUntil = "";
            return;
        }
        fs.appendFileSync(LOG_FILE, data, { encoding: "utf8" });
    } catch {
        // Survival first: drop this batch, count it, never rethrow into the
        // debounce timer. Never queue content — that would move a disk
        // problem into unbounded memory.
        const now = new Date().toISOString();
        if (suppressedBatches === 0) suppressedSince = now;
        suppressedUntil = now;
        suppressedBatches += 1;
        suppressedEntries += batchSize;
    }
}

export function closeLogger() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    logBuffer = [];
}
