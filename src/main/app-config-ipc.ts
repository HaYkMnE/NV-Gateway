import { AppLanguage, MAX_REQUEST_DEADLINE_MS, VALID_APP_LANGUAGES, isValidRequestDeadlineMs, type AppConfigState, type PerformanceMode } from "./gateway-runtime";
import type { GatewayStatus } from "./gateway-lifecycle";

export interface AppConfigUpdate {
  language?: AppLanguage;
  setupComplete?: boolean;
  performanceMode?: PerformanceMode;
  /** Э1b: total per-request deadline, integer ms in 1..MAX_REQUEST_DEADLINE_MS. */
  requestDeadlineMs?: number;
  /** LLM Stats ranking opt-out; default true. The gateway re-reads it from config.json at runtime. */
  llmStatsEnabled?: boolean;
}

export interface AppConfigUpdateHandlerOptions {
  getConfigPath: () => string;
  writeAppConfig: (configPath: string, update: AppConfigUpdate, protect: (filePath: string) => void) => AppConfigState;
  protectFile: (filePath: string) => void;
  validateBoolean: (value: unknown) => void;
  getStatus?: () => GatewayStatus;
}

export type AppConfigUpdateResult = AppConfigState & { status?: GatewayStatus };

/**
 * The only keys the renderer may write through `set-app-config`. Anything else
 * (gatewayPort, perModelSettings, disabledModels, modelLimits, __proto__, ...)
 * has a dedicated main-side channel and is rejected here, before any write.
 */
const ALLOWED_APP_CONFIG_UPDATE_KEYS: ReadonlySet<PropertyKey> = new Set<keyof AppConfigUpdate>([
  "language", "setupComplete", "performanceMode", "requestDeadlineMs", "llmStatsEnabled"
]);

export function createAppConfigUpdateHandler(options: AppConfigUpdateHandlerOptions): (update: AppConfigUpdate) => AppConfigUpdateResult {
  return (update) => {
    if (typeof update !== "object" || update === null || Array.isArray(update)) throw new Error("Invalid config update.");
    // Reflect.ownKeys also sees symbol keys and own `__proto__`/`constructor` keys.
    if (Reflect.ownKeys(update).some((key) => !ALLOWED_APP_CONFIG_UPDATE_KEYS.has(key))) throw new Error("Invalid config update.");
    if (update.language !== undefined && !VALID_APP_LANGUAGES.has(update.language)) throw new Error("Invalid language.");
    if (update.performanceMode !== undefined
      && update.performanceMode !== "day"
      && update.performanceMode !== "night"
      && update.performanceMode !== "auto") throw new Error("Invalid performance mode.");
    if (update.setupComplete !== undefined) options.validateBoolean(update.setupComplete);
    if (Object.hasOwn(update, "llmStatsEnabled")) options.validateBoolean(update.llmStatsEnabled);
    if (update.requestDeadlineMs !== undefined && !isValidRequestDeadlineMs(update.requestDeadlineMs)) {
      throw new Error(`Invalid request deadline: expected an integer from 1 to ${MAX_REQUEST_DEADLINE_MS} ms.`);
    }

    // Forward a fresh object built from the allowlist only (never the caller's object).
    const allowed: AppConfigUpdate = {};
    if (Object.hasOwn(update, "language")) allowed.language = update.language;
    if (Object.hasOwn(update, "setupComplete")) allowed.setupComplete = update.setupComplete;
    if (Object.hasOwn(update, "performanceMode")) allowed.performanceMode = update.performanceMode;
    if (Object.hasOwn(update, "requestDeadlineMs")) allowed.requestDeadlineMs = update.requestDeadlineMs;
    if (Object.hasOwn(update, "llmStatsEnabled")) allowed.llmStatsEnabled = update.llmStatsEnabled;

    const config = options.writeAppConfig(options.getConfigPath(), allowed, options.protectFile);
    const status = options.getStatus?.();
    return status === undefined ? config : { ...config, status };
  };
}
