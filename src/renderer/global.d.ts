interface Window {
  electronAPI: {
    checkPorts: (ports: number[]) => Promise<Record<number, boolean>>;
    findFreePort: () => Promise<number | null>;
    getGatewayPort: () => Promise<number>;
    getGatewayStatus: () => Promise<GatewayStatus>;
    getRuntimeState: () => Promise<RuntimeState>;
    setAppConfig: (update: { language?: 'en' | 'ru' | 'zh' | 'hi' | 'es' | 'fr' | 'ar'; setupComplete?: boolean; performanceMode?: 'day' | 'night' | 'auto' }) => Promise<AppConfig>;
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
    adminValidateKey: (key: string) => Promise<{ valid?: boolean; status?: number; error?: string }>;
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
    diagnostic: {
      export: () => Promise<DiagnosticExportResult>;
    };
    about: {
      getInfo: () => Promise<AboutInfo>;
    };
    onNavigateAbout: (callback: () => void) => () => void;
    onNavigateFeedback: (callback: () => void) => () => void;
  }
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
interface RuntimeState extends AppConfig { status: GatewayStatus; version: string; autoLaunch: boolean }

interface GatewayStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  port?: number;
  code?: 'PORT_IN_USE' | 'START_FAILED';
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
  popularity?: number;
  lastUpdated?: string | null;
  logoUrl?: string | null;
  downloadable?: boolean;
  freeEndpoint?: boolean;
}
