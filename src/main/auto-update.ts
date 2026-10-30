import type { AppLanguage } from "./gateway-runtime";

// Auto-update service for GitHub Releases, wrapped around electron-updater's
// autoUpdater. The service itself is Electron-free: every Electron/electron-updater
// dependency is injected so the event -> dialog / menu-state mapping and the
// graceful install ordering (gateway child fully stopped BEFORE
// quitAndInstall) are unit-testable with plain node:test, mirroring the
// project's other adapters (before-quit-guard, tray-icons, ...).
//
// Update policy: updates are only OFFERED, never auto-applied.
// - autoDownload is forced to false; downloads start only from the user's
//   "Download" button in the update-available dialog.
// - autoInstallOnAppQuit is forced to false; installing happens only from the
//   explicit "Restart and install" dialog action, which first stops the
//   gateway child so it is never orphaned and its ports are freed.

export type UpdateStateKind = "none" | "checking" | "available" | "downloading" | "ready" | "upToDate" | "error";

export interface UpdaterStatus {
  state: UpdateStateKind;
  version: string | null;
  percent: number | null;
}

export interface UpdaterDialogOptions {
  type?: "none" | "info" | "error" | "warning";
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
}

export interface UpdaterDialog {
  showMessageBox(options: UpdaterDialogOptions): Promise<{ response: number }>;
}

