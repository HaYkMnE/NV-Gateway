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
    debounceTimer = null;
    logBuffer = [];

    try {
        rotateLogIfNeeded();
    } catch {
        // Rotation failure is not fatal — proceed with append
    }

fs.appendFileSync(LOG_FILE, data, { encoding: "utf8" });
}

export function closeLogger() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    logBuffer = [];
}
