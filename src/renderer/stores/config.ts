import { create } from 'zustand';

export type AppLanguage = 'en' | 'ru' | 'zh' | 'hi' | 'es' | 'fr' | 'ar';

interface ConfigState {
  hydrated: boolean;
  setupComplete: boolean;
  language: AppLanguage;
  gatewayPort: number;
  hydrate: (config: AppConfig) => void;
  setConfig: (config: Partial<AppConfig>) => void;
}

export const useConfigStore = create<ConfigState>()(
    (set) => ({
      hydrated: false,
      setupComplete: false,
      language: 'en',
      gatewayPort: 12000,
      hydrate: (config) => set({ ...config, hydrated: true }),
      setConfig: (config) => set(config),
    })
);
