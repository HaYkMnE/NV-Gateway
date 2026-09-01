import * as fs from "node:fs";
import * as path from "node:path";

export interface GatewayRuntimePaths {
  configPath: string;
  statePath: string;
  logPath: string;
  appLogPath: string;
  stdioLogPath: string;
  ownerPath: string;
}

export interface GatewaySpawnOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface RuntimeProtector { protectDirectory(directoryPath: string): void; protectFile(filePath: string): void }
const NO_PROTECTION: RuntimeProtector = { protectDirectory: () => {}, protectFile: () => {} };

const DEFAULT_GATEWAY_PORT = 12000;
const WINDOWS_CHILD_ENVIRONMENT_NAMES = new Set([
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "PATH",
  "COMSPEC",
  "PATHEXT",
  "WINDIR"
]);
// Only these exact GATEWAY_* tuning knobs are forwarded from the parent
// environment to the gateway child; every other parent variable stays filtered.
const FORWARDED_GATEWAY_ENVIRONMENT_NAMES = new Set([
  "GATEWAY_FIRST_BYTE_TIMEOUT_MS",
  "GATEWAY_IDLE_TIMEOUT_MS",
  "GATEWAY_MAX_STREAM_DURATION_MS",
  "GATEWAY_MAX_FAILOVER_ATTEMPTS",
  "GATEWAY_MAX_BUFFERED_RESPONSE_BYTES",
  "NV_GATEWAY_DIRECT_GLM_PROBE"
]);
export type AppLanguage = "en" | "ru" | "zh" | "hi" | "es" | "fr" | "ar";
export const VALID_APP_LANGUAGES = new Set<AppLanguage>(["en", "ru", "zh", "hi", "es", "fr", "ar"]);
export type PerformanceMode = "day" | "night" | "auto";

/** Per-model override settings */
export interface PerModelSettings {
  enabled: boolean;
  performanceMode: PerformanceMode;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxStreamDurationMs?: number;
  maxFailoverAttempts?: number;
}

export interface AppConfigState {
  gatewayPort: number;
  language: AppLanguage;
  setupComplete: boolean;
  performanceMode: PerformanceMode;
  /** Whether to start the gateway automatically at app launch */
  autoStartGateway?: boolean;
  /** Per-model overrides keyed by model ID */
  perModelSettings: Record<string, PerModelSettings>;
  /** Set of model IDs that are explicitly disabled */
  disabledModels: string[];
}

/**
 * Central source of truth for per-model context/output limits.
 * These limits override what NVIDIA reports and are applied by
 * the gateway server at /v1/models time.
 *
 * Only add entries here whose limits differ from the wildcard "*" fallback.
 * 
 * NOTE: EOL models returning HTTP 410 Gone are excluded. Use /v1/models
 * discovery to get currently available models.
 */
const BUILTIN_MODEL_LIMITS: Record<string, { context: number, output: number }> = {
  "deepseek-ai/deepseek-v4-flash": { context: 1_048_576, output: 393_216 },
  "stepfun-ai/step-3.7-flash": { context: 256_000, output: 16_384 },
  "meta/llama-4-maverick-17b-128e-instruct": { context: 128_000, output: 4_096 },
  "qwen/qwen3.5-397b-a17b": { context: 262_144, output: 8_192 },
  "z-ai/glm-5.2": { context: 202_752, output: 131_072 },
  "minimaxai/minimax-m3": { context: 1_000_000, output: 16_384 },
  // No "*" entry here — the model-limits module handles the wildcard fallback
  // (131072 context / 4096 output) internally.
};

function getDefaultConfig(): object {
  return {
    version: 1,
    gatewayPort: DEFAULT_GATEWAY_PORT,
    language: "en",
    setupComplete: false,
    performanceMode: "day",
    autoStartGateway: true,
    modelLimits: BUILTIN_MODEL_LIMITS,
    perModelSettings: {
      // Default per-model settings for models with unstable performance
      "stepfun-ai/step-3.7-flash": {
        enabled: true,
        performanceMode: "day",
        firstByteTimeoutMs: 300000,
        idleTimeoutMs: 300000,
        maxStreamDurationMs: 1800000,
        maxFailoverAttempts: 3
      }
    },
    disabledModels: [
      // EOL models returning HTTP 410 Gone — removed from BUILTIN_MODEL_LIMITS
      "deepseek-ai/deepseek-v4-pro",
      "deepseek/deepseek-v4-pro"
    ]
  };
}

