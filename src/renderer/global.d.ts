interface Window {
  electronAPI: {
    checkPorts: (ports: number[]) => Promise<Record<number, boolean>>;
    findFreePort: () => Promise<number | null>;
    getGatewayPort: () => Promise<number>;
    getGatewayStatus: () => Promise<GatewayStatus>;
    getRuntimeState: () => Promise<RuntimeState>;
    setAppConfig: (update: { language?: 'en' | 'ru' | 'zh' | 'hi' | 'es' | 'fr' | 'ar'; setupComplete?: boolean; performanceMode?: 'day' | 'night' | 'auto'; requestDeadlineMs?: number; llmStatsEnabled?: boolean }) => Promise<AppConfig>;
    setGatewayPort: (port: number) => Promise<GatewayStatus>;
    retryGateway: (port?: number) => Promise<GatewayStatus>;
    toggleAutoLaunch: (enable: boolean) => Promise<boolean>;
    getAutoLaunch: () => Promise<boolean>;
    getAppVersion: () => Promise<string>;
    getUpdateStatus: () => Promise<UpdaterStatus>;
    checkForUpdates: () => Promise<UpdaterStatus>;
    getModels: () => Promise<{ models: ModelConfig[] }>;
    refreshModels: () => Promise<{ models: ModelConfig[] }>;
    updateModelSettings: (id: string, settings: { enabled?: boolean; mode?: 'day' | 'night' | 'auto' }) => Promise<ModelConfig>;
    toggleModel: (id: string, enabled: boolean) => Promise<ModelConfig>;
    bulkToggleModels: (enabled: boolean) => Promise<ModelConfig[]>;
    adminListKeys: () => Promise<{ keys: ApiKey[] }>;
    adminAddKey: (key: string) => Promise<unknown>;
    adminRemoveKey: (id: string) => Promise<unknown>;
    adminSetStatus: (id: string, status: string) => Promise<unknown>;
    adminReorder: (ids: string[]) => Promise<unknown>;
    adminLogs: () => Promise<{ logs: Array<{ level: string; message: string }> }>;
    adminValidateKey: (key: string) => Promise<{ valid?: boolean | null; status?: number; statusCode?: number; reason?: string; error?: string }>;
    getGatewayCredentials: () => Promise<{ port: number; gatewayToken: string }>;
    errorReport: {
      log: (entry: ErrorEntry) => Promise<void>;
      getCount: () => Promise<number>;
      preview: () => Promise<ErrorEntry[]>;
      send: () => Promise<ErrorReportResult>;
    };
    feedback: {
      save: (data: FeedbackData) => Promise<FeedbackResult>;
      openGitHubIssue: (data: FeedbackData) => Promise<void>;
    };
    openExternal: (url: string) => Promise<void>;
    clipboard: {
      writeText: (text: string) => Promise<void>;
    };
    diagnostic: {
      export: () => Promise<DiagnosticExportResult>;
    };
    about: {
      getInfo: () => Promise<AboutInfo>;
    };
    onNavigateAbout: (callback: () => void) => () => void;
    onNavigateFeedback: (callback: () => void) => () => void;
    // Main->renderer PUSH for gateway status (channel 'gateway-status-changed').
    // Send-only from main: no invoke counterpart exists. Returns an unsubscribe
    // function; the renderer must unsubscribe on effect cleanup so a remounting
    // component cannot stack listeners on a channel that fires per transition.
    onGatewayStatusChanged: (callback: (status: GatewayStatus) => void) => () => void;
    // Main->renderer PUSH (channel 'window-state') of main's BrowserWindow view,
    // plus a secured invoke for the current value (null while no window exists).
    onWindowState?: (callback: (state: WindowState) => void) => () => void;
    getWindowState?: () => Promise<WindowState | null>;
  }
}

interface WindowState {
  visible: boolean;
  focused: boolean;
  minimized: boolean;
}

interface ErrorEntry {
  timestamp: string;
  type: 'uncaughtException' | 'unhandledRejection' | 'gateway' | 'renderer';
  message: string;
  stack?: string;
  source?: string;
}

