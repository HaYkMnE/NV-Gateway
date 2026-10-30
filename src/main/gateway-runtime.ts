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
// The capability-probe entries come from the docblock in
// src/gateway/capability-probe.mjs — keep the two lists in sync.
const FORWARDED_GATEWAY_ENVIRONMENT_NAMES = new Set([
  "GATEWAY_FIRST_BYTE_TIMEOUT_MS",
  "GATEWAY_REQUEST_DEADLINE_MS",
  "GATEWAY_IDLE_TIMEOUT_MS",
  "GATEWAY_MAX_STREAM_DURATION_MS",
  "GATEWAY_MAX_FAILOVER_ATTEMPTS",
  "GATEWAY_MAX_BUFFERED_RESPONSE_BYTES",
  // Capability-probe knobs read by src/gateway/capability-probe.mjs (its module
  // docblock documents all six). Without these the documented override would be
  // silently dropped by the child environment subset, so the operator knob would
  // never reach the process that reads it.
  "GATEWAY_CAPABILITY_CACHE_PATH",
  "GATEWAY_CAPABILITY_PROBE_TTL_MS",
  "GATEWAY_CAPABILITY_PROBE_TIMEOUT_MS",
  "GATEWAY_CAPABILITY_PROBE_MAX_PER_SWEEP",
  "GATEWAY_CAPABILITY_PROBE_DISABLE",
  "GATEWAY_CAPABILITY_PROBE_ENABLE",
  "NV_GATEWAY_DIRECT_GLM_PROBE"
]);
export type AppLanguage = "en" | "ru" | "zh" | "hi" | "es" | "fr" | "ar";
export const VALID_APP_LANGUAGES = new Set<AppLanguage>(["en", "ru", "zh", "hi", "es", "fr", "ar"]);
export type PerformanceMode = "day" | "night" | "auto";
/**
 * Э1b app setting `requestDeadlineMs` (plan §12.11 Р4/Р5). Mirrors the gateway
 * child's DEFAULT_REQUEST_DEADLINE_MS / MAX_UPSTREAM_TIMEOUT_MS in
 * src/gateway/upstream-timeouts.mjs (tests pin that both sides agree).
 */
export const DEFAULT_REQUEST_DEADLINE_MS = 240_000;
export const MAX_REQUEST_DEADLINE_MS = 1_800_000;
export function isValidRequestDeadlineMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_REQUEST_DEADLINE_MS;
}

export type RequestDeadlineSource = "env" | "config" | "default";
export interface EffectiveRequestDeadline {
  requestDeadlineMs: number;
  requestDeadlineSource: RequestDeadlineSource;
}

/**
 * Э1b D1: the deadline the gateway child ACTUALLY applies, and where it came
 * from. Same rules as resolveRequestDeadlineMs in src/gateway/upstream-timeouts.mjs:
 * a valid GATEWAY_REQUEST_DEADLINE_MS (digits only, 1..MAX) wins and an invalid
 * one counts as unset; then a valid stored setting; then the default. The child
 * receives main's own process.env value through FORWARDED_GATEWAY_ENVIRONMENT_NAMES,
 * so resolving against main's environment gives the child's answer.
 */
export function resolveEffectiveRequestDeadline(environment: NodeJS.ProcessEnv, storedMs: unknown): EffectiveRequestDeadline {
  const raw = environment.GATEWAY_REQUEST_DEADLINE_MS;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (isValidRequestDeadlineMs(parsed)) return { requestDeadlineMs: parsed, requestDeadlineSource: "env" };
  }
  if (isValidRequestDeadlineMs(storedMs)) return { requestDeadlineMs: storedMs, requestDeadlineSource: "config" };
  return { requestDeadlineMs: DEFAULT_REQUEST_DEADLINE_MS, requestDeadlineSource: "default" };
}

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
  /**
   * Total per-request gateway deadline in ms (1..MAX_REQUEST_DEADLINE_MS).
   * Present on disk ONLY when the user chose it. The default is read-time only:
   * readAppConfig/readAppConfigCached fill DEFAULT_REQUEST_DEADLINE_MS when it is
   * absent/invalid, writeAppConfig never persists it (an invalid on-disk value is
   * dropped on the next write). A valid ENV GATEWAY_REQUEST_DEADLINE_MS in the
   * child overrides it.
   */
  requestDeadlineMs?: number;
  /**
   * LLM Stats ranking opt-out (owner 29.09: on by default, can be turned off).
   * Same storage contract as requestDeadlineMs: on disk ONLY when the user chose
   * it; readers fill `true` when absent/non-boolean. The gateway child re-reads
   * it from config.json (performance-mode.mjs readLlmStatsEnabled), so a write
   * here applies at runtime with no restart.
   */
  llmStatsEnabled?: boolean;
}

