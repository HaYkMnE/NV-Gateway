import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, session, Tray } from "electron";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { autoUpdater } from "electron-updater";
import { createAutoUpdateService, getUpdateMenuText, type AutoUpdateService, type UpdaterStatus } from "./auto-update";
import { initAppLogger, logAppEvent } from "./app-logger";
import { GatewayLifecycle, type GatewayStatus } from "./gateway-lifecycle";
import { createFatalShutdown } from "./fatal-shutdown";
import { ensureGatewayRuntime, readAppConfig, readGatewayPort, writeAppConfig, writeGatewayPort, type AppLanguage, type GatewayRuntimePaths } from "./gateway-runtime";
import { checkPorts, findFreePort } from "./port-scanner";
import { configureSingleInstance } from "./single-instance";
import { validateIpcSender, validators } from "./ipc-security";
import { requestAdmin } from "./admin-client";
import { createAdminIpcDispatcher } from "./admin-ipc";
import { createAppConfigUpdateHandler, type AppConfigUpdate } from "./app-config-ipc";
import { createModelsHandlers } from "./models-ipc";
import { wrapIpcHandler as wrapIpcHandlerWithLogError } from "./ipc-handler";
import { createSafeStorageAdapter, SecureStore } from "./secure-state";
import { createRuntimeAclProtector } from "./windows-acl";
import { installElectronSecurity } from "./electron-security";
import { redact, setRuntimeSecrets } from "./redaction";
import { mergeChildKeyProjection } from "./state-ownership";
import { runExplicitLegacyNvidiaMigration } from "./final-migration-workflow";
import { startMainProcess } from "./main-process-startup";
import { validateFixedLegacyNvidiaSource } from "./legacy-nvidia-migration";
import { acquireLegacyMigrationExclusionLock } from "./legacy-migration-exclusion";
import { createControlledStartupShutdown } from "./controlled-startup-shutdown";
import { handleBeforeQuit } from "./before-quit-guard";
import { createMigrationPhaseAudit } from "./migration-phase-audit";
import { createTrayIconCache } from "./tray-icons";
import { createWindowCloseGuard } from "./window-close-guard";
import { buildApplicationMenu, buildContextMenu, getMenuStrings } from "./app-menu";
import { saveFeedback, openGitHubIssue, type FeedbackData } from "./feedback-service";
import { openExternalUrl, REPO_URL } from "./external-open";
import { exportDiagnostic } from "./diagnostic-export";
import { init as initErrorReporter, logError, getErrorCount, previewErrors, sendErrors, type ErrorEntry } from "./error-reporter";

// Align the Electron app name with electron-builder productName so that
// app.getPath("userData") resolves to %APPDATA%/NV-Gateway, not the
// package.json "name" field.  Must be called before app.whenReady().
let mainWindow: BrowserWindow | null;
/** True once startNormal() has built the first window, so ensureMainWindow only ever REBUILDS. */
let windowWasCreated = false;
let tray: Tray | null = null;
let gatewayLifecycle: GatewayLifecycle | null = null;
let gatewayRuntime: GatewayRuntimePaths | null = null;
let updaterService: AutoUpdateService | null = null;
let isQuiting = false;
let credentials: { gatewayToken: string; adminToken: string } | null = null;
let secureStore: SecureStore | null = null;
let secureState: any = null;
let pendingMigrationState: Record<string, unknown> | null = null;
const migrationPhaseAudit = createMigrationPhaseAudit();

// Error reporter is a regular TypeScript module (error-reporter.ts) compiled
// into the CommonJS main bundle alongside the rest of src/main; it is imported
// statically above (init as initErrorReporter, logError, getErrorCount,
// previewErrors, sendErrors).

