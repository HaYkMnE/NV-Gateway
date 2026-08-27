// Phase 2: Models-panel main-process IPC handlers.
//
// Provides 4 handlers backing the preload channels get-models / refresh-models
// / update-model-settings / toggle-model (src/preload/index.ts). The handlers
// are factored out of src/main/index.ts into this factory (matching the
// admin-ipc.ts / app-config-ipc.ts convention) so they are unit-testable:
// tests inject a fake admin `dispatch` and a temp config path.
//
// CONTRACT notes (cite when wiring the renderer in Phase 3):
//  * Main <-> gateway is HTTP ONLY over the admin port+1 + admin token
//    (admin-ipc.ts dispatcher). Main never imports gateway modules.
//  * GET /admin/models  -> { data: [{ id, context_length, max_completion_tokens,
//                                       capabilities, enabled }] } (admin-api.mjs:235).
//  * POST /admin/models/refresh -> { data: [...raw upstream models...], cached: false }
//    (admin-api.mjs; admin-port mirror of the main-port /v1/models/refresh).
//  * Mapping ModelConfig (mirrors src/renderer/global.d.ts:46):
//      id        = entry.id
//      name      = entry.id            (no human display name source today)
//      enabled   = entry.enabled        (the endpoint derives this from disabledModels,
//                                        admin-api.mjs:222, case-insensitive)
//      mode      = perModelSettings[id]?.performanceMode ?? 'auto'
//      deprecated= false               (no reliable deprecation source today; EOL
//                                        deepseek entries live in disabledModels so
//                                        they surface as enabled:false, NOT deprecated)
//  * 'auto' means "no explicit per-model performance override"; 'day'/'night'
//    are explicit overrides written via update-model-settings. NOTE: readAppConfig
//    (gateway-runtime.ts:202-204) fills perModelSettings[id].performanceMode with
//    the GLOBAL performanceMode when an entry exists but omits performanceMode.
//    Therefore a legacy entry lacking an explicit mode will report the inherited
//    global mode rather than 'auto'; entries created via the panel always set an
//    explicit mode (see updateModelSettings), so this only affects hand-edited
//    legacy config. Surface to the renderer in Phase 3 if a strict 'auto=inherit'
//    semantic is desired (would require reading the raw perModelSettings).

import { readAppConfig, writeAppConfig, type AppConfigState, type PerformanceMode } from "./gateway-runtime";

export interface ModelConfig {
  id: string;
  name: string;
  enabled: boolean;
  mode: PerformanceMode;
  deprecated: boolean;
  // Phase 5 catalog enrichment (all optional, backwards-compatible):
  // The 5 fields above remain the canonical base; the 10 below are ADDITIVE
  // and sourced from NGC catalog metadata (admin-api.mjs GET /admin/models).
  // They are absent when the gateway predates Phase 5, when NGC is unreachable,
  // or for a model not listed in the NGC catalog — the renderer treats them as
  // optional and degrades gracefully (e.g. provider: null -> 'Unknown' chip).
  provider?: string | null;
  publisher?: string | null;
  shortDescription?: string;
  category?: string | null;
  labels?: string[];
  popularity?: number;
  lastUpdated?: string | null;
  logoUrl?: string | null;
  downloadable?: boolean;
  freeEndpoint?: boolean;
}

/** Shape returned by the admin dispatcher when the gateway is not running. */
export interface AdminUnavailableResult {
  ok: false;
  error: { code: "GATEWAY_NOT_RUNNING"; message: string };
}

export interface AdminRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

/** The admin IPC dispatcher (createAdminIpcDispatcher returns this). */
export type AdminDispatch = (request: AdminRequest) => Promise<unknown>;

export interface ModelsIpcOptions {
  /** Admin dispatcher over port+1 + admin token (gateway-down returns the envelope). */
  dispatch: AdminDispatch;
  /** Path to config.json (same file the gateway reads for disabledModels/perModelSettings). */
  getConfigPath: () => string;
  /** Atomic config writer (.tmp + rename + ACL) — gateway-runtime.writeAppConfig. */
  writeAppConfig: (configPath: string, update: Partial<AppConfigState>, protect: (filePath: string) => void) => AppConfigState;
  /** ACL protector applied to the temp + final config path. */
  protectFile: (filePath: string) => void;
}

