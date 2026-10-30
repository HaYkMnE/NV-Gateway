export const queryKeys = { runtime: ['runtime'] as const, keys: ['keys'] as const, logs: ['logs'] as const, updates: ['updates'] as const, models: ['models'] as const };
export const api = {
  runtime: () => window.electronAPI.getRuntimeState(),
  keys: () => window.electronAPI.adminListKeys(),
  logs: () => window.electronAPI.adminLogs(),
  updateStatus: () => window.electronAPI.getUpdateStatus(),
  models: () => window.electronAPI.getModels(),
  refreshModels: () => window.electronAPI.refreshModels()
};