function getAboutInfo(): {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  proxyPort: number;
  adminPort: number;
  repoUrl: string;
} {
  let proxyPort = 12000;
  if (gatewayRuntime) {
    try {
      proxyPort = readGatewayPort(gatewayRuntime.configPath);
    } catch {
      // Fall back to the default gateway port if the config can't be read.
    }
  }
  return {
    appVersion: app.getVersion() || "0.0.0",
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    proxyPort,
    adminPort: proxyPort + 1,
    repoUrl: REPO_URL
  };
}
function migrationPhaseAuditPath(): string {
  return path.join(app.getPath("appData"), "NV-Gateway", "logs", "migration-phase.jsonl");
}
function getGatewayServerPath(): string {
  // PACKAGED: inside app.asar (app.getAppPath() IS the archive), so the engine
  // is covered by ASAR integrity validation. It used to live in
  // process.resourcesPath/gateway, which is OUTSIDE the archive and therefore
  // outside the integrity envelope — a substituted engine ran unnoticed, and the
  // engine is handed the user's NVIDIA keys in the clear over IPC.
  // Electron patches fs and the module loaders with asar support in both the main
  // process and ELECTRON_RUN_AS_NODE children, so the existsSync check below and
  // spawning this path as the child's entry script both work unchanged.
  // DEV: unchanged — the readable sources, so `npm run dev` is unaffected.
  return app.isPackaged
    ? path.join(app.getAppPath(), "build", "gateway", "server.mjs")
    : path.join(app.getAppPath(), "src", "gateway", "server.mjs");
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway child model-limits delivery (bound IPC channel).
//
// The packaged app cannot rely on the child resolving config.json from disk
// (no repo-relative example, env paths not guaranteed across deployed builds),
// so main attaches a sanitized, NUMBERS-ONLY copy of the operator's
// config.json `modelLimits` to the gateway initial state. The field rides the
// existing challenge-bound `state:init` channel into server.mjs, which hands
// it to model-limits.mjs via setModelLimits(). No credentials, no paths —
// spawn argv/env remain untouched (production-security-wiring tests). The
// on-disk keys.json stays pristine: injection happens in-memory only, after
// secureStore.persist().
// ─────────────────────────────────────────────────────────────────────────────
const MAX_MODEL_LIMIT_ENTRIES = 512;
const MAX_MODEL_LIMIT_KEY_LENGTH = 256;

function isValidModelLimitEntry(entry: unknown): entry is { context: number; output: number } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const candidate = entry as Record<string, unknown>;
  return typeof candidate.context === "number" && Number.isSafeInteger(candidate.context) && candidate.context > 0
    && typeof candidate.output === "number" && Number.isSafeInteger(candidate.output) && candidate.output > 0;
}

function readGatewayModelLimits(configPath: string): Record<string, { context: number; output: number }> {
  const sanitized: Record<string, { context: number; output: number }> = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw.codePointAt(0) === 0xFEFF ? raw.slice(1) : raw) as Record<string, unknown> | null;
    const limits = parsed?.modelLimits;
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) return sanitized;
    for (const [key, entry] of Object.entries(limits as Record<string, unknown>)) {
      if (Object.keys(sanitized).length >= MAX_MODEL_LIMIT_ENTRIES) break;
      if (typeof key !== "string" || key.length === 0 || key.length > MAX_MODEL_LIMIT_KEY_LENGTH) continue;
      if (isValidModelLimitEntry(entry)) sanitized[key] = { context: entry.context, output: entry.output };
    }
  } catch {
    // Config absent or malformed — inject nothing; the gateway falls back internally.
  }
  return sanitized;
}

function withGatewayModelLimits(state: unknown): unknown {
  if (!gatewayRuntime || typeof state !== "object" || state === null || Array.isArray(state)) return state;
  const limits = readGatewayModelLimits(gatewayRuntime.configPath);
  if (Object.keys(limits).length === 0) return state;
  return { ...(state as Record<string, unknown>), modelLimits: limits };
}