/** Minimal structural view of electron-updater's AppUpdater used by the service. */
export interface UpdaterEventSource {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (payload?: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AutoUpdateServiceOptions {
  updater: UpdaterEventSource;
  dialog: UpdaterDialog;
  /** Reads the configured UI language (config.json "language"). */
  getLanguage(): AppLanguage;
  log(level: string, event: string, data: Record<string, unknown>): void;
  /** Marks the app as quitting so before-quit/window-close guards allow exit. Called only after the gateway child is confirmed stopped. */
  setQuitting(): void;
  /**
   * Stops the managed gateway child; resolves only after it fully exits.
   * Adapter contract: production GatewayLifecycle.stop() NEVER rejects — a
   * failed stop RESOLVES with a status object whose `state` is "error". A
   * resolved value of that shape aborts the install exactly like a rejection;
   * undefined/null (no lifecycle yet) counts as success.
   */
  stopGateway(): Promise<unknown>;
  /** Called with the new status after every transition (tray/menu refresh). */
  onStatusChanged?(status: UpdaterStatus): void;
  /** false in development/unpackaged runs: checks are skipped and logged. */
  enabled: boolean;
  /** Timer source for the periodic check; defaults to the global timers. */
  scheduler?: PeriodicScheduler;
  /** Jitter source in [0, 1); defaults to Math.random. */
  random?: () => number;
}

export interface PeriodicScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Background re-check cadence while the app keeps running (packaged builds only). */
export const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Each periodic delay is shifted by a uniform random offset in [-JITTER, +JITTER]. */
export const PERIODIC_CHECK_JITTER_MS = 15 * 60 * 1000;
/** Plain-text release notes shown in the offer dialog are capped at this many characters. */
export const RELEASE_NOTES_MAX_CHARS = 1500;
/**
 * Raw release-notes input is cut to this many UTF-16 units BEFORE any regex
 * runs (~11x the output cap). The tag regexes are quadratic on pathological
 * input (measured: 50 KB of "<p" took 712 ms on the main thread); bounding n
 * bounds that cost. Applied to the string form and to each array note.
 */
export const RELEASE_NOTES_INPUT_MAX_CHARS = 16_384;

export interface AutoUpdateService {
  getStatus(): UpdaterStatus;
  checkForUpdates(options: { manual: boolean }): Promise<UpdaterStatus>;
  /** Stops the gateway child, then quitAndInstall(isSilent=false, isForceRunAfter=true). */
  installAndQuit(): Promise<void>;
  /** true between the install request and the quitAndInstall handoff (or abort). */
  isInstalling(): boolean;
  /** Arms the unref'd 6 h ± 15 min background check. No-op when disabled or already armed. */
  startPeriodicChecks(): void;
  /** Clears the periodic timer (app quit). Idempotent. */
  stopPeriodicChecks(): void;
}

/** The six standard Keep a Changelog section names ("### Added", ...). */
export type ChangelogSection = "added" | "changed" | "deprecated" | "removed" | "fixed" | "security";

interface UpdateStrings {
  checkMenu: string; // tray menu item
  stateText: Record<Exclude<UpdateStateKind, "none">, string>; // tray status line + log context
  availableTitle: string;
  availableMessage(version: string): string;
  whatsNew: string; // heading above the plain-text release notes in the offer dialog
  sections: Record<ChangelogSection, string>; // Keep a Changelog "### X" section names
  download: string;
  later: string;
  readyTitle: string;
  readyMessage(version: string): string;
  restartInstall: string;
  upToDateTitle: string;
  upToDateMessage: string;
  errorTitle: string;
  errorMessage: string;
}

const UPDATE_STRINGS: Record<AppLanguage, UpdateStrings> = {
  en: {
    checkMenu: "Check for updates…",
    stateText: {
      checking: "Checking for updates…",
      available: "Update available: {version}",
      downloading: "Downloading update… {percent}%",
      ready: "Update ready to install",
      upToDate: "You have the latest version",
      error: "Update check failed"
    },
    availableTitle: "Update available",
    availableMessage: (version) => `A new version is available: ${version}`,
    whatsNew: "What's new:",
    sections: { added: "Added", changed: "Changed", deprecated: "Deprecated", removed: "Removed", fixed: "Fixed", security: "Security" },
    download: "Download",
    later: "Later",
    readyTitle: "Ready to install",
    readyMessage: (version) => `Version ${version} has been downloaded and is ready to install.`,
    restartInstall: "Restart and install",
    upToDateTitle: "No updates",
    upToDateMessage: "You have the latest version.",
    errorTitle: "Update error",
    errorMessage: "Failed to check for updates. See the application log for details."
  },
  ru: {
    checkMenu: "Проверить обновления…",
    stateText: {
      checking: "Проверка обновлений…",
      available: "Доступно обновление: {version}",
      downloading: "Скачивание обновления… {percent}%",
      ready: "Обновление готово к установке",
      upToDate: "У вас последняя версия",
      error: "Не удалось проверить обновления"
    },
    availableTitle: "Доступно обновление",
    availableMessage: (version) => `Доступна новая версия: ${version}`,
    whatsNew: "Что нового:",
    sections: { added: "Добавлено", changed: "Изменено", deprecated: "Устарело", removed: "Удалено", fixed: "Исправлено", security: "Безопасность" },
    download: "Скачать",
    later: "Позже",
    readyTitle: "Готово к установке",
    readyMessage: (version) => `Версия ${version} скачана и готова к установке.`,
    restartInstall: "Перезапустить и установить",
    upToDateTitle: "Обновлений нет",
    upToDateMessage: "У вас последняя версия.",
    errorTitle: "Ошибка обновления",
    errorMessage: "Не удалось проверить обновления. Подробности — в журнале приложения."
  },
  zh: {
    checkMenu: "检查更新…",
    stateText: {
      checking: "正在检查更新…",
      available: "发现新版本: {version}",
      downloading: "正在下载更新… {percent}%",
      ready: "更新已准备好安装",
      upToDate: "当前已是最新版本",
      error: "检查更新失败"
    },
    availableTitle: "发现新版本",
    availableMessage: (version) => `发现新版本: ${version}`,
    whatsNew: "更新内容：",
    sections: { added: "新增", changed: "变更", deprecated: "弃用", removed: "移除", fixed: "修复", security: "安全" },
    download: "下载",
    later: "稍后",
    readyTitle: "准备安装",
    readyMessage: (version) => `版本 ${version} 已下载完成，准备安装。`,
    restartInstall: "重启并安装",
    upToDateTitle: "无可用更新",
    upToDateMessage: "当前已是最新版本。",
    errorTitle: "更新错误",
    errorMessage: "检查更新失败，详情请查看应用日志。"
  },
  es: {
    checkMenu: "Buscar actualizaciones…",
    stateText: {
      checking: "Buscando actualizaciones…",
      available: "Actualización disponible: {version}",
      downloading: "Descargando actualización… {percent}%",
      ready: "Actualización lista para instalar",
      upToDate: "Ya tienes la última versión",
      error: "Error al buscar actualizaciones"
    },
    availableTitle: "Actualización disponible",
    availableMessage: (version) => `Hay una nueva versión disponible: ${version}`,
    whatsNew: "Novedades:",
    sections: { added: "Añadido", changed: "Cambiado", deprecated: "Obsoleto", removed: "Eliminado", fixed: "Corregido", security: "Seguridad" },
    download: "Descargar",
    later: "Más tarde",
    readyTitle: "Listo para instalar",
    readyMessage: (version) => `La versión ${version} se ha descargado y está lista para instalar.`,
    restartInstall: "Reiniciar e instalar",
    upToDateTitle: "Sin actualizaciones",
    upToDateMessage: "Tienes la última versión.",
    errorTitle: "Error de actualización",
    errorMessage: "Error al buscar actualizaciones. Consulta el registro de la aplicación."
  },
  hi: {
    checkMenu: "अपडेट की जाँच करें…",
    stateText: {
      checking: "अपडेट की जाँच हो रही है…",
      available: "अपडेट उपलब्ध है: {version}",
      downloading: "अपडेट डाउनलोड हो रहा है… {percent}%",
      ready: "अपडेट इंस्टॉल करने के लिए तैयार है",
      upToDate: "आपके पास नवीनतम संस्करण है",
      error: "अपडेट जाँच विफल रही"
    },
    availableTitle: "अपडेट उपलब्ध है",
    availableMessage: (version) => `एक नया संस्करण उपलब्ध है: ${version}`,
    whatsNew: "नया क्या है:",
    sections: { added: "जोड़ा गया", changed: "बदला गया", deprecated: "अप्रचलित", removed: "हटाया गया", fixed: "ठीक किया गया", security: "सुरक्षा" },
    download: "डाउनलोड करें",
    later: "बाद में",
    readyTitle: "इंस्टॉल के लिए तैयार",
    readyMessage: (version) => `संस्करण ${version} डाउनलोड हो गया है और इंस्टॉल के लिए तैयार है।`,
    restartInstall: "पुनरारंभ करें और इंस्टॉल करें",
    upToDateTitle: "कोई अपडेट नहीं",
    upToDateMessage: "आपके पास नवीनतम संस्करण है।",
    errorTitle: "अपडेट त्रुटि",
    errorMessage: "अपडेट की जाँच विफल रही। विवरण के लिए एप्लिकेशन लॉग देखें।"
  },
  fr: {
    checkMenu: "Vérifier les mises à jour…",
    stateText: {
      checking: "Vérification des mises à jour…",
      available: "Mise à jour disponible : {version}",
      downloading: "Téléchargement de la mise à jour… {percent}%",
      ready: "Mise à jour prête à installer",
      upToDate: "Vous disposez de la dernière version",
      error: "Échec de la recherche de mise à jour"
    },
    availableTitle: "Mise à jour disponible",
    availableMessage: (version) => `Une nouvelle version est disponible : ${version}`,
    whatsNew: "Nouveautés :",
    sections: { added: "Ajouté", changed: "Modifié", deprecated: "Obsolète", removed: "Supprimé", fixed: "Corrigé", security: "Sécurité" },
    download: "Télécharger",
    later: "Plus tard",
    readyTitle: "Prêt à installer",
    readyMessage: (version) => `La version ${version} a été téléchargée et est prête à être installée.`,
    restartInstall: "Redémarrer et installer",
    upToDateTitle: "Aucune mise à jour",
    upToDateMessage: "Vous disposez de la dernière version.",
    errorTitle: "Erreur de mise à jour",
    errorMessage: "Échec de la recherche de mise à jour. Consultez le journal de l'application."
  },
  ar: {
    checkMenu: "التحقق من وجود تحديثات…",
    stateText: {
      checking: "جارٍ التحقق من التحديثات…",
      available: "تحديث متاح: {version}",
      downloading: "جارٍ تنزيل التحديث… {percent}%",
      ready: "التحديث جاهز للتثبيت",
      upToDate: "لديك أحدث إصدار",
      error: "فشل التحقق من التحديثات"
    },
    availableTitle: "تحديث متاح",
    availableMessage: (version) => `يتوفر إصدار جديد: ${version}`,
    whatsNew: "ما الجديد:",
    sections: { added: "إضافات", changed: "تغييرات", deprecated: "ميزات مهملة", removed: "ميزات مُزالة", fixed: "إصلاحات", security: "الأمان" },
    download: "تنزيل",
    later: "لاحقاً",
    readyTitle: "جاهز للتثبيت",
    readyMessage: (version) => `تم تنزيل الإصدار ${version} وهو جاهز للتثبيت.`,
    restartInstall: "إعادة التشغيل والتثبيت",
    upToDateTitle: "لا توجد تحديثات",
    upToDateMessage: "لديك أحدث إصدار بالفعل.",
    errorTitle: "خطأ في التحديث",
    errorMessage: "فشل التحقق من وجود تحديثات. راجع سجل التطبيق لمزيد من التفاصيل."
  }
};

/** Localized tray-menu text for the current updater status. */
export function getUpdateMenuText(status: UpdaterStatus, language: AppLanguage): { checkLabel: string; statusLabel: string | null; checkEnabled: boolean } {
  const strings = UPDATE_STRINGS[language] ?? UPDATE_STRINGS.en;
  const checkEnabled = status.state !== "checking" && status.state !== "downloading";
  if (status.state === "none" || status.state === "error") {
    return { checkLabel: strings.checkMenu, statusLabel: null, checkEnabled };
  }
  const template = strings.stateText[status.state];
  const statusLabel = template
    .replace("{version}", status.version ?? "?")
    .replace("{percent}", status.percent === null ? "0" : String(status.percent));
  return { checkLabel: strings.checkMenu, statusLabel, checkEnabled };
}

function readVersion(payload: unknown): string | null {
  if (payload && typeof payload === "object" && typeof (payload as { version?: unknown }).version === "string") {
    return (payload as { version: string }).version;
  }
  return null;
}

function readPercent(payload: unknown): number | null {
  if (payload && typeof payload === "object") {
    const value = (payload as { percent?: unknown }).percent;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.min(100, Math.round(value)));
    }
  }
  return null;
}