export function ensureGatewayRuntime(userDataPath: string, protector: RuntimeProtector = NO_PROTECTION): GatewayRuntimePaths {
  const configPath = path.join(userDataPath, "config.json");
  const statePath = path.join(userDataPath, "keys.json");
  const logsDir = path.join(userDataPath, "logs");
  const logPath = path.join(logsDir, "gateway.jsonl");
  const appLogPath = path.join(logsDir, "app.jsonl");
  const stdioLogPath = path.join(logsDir, "gateway-stdio.jsonl");
  const ownerPath = path.join(userDataPath, "gateway-owner.json");

  fs.mkdirSync(logsDir, { recursive: true });
  protector.protectDirectory(userDataPath);
  protector.protectDirectory(logsDir);

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(getDefaultConfig(), null, 2), "utf8");
    protector.protectFile(configPath);
  }

  for (const filePath of [logPath, appLogPath, stdioLogPath]) {
    fs.closeSync(fs.openSync(filePath, "a", 0o600));
    protector.protectFile(filePath);
  }
  return { configPath, statePath, logPath, appLogPath, stdioLogPath, ownerPath };
}

// ---------------------------------------------------------------------------
// config.json is PARSED ONCE and cached for read-only hot paths.
//
// MEASURED on this machine, 2000 iterations against a real config.json. The
// numbers are printed by tests/app-config-cache.test.mjs on every run, so they
// are re-derived rather than trusted from this comment:
//   readAppConfig        1.5348 ms/call  (3069.5 ms / 2000)  <- readFileSync + JSON.parse
//   readAppConfigCached  below timer resolution (0.0 ms total for 2000 reads)
// Independently consistent with the ~1.07 ms per read measured elsewhere on this
// box; it is under memory pressure, which is why this figure is higher. The
// cached figure is a FLOOR: it is too small to time, not proven to be zero.
//
// WHY IT MATTERS: readAppConfig sat inside the `get-runtime-state` IPC handler,
// which the renderer polls, and inside currentLanguage(), which updateTray()
// calls. A synchronous readFileSync on a polled channel blocks the main thread
// on every request, forever. One upstream defect already amplified 5,000
// download ticks into 5,000 synchronous config reads and 5.3 s of blocked main
// thread (commit fea558f) precisely because a per-event path reached this
// function.
//
// TRADEOFF, stated plainly rather than hidden — the same class of tradeoff the
// auto-launch cache accepts for an EXTERNAL registry edit (see
// getAutoLaunchCached in index.ts): if config.json is edited EXTERNALLY while
// the app is running — a text editor, a script, another tool — the cached hot
// paths keep serving the parse they last took. get-runtime-state (and so the
// Settings view) and the tray language can therefore show a stale value.
//
// HOW LONG: until the app itself writes the config (writeAppConfig or
// writeGatewayPort, both of which invalidate below), or until restart. There is
// no timer and no file watcher, so an external edit that is never followed by
// an app-side write stays unobserved for the rest of the session. Every
// app-driven change — the language toggle, the performance mode, a port retry,
// a model toggle — invalidates, so nothing the USER does inside the app can
// look stale.
//
// The cached object is FROZEN: it is handed to more than one caller, so an
// accidental mutation by a future caller would otherwise corrupt every
// subsequent read. Writers deliberately do NOT use it (see writeAppConfig).
let appConfigCache: { configPath: string; value: Readonly<AppConfigState> } | null = null;

/** Drop the cached parse. Called by every writer in this module. */
export function invalidateAppConfigCache(): void {
  appConfigCache = null;
}

/**
 * Cached read for READ-ONLY hot paths (get-runtime-state, currentLanguage).
 *
 * Keyed by configPath: a different path is a different file, and serving one
 * file's contents for another would be silent corruption during a migration or
 * a relocated userData directory.
 *
 * NEVER use this as the base for a write. See writeAppConfig.
 */