function initializeGatewayLifecycle(): GatewayLifecycle {
  const acl = createRuntimeAclProtector();
  gatewayRuntime = ensureGatewayRuntime(app.getPath("userData"), acl);
  secureStore = new SecureStore(gatewayRuntime.statePath, createSafeStorageAdapter(safeStorage), acl.protectFile);
  secureState = secureStore.initialize();
  credentials = secureState.credentials && typeof secureState.credentials.gatewayToken === "string" && typeof secureState.credentials.adminToken === "string"
    ? secureState.credentials : { gatewayToken: crypto.randomBytes(32).toString("base64url"), adminToken: crypto.randomBytes(32).toString("base64url") };
  secureState.credentials = credentials;
  setRuntimeSecrets([credentials.gatewayToken, credentials.adminToken]);
  secureStore.persist(secureState);
  const serverPath = getGatewayServerPath();
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Gateway runtime is missing: ${serverPath}`);
  }

  // Initialize main-process logger
  initAppLogger(gatewayRuntime.appLogPath, acl.protectFile);
  migrationPhaseAudit.setFilePath(path.join(path.dirname(gatewayRuntime.appLogPath), "migration-phase.jsonl"));

  gatewayLifecycle = new GatewayLifecycle({
    executablePath: process.execPath,
    runtimePaths: gatewayRuntime,
    serverPath,
    spawnChild: spawn,
    stdioLogPath: gatewayRuntime.stdioLogPath,
    workingDirectory: app.getPath("userData"),
    onStatusChange: updateTray,
    onLifecycleEvent: (event: string, data: Record<string, unknown>) => {
      logAppEvent("info", event, data);
      // Forward gateway lifecycle errors to the structured error reporter so
      // they appear in errors.log and the operator can bundle/preview/send them.
      if (event === "gateway_lifecycle" && data.state === "error") {
        const message = typeof data.message === "string" ? data.message : "Gateway lifecycle error";
        const stack = typeof data.stack === "string" ? data.stack : undefined;
        logError({ type: "gateway", message, ...(stack ? { stack } : {}), source: "gateway" });
      }
    },
    initialState: withGatewayModelLimits(secureState),
    persistState: (projection) => {
      try {
        if (pendingMigrationState) {
          pendingMigrationState = mergeChildKeyProjection(pendingMigrationState, projection);
          return;
        }
        secureState = mergeChildKeyProjection(secureState, projection);
        secureStore?.persist(secureState);
      } catch (error) {
        // Defense-in-depth: never let a state-persist failure (e.g. a delayed ACL
        // protector raise, a write error) crash the Electron main process. The
        // tolerant protector in windows-acl.ts is the primary shield; this catches
        // any remaining sync throw in mergeChildKeyProjection or secureStore.persist.
        logAppEvent("error", "persist_state_failed", { message: error instanceof Error ? error.message : String(error) });
      }
    },
    protectFile: acl.protectFile
    ,onPreparedChildSpawn: (phase, childPid) => {
      migrationPhaseAudit.emit(phase === "requested" ? "child_spawn_requested" : "child_spawned", { pid: process.pid, childPid });
    }
  });
  return gatewayLifecycle;
}

async function startGateway(): Promise<GatewayStatus> {
  if (!gatewayRuntime || !gatewayLifecycle) {
    throw new Error("Gateway runtime is not initialized.");
  }
  const port = readGatewayPort(gatewayRuntime.configPath);
  logAppEvent("info", "gateway_start_request", { port });
  return gatewayLifecycle.start(port);
}

async function retryGateway(port?: number): Promise<GatewayStatus> {
  if (!gatewayRuntime || !gatewayLifecycle) {
    throw new Error("Gateway runtime is not initialized.");
  }
  const requestedPort = port ?? readGatewayPort(gatewayRuntime.configPath);
  const previousPort = gatewayLifecycle.getStatus().port ?? null;
  logAppEvent("info", "gateway_retry_request", { requestedPort, previousPort });
  const status = await gatewayLifecycle.retry(requestedPort);
  if (status.state === "running") {
    writeGatewayPort(gatewayRuntime.configPath, requestedPort, createRuntimeAclProtector().protectFile);
    logAppEvent("info", "gateway_port_written", { port: requestedPort });
  }
  return status;
}

function trayAssetsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "assets")
    : path.join(app.getAppPath(), "src", "renderer", "assets");
}

function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "assets", "icon.png")
    : path.join(app.getAppPath(), "build", "assets", "icon.png");
}

const trayIcons = createTrayIconCache({ resolveAssetsDir: trayAssetsDir, nativeImage });

// Owns the "announce the first hide once" state for this process.
const handleWindowClose = createWindowCloseGuard();

function createTrayIcon(state?: string): Electron.NativeImage {
  return trayIcons(state) as Electron.NativeImage;
}

// Returns a window that is safe to call, rebuilding it if it was destroyed.
//
// `mainWindow?.show()` guards NULL but NOT a DESTROYED native object. MEASURED in
// a real launched app (tray alive, window destroyed): a tray click threw
// "TypeError: Object has been destroyed". That throw happens inside an Electron
// event callback, so it reaches process.on("uncaughtException") ->
// fatalShutdownAndExit -> process.exit(1) — the raw exit that skips before-quit ->
// cleanupAndQuit -> gatewayLifecycle.stop(), i.e. the ipc shutdown that flushes
// keys.json and the model-key affinity cache. window-all-closed deliberately
// early-returns while a tray exists, so this state is a LIVE trayed process with
// no window: the same "invisible app" failure class the tray fix addresses.
function ensureMainWindow(): BrowserWindow | null {
  const usable = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (usable) return usable;
  // Only ever REBUILD a window that existed and died. Never create the FIRST
  // window here: startNormal() owns initial creation, and a second-instance
  // arriving in that gap would otherwise leave two windows. And never resurrect
  // one during teardown, which would only have to be closed again.
  if (!windowWasCreated || isQuiting) return null;
  createWindow();
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** The one way to bring the app back into view, from the tray, menu or a second instance. */
function revealMainWindow(): void {
  const window = ensureMainWindow();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// UI language for main-process surfaces (tray menu, update dialogs) comes from
// the persisted config.json "language" field; the renderer toggles the same
// field through set-app-config, so both stay in sync.
function currentLanguage(): AppLanguage {
  try {
    return gatewayRuntime ? readAppConfig(gatewayRuntime.configPath).language : "en";
  } catch {
    return "en";
  }
}

function updaterTrayMenuItems(): Electron.MenuItemConstructorOptions[] {
  if (!updaterService) return [];
  const menuText = getUpdateMenuText(updaterService.getStatus(), currentLanguage());
  return [
    { type: "separator" },
    {
      label: menuText.checkLabel,
      enabled: menuText.checkEnabled,
      click: () => { void updaterService?.checkForUpdates({ manual: true }); }
    },
    ...(menuText.statusLabel ? [{ label: menuText.statusLabel, enabled: false }] as Electron.MenuItemConstructorOptions[] : [])
  ];
}

function updateAppMenu(): void {
  const lang = currentLanguage();
  const menu = buildApplicationMenu({
    language: lang,
    onCheckUpdates: () => {
      if (updaterService) void updaterService.checkForUpdates({ manual: true });
    },
    onOpenSettings: () => {
      revealMainWindow();
    }
  });
  Menu.setApplicationMenu(menu);
}

function updateTray(status: GatewayStatus = gatewayLifecycle?.getStatus() ?? { state: "stopped" }): void {
  if (!tray) return;
  const lang = currentLanguage();
  const menuStr = getMenuStrings(lang);
  tray.setImage(createTrayIcon(status.state));
  const stateKey = `gateway_${status.state}` as keyof typeof menuStr;
  const stateLabel = (menuStr[stateKey] as string) ?? (status.state[0].toUpperCase() + status.state.slice(1));
  const details = status.port ? ` (port ${status.port})` : "";
  tray.setToolTip(`NVIDIA Gateway — ${stateLabel}${details}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${menuStr.status_label}: ${stateLabel}${details}`, enabled: false },
    ...(status.state === "error" && status.message ? [{ label: status.message, enabled: false }] : []),
    { type: "separator" },
    {
      label: menuStr.show_app,
      click: () => revealMainWindow()
    },
    {
      label: menuStr.retry_gateway,
      enabled: status.state !== "starting",
      click: () => { void retryGateway(); }
    },
    ...updaterTrayMenuItems(),
    {
      label: menuStr.quit,
      click: () => app.quit()
    }
  ]));

  logAppEvent("info", "tray_status_update", { state: status.state, port: status.port ?? null });
}

function createTray(): void {
  // A throwing Tray constructor used to escape into the bare `void
  // startMainProcess(...)` call below, surface as an unhandledRejection, and be
  // turned into process.exit(1) by fatalShutdownAndExit — a hard quit with the
  // cause buried. Contain it here instead: the app stays usable, `tray` stays
  // null so handleWindowClose degrades to a real close, and the reason is
  // logged rather than silently swallowed.
  try {
    tray = new Tray(createTrayIcon(gatewayLifecycle?.getStatus().state));
    logAppEvent("info", "tray_created", {});
    updateTray();
    tray.on("click", () => revealMainWindow());
  } catch (error) {
    tray = null;
    logAppEvent("error", "tray_create_failed", {
      message: error instanceof Error ? error.message : String(error),
      outcome: "window_close_will_quit_instead_of_hiding"
    });
  }
}