// Only KNOWN HTML tag names (plus comments) are markup. Anything else in angle
// brackets is text: Promise<string>, Map<string, number>, f<T>(), a < b > c.
// Accepted edge: a generic named like a listed tag (Foo<a>, <b>, <i>) is still
// stripped as a tag.
const HTML_TAG_NAMES = "p|br|ul|ol|li|h[1-6]|a|strong|b|em|i|code|pre|blockquote|div|span|img|table|thead|tbody|tr|td|th|hr|sub|sup|del|details|summary";
// The name must END at whitespace, "/", ">" or end of input. A plain \b also
// matched before "-" and ":", so <code-editor>, <p-foo> and <a:b> were eaten.
const HTML_TAG = new RegExp(`<!--[\\s\\S]*?-->|<\\/?(?:${HTML_TAG_NAMES})(?=[\\s/>]|$)[^>]*>`, "gi");
const HTML_TAG_UNTERMINATED = new RegExp(`<!--[\\s\\S]*$|<\\/?(?:${HTML_TAG_NAMES})(?=[\\s/>]|$)[^>]*$`, "i");

/** Caps raw input at RELEASE_NOTES_INPUT_MAX_CHARS without splitting a surrogate pair. */
function capReleaseNotesInput(input: string): string {
  if (input.length > RELEASE_NOTES_INPUT_MAX_CHARS) {
    let end = RELEASE_NOTES_INPUT_MAX_CHARS;
    // Do not keep a high surrogate whose low half is cut off.
    const last = input.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return input.slice(0, end);
  }
  return input;
}