/**
 * writeAppConfig update. perModelSettings is a PATCH keyed by model id: each
 * entry is merged onto the stored on-disk record (CR7-001), so callers pass only
 * the fields they change.
 */
export type AppConfigWriteUpdate = Omit<Partial<AppConfigState>, "perModelSettings"> & {
  perModelSettings?: Record<string, Partial<PerModelSettings>>;
};

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
  // https://docs.api.nvidia.com/nim/reference/nvidia-deepseek-v4_1-flash-infer
  // max_tokens defaults to 262,144; the accepted maximum is 1,048,576.
  "deepseek-ai/deepseek-v4.1-flash": { context: 1_048_576, output: 1_048_576 },
  "stepfun-ai/step-3.7-flash": { context: 256_000, output: 16_384 },
  "meta/llama-4-maverick-17b-128e-instruct": { context: 128_000, output: 4_096 },
  "qwen/qwen3.5-397b-a17b": { context: 262_144, output: 8_192 },
  "z-ai/glm-5.2": { context: 202_752, output: 131_072 },
  "minimaxai/minimax-m3": { context: 1_000_000, output: 16_384 },
  // No "*" entry here — the model-limits module handles the wildcard fallback
  // (131072 context / 4096 output) internally.
};

const DEEPSEEK_V41_FLASH_ID = "deepseek-ai/deepseek-v4.1-flash";

/**
 * Upgrade an existing config that predates a known-model limit. The exact entry
 * is added alongside (and therefore ahead of) its wildcard; a user's exact entry
 * is never changed. This keeps renderer/main state and the gateway IPC payload in
 * agreement with the gateway's built-in fallback.
 */
