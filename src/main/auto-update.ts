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
}

export interface AutoUpdateService {
  getStatus(): UpdaterStatus;
  checkForUpdates(options: { manual: boolean }): Promise<UpdaterStatus>;
  /** Stops the gateway child, then quitAndInstall(isSilent=false, isForceRunAfter=true). */
  installAndQuit(): Promise<void>;
  /** true between the install request and the quitAndInstall handoff (or abort). */
  isInstalling(): boolean;
}

interface UpdateStrings {
  checkMenu: string; // tray menu item
  stateText: Record<Exclude<UpdateStateKind, "none">, string>; // tray status line + log context
  availableTitle: string;
  availableMessage(version: string): string;
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

export function createAutoUpdateService(options: AutoUpdateServiceOptions): AutoUpdateService {
  const { updater, dialog, getLanguage, log, setQuitting, stopGateway, onStatusChanged, enabled } = options;

  // Offer-only policy: no background downloads and no silent install on quit.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  let status: UpdaterStatus = { state: "none", version: null, percent: null };
  let lastManual = false;
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
    status = { state, version, percent };
    onStatusChanged?.({ ...status });
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

  async function promptDownload(version: string): Promise<void> {
    if (dialogBusy) return;
    dialogBusy = true;
    let choice: { response: number };
    try {
      const text = strings();
      choice = await dialog.showMessageBox({
        type: "info",
        title: text.availableTitle,
        message: text.availableMessage(version),
        buttons: [text.download, text.later],
        defaultId: 0,
        cancelId: 1
      });
    } finally {
      // Release before any download starts: the downloaded/ready events that
      // follow must reach promptInstall unimpeded.
      dialogBusy = false;
    }
    if (choice.response !== 0) {
      log("info", "update_download_postponed", { version });
      return;
    }
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
    void promptDownload(version);
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

  return { getStatus, checkForUpdates, installAndQuit, isInstalling: () => installInProgress };
}