/** HTML/markdown fragment -> plain text. Known HTML tags and comments are removed; other <...> text is kept. */
function htmlToPlainText(source: string): string {
  // Cap first: every regex below then runs on bounded input (string form and
  // each array note both enter through here).
  let text = capReleaseNotesInput(source).replace(/\r\n?/g, "\n");
  // Script/style bodies are code, not notes: drop them with their content.
  // Same name boundary as HTML_TAG: <script-runner> / <style-guide> are text.
  text = text.replace(/<(script|style)(?=[\s/>]|$)[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  // Unterminated script/style: drop everything from the opening tag on.
  text = text.replace(/<(script|style)(?=[\s/>]|$)[\s\S]*$/i, "");
  // Block-level boundaries become line breaks so the text keeps its shape.
  text = text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|ul|ol|h[1-6]|pre|blockquote|tr)\s*>/gi, "\n");
  // Every remaining known tag/comment, and a trailing unterminated "<tag..." or "<!--...".
  text = text.replace(HTML_TAG, "").replace(HTML_TAG_UNTERMINATED, "");
  // Basic entities; &amp; last so "&amp;lt;" decodes once to the literal "&lt;".
  text = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  // After decoding (so an entity cannot smuggle one back in): drop bidi
  // overrides/isolates, zero-width marks and the BOM, which could reorder or
  // hide dialog text, then C0 controls + DEL. \t (0x09) and \n (0x0A) are kept;
  // \r was already normalized to \n above, so removing 0x0D loses no line break.
  text = text
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    // Unpaired surrogates render as U+FFFD; valid pairs (emoji) are kept.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return text;
}