// Tells the user, once, that closing the window did not close the app. This is
// the other half of the reported defect: Windows 11 files new tray icons in the
// hidden overflow flyout by default, and no supported API can promote them, so
// without this notice the first X press looks exactly like a crash.
function notifyHiddenToTray(): void {
  if (!tray) return;
  const menuStr = getMenuStrings(currentLanguage());
  tray.displayBalloon({
    title: menuStr.hidden_to_tray_title,
    content: menuStr.hidden_to_tray_body,
    iconType: "info"
  });
  logAppEvent("info", "window_hidden_to_tray_notice", {});
}

function createWindow(): void {
  windowWasCreated = true;
  const windowIcon = appIconPath();
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0D0D0D",
    ...(fs.existsSync(windowIcon) ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  if (process.env.NODE_ENV === "development" || !app.isPackaged) {
    void mainWindow.loadURL("http://localhost:5173");
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
  const exactUrl = app.isPackaged ? new URL(`file://${path.join(__dirname, "../../renderer/index.html")}`).href : "http://localhost:5173/";
  installElectronSecurity({ targetSession: mainWindow.webContents.session, contents: mainWindow.webContents, exactUrl });

  updateAppMenu();

  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow) return;
    buildContextMenu(currentLanguage(), params).popup({ window: mainWindow });
  });

  mainWindow.on("close", (event) => {
    handleWindowClose({
      event,
      isQuitting: () => isQuiting,
      // The decisive condition. Hiding is only safe when there is a tray icon to
      // restore from; otherwise the close proceeds and window-all-closed quits.
      hasTray: () => tray !== null,
      hide: () => mainWindow?.hide(),
      onFirstHide: notifyHiddenToTray,
      log: logAppEvent
    });
  });

  // Drop the pointer as soon as the native object dies. Without this the
  // destroyed window stays truthy, and `mainWindow?.show()` (optional chaining
  // guards null, NOT destroyed) throws "Object has been destroyed" from a tray
  // click — measured in a real launched app — which escalates through
  // uncaughtException to a raw process.exit(1) that skips the keys.json flush.
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("before-quit", (event) => {
  handleBeforeQuit({
    event,
    isQuitting: () => isQuiting,
    setQuitting: () => { isQuiting = true; },
    isControlled: () => controlledStartupShutdown.isControlled(),
    // An update install is in flight (gateway child stop -> quitAndInstall):
    // ignore Quit requests so no quit path can bypass the stop ordering.
    isBlocked: () => updaterService?.isInstalling() ?? false,
    log: logAppEvent,
    cleanupAndQuit
  });
});

