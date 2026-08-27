import { create } from 'zustand';

export interface ModelEntry {
  id: string;
  name: string;
  enabled: boolean;
  mode: 'day' | 'night' | 'auto';
  deprecated: boolean;
  // Phase 5 catalog enrichment (all optional, backwards-compatible):
  // Mirrors global.d.ts ModelConfig — sourced from NGC catalog metadata via the
  // admin-api response. Absent for unlisted-or-unreachable cases (renderer
  // degrades gracefully via placeholder UI on absence).
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

interface ModelsState {
  models: ModelEntry[];
  loading: boolean;
  error: string | null;
  lastRefreshed: number | null;
  setModels: (models: ModelEntry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setLastRefreshed: (timestamp: number | null) => void;
}

export const useModelsStore = create<ModelsState>()(
  (set) => ({
    models: [],
    loading: false,
    error: null,
    lastRefreshed: null,
    setModels: (models) => set({ models }),
    setLoading: (loading) => set({ loading }),
    setError: (error) => set({ error }),
    setLastRefreshed: (timestamp) => set({ lastRefreshed: timestamp }),
  })
);