/** Inline Markdown -> text: links keep their label, code/bold/emphasis marks go. */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    // `**x**` only as a closed pair around non-space text, so 2**10 and ***
    // survive.
    // The inner text may not contain "*", so two spans on one line
    // ("**a** and **b**") never merge into one match.
    .replace(/\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*/g, "$1")
    // `_x_` / `*x*` only with a space or line edge on BOTH sides, and the inner
    // text must not start or end with a marker, so snake_case_id, __init__,
    // a*b and "5 * 3" survive.
    .replace(/(^|\s)([_*])([^\s_*](?:\S*?[^\s_*])?)\2(?=\s|$)/g, "$1$3");
}

/** A code-fence line: ``` plus an optional language tag. */
const CODE_FENCE_LINE = /^\s*```[\w+.#-]*\s*$/;
/** A horizontal rule: 3+ of the same -, * or _ (spaces allowed), nothing else. */
const HORIZONTAL_RULE_LINE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

/** CHANGELOG (Keep a Changelog) Markdown -> plain text for the native dialog. */
function markdownToPlainText(source: string, sections: Record<ChangelogSection, string>): string {
  const out: string[] = [];
  let afterHeading = false;
  let inFence = false;
  for (const line of source.split("\n")) {
    if (CODE_FENCE_LINE.test(line)) { inFence = !inFence; continue; } // drop the fence, keep its body
    if (inFence) { afterHeading = false; out.push(line); continue; } // code stays exactly as written
    if (HORIZONTAL_RULE_LINE.test(line)) continue; // before the bullet rule: "* * *" is a rule, "- item" is not
    if (/^##(?!#)\s/.test(line)) continue; // "## [x.y.z] - date": the dialog already names the version
    const heading = /^#{3,}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const name = stripInlineMarkdown(heading[1]).trim();
      const known = sections[name.toLowerCase() as ChangelogSection];
      if (out.some((entry) => entry.trim() !== "")) out.push("");
      out.push(`${known ?? name}:`);
      afterHeading = true;
      continue;
    }
    if (afterHeading && line.trim() === "") continue; // heading sits directly on its first item
    afterHeading = false;
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    out.push(bullet
      ? `${bullet[1].length >= 2 ? "  " : ""}• ${stripInlineMarkdown(bullet[2])}`
      : stripInlineMarkdown(line));
  }
  return out.join("\n");
}

/**
 * electron-updater UpdateInfo.releaseNotes (a string, or with fullChangelog an
 * array of { version, note }) -> capped plain text for a native dialog's
 * `detail`. Returns "" when there is nothing to show.
 */
export function formatReleaseNotes(releaseNotes: unknown, options: { language?: AppLanguage; maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? RELEASE_NOTES_MAX_CHARS;
  const sections = (UPDATE_STRINGS[options.language ?? "en"] ?? UPDATE_STRINGS.en).sections;
  // HTML/entity/bidi/control/surrogate cleanup first, then the CHANGELOG
  // Markdown rules. On HTML input the tags are already gone, so the Markdown
  // pass finds nothing of its own to rewrite.
  const toText = (source: string): string => markdownToPlainText(htmlToPlainText(source), sections);
  let raw = "";
  if (typeof releaseNotes === "string") {
    raw = toText(releaseNotes);
  } else if (Array.isArray(releaseNotes)) {
    raw = releaseNotes
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const version = typeof (entry as { version?: unknown }).version === "string" ? htmlToPlainText((entry as { version: string }).version).trim() : "";
        const note = typeof (entry as { note?: unknown }).note === "string" ? toText((entry as { note: string }).note).trim() : "";
        if (!note) return "";
        return version ? `${version}\n${note}` : note;
      })
      .filter((part) => part.length > 0)
      .join("\n\n");
  }
  const text = raw
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // collapse runs of blank lines to one
    .trim();
  if (text.length <= maxChars) return text;
  // Cap LAST, at the last whole line, with "…" on its own line ("\n…" = 2
  // units). A newline boundary never splits a surrogate pair.
  const lineEnd = text.lastIndexOf("\n", maxChars - 2);
  if (lineEnd > 0) {
    const kept = text.slice(0, lineEnd).trimEnd();
    if (kept) return `${kept}\n…`;
  }
  // A single over-long first line: cut inside it.
  let end = maxChars - 1;
  // Never split a surrogate pair: a lone high surrogate renders as U+FFFD.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

function readReleaseNotes(payload: unknown): unknown {
  return payload && typeof payload === "object" ? (payload as { releaseNotes?: unknown }).releaseNotes : undefined;
}

export function createAutoUpdateService(options: AutoUpdateServiceOptions): AutoUpdateService {
  const { updater, dialog, getLanguage, log, setQuitting, stopGateway, onStatusChanged, enabled } = options;
  const scheduler: PeriodicScheduler = options.scheduler ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
  const random = options.random ?? Math.random;

  // Offer-only policy: no background downloads and no silent install on quit.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  let status: UpdaterStatus = { state: "none", version: null, percent: null };
  let lastManual = false;
  // Version the user answered "Later" to. A later BACKGROUND check that finds the
  // same version only refreshes the status (tray line / pet tip), never re-opens
  // the modal; a newer version, or an explicit manual check, offers again.
  let postponedVersion: string | null = null;
  let periodicTimer: unknown = null;
  let periodicStopped = false;
  let installInProgress = false;
  // true only while an offer/install dialog awaits the user's click; a pending
  // dialog quashes re-triggered checks so dialogs never stack.
  let dialogBusy = false;
  let lastLoggedPercent: number | null = null;
  // electron-updater emits "error" AND rejects the triggering promise for the
  // same failure; the last event payload is kept to dedupe promise catches.
  let lastEventError: unknown = null;

  function strings(): UpdateStrings {
    const language = getLanguage();
    return UPDATE_STRINGS[language] ?? UPDATE_STRINGS.en;
  }

  function setState(state: UpdateStateKind, version: string | null = null, percent: number | null = null): UpdaterStatus {
    const previous = status;
    status = { state, version, percent };
    // Notify ONLY on an actual change of the observable status.
    //
    // MEASURED against the built module with a fake updater: electron-updater
    // emits "download-progress" per network chunk, not per percent. 5,000 ticks
    // carrying fractional percents produced 101 throttled log records here (the
    // in-module `lastLoggedPercent` throttle, whose comment promises "~100
    // records per download instead of a record per tick") but 5,000
    // onStatusChanged calls — a 49.5x amplification that defeated that throttle
    // downstream.
    //
    // Production wires `onStatusChanged: () => updateTray()` (src/main/index.ts),
    // and one updateTray() does a synchronous readAppConfig() (readFileSync +
    // JSON.parse), a Menu.buildFromTemplate + setImage/setToolTip/setContextMenu,
    // and one unthrottled `tray_status_update` log line. Measured cost of the
    // amplified part of a single download: 5,000 synchronous config reads
    // (5,339.6 ms total, ~1.07 ms each, on the main thread) and 600,000 bytes of
    // tray_status_update records (120 B x 5,000). app-logger rotates at 5 MB
    // keeping 3 files, so that noise evicts real diagnostics rather than growing
    // unbounded.
    //
    // percent is already rounded by readPercent(), so consecutive ticks inside the
    // same integer percent are genuinely indistinguishable to every consumer:
    // getStatus() still returns the freshly assigned status, and the tray label
    // (getUpdateMenuText) renders only state/version/percent. Suppressing a
    // no-op notification cannot change what any observer can see.
    if (previous.state !== state || previous.version !== version || previous.percent !== percent) {
      onStatusChanged?.({ ...status });
    }
    return { ...status };
  }

  function getStatus(): UpdaterStatus {
    return { ...status };
  }

  function handleError(error: unknown, manual: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    // Downgrade the common dev/unpublished-release noise (ENOENT for
    // app-update.yml on --dir builds, 404 from a non-existent releases.atom
    // feed) to a single quiet info line so the log isn't spammed by huge
    // HTTP response bodies with headers. Genuine failures stay at "error".
    if (message.includes("ENOENT") || message.includes("404")) {
      log("info", "update_check_unavailable", { manual, message: "Update check unavailable: no release feed configured" });
    } else {
      const truncated = message.length > 300 ? message.slice(0, 300) : message;
      log("error", "update_error", { manual, message: truncated });
    }
    setState("error");
    if (manual) {
      const text = strings();
      void dialog.showMessageBox({ type: "error", title: text.errorTitle, message: text.errorMessage, buttons: [text.later], defaultId: 0, cancelId: 0 });
    }
  }

  async function promptDownload(version: string, releaseNotes: unknown): Promise<void> {
    if (dialogBusy) return;
    dialogBusy = true;
    let choice: { response: number };
    try {
      const text = strings();
      const options: UpdaterDialogOptions = {
        type: "info",
        title: text.availableTitle,
        message: text.availableMessage(version),
        buttons: [text.download, text.later],
        defaultId: 0,
        cancelId: 1
      };
      // Plain text only: the native dialog's `detail` never renders markup, and
      // formatReleaseNotes strips every tag before it gets there.
      const notes = formatReleaseNotes(releaseNotes, { language: getLanguage() });
      if (notes) options.detail = `${text.whatsNew}\n${notes}`;
      choice = await dialog.showMessageBox(options);
    } catch (error) {
      // A rejected dialog must not fall through into downloadUpdate(): the user
      // was never asked. Surface it through the shared error path and stop.
      handleError(error, lastManual);
      return;
    } finally {
      // Release before any download starts: the downloaded/ready events that
      // follow must reach promptInstall unimpeded.
      dialogBusy = false;
    }
    if (choice.response !== 0) {
      postponedVersion = version;
      log("info", "update_download_postponed", { version });
      return;
    }
    postponedVersion = null;
    log("info", "update_download_requested", { version });
    lastLoggedPercent = null;
    setState("downloading", version, 0);
    try {
      await updater.downloadUpdate();
    } catch (error) {
      // Usually already handled via the "error" event (same Error object).
      if (error !== lastEventError) handleError(error, lastManual);
    }
  }

  async function promptInstall(version: string): Promise<void> {
    if (dialogBusy) return;
    dialogBusy = true;
    let choice: { response: number };
    try {
      const text = strings();
      choice = await dialog.showMessageBox({
        type: "info",
        title: text.readyTitle,
        message: text.readyMessage(version),
        buttons: [text.restartInstall, text.later],
        defaultId: 0,
        cancelId: 1
      });
    } catch (error) {
      // A rejected dialog must not fall through into installAndQuit(): the user
      // never confirmed the restart. Surface it through the shared error path.
      handleError(error, lastManual);
      return;
    } finally {
      dialogBusy = false;
    }
    if (choice.response !== 0) {
      log("info", "update_install_postponed", { version });
      return;
    }
    await installAndQuit();
  }

  async function installAndQuit(): Promise<void> {
    if (installInProgress) return;
    installInProgress = true;
    log("info", "update_install_requested", { version: status.version });
    const abortInstall = (message: string): void => {
      installInProgress = false;
      log("error", "update_gateway_stop_failed", { message });
      // Coherent user-facing state: the ready install no longer applies.
      setState("error");
    };
    // Graceful ordering invariant: the gateway child must be FULLY stopped
    // (ports freed, never orphaned) before the quitting flag is set or
    // quitAndInstall begins. The quitting flag therefore flips only after the
    // stop is confirmed; while installInProgress is true the before-quit guard
    // blocks user Quit requests, so no quit path can bypass the stop.
    try {
      const stopResult = await stopGateway();
      // GatewayLifecycle.stop() never rejects: a failed stop RESOLVES with a
      // status object whose state is "error". Abort on that shape too.
      if (stopResult && typeof stopResult === "object" && (stopResult as { state?: unknown }).state === "error") {
        const detail = typeof (stopResult as { message?: unknown }).message === "string"
          ? (stopResult as { message: string }).message
          : "gateway child shutdown could not be confirmed";
        abortInstall(detail);
        return;
      }
    } catch (error) {
      abortInstall(error instanceof Error ? error.message : String(error));
      return;
    }
    log("info", "update_gateway_stopped", {});
    setQuitting();
    updater.quitAndInstall(false, true);
  }

  async function checkForUpdates(trigger: { manual: boolean }): Promise<UpdaterStatus> {
    if (!enabled) {
      log("info", "update_check_skipped", { manual: trigger.manual, reason: "not-packaged" });
      return getStatus();
    }
    if (installInProgress || dialogBusy || status.state === "checking" || status.state === "downloading") {
      // Re-entry while a check, download, dialog, or install is in flight:
      // ignore it so prompts never stack, status never flaps, and the manual/
      // background attribution of the in-flight flow is preserved.
      log("info", "update_check_skipped", { manual: trigger.manual, reason: "busy" });
      return getStatus();
    }
    if (status.state === "ready") {
      // A downloaded install is still pending: re-present the cached install
      // offer instead of starting a redundant (and worse, dialog-stacking)
      // network check.
      lastManual = trigger.manual;
      log("info", "update_install_prompted", { manual: trigger.manual, version: status.version });
      void promptInstall(status.version ?? "unknown");
      return getStatus();
    }
    lastManual = trigger.manual;
    setState("checking");
    log("info", "update_checking", { manual: trigger.manual });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      // Usually already handled via the "error" event (same Error object).
      if (error !== lastEventError) handleError(error, trigger.manual);
    }
    return getStatus();
  }

  updater.on("checking-for-update", () => {
    setState("checking");
  });

  updater.on("update-available", (payload) => {
    const version = readVersion(payload) ?? "unknown";
    setState("available", version);
    log("info", "update_available", { version, manual: lastManual });
    if (!lastManual && version === postponedVersion) {
      // The user already said "Later" to exactly this version: a background
      // re-check only refreshes the status above (tray line, pet tip).
      log("info", "update_offer_suppressed", { version, reason: "postponed" });
      return;
    }
    void promptDownload(version, readReleaseNotes(payload));
  });

  updater.on("update-not-available", () => {
    setState("upToDate");
    log("info", "update_not_available", { manual: lastManual });
    if (lastManual) {
      const text = strings();
      void dialog.showMessageBox({ type: "info", title: text.upToDateTitle, message: text.upToDateMessage, buttons: [text.later], defaultId: 0, cancelId: 0 });
    }
  });

  updater.on("download-progress", (payload) => {
    const percent = readPercent(payload);
    setState("downloading", status.version, percent ?? 0);
    // Transient progress: one log record per integer-percent change keeps
    // ~100 records per download instead of a record per electron-updater tick.
    if (percent !== lastLoggedPercent) {
      lastLoggedPercent = percent;
      log("info", "update_download_progress", { percent });
    }
  });

  updater.on("update-downloaded", (payload) => {
    const version = readVersion(payload) ?? status.version ?? "unknown";
    setState("ready", version);
    log("info", "update_downloaded", { version, manual: lastManual });
    void promptInstall(version);
  });

  updater.on("error", (error) => {
    lastEventError = error;
    handleError(error, lastManual);
  });

  function nextPeriodicDelay(): number {
    // Uniform offset in [-JITTER, +JITTER] so many installs do not poll in lockstep.
    return PERIODIC_CHECK_INTERVAL_MS + Math.round((random() * 2 - 1) * PERIODIC_CHECK_JITTER_MS);
  }

  function schedulePeriodicCheck(): void {
    if (periodicStopped) return;
    const handle = scheduler.setTimeout(() => {
      periodicTimer = null;
      void runPeriodicCheck();
    }, nextPeriodicDelay());
    // Never keep the process alive just for the update poll.
    (handle as { unref?: () => void } | null)?.unref?.();
    periodicTimer = handle;
  }

  async function runPeriodicCheck(): Promise<void> {
    try {
      // An open dialog, a download, a pending install (downloaded "ready" state
      // or install in flight) or a running check: skip this round entirely.
      // "ready" is excluded here on purpose: checkForUpdates would re-open the
      // install dialog, which a background timer must not do.
      if (installInProgress || dialogBusy || status.state === "checking" || status.state === "downloading" || status.state === "ready") {
        log("info", "update_periodic_check_skipped", { reason: "busy", state: status.state });
        return;
      }
      await checkForUpdates({ manual: false });
    } catch (error) {
      log("error", "update_periodic_check_failed", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      schedulePeriodicCheck();
    }
  }

  function startPeriodicChecks(): void {
    if (!enabled) {
      log("info", "update_periodic_check_disabled", { reason: "not-packaged" });
      return;
    }
    if (periodicTimer !== null || periodicStopped) return;
    schedulePeriodicCheck();
  }

  function stopPeriodicChecks(): void {
    periodicStopped = true;
    if (periodicTimer !== null) {
      scheduler.clearTimeout(periodicTimer);
      periodicTimer = null;
    }
  }

  return { getStatus, checkForUpdates, installAndQuit, isInstalling: () => installInProgress, startPeriodicChecks, stopPeriodicChecks };
}