export type ModelSettingsUpdate = { enabled?: boolean; mode?: PerformanceMode };

interface AdminModelEntry {
  id: string;
  context_length?: number;
  max_completion_tokens?: number;
  capabilities?: unknown;
  enabled?: boolean;
  // Phase 5 catalog enrichment fields (all optional, additive — a pre-Phase-5
  // gateway may omit them entirely; mapModelCatalog tolerates their absence).
  provider?: string | null;
  publisher?: string | null;
  shortDescription?: string;
  category?: string | null;
  labels?: string[];
  popularity?: number;
  lastUpdated?: string | null;
  logoUrl?: string | null;
  downloadable?: boolean;
  freeEndpoint?: boolean;
}

const DEPRECATED = false;

function isAdminUnavailable(value: unknown): value is AdminUnavailableResult {
  if (!value || typeof value !== "object") return false;
  const v = value as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
  return v.ok === false
    && typeof v.error?.code === "string"
    && typeof v.error?.message === "string"
    && v.error.code === "GATEWAY_NOT_RUNNING";
}

function extractModelEntries(response: unknown): AdminModelEntry[] {
  if (!response || typeof response !== "object") return [];
  const r = response as { data?: unknown; models?: unknown };
  // Contract is { data: [...] } (admin-api.mjs:235). Tolerate a { models: [...] }
  // or bare-array fallback defensively, but only data/ [] are produced today.
  if (Array.isArray(r.data)) return r.data as AdminModelEntry[];
  if (Array.isArray(r.models)) return r.models as AdminModelEntry[];
  if (Array.isArray(response)) return response as AdminModelEntry[];
  return [];
}

function mapModelCatalog(response: unknown, config: AppConfigState): ModelConfig[] {
  return extractModelEntries(response)
    .filter((m): m is AdminModelEntry => !!m && typeof m === "object" && typeof m.id === "string")
    .map((m) => {
      const id = m.id;
      // Key lowercase-symmetric with the WRITE path (updateModelSettings) and
      // disabledModels: NVIDIA endpoint ids are lowercase, but defensive
      // toLowerCase() keeps hand-edited mixed-case config keys legible.
      const mode: PerformanceMode = config.perModelSettings[id.toLowerCase()]?.performanceMode ?? "auto";
      // Phase 5: thread catalog fields through from result.data[i] → ModelConfig.
      // admin-api.mjs GET /admin/models now carries these ADDITIVE fields by
      // default. Each is OPTIONAL — mapModelCatalog only PROGRESSES a field when
      // the admin response actually carries a sensible value (string|number|
      // boolean|Array|null); an unknown value yields `undefined`, which the
      // context-bridge JSON serialization drops so the renderer sees the field
      // absent. A pre-Phase-5 gateway (no admin enrichment) yields ModelConfig
      // objects with the 5 canonical fields only — backwards-compatible.
      return {
        id,
        name: id,
        enabled: m.enabled === true,
        mode,
        deprecated: DEPRECATED,
        provider: typeof m.provider === "string" ? m.provider : (m.provider === null ? null : undefined),
        publisher: typeof m.publisher === "string" ? m.publisher : (m.publisher === null ? null : undefined),
        shortDescription: typeof m.shortDescription === "string" ? m.shortDescription : undefined,
        category: typeof m.category === "string" ? m.category : (m.category === null ? null : undefined),
        labels: Array.isArray(m.labels) ? m.labels : undefined,
        popularity: typeof m.popularity === "number" ? m.popularity : undefined,
        lastUpdated: typeof m.lastUpdated === "string" ? m.lastUpdated : (m.lastUpdated === null ? null : undefined),
        logoUrl: typeof m.logoUrl === "string" ? m.logoUrl : (m.logoUrl === null ? null : undefined),
        downloadable: typeof m.downloadable === "boolean" ? m.downloadable : undefined,
        freeEndpoint: typeof m.freeEndpoint === "boolean" ? m.freeEndpoint : undefined
      };
    });
}

