import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Code,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  Radio,
  Server,
} from 'lucide-react';
import { api, queryKeys } from '../lib/api';
import { useGatewayLifecycle } from '../lib/gateway-lifecycle';
import { useConfigStore } from '../stores/config';
import { ProviderGlyph, resolveProvider } from '../components/ProviderGlyph';

function providerSlugOf(m: { publisher?: string | null; provider?: string | null; id: string }): string | null {
  return m.publisher ?? m.provider ?? (m.id.includes('/') ? m.id.split('/')[0] : null);
}

type ConfigTab = 'opencode' | 'cursor' | 'cloudcode' | 'openai' | 'anthropic';

export function Endpoint() {
  const { t } = useTranslation();
  const lifecycle = useGatewayLifecycle();
  const { gatewayPort } = useConfigStore();
  const [showToken, setShowToken] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [configTab, setConfigTab] = useState<ConfigTab>('opencode');
  const [isConfigOpen, setIsConfigOpen] = useState(true);

  // Fetch gateway credentials (port + token) via the get-gateway-credentials IPC.
  const credsQuery = useQuery({
    queryKey: ['gateway-credentials'],
    queryFn: () => window.electronAPI.getGatewayCredentials(),
    enabled: lifecycle.status?.state === 'running',
  });
  const gatewayToken = credsQuery.data?.gatewayToken ?? '';
  const port = credsQuery.data?.port ?? gatewayPort;

  // Fetch enabled models only.
  const modelsQuery = useQuery({
    queryKey: queryKeys.models,
    queryFn: api.models,
    enabled: lifecycle.status?.state === 'running',
  });
  const models = (modelsQuery.data?.models ?? []).filter((m) => m.enabled);

  // Fetch upstream keys count for the HUD.
  const keysQuery = useQuery({
    queryKey: queryKeys.keys,
    queryFn: api.keys,
    enabled: lifecycle.status?.state === 'running',
  });
  const keysCount = keysQuery.data?.keys?.length ?? 0;

  const copy = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(null), 2000);
    } catch {
      /* ignore clipboard errors */
    }
  };

  const baseUrl = `http://127.0.0.1:${port}/v1`;

  // Per-client configuration blocks. All share the same base URL and gateway token;
  // only the enabled models and the per-client shape differ.
  const firstModelId = models[0]?.id ?? 'meta/llama-3.3-70b-instruct';
  const configs: Record<ConfigTab, { label: string; lang: string; content: string }> = {
    opencode: {
      label: 'OpenCode',
      lang: 'jsonc',
      content: JSON.stringify(
        {
          'NV-Gateway': {
            baseURL: baseUrl,
            apiKey: gatewayToken,
            models: Object.fromEntries(
              models.map((m) => [m.id, { name: m.name ?? m.id }])
            ),
          },
        },
        null,
        2
      ),
    },
    cursor: {
      label: 'Cursor',
      lang: 'json',
      content: JSON.stringify(
        {
          openai: {
            apiBase: baseUrl,
            apiKey: gatewayToken,
          },
          models: models.map((m) => ({
            model: m.id,
            title: m.name ?? m.id,
          })),
        },
        null,
        2
      ),
    },
    cloudcode: {
      label: 'CloudCode',
      lang: 'json',
      content: JSON.stringify(
        {
          baseURL: baseUrl,
          apiKey: gatewayToken,
          models: models.map((m) => m.id),
        },
        null,
        2
      ),
    },
    openai: {
      label: 'OpenAI',
      lang: 'python',
      content: [
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        `    base_url="${baseUrl}",`,
        `    api_key="${gatewayToken}"`,
        ')',
        '',
        'response = client.chat.completions.create(',
        `    model="${firstModelId}",`,
        '    messages=[{"role": "user", "content": "Hello!"}]',
        ')',
        'print(response.choices[0].message.content)',
      ].join('\n'),
    },
    anthropic: {
      label: 'Anthropic',
      lang: 'json',
      content: JSON.stringify(
        {
          baseURL: baseUrl,
          apiKey: gatewayToken,
          models: models.map((m) => m.id),
          note: 'NV-Gateway is OpenAI-compatible. For native Anthropic format (/v1/messages), use an OpenAI-to-Anthropic adapter (e.g., LiteLLM).',
        },
        null,
        2
      ),
    },
  };

  if (lifecycle.status?.state !== 'running') {
    return (
      <div role="alert" className="flex flex-col h-full p-4 sm:p-8 min-w-0 items-center justify-center text-center">
        <AlertTriangle aria-hidden size={40} className="text-warning mb-4" />
        <p className="text-lg">{t('gateway_stopped')}</p>
      </div>
    );
  }

  const tabs: ConfigTab[] = ['opencode', 'cursor', 'cloudcode', 'openai', 'anthropic'];
  const active = configs[configTab];

  return (
    <div className="flex flex-col h-full p-4 sm:p-8 min-w-0 overflow-y-auto">
      {/* View Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-textMain tracking-tight">{t('endpoint_title')}</h2>
        </div>
      </div>

      {/* Live Status HUD */}
      <section className="bg-surface/90 border border-border/90 rounded-xl p-5 mb-6 shadow-lg backdrop-blur-md">
        <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <Radio aria-hidden size={16} className="text-accent-neon animate-glow-pulse" />
            <span className="text-xs font-bold uppercase tracking-wider text-textMain">{t('endpoint_hud_gateway')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-accent-neon animate-glow-pulse shadow-[0_0_8px_#59FF00]" />
            <span className="text-xs font-mono font-bold text-accent-neon">{t('endpoint_status_online')}</span>
          </div>
        </div>

        {/* HUD Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <div className="bg-bg border border-border/70 p-3 rounded-lg">
            <div className="flex items-center gap-1.5 text-textMuted text-[11px] font-medium mb-1">
              <Server size={13} className="text-nvidia" />
              <span>{t('port')}</span>
            </div>
            <div className="font-mono text-base font-bold text-textMain">{port}</div>
          </div>

          <div className="bg-bg border border-border/70 p-3 rounded-lg">
            <div className="flex items-center gap-1.5 text-textMuted text-[11px] font-medium mb-1">
              <KeyRound size={13} className="text-accent-cyan" />
              <span>{t('endpoint_key_pool')}</span>
            </div>
            <div className="font-mono text-base font-bold text-textMain">{keysCount} {t('keys_short')}</div>
          </div>

          <div className="bg-bg border border-border/70 p-3 rounded-lg">
            <div className="flex items-center gap-1.5 text-textMuted text-[11px] font-medium mb-1">
              <Cpu size={13} className="text-accent-neon" />
              <span>{t('endpoint_active_models')}</span>
            </div>
            <div className="font-mono text-base font-bold text-textMain">{models.length}</div>
          </div>

          <div className="bg-bg border border-border/70 p-3 rounded-lg">
            <div className="flex items-center gap-1.5 text-textMuted text-[11px] font-medium mb-1">
              <Activity size={13} className="text-purple-400" />
              <span>{t('endpoint_latency')}</span>
            </div>
            <div className="font-mono text-xs font-semibold text-purple-300 mt-1">{t('endpoint_latency_subms')}</div>
          </div>
        </div>

        {/* Connection Credentials (Base URL + Gateway Token) */}
        <div className="space-y-4 pt-2">
          {/* Base URL */}
          <div>
            <label className="block text-xs font-semibold text-textMuted uppercase tracking-wider mb-1.5">{t('endpoint_base_url')}</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-bg border border-border/90 px-3.5 py-2 text-sm font-mono text-accent-neon rounded-lg break-all select-all">
                {baseUrl}
              </code>
              <button
                type="button"
                onClick={() => copy(baseUrl, 'url')}
                className="px-3.5 py-2 border border-border hover:border-accent-neon/60 bg-surface hover:bg-bg text-accent-neon text-xs font-medium rounded-lg flex items-center gap-1.5 shrink-0 transition-all cursor-pointer animate-tactile-tick"
                aria-label={t('copy')}
              >
                {copiedField === 'url' ? <Check aria-hidden size={15} /> : <Copy aria-hidden size={15} />}
                <span>{copiedField === 'url' ? t('copied') : t('copy')}</span>
              </button>
            </div>
          </div>

          {/* Gateway Token */}
          <div>
            <label className="block text-xs font-semibold text-textMuted uppercase tracking-wider mb-1.5">{t('endpoint_gateway_token')}</label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={gatewayToken}
                  readOnly
                  className="w-full bg-bg border border-border/90 px-3.5 py-2 pr-10 font-mono text-sm text-textMain rounded-lg outline-none select-all"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  aria-label={showToken ? t('hide_key') : t('show_key')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-textMuted hover:text-accent-neon p-1 transition-colors cursor-pointer"
                >
                  {showToken ? <EyeOff aria-hidden size={16} /> : <Eye aria-hidden size={16} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => copy(gatewayToken, 'token')}
                className="px-3.5 py-2 border border-border hover:border-accent-neon/60 bg-surface hover:bg-bg text-accent-neon text-xs font-medium rounded-lg flex items-center gap-1.5 shrink-0 transition-all cursor-pointer animate-tactile-tick"
                aria-label={t('copy')}
              >
                {copiedField === 'token' ? <Check aria-hidden size={15} /> : <Copy aria-hidden size={15} />}
                <span>{copiedField === 'token' ? t('copied') : t('copy')}</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Collapsible Client Configuration */}
      <section className="mb-6">
        <button
          type="button"
          onClick={() => setIsConfigOpen((v) => !v)}
          className="flex items-center justify-between w-full p-4 bg-surface/90 border border-border hover:border-accent-neon/50 rounded-xl transition-all text-left cursor-pointer"
          aria-expanded={isConfigOpen}
        >
          <div className="flex items-center gap-2.5">
            <Code aria-hidden size={18} className="text-nvidia" />
            <span className="text-sm font-bold text-textMain">{t('endpoint_configuration')}</span>
            <span className="text-xs font-mono text-textMuted">({tabs.length} {t('endpoint_clients_count')})</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-textMuted">
            <span>{isConfigOpen ? t('endpoint_hide_config') : t('endpoint_show_config')}</span>
            {isConfigOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {isConfigOpen && (\n          <div className="mt-2.5 p-5 bg-surface border border-border rounded-xl space-y-4">
            {/* Tab Selector */}
            <div className="flex flex-wrap gap-2">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setConfigTab(tab)}
                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                    configTab === tab
                      ? 'border border-accent-neon text-accent-neon bg-accent-neon/10 font-bold shadow-[0_0_10px_rgba(89,255,0,0.2)]'
                      : 'border border-border text-textMuted hover:border-textMuted hover:text-textMain bg-bg'
                  }`}
                >
                  {configs[tab].label}
                </button>
              ))}
            </div>

            {/* Active Config Snippet */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-textMuted font-mono uppercase tracking-wider">{active.label} Configuration</span>
                <button
                  type="button"
                  onClick={() => copy(active.content, `config-${configTab}`)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-accent-neon hover:text-accent-neon/80 cursor-pointer animate-tactile-tick"
                >
                  {copiedField === `config-${configTab}` ? (
                    <>
                      <Check aria-hidden size={14} />
                      <span>{t('copied')}</span>
                    </>
                  ) : (
                    <>
                      <Copy aria-hidden size={14} />
                      <span>{t('copy')}</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="bg-[#080B09] border border-border p-4 text-xs font-mono text-textMain overflow-x-auto whitespace-pre-wrap break-all rounded-lg leading-relaxed shadow-inner">
                {active.content}
              </pre>
            </div>
          </div>
        )}
      </section>

      {/* Section 3: Enabled Models List (Directly Below) */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-textMain tracking-tight">
            {t('endpoint_enabled_models', { count: models.length })}
          </h3>
        </div>

        {models.length === 0 ? (
          <div className="bg-surface/60 border border-dashed border-border/80 p-6 rounded-xl text-center text-textMuted text-sm">
            <Cpu size={32} className="mx-auto mb-2 text-textMuted/60" />
            <p>{t('endpoint_no_models_enabled')}</p>
          </div>
        ) : (
          <div className="grid gap-2.5">
            {models.map((m) => {
              const slug = providerSlugOf(m);
              const providerInfo = resolveProvider(slug);
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-3 bg-surface border border-border/80 hover:border-accent-neon/40 p-3.5 rounded-xl transition-all"
                >
                  {/* Provider Glyph */}
                  <div
                    className="p-1.5 rounded-lg border shrink-0"
                    style={{
                      backgroundColor: providerInfo.tagBg,
                      borderColor: `${providerInfo.color}30`,
                    }}
                  >
                    <ProviderGlyph provider={slug} size={16} color={providerInfo.color} />
                  </div>

                  {/* Model ID & Name */}
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-sm text-textMain font-semibold break-all">{m.id}</div>
                    {m.name && m.name !== m.id ? (
                      <div className="text-xs text-textMuted mt-0.5 truncate">{m.name}</div>
                    ) : null}
                  </div>

                  {/* Status Badges */}
                  <div className="flex items-center gap-1.5 shrink-0 hidden sm:flex">
                    {m.freeEndpoint && (
                      <span className="px-2 py-0.5 text-[10px] font-bold bg-purple-950/70 text-purple-300 border border-purple-800/50 rounded-full">
                        {t('models_free_endpoint')}
                      </span>
                    )}
                    {m.downloadable && (
                      <span className="px-2 py-0.5 text-[10px] font-bold bg-cyan-950/70 text-cyan-300 border border-cyan-800/50 rounded-full">
                        {t('models_downloadable')}
                      </span>
                    )}
                  </div>

                  {/* Copy Button */}
                  <button
                    type="button"
                    onClick={() => copy(m.id, `model-${m.id}`)}
                    className="p-2 border border-border hover:border-accent-neon/50 bg-bg hover:bg-surface text-accent-neon rounded-lg shrink-0 transition-all cursor-pointer animate-tactile-tick"
                    aria-label={t('copy')}
                  >
                    {copiedField === `model-${m.id}` ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
