import { app, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { exportDiagnostic } from "./diagnostic-export";
import { REPORTS_BASE_URL } from "./reports-endpoint";

export interface FeedbackData {
  type: "suggestion" | "bug";
  title: string;
  description: string;
  email?: string;
  attachDiagnostic: boolean;
}

export interface FeedbackResult {
  success: boolean;
  path?: string;
  message: string;
}

const REPO_ISSUES_URL = "https://github.com/susmnavorasem/nv-gateway/issues/new";

// Online delivery of saved feedback to the reporting worker (POST
// /v1/feedback).  Best-effort: the local save below is the source of truth
// and network failures never fail the submission.
const FEEDBACK_ENDPOINT = `${REPORTS_BASE_URL}/v1/feedback`;
const SEND_TIMEOUT_MS = 15000;
// Worker-side payload limits for /v1/feedback.
const MIN_MESSAGE_CHARS = 10;
const MAX_MESSAGE_CHARS = 5000;
const MAX_CONTACT_CHARS = 200;
const MAX_LOGS_CHARS = 32768;

function feedbackDir(): string {
  return path.join(app.getPath("userData"), "feedback");
}

function sanitizeText(value: string): string {
  return value
    .replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-***")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/C:\\Users\\[^\\]+\\/g, "C:\\Users\\***\\")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "***@***.***");
}

// Reads the exported diagnostic bundle (entries were sanitized at collection
// time by diagnostic-export.ts) and clamps it to the worker's logs limit.
function diagnosticLogs(diagnosticPath: string | undefined): string | undefined {
  if (!diagnosticPath) return undefined;
  try {
    const raw = fs.readFileSync(diagnosticPath, "utf8");
    if (!raw) return undefined;
    return raw.length > MAX_LOGS_CHARS ? raw.slice(0, MAX_LOGS_CHARS) : raw;
  } catch {
    return undefined;
  }
}

// Best-effort POST to the worker.  Never throws.
async function sendToWorker(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

export async function saveFeedback(data: FeedbackData): Promise<FeedbackResult> {
  if (!data || typeof data !== "object") {
    return { success: false, message: "Invalid feedback data." };
  }
  if (typeof data.title !== "string" || typeof data.description !== "string") {
    return { success: false, message: "Invalid feedback data: title and description are required." };
  }
  const title = sanitizeText(typeof data.title === "string" ? data.title : String(data.title ?? ""));
  const description = sanitizeText(typeof data.description === "string" ? data.description : String(data.description ?? ""));
  const email = typeof data.email === "string" && data.email.trim() ? sanitizeText(data.email.trim()) : "";
  const attachDiagnostic = Boolean(data.attachDiagnostic);

  const dir = feedbackDir();
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const stamp = timestamp.replace(/[:.]/g, "-");

  let diagnosticPath: string | undefined;
  if (attachDiagnostic) {
    try {
      const result = await exportDiagnostic();
      if (result.success && result.path) diagnosticPath = result.path;
    } catch {
      // Diagnostic export must not block feedback submission.
    }
  }

  const entry: Record<string, unknown> = {
    timestamp,
    type: data.type === "bug" ? "bug" : "suggestion",
    title,
    description,
    attachDiagnostic
  };
  if (email) entry.email = email;
  if (diagnosticPath) entry.diagnosticPath = diagnosticPath;

  const jsonlPath = path.join(dir, "feedback.jsonl");
  try {
    fs.appendFileSync(jsonlPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    return { success: false, message: "Failed to append feedback log." };
  }

  const standalonePath = path.join(dir, `feedback-${stamp}.json`);
  try {
    fs.writeFileSync(standalonePath, JSON.stringify(entry, null, 2), "utf8");
  } catch {
    return { success: false, message: "Failed to write feedback file." };
  }

  // Local persistence succeeded — now mirror the entry to the reporting
  // worker.  Payload mapping follows the /v1/feedback schema: message is
  // required (10..5000 chars), contact/logs/appVersion optional.  Entries
  // too short for the worker's minimum skip the network leg silently.
  const message = `[${entry.type}] ${title}\n\n${description}`.slice(0, MAX_MESSAGE_CHARS);
  let sentOnline = false;
  if (message.trim().length >= MIN_MESSAGE_CHARS) {
    const payload: Record<string, unknown> = {
      message,
      appVersion: app.getVersion() || "0.0.0"
    };
    if (email) payload.contact = email.slice(0, MAX_CONTACT_CHARS);
    const logs = diagnosticLogs(diagnosticPath);
    if (logs) payload.logs = logs;
    sentOnline = await sendToWorker(payload);
  }

  return {
    success: true,
    path: standalonePath,
    message: sentOnline ? "Feedback saved and sent" : "Feedback saved"
  };
}

export async function openGitHubIssue(data: FeedbackData): Promise<void> {
  const title = sanitizeText(typeof data.title === "string" ? data.title : String(data.title ?? ""));
  const description = sanitizeText(typeof data.description === "string" ? data.description : String(data.description ?? ""));
  const email = typeof data.email === "string" && data.email.trim() ? sanitizeText(data.email.trim()) : "";
  const typeLabel = data.type === "bug" ? "Bug report" : "Suggestion";

  const lines: string[] = [];
  lines.push(`**Type:** ${typeLabel}`);
  lines.push("");
  lines.push(`**Title:** ${title}`);
  lines.push("");
  lines.push("### Description");
  lines.push("");
  lines.push(description);
  lines.push("");
  if (data.attachDiagnostic) {
    lines.push("> A diagnostic bundle was exported locally when this feedback was saved.");
    lines.push("> Please attach it to this issue if relevant.");
    lines.push("");
  }
  if (email) {
    lines.push(`**Contact:** ${email}`);
  }

  const url = `${REPO_ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(lines.join("\n"))}`;
  await shell.openExternal(url);
}