const DEFAULT_KNOWN_MODELS = [
  "deepseek-ai/deepseek-v4-flash",
  "stepfun-ai/step-3.7-flash",
  "meta/llama-4-maverick-17b-128e-instruct",
  "qwen/qwen3.5-397b-a17b",
  "z-ai/glm-5.2",
  "minimaxai/minimax-m3",
  "meta/llama-3.1-8b-instruct",
  "meta/llama-3.1-70b-instruct",
  "meta/llama-3.3-70b-instruct",
  "deepseek-ai/deepseek-r1",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "mistralai/mistral-large-2-instruct"
];

const EOL_DISABLED_MODELS = [
  "deepseek-ai/deepseek-v4-pro",
  "deepseek/deepseek-v4-pro"
];

function deriveFallbackCatalog(config: AppConfigState): ModelConfig[] {
  const modelIds = new Set<string>(DEFAULT_KNOWN_MODELS);
  if (config && typeof config.perModelSettings === "object" && config.perModelSettings !== null) {
    for (const key of Object.keys(config.perModelSettings)) {
      modelIds.add(key);
    }
  }
  if (Array.isArray(config.disabledModels)) {
    for (const key of config.disabledModels) {
      if (typeof key === "string" && key.length > 0) modelIds.add(key);
    }
  }
  return Array.from(modelIds).map((id) => deriveModelConfig(id, config));
}

/**
 * Derive a single ModelConfig for `id` from the just-written config. `enabled`
 * mirrors the gateway's case-insensitive disabledModels enforcement
 * (model-limits.mjs:171-173 lowercases at read; admin-api.mjs:222 compares the
 * lowercased id) rather than the vestigial perModelSettings[id].enabled flag,
 * which the gateway does NOT consult for enable/disable.
 */
function deriveModelConfig(id: string, config: AppConfigState): ModelConfig {
  const lowerId = id.toLowerCase();
  const enabled = !Array.isArray(config.disabledModels)
    || !config.disabledModels.some((m) => typeof m === "string" && m.toLowerCase() === lowerId);
  const mode: PerformanceMode = config.perModelSettings[lowerId]?.performanceMode ?? "auto";
  return { id, name: id, enabled, mode, deprecated: DEPRECATED };
}