function ensureKnownModelLimits(configPath: string, protect: (filePath: string) => void): void {
  let parsed: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const value = JSON.parse(raw.codePointAt(0) === 0xFEFF ? raw.slice(1) : raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    parsed = value as Record<string, unknown>;
  } catch {
    return; // Never replace a malformed or temporarily unreadable user config.
  }

  const current = parsed.modelLimits;
  const modelLimits: Record<string, unknown> = current && typeof current === "object" && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  if (Object.prototype.hasOwnProperty.call(modelLimits, DEEPSEEK_V41_FLASH_ID)) return;
  modelLimits[DEEPSEEK_V41_FLASH_ID] = BUILTIN_MODEL_LIMITS[DEEPSEEK_V41_FLASH_ID];

  const temporaryPath = `${configPath}.known-model-limits.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify({ ...parsed, modelLimits }, null, 2), "utf8");
    protect(temporaryPath);
    fs.renameSync(temporaryPath, configPath);
    protect(configPath);
  } catch {
    // Optional startup migration: the app logger is initialized only after this
    // function returns, so failing silently is safer than leaking config paths via
    // an ad-hoc logger. The gateway still has the same exact built-in limit in
    // model-limits.mjs, while write-to-temp then rename keeps config.json atomic.
  } finally {
    // Remove only this migration's exact temp path. Cleanup is also best-effort:
    // a locked orphan must not turn an optional upgrade into a startup failure.
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch {}
    invalidateAppConfigCache();
  }
}

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
    // THIS IS THE THIRD WRITER of config.json in this module, and it is the one
    // easiest to overlook because it only fires when the file is absent. If the
    // cache is armed and config.json then disappears (a cleanup script, a synced
    // userData directory, a user deleting it), this rewrites DEFAULTS to disk
    // while the cached parse keeps serving the old values: MEASURED cache 41100
    // against disk 12000. Today the single call site runs at startup before any
    // window exists, but relying on that ordering is exactly what turns a future
    // reordering into a silent staleness bug.
    invalidateAppConfigCache();
  } else {
    ensureKnownModelLimits(configPath, (filePath) => protector.protectFile(filePath));
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
// HOW LONG: until the app itself writes the config (writeAppConfig,
// writeGatewayPort or ensureGatewayRuntime — ALL THREE writers in this module
// invalidate, each in a finally so a throwing ACL protector cannot skip it), or
// until restart. There is
// no timer and no file watcher, so an external edit that is never followed by
// an app-side write stays unobserved for the rest of the session. Every
// app-driven change — the language toggle, the performance mode, a port retry,
// a model toggle — invalidates, so nothing the USER does inside the app can
// look stale.
//
// The cached object is FROZEN: it is handed to more than one caller, so an
// accidental mutation by a future caller would otherwise corrupt every
// subsequent read. Writers deliberately do NOT use it (see writeAppConfig).
// storedRequestDeadlineMs: the STORED setting before the read-time default, so
// the runtime-state reader can tell a user-chosen 240000 ('config') from the
// code default ('default') without a second disk read.
let appConfigCache: { configPath: string; value: Readonly<AppConfigState>; storedRequestDeadlineMs: number | undefined } | null = null;

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
  return readAppConfigCachedWithStored(configPath).value;
}

/**
 * Э1b D1: payload for the polled `get-runtime-state` channel. The cached config
 * plus the EFFECTIVE request deadline and its source, resolved against main's
 * environment with the child's rules (see resolveEffectiveRequestDeadline).
 */
export function readRuntimeAppConfigCached(configPath: string, environment: NodeJS.ProcessEnv = process.env): AppConfigState & EffectiveRequestDeadline {
  const { value, storedRequestDeadlineMs } = readAppConfigCachedWithStored(configPath);
  return { ...value, ...resolveEffectiveRequestDeadline(environment, storedRequestDeadlineMs) };
}

function readAppConfigCachedWithStored(configPath: string): { value: AppConfigState; storedRequestDeadlineMs: number | undefined } {
  if (appConfigCache && appConfigCache.configPath === configPath) return appConfigCache;
  // ONE read, then decide whether it is cacheable. readAppConfig() cannot tell a
  // caller the difference between "the file said port 12000" and "the file could
  // not be read, so here are the DEFAULTS", because it swallows both into the
  // same return. Caching the second is not staleness, it is FABRICATION that
  // outlives its cause: MEASURED, a config.json that is transiently unparseable
  // (a half-written external edit, a locked file, an antivirus hold) pinned
  // setupComplete:false and gatewayPort 12000 for the rest of the session, and
  // the values stayed wrong after the file was repaired. setupComplete:false is
  // what the renderer uses to decide whether to show the setup wizard.
  const parsed = parseConfigFile(configPath);
  const stored = normalizeAppConfig(parsed ?? {});
  const storedRequestDeadlineMs = stored.requestDeadlineMs;
  const value = withReadDefaults(stored);
  if (parsed === null) return { value, storedRequestDeadlineMs };
  // DEEP freeze. The per-model ENTRIES are handed out by reference to every
  // caller; freezing only the map left them writable, and MEASURED a single
  // `entry.enabled = false` by one caller poisoned every subsequent cached read
  // while disk still said true.
  for (const entry of Object.values(value.perModelSettings)) Object.freeze(entry);
  Object.freeze(value.perModelSettings);
  Object.freeze(value.disabledModels);
  Object.freeze(value);
  appConfigCache = { configPath, value, storedRequestDeadlineMs };
  return appConfigCache;
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
  // This writer does NOT go through writeAppConfig, so it must drop the cache
  // itself: retry-gateway / set-gateway-port land here, and a stale cached parse
  // would make get-runtime-state report the pre-retry port. Invalidating AFTER
  // the rename is deliberate — invalidating first would let a read in between
  // re-cache the OLD contents and pin the staleness permanently.
  //
  // FINALLY, not a trailing statement: protect() runs AFTER the rename, so if it
  // throws the file on disk has ALREADY been replaced and a trailing invalidate
  // never runs. MEASURED with a protector that throws for configPath: disk said
  // 41777 while the cached parse still said 41100, for the rest of the session.
  // The production protector degrades rather than throws, so this is defence
  // rather than an observed production failure — but the ordering must not be
  // what protects us. Invalidating when the rename itself failed is harmless:
  // the next read simply re-parses a file that never changed.
  try {
    fs.renameSync(temporaryPath, configPath);
    protect(configPath);
  } finally {
    invalidateAppConfigCache();
  }
}

/**
 * Read + parse config.json, or NULL when it could not be read or is not a JSON
 * object. The null is the whole point: readAppConfig() returns defaults for an
 * unreadable file and its caller cannot tell that apart from a file that
 * genuinely said "port 12000". That is harmless for a one-shot read and is
 * FABRICATION once cached, so the cached reader needs to know the difference.
 */
function parseConfigFile(configPath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Validate + default every field. Pure: touches no disk, so it cannot fail. */
function normalizeAppConfig(config: Record<string, unknown>): AppConfigState {
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
  
  // STORED value only (invalid/absent -> undefined, key kept so a merge clears
  // an invalid on-disk value). The default is applied by the READERS below, never
  // here: this object is also the writers' merge base, and filling 240000 here
  // persisted the code default on every unrelated write.
  const requestDeadlineMs = isValidRequestDeadlineMs(config.requestDeadlineMs) ? config.requestDeadlineMs : undefined;
  // Same stored-only rule: a non-boolean on disk is dropped on the next write.
  const llmStatsEnabled = typeof config.llmStatsEnabled === "boolean" ? config.llmStatsEnabled : undefined;

  return { gatewayPort, language, setupComplete: config.setupComplete === true, performanceMode, autoStartGateway, perModelSettings, disabledModels, requestDeadlineMs, llmStatsEnabled };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * CR7-001: merge a per-model PATCH onto the raw on-disk records. Only the fields
 * the caller supplies are overridden; every stored field (including ones this
 * version does not know) survives. `undefined` patch values are ignored so a
 * caller cannot erase a stored field by spreading a normalized record.
 */
function mergePerModelSettings(raw: unknown, update: unknown): Record<string, unknown> {
  if (!isPlainRecord(update)) throw new Error("Invalid perModelSettings: expected an object keyed by model id.");
  const base = isPlainRecord(raw) ? raw : {};
  const merged: Record<string, unknown> = { ...base };
  for (const [modelId, patch] of Object.entries(update)) {
    if (modelId === "__proto__") continue;
    if (!isPlainRecord(patch)) throw new Error("Invalid perModelSettings entry: expected an object.");
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const stored = base[modelId];
    merged[modelId] = { ...(isPlainRecord(stored) ? stored : {}), ...defined };
  }
  return merged;
}

/** Read-time defaults for the optional stored-only keys (both mirror the child). */
function withReadDefaults(config: AppConfigState): AppConfigState {
  if (config.requestDeadlineMs !== undefined && config.llmStatsEnabled !== undefined) return config;
  return {
    ...config,
    requestDeadlineMs: config.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS,
    llmStatsEnabled: config.llmStatsEnabled ?? true
  };
}

/** FRESH read of what is actually stored, no read-time defaults: the writers' merge base. */
function readStoredAppConfig(configPath: string): AppConfigState {
  return normalizeAppConfig(parseConfigFile(configPath) ?? {});
}

/**
 * FRESH read straight from disk, defaults on any failure. Unchanged behaviour:
 * an unreadable or non-object config.json yields the same defaults it always
 * did. Read-modify-write callers must use it (or readStoredAppConfig) as their
 * merge base, never the cache.
 */
export function readAppConfig(configPath: string): AppConfigState {
  return withReadDefaults(readStoredAppConfig(configPath));
}

export function writeAppConfig(configPath: string, update: AppConfigWriteUpdate, protect: (filePath: string) => void = () => {}): AppConfigState {
  // DELIBERATELY the FRESH reader, never readAppConfigCached. This read is the
  // MERGE BASE: everything it returns is written back out below. Serving it from
  // the cache would resurrect whatever the cache last held and silently discard
  // any change made since — most concretely, writeGatewayPort() writes this file
  // without passing through here, so a cached base would revert the user's
  // gateway port on the next language or performance-mode change. A cache is
  // safe on a path that only READS; on a read-modify-write path it is data loss.
  // readStoredAppConfig = readAppConfig minus the read-time requestDeadlineMs
  // default, so an unrelated write never persists the code default.
  const current = readStoredAppConfig(configPath);
  const { perModelSettings: perModelPatch, ...scalarUpdate } = update;
  const next: AppConfigState = { ...current, ...scalarUpdate };
  if (!Number.isInteger(next.gatewayPort) || next.gatewayPort < 1 || next.gatewayPort > 65534) throw new Error("Invalid gateway port.");
  if (!VALID_APP_LANGUAGES.has(next.language)) throw new Error("Invalid language.");
  if (next.performanceMode !== "day" && next.performanceMode !== "night" && next.performanceMode !== "auto") throw new Error("Invalid performance mode.");
  if (next.requestDeadlineMs !== undefined && !isValidRequestDeadlineMs(next.requestDeadlineMs)) throw new Error(`Invalid request deadline: expected an integer from 1 to ${MAX_REQUEST_DEADLINE_MS} ms.`);
  if (next.llmStatsEnabled !== undefined && typeof next.llmStatsEnabled !== "boolean") throw new Error("Invalid llmStatsEnabled: expected a boolean.");
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")); } catch { /* fresh */ }
  // CR7-001: perModelSettings is written from the RAW on-disk records, never from
  // the normalized view. normalizeAppConfig keeps only 6 known fields and fills an
  // absent performanceMode with the GLOBAL mode, so writing it back dropped
  // rateLimitMaxAttempts / unknown fields and pinned "inherit" models to the
  // current global mode on ANY write (language, mode, deadline, ...). Absent from
  // the update -> raw records unchanged; present -> per-id {...raw[id], ...patch}.
  // Validation of the stored values stays with the readers (normalizeAppConfig,
  // performance-mode.mjs), which already reject invalid values at read time.
  const rawPerModel: unknown = perModelPatch !== undefined
    ? mergePerModelSettings(existing.perModelSettings, perModelPatch)
    : isPlainRecord(existing.perModelSettings) ? existing.perModelSettings : next.perModelSettings;
  if (perModelPatch !== undefined) {
    next.perModelSettings = normalizeAppConfig({ performanceMode: next.performanceMode, perModelSettings: rawPerModel }).perModelSettings;
  }
  const temporaryPath = `${configPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({ ...existing, version: 1, ...next, perModelSettings: rawPerModel }, null, 2), "utf8");
  protect(temporaryPath);
  // Invalidate AFTER the rename: dropping the cache before the file is in place
  // would let an interleaved read re-cache the OLD contents and pin the stale
  // value for the rest of the session. In a FINALLY because protect() runs after
  // the rename and a throw there would skip a trailing invalidate while the new
  // contents are already on disk — MEASURED as cached "en" against disk "ru".
  try {
    fs.renameSync(temporaryPath, configPath);
    protect(configPath);
  } finally {
    invalidateAppConfigCache();
  }
  // Callers (IPC -> renderer) get the effective value, the file keeps only the stored one.
  return withReadDefaults(next);
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