export function readAppConfigCached(configPath: string): AppConfigState {
  if (appConfigCache && appConfigCache.configPath === configPath) return appConfigCache.value;
  const value = readAppConfig(configPath);
  Object.freeze(value.perModelSettings);
  Object.freeze(value.disabledModels);
  Object.freeze(value);
  appConfigCache = { configPath, value };
  return value;
}

export function readGatewayPort(configPath: string): number {
  try {
    // Strip UTF-8 BOM before parsing — configs edited externally (e.g. PowerShell
    // Set-Content -Encoding UTF8) may carry a BOM prefix that breaks JSON.parse.
    const raw = fs.readFileSync(configPath, "utf8");
    const sanitized = raw.codePointAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const config: unknown = JSON.parse(sanitized);
    if (isGatewayConfig(config)) {
      return config.gatewayPort;
    }
  } catch {
    // The runtime will recreate the default config on the next start if it is invalid.
  }

  return DEFAULT_GATEWAY_PORT;
}

export function writeGatewayPort(configPath: string, gatewayPort: number, protect: (filePath: string) => void = () => {}): void {
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65534) {
    throw new Error("Gateway port must be an integer between 1 and 65534.");
  }

  // Preserve existing config fields (especially modelLimits and perModelSettings) when updating only the port
  let existingConfig: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const sanitized = raw.codePointAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const parsed = JSON.parse(sanitized);
    if (typeof parsed === "object" && parsed !== null) {
      existingConfig = parsed;
    }
  } catch {
    // Config absent or invalid — start fresh
  }

  const config = {
    ...existingConfig,
    version: 1,
    gatewayPort
  };

  const temporaryPath = `${configPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2), "utf8");
  protect(temporaryPath);
  fs.renameSync(temporaryPath, configPath);
  protect(configPath);
  // This writer does NOT go through writeAppConfig, so it must drop the cache
  // itself: retry-gateway / set-gateway-port land here, and a stale cached parse
  // would make get-runtime-state report the pre-retry port. Invalidating AFTER
  // the rename is deliberate — invalidating first would let a read in between
  // re-cache the OLD contents and pin the staleness permanently.
  invalidateAppConfigCache();
}

export function readAppConfig(configPath: string): AppConfigState {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")); } catch { /* defaults */ }
  const gatewayPort = isGatewayConfig(config) ? config.gatewayPort : DEFAULT_GATEWAY_PORT;
  const performanceMode: PerformanceMode =
    config.performanceMode === "night" || config.performanceMode === "auto" || config.performanceMode === "day"
      ? config.performanceMode
      : "day";
  
  // Parse per-model settings with defaults
  const perModelSettings: Record<string, PerModelSettings> = {};
  if (config.perModelSettings && typeof config.perModelSettings === "object") {
    for (const [modelId, settings] of Object.entries(config.perModelSettings)) {
      if (settings && typeof settings === "object") {
        const s = settings as Record<string, unknown>;
        const mode: PerformanceMode = s.performanceMode === "night" || s.performanceMode === "auto" || s.performanceMode === "day" 
          ? s.performanceMode as PerformanceMode 
          : performanceMode;
        perModelSettings[modelId] = {
          enabled: s.enabled !== false,
          performanceMode: mode,
          firstByteTimeoutMs: typeof s.firstByteTimeoutMs === "number" ? s.firstByteTimeoutMs : undefined,
          idleTimeoutMs: typeof s.idleTimeoutMs === "number" ? s.idleTimeoutMs : undefined,
          maxStreamDurationMs: typeof s.maxStreamDurationMs === "number" ? s.maxStreamDurationMs : undefined,
          maxFailoverAttempts: typeof s.maxFailoverAttempts === "number" ? s.maxFailoverAttempts : undefined,
        };
      }
    }
  }
  
  const disabledModels: string[] = Array.isArray(config.disabledModels) 
    ? config.disabledModels.filter((m): m is string => typeof m === "string")
    : [];
  
  const autoStartGateway = config.autoStartGateway !== false;
  
  const language: AppLanguage = typeof config.language === "string" && VALID_APP_LANGUAGES.has(config.language as AppLanguage)
    ? (config.language as AppLanguage)
    : "en";
  
  return { gatewayPort, language, setupComplete: config.setupComplete === true, performanceMode, autoStartGateway, perModelSettings, disabledModels };
}

export function writeAppConfig(configPath: string, update: Partial<AppConfigState>, protect: (filePath: string) => void = () => {}): AppConfigState {
  // DELIBERATELY the FRESH reader, never readAppConfigCached. This read is the
  // MERGE BASE: everything it returns is written back out below. Serving it from
  // the cache would resurrect whatever the cache last held and silently discard
  // any change made since — most concretely, writeGatewayPort() writes this file
  // without passing through here, so a cached base would revert the user's
  // gateway port on the next language or performance-mode change. A cache is
  // safe on a path that only READS; on a read-modify-write path it is data loss.
  const current = readAppConfig(configPath);
  const next = { ...current, ...update };
  if (!Number.isInteger(next.gatewayPort) || next.gatewayPort < 1 || next.gatewayPort > 65534) throw new Error("Invalid gateway port.");
  if (!VALID_APP_LANGUAGES.has(next.language)) throw new Error("Invalid language.");
  if (next.performanceMode !== "day" && next.performanceMode !== "night" && next.performanceMode !== "auto") throw new Error("Invalid performance mode.");
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")); } catch { /* fresh */ }
  const temporaryPath = `${configPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({ ...existing, version: 1, ...next }, null, 2), "utf8");
  protect(temporaryPath); fs.renameSync(temporaryPath, configPath); protect(configPath);
  // Invalidate AFTER the rename: dropping the cache before the file is in place
  // would let an interleaved read re-cache the OLD contents and pin the stale
  // value for the rest of the session.
  invalidateAppConfigCache();
  return next;
}