export function createModelsHandlers(options: ModelsIpcOptions) {
  let lastKnownCatalog: ModelConfig[] | null = null;

  const getModels = async (): Promise<{ models: ModelConfig[] } | AdminUnavailableResult> => {
    let result: unknown;
    try {
      result = await options.dispatch({ method: "GET", path: "/admin/models" });
    } catch {
      // Dispatch failed or timed out — fallback gracefully
      const config = readAppConfig(options.getConfigPath());
      return { models: lastKnownCatalog ?? deriveFallbackCatalog(config) };
    }
    // Return the unavailable ENVELOPE (not throw) so the preload's invokeAdmin can
    // reconstruct error.name in the renderer process — guaranteeing bridge-safe
    // fidelity for GATEWAY_NOT_RUNNING (mirrors admin-ipc.ts dispatcher convention).
    if (isAdminUnavailable(result)) return result;
    const config = readAppConfig(options.getConfigPath());
    const models = mapModelCatalog(result, config);
    if (models.length > 0) {
      lastKnownCatalog = models;
    }
    return { models: models.length > 0 ? models : (lastKnownCatalog ?? deriveFallbackCatalog(config)) };
  };

  const refreshModels = async (): Promise<{ models: ModelConfig[] } | AdminUnavailableResult> => {
    // Trigger upstream re-discovery, then re-fetch the enriched catalog (the
    // refresh result is the RAW upstream catalog without the `enabled` flag or
    // context/capability enrichment; /admin/models carries those + the flag).
    // Best-effort refresh trigger: a POST timeout (NVIDIA slow >5s, the
    // admin-client.ts:7 socket timeout) is NON-FATAL because the gateway
    // refreshModels() (model-discovery.mjs:93, 30s cap) keeps running and
    // updates the server-side cache asynchronously; the GET below returns that
    // cache once it settles (or the stale cache if still in-flight — the user
    // can retry). A gateway-down dispatcher result is the unavailable envelope;
    // it is RETURNED here (NOT raised) so the preload's invokeAdmin reconstructs
    // error.name bridge-safe for GATEWAY_NOT_RUNNING. Only the thrown POST
    // timeout is swallowed.
    let refreshResult: unknown;
    try {
      refreshResult = await options.dispatch({ method: "POST", path: "/admin/models/refresh" });
    } catch {
      // POST refresh timed out (NVIDIA slow) — non-fatal; proceed to GET.
      refreshResult = undefined;
    }
    // Envelope (not throw) on POST gateway-down so the preload's invokeAdmin
    // reconstructs error.name in the renderer.
    if (isAdminUnavailable(refreshResult)) return refreshResult;

    let result: unknown;
    try {
      result = await options.dispatch({ method: "GET", path: "/admin/models" });
    } catch {
      // GET timed out or failed — fallback gracefully
      const config = readAppConfig(options.getConfigPath());
      return { models: lastKnownCatalog ?? deriveFallbackCatalog(config) };
    }
    if (isAdminUnavailable(result)) return result;
    const config = readAppConfig(options.getConfigPath());
    const models = mapModelCatalog(result, config);
    if (models.length > 0) {
      lastKnownCatalog = models;
    }
    return { models: models.length > 0 ? models : (lastKnownCatalog ?? deriveFallbackCatalog(config)) };
  };

  const updateModelSettings = async (id: string, settings: ModelSettingsUpdate = {}): Promise<ModelConfig> => {
    if (typeof id !== "string" || id.length === 0) throw new Error("Invalid model id.");
    if (settings.mode !== undefined
      && settings.mode !== "day"
      && settings.mode !== "night"
      && settings.mode !== "auto") {
      throw new Error("Invalid performance mode.");
    }
    if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") {
      throw new Error("Invalid enabled flag.");
    }

    const configPath = options.getConfigPath();
    const current = readAppConfig(configPath);

    // perModelSettings: only mutated when an explicit mode is supplied (enabled
    // is tracked via disabledModels, not perModelSettings — see deriveModelConfig
    // docs). Create the entry with sensible defaults if it is missing.
    const perModelSettings: Record<string, AppConfigState["perModelSettings"][string]> = { ...current.perModelSettings };
    if (settings.mode !== undefined) {
      // Key on the LOWERCASED id so perModelSettings is symmetric with
      // disabledModels (lowercased below) and with the READ path
      // (mapModelCatalog/deriveModelConfig read by id.toLowerCase()). Without
      // this, a mixed-case id from the renderer would write under the
      // original-case key but the lowercase endpoint id read would miss it and
      // silently revert the mode to 'auto'.
      const lowerKey = id.toLowerCase();
      const existing = perModelSettings[lowerKey];
      perModelSettings[lowerKey] = {
        enabled: existing?.enabled ?? true,
        performanceMode: settings.mode,
        firstByteTimeoutMs: existing?.firstByteTimeoutMs,
        idleTimeoutMs: existing?.idleTimeoutMs,
        maxStreamDurationMs: existing?.maxStreamDurationMs,
        maxFailoverAttempts: existing?.maxFailoverAttempts
      };
    }

    // disabledModels: normalize to lowercase + de-dupe on write so the config
    // stays clean and matches the gateway's case-insensitive read (model-limits
    // lowercases at read; keep config lowercased for cleanliness).
    const lowerId = id.toLowerCase();
    const normalizedDisabled = Array.from(new Set(
      (Array.isArray(current.disabledModels) ? current.disabledModels : [])
        .filter((m): m is string => typeof m === "string")
        .map((m) => m.toLowerCase())
    ));
    let disabledModels: string[];
    if (settings.enabled === false) {
      disabledModels = normalizedDisabled.includes(lowerId) ? normalizedDisabled : [...normalizedDisabled, lowerId];
    } else if (settings.enabled === true) {
      disabledModels = normalizedDisabled.filter((m) => m !== lowerId);
    } else {
      disabledModels = normalizedDisabled;
    }

    // writeAppConfig is a partial-merger (gateway-runtime.ts:224-236): it reads
    // current, spreads the update on top, preserves raw fields (modelLimits),
    // validates gatewayPort/language/performanceMode (all unchanged here), and
    // writes atomically via .tmp + rename + protect. It does NOT route through
    // set-app-config (app-config-ipc.ts rejects per-model fields).
    options.writeAppConfig(configPath, { perModelSettings, disabledModels }, options.protectFile);

    return deriveModelConfig(id, readAppConfig(configPath));
  };

  const toggleModel = (id: string, enabled: boolean): Promise<ModelConfig> => updateModelSettings(id, { enabled });

  const bulkToggleModels = async (enabled: boolean): Promise<ModelConfig[]> => {
    if (typeof enabled !== "boolean") throw new Error("Invalid enabled flag.");

    const configPath = options.getConfigPath();
    const current = readAppConfig(configPath);

    if (!lastKnownCatalog) {
      try {
        const result = await options.dispatch({ method: "GET", path: "/admin/models" });
        if (!isAdminUnavailable(result)) {
          const models = mapModelCatalog(result, current);
          if (models.length > 0) {
            lastKnownCatalog = models;
          }
        }
      } catch {
        // Dispatch failed or timed out — fallback gracefully
      }
    }

    let disabledModels: string[];
    if (enabled) {
      disabledModels = [...EOL_DISABLED_MODELS];
    } else {
      const knownIds = new Set<string>();
      for (const id of DEFAULT_KNOWN_MODELS) {
        knownIds.add(id.toLowerCase());
      }
      for (const id of EOL_DISABLED_MODELS) {
        knownIds.add(id.toLowerCase());
      }
      if (current.perModelSettings && typeof current.perModelSettings === "object") {
        for (const key of Object.keys(current.perModelSettings)) {
          knownIds.add(key.toLowerCase());
        }
      }
      if (Array.isArray(current.disabledModels)) {
        for (const key of current.disabledModels) {
          if (typeof key === "string" && key.length > 0) knownIds.add(key.toLowerCase());
        }
      }
      if (lastKnownCatalog) {
        for (const m of lastKnownCatalog) {
          if (m && typeof m.id === "string") knownIds.add(m.id.toLowerCase());
        }
      }
      disabledModels = Array.from(knownIds);
    }

    const perModelSettings: Record<string, AppConfigState["perModelSettings"][string]> = { ...current.perModelSettings };
    for (const key of Object.keys(perModelSettings)) {
      const existing = perModelSettings[key];
      if (existing) {
        const lowerKey = key.toLowerCase();
        const isEol = EOL_DISABLED_MODELS.some((eol) => eol.toLowerCase() === lowerKey);
        perModelSettings[key] = {
          ...existing,
          enabled: enabled ? !isEol : false
        };
      }
    }

    options.writeAppConfig(configPath, { perModelSettings, disabledModels }, options.protectFile);

    const updatedConfig = readAppConfig(configPath);
    if (lastKnownCatalog && lastKnownCatalog.length > 0) {
      const updatedCatalog = lastKnownCatalog.map((m) => {
        const lowerId = m.id.toLowerCase();
        const isModelEnabled = !disabledModels.some((d) => d.toLowerCase() === lowerId);
        const mode = updatedConfig.perModelSettings[lowerId]?.performanceMode ?? m.mode ?? "auto";
        return {
          ...m,
          enabled: isModelEnabled,
          mode
        };
      });
      lastKnownCatalog = updatedCatalog;
      return updatedCatalog;
    }

    const fallback = deriveFallbackCatalog(updatedConfig);
    lastKnownCatalog = fallback;
    return fallback;
  };

  return { getModels, refreshModels, updateModelSettings, toggleModel, bulkToggleModels };
}