app.on("will-quit", () => {
  // Last-resort: if the gateway child is still alive when Electron is
  // about to exit, force-kill it synchronously so the OS does not leave
  // an orphaned process holding the port.
  if (gatewayLifecycle) {
    try {
      void gatewayLifecycle.stop();
    } catch {
      // Best-effort
    }
  }
});

async function cleanupAndQuit(): Promise<void> {
  try {
    await gatewayLifecycle?.stop();
    logAppEvent("info", "app_shutdown_complete", {});
  } catch (err) {
    logAppEvent("error", "app_shutdown_error", {
      message: err instanceof Error ? err.message : String(err)
    });
  }
  app.quit();
}

const fatalShutdownAndExit = createFatalShutdown({
  stop: async () => { await gatewayLifecycle?.stop(); },
  exit: (code) => process.exit(code),
  deadlineMs: 5_000,
  onFatalShutdown: () => migrationPhaseAudit.emit("fatal_shutdown", { pid: process.pid })
});

const controlledStartupShutdown = createControlledStartupShutdown({
  setControlled: () => {},
  setExitCode: (exitCode) => { process.exitCode = exitCode; },
  quit: () => app.quit()
});

// Crash recovery: ensure the gateway child is cleaned up if the Electron
// main process crashes unexpectedly.  Without these handlers an uncaught
// exception would leave an orphaned child holding the port.
process.on("uncaughtException", (err) => {
  logAppEvent("error", "uncaught_exception", {
    message: err.message,
    stack: err.stack ?? null
  });
  void fatalShutdownAndExit();
});

process.on("unhandledRejection", (reason) => {
  logAppEvent("error", "unhandled_rejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? (reason.stack ?? null) : null
  });
  void fatalShutdownAndExit();
});

// This chooses only the fixed audit target; the file itself is created only
// when the explicit command emits a phase record.
migrationPhaseAudit.setFilePath(migrationPhaseAuditPath());

void startMainProcess({
  argv: process.argv,
  app,
  // ensureMainWindow(), not the raw pointer: single-instance.ts calls
  // isMinimized()/show()/focus() unguarded, which throws on a destroyed window.
  configureSingleInstance: () => configureSingleInstance(app, () => ensureMainWindow()),
  acquireLegacyMigrationLock: () => acquireLegacyMigrationExclusionLock(app.getPath("userData")),
  createApplicationStartupOptions: () => ({
    validateLegacySource: validateFixedLegacyNvidiaSource,
    initializeLifecycle: initializeGatewayLifecycle,
    runMigration: async (source) => {
      if (!gatewayRuntime || !secureStore || !secureState || !gatewayLifecycle) throw new Error("MIGRATION_RUNTIME_UNAVAILABLE");
      const acl = createRuntimeAclProtector();
      const migration = await runExplicitLegacyNvidiaMigration({ runtime: gatewayRuntime, store: secureStore, state: secureState, protectFile: acl.protectFile, source, lifecycle: {
        startPrepared: async (state, port) => {
          pendingMigrationState = structuredClone(state);
          const status = await gatewayLifecycle.startPrepared(withGatewayModelLimits(state), port);
          if (status.state !== "running") pendingMigrationState = null;
          return status;
        },
        stopPrepared: async () => {
          const status = await gatewayLifecycle.stopPrepared();
          pendingMigrationState = null;
          return status;
        },
        commitPreparedState: (state) => {
          const committed = pendingMigrationState ? { ...state, keys: pendingMigrationState.keys } : state;
          pendingMigrationState = null;
          secureState = committed;
          return committed;
        }
      } });
      secureState = migration.state;
      credentials = secureState.credentials && typeof secureState.credentials.gatewayToken === "string" && typeof secureState.credentials.adminToken === "string"
        ? secureState.credentials as { gatewayToken: string; adminToken: string }
        : null;
      if (!credentials) throw new Error("MIGRATION_CREDENTIALS_UNAVAILABLE");
      setRuntimeSecrets([credentials.gatewayToken, credentials.adminToken]);
      gatewayLifecycle.replaceInitialState(withGatewayModelLimits(secureState));
      return migration;
    },
    startNormal: async () => {
      logAppEvent("info", "app_start", {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node
      });
      // Initialize the error reporter process hooks before the gateway starts so
      // gateway/IPC errors are captured from the first moment.
      try {
        initErrorReporter();
      } catch (error) {
        logAppEvent("error", "error_reporter_init_failed", { message: error instanceof Error ? error.message : String(error) });
      }
      createWindow();
      createTray();
      updaterService = createAutoUpdateService({
        updater: autoUpdater,
        dialog: {
          showMessageBox: (options) => {
            const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
            return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
          }
        },
        getLanguage: currentLanguage,
        log: logAppEvent,
        setQuitting: () => { isQuiting = true; },
        // The gateway child must fully exit (ports freed, never orphaned)
        // before quitAndInstall runs — same stop path as cleanupAndQuit.
        stopGateway: async () => { await gatewayLifecycle?.stop(); },
        onStatusChanged: () => updateTray(),
        enabled: app.isPackaged
      });
      updateTray();
      if (app.isPackaged) {
        // Silent background check at startup: no update -> log only; a new
        // version shows the download offer dialog; errors stay in the log.
        // ENOENT (app-update.yml missing on --dir builds) is swallowed here;
        // the auto-updater already reports it through the "error" event,
        // which handleError downgrades to a quiet info line.
        void updaterService.checkForUpdates({ manual: false }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("ENOENT")) {
            // Already logged quietly via the "error" event handler.
            return;
          }
          logAppEvent("error", "update_initial_check_failed", { message: message.length > 300 ? message.slice(0, 300) : message });
        });
      }
      // Auto-start gateway if configured
      if (gatewayRuntime) {
        const config = readAppConfig(gatewayRuntime.configPath);
        if (config.autoStartGateway !== false) {
          await gatewayLifecycle.start(config.gatewayPort);
        }
      }
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    },
    log: (_level, event, data) => {
      // The app logger is intentionally unavailable before source validation, so
      // this writes straight to stderr. It must still pass through redact() like
      // every other path that leaves the app: the local gatewayToken/adminToken
      // are unprefixed base64url, so nothing in their VALUE marks them secret --
      // they are caught only by field name or via setRuntimeSecrets. A raw
      // JSON.stringify here defeated both and leaked them verbatim.
      console.error(JSON.stringify(redact({ event, ...data })));
    },
    audit: migrationPhaseAudit,
  }),
  close: (exitCode) => {
    controlledStartupShutdown.close(exitCode);
  }
});