interface FeedbackData {
  type: 'suggestion' | 'bug';
  title: string;
  description: string;
  email?: string;
  attachDiagnostic: boolean;
}

interface AboutInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  proxyPort: number;
  adminPort: number;
  repoUrl: string;
}

interface ErrorReportResult {
  success: boolean;
  count: number;
  message: string;
}

interface FeedbackResult {
  success: boolean;
  path?: string;
  message: string;
}

interface DiagnosticExportResult {
  success: boolean;
  path?: string;
  message: string;
}

  interface AppConfig { gatewayPort: number; language: 'en' | 'ru' | 'zh' | 'hi' | 'es' | 'fr' | 'ar'; setupComplete: boolean; performanceMode: 'day' | 'night' | 'auto' }
interface RuntimeState extends AppConfig { status: GatewayStatus; version: string; autoLaunch: boolean; requestDeadlineMs: number; requestDeadlineSource: 'env' | 'config' | 'default'; llmStatsEnabled: boolean }

interface GatewayStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  port?: number;
  code?: 'PORT_IN_USE' | 'START_FAILED' | 'RUNTIME_EXIT';
  message?: string;
}

interface UpdaterStatus {
  state: 'none' | 'checking' | 'available' | 'downloading' | 'ready' | 'upToDate' | 'error';
  version: string | null;
  percent: number | null;
}

interface ModelConfig {
  id: string;
  name: string;
  enabled: boolean;
  mode: 'day' | 'night' | 'auto';
  deprecated: boolean;
  // Phase 5 catalog enrichment (all optional, backwards-compatible):
  // Sourced from NGC catalog metadata via admin-api.mjs GET /admin/models.
  // Absent for a pre-Phase-5 gateway, NGC-unreachable, or unlisted models — the
  // renderer treats them as optional ('Unknown' / placeholder UI on absence).
  provider?: string | null;
  publisher?: string | null;
  shortDescription?: string;
  category?: string | null;
  labels?: string[];
  // NOTE: this stays `number` (NOT `| null`) deliberately. The backend CAN emit an
  // explicit null for an unknown invocation count (nvidia-catalog-sync.mjs
  // recordToMetadata() → admin-api.mjs:336-338 → copied verbatim by mapModelCatalog,
  // models-ipc.ts:202-204), but every consumer already treats absence as "no value":
  // models-filter.ts:176/222 read `typeof m.popularity === 'number' ? … : 0`, and the
  // drawer/card gate through formatPopularity(), which returns null for both null and
  // undefined. Widening this type to `| null` only makes the transport null provable at
  // the `FilterableModel` boundary (models-filter.ts:46 declares `popularity?: number`
  // and is the structural type the view's filtered list flows through), so the raw
  // null is absorbed BEFORE it can reach JSX.
  popularity?: number;
  lastUpdated?: string | null;
  logoUrl?: string | null;
  downloadable?: boolean;
  freeEndpoint?: boolean;
  // Round E model-strength ranking (LLM Stats — see src/gateway/llm-stats-ranking.mjs).
  // Copied verbatim by mapModelCatalog; ABSENT (undefined) for the 58 models with
  // no genuine LLM Stats counterpart, so the UI renders "—" rather than a guess.
  // `llmStatsRank` is the source's published overall position (1 = strongest).
  // The ranking is displayed with the source attribution "Data by LLM Stats".
  llmStatsRank?: number;
  llmStatsScore?: number;
  llmStatsMatchedVia?: string;
  // Round 1b technical data (all optional, backwards-compatible). Copied verbatim
  // from GET /admin/models (admin-api.mjs:312-314) by mapModelCatalog in
  // src/main/models-ipc.ts. Absent when the gateway does not carry it; the
  // renderer then omits the row instead of showing a default.
  context_length?: number;
  max_completion_tokens?: number;
  capabilities?: ModelCapabilities;
}

/** Capability metadata shape served by GET /admin/models (capability-registry). */
interface ModelCapabilities {
  reasoning?: {
    supported?: boolean;
    modes?: string[];
    controlKey?: string | null;
    defaultMode?: string | null;
  };
  tools?: boolean;
  vision?: boolean;
  audio?: boolean;
}