/**
 * Get effective performance mode for a specific model.
 * Per-model override takes precedence over global setting.
 */
export function getEffectivePerformanceMode(config: AppConfigState, modelId?: string): PerformanceMode {
  if (modelId && config.perModelSettings[modelId]) {
    return config.perModelSettings[modelId].performanceMode;
  }
  return config.performanceMode;
}

/**
 * Check if a model is enabled.
 */
export function isModelEnabled(config: AppConfigState, modelId: string): boolean {
  // If in disabledModels list, explicitly disabled
  if (config.disabledModels.includes(modelId)) {
    return false;
  }
  // If has per-model settings, check enabled flag
  if (config.perModelSettings[modelId]) {
    return config.perModelSettings[modelId].enabled;
  }
  // Default: enabled
  return true;
}

export function createGatewaySpawnOptions(serverPath: string, runtimePaths: GatewayRuntimePaths, port: number): GatewaySpawnOptions {
  const forwarded = selectEnvironmentSubset(process.env, FORWARDED_GATEWAY_ENVIRONMENT_NAMES);
  // Do not inject profile-derived GATEWAY_* values here. The child resolves
  // day/night/auto from config per request; only explicit operator tuning knobs
  // from the parent environment are forwarded, so those overrides keep clear
  // precedence over every selected profile.
  return {
    args: [serverPath],
    env: {
      ...selectEnvironmentSubset(process.env, WINDOWS_CHILD_ENVIRONMENT_NAMES),
      ...forwarded,
      ELECTRON_RUN_AS_NODE: "1",
      GATEWAY_LOG_PATH: runtimePaths.logPath,
      GATEWAY_CONFIG_PATH: runtimePaths.configPath,
      PORT: String(port)
    }
  };
}

function selectEnvironmentSubset(parentEnvironment: NodeJS.ProcessEnv, allowedNames: Set<string>): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  const selectedNames = new Set<string>();

  for (const [name, value] of Object.entries(parentEnvironment)) {
    const normalizedName = name.toUpperCase();
    if (value !== undefined
      && allowedNames.has(normalizedName)
      && !selectedNames.has(normalizedName)) {
      childEnvironment[name] = value;
      selectedNames.add(normalizedName);
    }
  }

  return childEnvironment;
}

function isGatewayConfig(value: unknown): value is { gatewayPort: number } {
  return typeof value === "object"
    && value !== null
    && "gatewayPort" in value
    && typeof value.gatewayPort === "number"
    && Number.isInteger(value.gatewayPort)
    && value.gatewayPort >= 1
    && value.gatewayPort <= 65534;
}