app.on("window-all-closed", () => {
  // Normally a no-op: the application remains available from the tray.
  //
  // With no tray there is neither a way back nor a way out, which is the state
  // the bug report describes — a live, invisible, unquittable process. Quit for
  // real instead, and do it through app.quit() so before-quit -> handleBeforeQuit
  // -> cleanupAndQuit -> gatewayLifecycle.stop() still runs. That is the IPC
  // shutdown path that flushes keys.json and the model-key affinity cache, so
  // this escape hatch cannot cost the user their key state. It must NEVER be a
  // raw process-level exit here: that would skip the flush entirely.
  if (tray) return;
  logAppEvent("warn", "window_all_closed_without_tray", { outcome: "quit" });
  app.quit();
});

// ---- IPC handlers with error logging ----

function wrapIpcHandler<T extends (...args: unknown[]) => unknown>(
  name: string,
  handler: T
): T {
  return wrapIpcHandlerWithLogError(name, handler, (entry) => {
    // Named explicitly rather than spread: a spread hides which field names reach
    // the log, keeping them out of the project's logged-field-name census and so
    // unprotected-by-inspection. These three are the whole IpcErrorLog shape.
    logAppEvent("error", "ipc_handler_error", { handler: entry.handler, message: entry.message, stack: entry.stack });
  });
}

function allowedRendererUrls(): string[] {
  return app.isPackaged ? [new URL(`file://${path.join(__dirname, "../../renderer/index.html")}`).href] : ["http://localhost:5173/"];
}

function adminCredentials(): { port: number; token: string } {
  if (!gatewayRuntime) throw new Error("Gateway runtime is not initialized.");
  if (!credentials) throw new Error("Admin credential is unavailable.");
  return { port: readGatewayPort(gatewayRuntime.configPath), token: credentials.adminToken };
}
const admin = createAdminIpcDispatcher({
  getStatus: () => gatewayLifecycle?.getStatus() ?? { state: "stopped" },
  isStopping: () => gatewayLifecycle?.isStopping() ?? false,
  getCredentials: adminCredentials,
  requestAdmin
});

const updateAppConfig = createAppConfigUpdateHandler({
  getConfigPath: () => {
    if (!gatewayRuntime) throw new Error("Gateway runtime is not initialized.");
    return gatewayRuntime.configPath;
  },
  writeAppConfig,
  protectFile: createRuntimeAclProtector().protectFile,
  validateBoolean: validators.boolean,
  getStatus: () => gatewayLifecycle?.getStatus() ?? { state: "stopped" }
});

// Upper bound for a renderer clipboard write. The largest legitimate payload is
// a generated client-config block or a cURL snippet (Endpoint/Models views), all
// far below this; the cap simply stops a renderer from pushing arbitrary volume
// into the OS clipboard.
const CLIPBOARD_TEXT_MAX = 1_000_000;

// Validation mirrors the style of validators in ipc-security.ts: assert the type,
// bound the size, throw a generic Error. The value itself is NEVER echoed into
// the message -- it can be an NVIDIA API key or the local gateway token.
function assertClipboardText(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error("Invalid clipboard text.");
  if (value.length > CLIPBOARD_TEXT_MAX) throw new Error("Invalid clipboard text.");
}

