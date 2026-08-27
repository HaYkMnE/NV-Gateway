import type { GatewayState, KeyItem, AppSettings, LogEntry, PortScanResult } from '../../preload';

export interface FrontendSnapshot {
  state: GatewayState | null;
  keys: KeyItem[];
  settings: AppSettings | null;
  logs: LogEntry[];
  scanResult: PortScanResult | null;
  isStale: boolean;
  hasHydrated: boolean;
  selectedKeyId: string | null;
  portInput: string;
  isKeyInputVisible: boolean;
  activeDialog: 'settings' | 'about' | 'feedback' | 'port' | null;
  viewMode: 'status' | 'keys' | 'logs' | 'settings';
}

export const initialFrontendSnapshot: FrontendSnapshot = {
  state: null,
  keys: [],
  settings: null,
  logs: [],
  scanResult: null,
  isStale: false,
  hasHydrated: false,
  selectedKeyId: null,
  portInput: '8080',
  isKeyInputVisible: false,
  activeDialog: null,
  viewMode: 'status',
};

export type FrontendAction =
  | { type: 'HYDRATE'; payload: { state: GatewayState; keys: KeyItem[]; settings: AppSettings; logs: LogEntry[] } }
  | { type: 'SET_GATEWAY_STATE'; payload: GatewayState }
  | { type: 'SET_KEYS'; payload: KeyItem[] }
  | { type: 'SET_SETTINGS'; payload: AppSettings }
  | { type: 'SET_LOGS'; payload: LogEntry[] }
  | { type: 'APPEND_LOG'; payload: LogEntry }
  | { type: 'SET_SCAN_RESULT'; payload: PortScanResult | null }
  | { type: 'SET_STALE'; payload: boolean }
  | { type: 'SELECT_KEY'; payload: string | null }
  | { type: 'SET_PORT_INPUT'; payload: string }
  | { type: 'SET_KEY_INPUT_VISIBLE'; payload: boolean }
  | { type: 'OPEN_DIALOG'; payload: 'settings' | 'about' | 'feedback' | 'port' }
  | { type: 'CLOSE_DIALOG' }
  | { type: 'SET_VIEW_MODE'; payload: 'status' | 'keys' | 'logs' | 'settings' };

export function frontendReducer(state: FrontendSnapshot, action: FrontendAction): FrontendSnapshot {
  switch (action.type) {
    case 'HYDRATE':
      return {
        ...state,
        state: action.payload.state,
        keys: action.payload.keys,
        settings: action.payload.settings,
        logs: action.payload.logs,
        portInput: String(action.payload.state.port || state.portInput),
        hasHydrated: true,
        isStale: false,
      };

    case 'SET_GATEWAY_STATE':
      return {
        ...state,
        state: action.payload,
        portInput: String(action.payload.port || state.portInput),
      };

    case 'SET_KEYS':
      return {
        ...state,
        keys: action.payload,
      };

    case 'SET_SETTINGS':
      return {
        ...state,
        settings: action.payload,
      };

    case 'SET_LOGS':
      return {
        ...state,
        logs: action.payload,
      };

    case 'APPEND_LOG': {
      const logs = [...state.logs, action.payload];
      if (logs.length > 1000) {
        logs.splice(0, logs.length - 1000);
      }
      return {
        ...state,
        logs,
      };
    }

    case 'SET_SCAN_RESULT':
      return {
        ...state,
        scanResult: action.payload,
      };

    case 'SET_STALE':
      return {
        ...state,
        isStale: action.payload,
      };

    case 'SELECT_KEY':
      return {
        ...state,
        selectedKeyId: action.payload,
      };

    case 'SET_PORT_INPUT':
      return {
        ...state,
        portInput: action.payload,
      };

    case 'SET_KEY_INPUT_VISIBLE':
      return {
        ...state,
        isKeyInputVisible: action.payload,
      };

    case 'OPEN_DIALOG':
      return {
        ...state,
        activeDialog: action.payload,
      };

    case 'CLOSE_DIALOG':
      return {
        ...state,
        activeDialog: null,
      };

    case 'SET_VIEW_MODE':
      return {
        ...state,
        viewMode: action.payload,
      };

    default:
      return state;
  }
}

export function deriveGatewayStatusText(state: GatewayState | null): string {
  if (!state) return 'offline';
  if (state.status === 'running') return 'online';
  if (state.status === 'starting') return 'starting';
  if (state.status === 'error') return 'error';
  return 'stopped';
}

export function validatePortNumber(portStr: string): { isValid: boolean; errorKey?: string; port?: number } {
  const trimmed = portStr.trim();
  if (!trimmed) {
    return { isValid: false, errorKey: 'port_required' };
  }

  const port = Number(trimmed);
  if (!Number.isInteger(port)) {
    return { isValid: false, errorKey: 'port_integer' };
  }

  if (port < 1 || port > 65534) {
    return { isValid: false, errorKey: 'port_range' };
  }

  return { isValid: true, port };
}
