// Feedback is saved LOCALLY and never transmitted.
//
// This module used to POST every saved entry to the reporting worker as a side
// effect of saving — including the exported diagnostic bundle as `logs` (up to
// 32 KB of gateway/app/stdio log lines). The user pressed "save" and an upload
// happened, which is exactly the behaviour the owner requirement forbids:
// nothing may leave the machine until the user explicitly asks for it.
//
// The network leg is therefore gone. What remains:
//   * the local save (the source of truth, and what the user can inspect), and
//   * openGitHubIssue(), which opens a PREFILLED browser page — the user still
//     has to review it and press GitHub's own submit button, and the app itself
//     transmits nothing.
import { app, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { exportDiagnostic } from "./diagnostic-export";
import { REPO_ISSUES_URL } from "./external-open";
import { sanitizeReportText } from "./report-sanitizer";

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

/** Injection point for tests; production resolves Electron's userData dir. */
export interface FeedbackOptions {
  userDataPath?: string;
}

function feedbackDir(options?: FeedbackOptions): string {
  const base = options?.userDataPath ?? app.getPath("userData");
  return path.join(base, "feedback");
}

export async function saveFeedback(data: FeedbackData, options?: FeedbackOptions): Promise<FeedbackResult> {
  if (!data || typeof data !== "object") {
    return { success: false, message: "Invalid feedback data." };
  }
  if (typeof data.title !== "string" || typeof data.description !== "string") {
    return { success: false, message: "Invalid feedback data: title and description are required." };
  }
  const title = sanitizeReportText(typeof data.title === "string" ? data.title : String(data.title ?? ""));
  const description = sanitizeReportText(typeof data.description === "string" ? data.description : String(data.description ?? ""));
  const email = typeof data.email === "string" && data.email.trim() ? sanitizeReportText(data.email.trim()) : "";
  const attachDiagnostic = Boolean(data.attachDiagnostic);

  const dir = feedbackDir(options);
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const stamp = timestamp.replace(/[:.]/g, "-");

  let diagnosticPath: string | undefined;
  if (attachDiagnostic) {
    try {
      const result = await exportDiagnostic(options);
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

  // NO NETWORK LEG. This is where the entry used to be POSTed to the reporting
  // worker — with the diagnostic bundle attached as `logs` — purely because the
  // user pressed "save". Saving is a local action and stays local; transmitting
  // is a separate, explicit decision the user makes elsewhere.
  return {
    success: true,
    path: standalonePath,
    message: "Feedback saved"
  };
}

// Opens a PREFILLED GitHub issue page in the user's browser. The app transmits
// nothing: the user reviews the prefilled text and presses GitHub's own submit
// button, so this remains an explicit user action end to end.
export async function openGitHubIssue(data: FeedbackData): Promise<void> {
  const title = sanitizeReportText(typeof data.title === "string" ? data.title : String(data.title ?? ""));
  const description = sanitizeReportText(typeof data.description === "string" ? data.description : String(data.description ?? ""));
  const email = typeof data.email === "string" && data.email.trim() ? sanitizeReportText(data.email.trim()) : "";
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
