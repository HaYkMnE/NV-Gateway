import { AppLanguage, VALID_APP_LANGUAGES, type AppConfigState, type PerformanceMode } from "./gateway-runtime";
import type { GatewayStatus } from "./gateway-lifecycle";

export interface AppConfigUpdate {
  language?: AppLanguage;
  setupComplete?: boolean;
  performanceMode?: PerformanceMode;
  autoStartGateway?: boolean;
}

export interface AppConfigUpdateHandlerOptions {
  getConfigPath: () => string;
  writeAppConfig: (configPath: string, update: AppConfigUpdate, protect: (filePath: string) => void) => AppConfigState;
  protectFile: (filePath: string) => void;
  validateBoolean: (value: unknown) => void;
  getStatus?: () => GatewayStatus;
}

export type AppConfigUpdateResult = AppConfigState & { status?: GatewayStatus };

export function createAppConfigUpdateHandler(options: AppConfigUpdateHandlerOptions): (update: AppConfigUpdate) => AppConfigUpdateResult {
  return (update) => {
    if (typeof update !== "object" || update === null) throw new Error("Invalid config update.");
    if (update.language !== undefined && !VALID_APP_LANGUAGES.has(update.language)) throw new Error("Invalid language.");
    if (update.performanceMode !== undefined
      && update.performanceMode !== "day"
      && update.performanceMode !== "night"
      && update.performanceMode !== "auto") throw new Error("Invalid performance mode.");
    if (update.setupComplete !== undefined) options.validateBoolean(update.setupComplete);
    if (update.autoStartGateway !== undefined) options.validateBoolean(update.autoStartGateway);

    const config = options.writeAppConfig(options.getConfigPath(), update, options.protectFile);
    const status = options.getStatus?.();
    return status === undefined ? config : { ...config, status };
  };
}