function secure<T extends (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown>(handler: T): T {
  return ((event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => { if (!mainWindow) throw new Error("Window unavailable."); validateIpcSender(event, mainWindow.webContents, allowedRendererUrls()); return handler(event, ...args); }) as T;
}

ipcMain.handle("get-app-version", wrapIpcHandler("get-app-version", secure(() => app.getVersion())));
ipcMain.handle("check-ports", wrapIpcHandler("check-ports", secure(async (_event, ports: number[]) => { validators.ports(ports); return checkPorts(ports); })));
ipcMain.handle("find-free-port", wrapIpcHandler("find-free-port", secure(async () => findFreePort())));
ipcMain.handle("get-gateway-port", wrapIpcHandler("get-gateway-port", secure(() => {
  if (!gatewayRuntime) throw new Error("Gateway runtime is not initialized.");
  return readGatewayPort(gatewayRuntime.configPath);
})));
ipcMain.handle("get-gateway-status", wrapIpcHandler("get-gateway-status", secure(() => gatewayLifecycle?.getStatus() ?? { state: "stopped" })));
ipcMain.handle("get-runtime-state", wrapIpcHandler("get-runtime-state", secure(() => {
  if (!gatewayRuntime) throw new Error("Gateway runtime is not initialized.");
  return { ...readAppConfig(gatewayRuntime.configPath), status: gatewayLifecycle?.getStatus() ?? { state: "stopped" }, version: app.getVersion(), autoLaunch: app.getLoginItemSettings().openAtLogin };
})));
ipcMain.handle("set-app-config", wrapIpcHandler("set-app-config", secure((_event, update: { language?: string; setupComplete?: boolean; performanceMode?: string; autoStartGateway?: boolean }) => {
  const result = updateAppConfig(update as AppConfigUpdate);
  if (update.language) {
    updateTray();
    updateAppMenu();
  }
  return result;
})));
ipcMain.handle("retry-gateway", wrapIpcHandler("retry-gateway", secure(async (_event, port?: number) => { if (port !== undefined) validators.port(port); return retryGateway(port); })));
ipcMain.handle("set-gateway-port", wrapIpcHandler("set-gateway-port", secure(async (_event, port: number) => {
  validators.port(port);
  const scan = await checkPorts([port, port + 1]);
  const current = gatewayLifecycle?.getStatus();
  if ((scan[port] || scan[port + 1]) && !(current?.state === "running" && current.port === port)) return { state: "error", code: "PORT_IN_USE", port };
  logAppEvent("info", "port_configuration_change", { newPort: port });
  return retryGateway(port);
})));

ipcMain.handle("toggle-auto-launch", wrapIpcHandler("toggle-auto-launch", secure((_event, enable: boolean) => {
  validators.boolean(enable);
  app.setLoginItemSettings({ openAtLogin: enable, path: app.getPath("exe") });
  logAppEvent("info", "auto_launch_toggle", { enabled: enable });
  return enable;
})));
ipcMain.handle("get-auto-launch", wrapIpcHandler("get-auto-launch", secure(() => app.getLoginItemSettings().openAtLogin)));
const UPDATE_STATUS_FALLBACK: UpdaterStatus = { state: "none", version: null, percent: null };
ipcMain.handle("get-update-status", wrapIpcHandler("get-update-status", secure(() => updaterService?.getStatus() ?? { ...UPDATE_STATUS_FALLBACK })));
ipcMain.handle("check-for-updates", wrapIpcHandler("check-for-updates", secure(() => {
  // Manual check (tray menu or Settings view): errors also surface as dialogs.
  if (updaterService) void updaterService.checkForUpdates({ manual: true });
  return updaterService?.getStatus() ?? { ...UPDATE_STATUS_FALLBACK };
})));
ipcMain.handle("admin-list-keys", wrapIpcHandler("admin-list-keys", secure(() => admin({ method: "GET", path: "/admin/keys" }))));
ipcMain.handle("admin-add-key", wrapIpcHandler("admin-add-key", secure((_event, key: string) => { validators.key(key); return admin({ method: "POST", path: "/admin/keys", body: { key } }); })));
ipcMain.handle("admin-remove-key", wrapIpcHandler("admin-remove-key", secure((_event, id: string) => { validators.uuid(id); return admin({ method: "DELETE", path: `/admin/keys/${encodeURIComponent(id)}` }); })));
ipcMain.handle("admin-set-status", wrapIpcHandler("admin-set-status", secure((_event, id: string, status: string) => { validators.uuid(id); validators.status(status); return admin({ method: "PATCH", path: `/admin/keys/${encodeURIComponent(id)}`, body: { status } }); })));
ipcMain.handle("admin-reorder", wrapIpcHandler("admin-reorder", secure((_event, ids: string[]) => { validators.reorder(ids); return admin({ method: "POST", path: "/admin/keys/reorder", body: { ids } }); })));
ipcMain.handle("admin-logs", wrapIpcHandler("admin-logs", secure(() => admin({ method: "GET", path: "/admin/logs" }))));
ipcMain.handle("admin-get-performance", wrapIpcHandler("admin-get-performance", secure(() => admin({ method: "GET", path: "/admin/performance" }))));
ipcMain.handle("admin-validate-key", wrapIpcHandler("admin-validate-key", secure((_event, key: string) => { validators.key(key); return admin({ method: "POST", path: "/admin/validate", body: { key } }); })));
ipcMain.handle("get-gateway-credentials", wrapIpcHandler("get-gateway-credentials", secure(() => {
  if (!gatewayRuntime) throw new Error("Gateway runtime is not initialized.");
  if (!credentials) throw new Error("Credentials are unavailable.");
  return { port: readGatewayPort(gatewayRuntime.configPath), gatewayToken: credentials.gatewayToken };
})));

// Phase 2: Models-panel handlers. The preload already exposes get-models /
// refresh-models / update-model-settings / toggle-model (src/preload/index.ts);
// registering them here removes the previous "No handler registered" throws.
// They reuse the admin dispatcher (admin port+1 + admin token) for HTTP and
// the atomic writeAppConfig (gateway-runtime.ts) for per-model writes — per-model
// fields are NOT routed through set-app-config (app-config-ipc.ts rejects them).
const modelsHandlers = createModelsHandlers({
  dispatch: admin,
  getConfigPath: () => {
    if (!gatewayRuntime) throw new Error("Gateway runtime is not initialized.");
    return gatewayRuntime.configPath;
  },
  writeAppConfig,
  protectFile: createRuntimeAclProtector().protectFile
});
ipcMain.handle("get-models", wrapIpcHandler("get-models", secure(() => modelsHandlers.getModels())));
ipcMain.handle("refresh-models", wrapIpcHandler("refresh-models", secure(() => modelsHandlers.refreshModels())));
ipcMain.handle("update-model-settings", wrapIpcHandler("update-model-settings", secure((_event, id: string, settings: { enabled?: boolean; mode?: "day" | "night" | "auto" }) => modelsHandlers.updateModelSettings(id, settings))));
ipcMain.handle("toggle-model", wrapIpcHandler("toggle-model", secure((_event, id: string, enabled: boolean) => {
  if (typeof enabled !== "boolean") throw new Error("Invalid enabled flag.");
  return modelsHandlers.toggleModel(id, enabled);
})));
ipcMain.handle("bulk-toggle-models", wrapIpcHandler("bulk-toggle-models", secure((_event, enabled: boolean) => {
  if (typeof enabled !== "boolean") throw new Error("Invalid enabled flag.");
  return modelsHandlers.bulkToggleModels(enabled);
})));

// ---- Error reporting, feedback, diagnostics, and about handlers ----
// The error reporter is a statically imported CommonJS module compiled from
// error-reporter.ts; its process hooks are initialized in startNormal.
ipcMain.handle("error-report:log", wrapIpcHandler("error-report:log", secure((_event, entry: ErrorEntry) => {
  logError(entry);
  return undefined;
})));
ipcMain.handle("error-report:get-count", wrapIpcHandler("error-report:get-count", secure(() => getErrorCount())));
ipcMain.handle("error-report:preview", wrapIpcHandler("error-report:preview", secure(() => previewErrors())));
ipcMain.handle("error-report:send", wrapIpcHandler("error-report:send", secure(async () => sendErrors())));
ipcMain.handle("feedback:save", wrapIpcHandler("feedback:save", secure((_event, data: FeedbackData) => saveFeedback(data))));
ipcMain.handle("feedback:open-github-issue", wrapIpcHandler("feedback:open-github-issue", secure((_event, data: FeedbackData) => openGitHubIssue(data))));
ipcMain.handle("shell:open-external", wrapIpcHandler("shell:open-external", secure((_event, url: unknown) => openExternalUrl(url))));
ipcMain.handle("diagnostic:export", wrapIpcHandler("diagnostic:export", secure(() => exportDiagnostic())));
ipcMain.handle("about:get-info", wrapIpcHandler("about:get-info", secure(() => getAboutInfo())));

// Clipboard: WRITE-ONLY, on purpose. navigator.clipboard in the renderer rejects
// with NotAllowedError ("Document is not focused") whenever the window is not
// focused -- measured under this app's own webPreferences and CSP -- and this app
// is tray-resident, so an unfocused window is an ordinary state. Electron's own
// clipboard module is focus-independent, so the write happens here instead.
// There is deliberately NO read channel: a renderer must not be able to pull back
// clipboard contents. The text is never logged; it may be a credential.
ipcMain.handle("clipboard:write-text", wrapIpcHandler("clipboard:write-text", secure((_event, text: unknown) => {
  assertClipboardText(text);
  clipboard.writeText(text);
  return undefined;
})));
