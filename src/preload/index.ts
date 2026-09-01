import { contextBridge, ipcRenderer } from 'electron'
// Type-only, so it is ERASED at compile time and adds no runtime coupling
// between the sandboxed preload and the main bundle. It keeps the pushed payload
// shape tied to the single source of truth instead of drifting from a duplicate.
import type { GatewayStatus } from '../main/gateway-lifecycle'

// Must match GATEWAY_STATUS_CHANNEL in src/main/index.ts. The agreement is
// verified behaviourally, not by eye: tests/gateway-status-push.test.mjs takes
// the channel from what MAIN actually sends and asserts THIS listener receives
// on it, so a rename on either side fails the suite.
const GATEWAY_STATUS_CHANNEL = 'gateway-status-changed'

function invokeAdmin(channel: string, ...args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke(channel, ...args).then((result: unknown) => {
    if (isGatewayNotRunning(result)) {
      const value = result as { error: { message: string; code: string } };
      const error = new Error(value.error.message);
      error.name = value.error.code;
      throw error;
    }
    return result;
  });
}

function isGatewayNotRunning(result: unknown): result is { ok: false; error: { code: string; message: string } } {
  if (!result || typeof result !== 'object') return false;
  const value = result as { ok?: boolean; error?: { code?: string; message?: string } };
  return value.ok === false
    && value.error?.code === 'GATEWAY_NOT_RUNNING'
    && typeof value.error.message === 'string';
}

contextBridge.exposeInMainWorld('electronAPI', {
  checkPorts: (ports: number[]) => ipcRenderer.invoke('check-ports', ports),
  findFreePort: () => ipcRenderer.invoke('find-free-port'),
  getGatewayPort: () => ipcRenderer.invoke('get-gateway-port'),
  getGatewayStatus: () => ipcRenderer.invoke('get-gateway-status'),
  getRuntimeState: () => ipcRenderer.invoke('get-runtime-state'),
  setAppConfig: (update: { language?: 'en' | 'ru' | 'zh' | 'hi' | 'es' | 'fr' | 'ar'; setupComplete?: boolean; performanceMode?: 'day' | 'night' | 'auto' }) => ipcRenderer.invoke('set-app-config', update),
  setGatewayPort: (port: number) => ipcRenderer.invoke('set-gateway-port', port),
  retryGateway: (port?: number) => ipcRenderer.invoke('retry-gateway', port),
  toggleAutoLaunch: (enable: boolean) => ipcRenderer.invoke('toggle-auto-launch', enable),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getModels: () => invokeAdmin('get-models'),
  refreshModels: () => invokeAdmin('refresh-models'),
  updateModelSettings: (id: string, settings: { enabled?: boolean; mode?: 'day' | 'night' | 'auto' }) => invokeAdmin('update-model-settings', id, settings),
  toggleModel: (id: string, enabled: boolean) => invokeAdmin('toggle-model', id, enabled),
  bulkToggleModels: (enabled: boolean) => invokeAdmin('bulk-toggle-models', enabled),
  adminListKeys: () => invokeAdmin('admin-list-keys'),
  adminAddKey: (key: string) => invokeAdmin('admin-add-key', key),
  adminRemoveKey: (id: string) => invokeAdmin('admin-remove-key', id),
  adminSetStatus: (id: string, status: string) => invokeAdmin('admin-set-status', id, status),
  adminReorder: (ids: string[]) => invokeAdmin('admin-reorder', ids),
  adminLogs: () => invokeAdmin('admin-logs'),
  adminGetPerformance: () => invokeAdmin('admin-get-performance'),
  adminValidateKey: (key: string) => invokeAdmin('admin-validate-key', key),
  getGatewayCredentials: () => ipcRenderer.invoke('get-gateway-credentials'),
  errorReport: {
    log: (entry: { timestamp: string; type: string; message: string; stack?: string; source?: string }) => ipcRenderer.invoke('error-report:log', entry),
    getCount: () => ipcRenderer.invoke('error-report:get-count'),
    preview: () => ipcRenderer.invoke('error-report:preview'),
    send: () => ipcRenderer.invoke('error-report:send')
  },
  feedback: {
    save: (data: { type: 'suggestion' | 'bug'; title: string; description: string; email?: string; attachDiagnostic: boolean }) => ipcRenderer.invoke('feedback:save', data),
    openGitHubIssue: (data: { type: 'suggestion' | 'bug'; title: string; description: string; email?: string; attachDiagnostic: boolean }) => ipcRenderer.invoke('feedback:open-github-issue', data)
  },
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  // Write-only by design: no read counterpart is exposed, so a renderer can put
  // text on the clipboard but never pull it back.
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text)
  },
  diagnostic: {
    export: () => ipcRenderer.invoke('diagnostic:export')
  },
  about: {
    getInfo: () => ipcRenderer.invoke('about:get-info')
  },
  onNavigateAbout: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('navigate-about', listener);
    return () => { ipcRenderer.removeListener('navigate-about', listener); };
  },
  onNavigateFeedback: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('navigate-feedback', listener);
    return () => { ipcRenderer.removeListener('navigate-feedback', listener); };
  },
  // Main->renderer PUSH for gateway status. Read-only from the renderer's side:
  // there is no invoke counterpart, so this cannot be used to trigger or forge a
  // status change, only to hear about one.
  //
  // The IpcRendererEvent is deliberately NOT forwarded — exactly as the two
  // onNavigate* bridges above drop it. `event.sender` is a live IPC handle, and
  // handing it to renderer code would widen the bridge far past one status
  // object. The callback receives the status and nothing else.
  //
  // Returns an unsubscribe function so a remounting component cannot stack
  // listeners on a channel that fires on every gateway transition.
  onGatewayStatusChanged: (callback: (status: GatewayStatus) => void) => {
    const listener = (_event: unknown, status: GatewayStatus) => callback(status);
    ipcRenderer.on(GATEWAY_STATUS_CHANNEL, listener);
    return () => { ipcRenderer.removeListener(GATEWAY_STATUS_CHANNEL, listener); };
  }
})
