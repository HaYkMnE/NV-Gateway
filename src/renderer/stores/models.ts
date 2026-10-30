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
  // Mirrors global.d.ts ModelConfig — stays `number` on purpose. The backend can
  // emit an explicit null for an unknown count, but the renderer absorbs it before
  // it reaches JSX: every consumer gates through formatPopularity() (which returns
  // null for null AND undefined), and models-filter.ts declares `popularity?: number`
  // as the structural FilterableModel the view passes its list through.
  popularity?: number;
  lastUpdated?: string | null;
  logoUrl?: string | null;
  downloadable?: boolean;
  freeEndpoint?: boolean;
  // Round 1b technical data (all optional, backwards-compatible). Sourced from
  // GET /admin/models (admin-api.mjs:312-314) via mapModelCatalog. Absent when
  // the gateway does not carry it — the drawer then omits the row.
  context_length?: number;
  max_completion_tokens?: number;
  capabilities?: ModelCapabilities;
  // Round E model-strength ranking (LLM Stats). Absent for the models that have
  // no genuine LLM Stats counterpart — the strength sort then places them last
  // and the drawer shows "—", never a fabricated position.
  llmStatsRank?: number;
  llmStatsScore?: number;
  llmStatsMatchedVia?: string;
}

/** Capability metadata shape served by GET /admin/models (capability-registry). */
export interface ModelCapabilities {
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
