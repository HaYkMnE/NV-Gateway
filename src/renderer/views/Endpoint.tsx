import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
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
import { safeError, knownCount } from '../lib/frontend-state';
import { useGatewayLifecycle } from '../lib/gateway-lifecycle';
import { useConfigStore } from '../stores/config';
import { ProviderGlyph, resolveProvider } from '../components/ProviderGlyph';
import { buildOpenCodeConfig, hasUnresolvedPlaceholder } from './opencodeConfig';
import { focusPendingSetting, focusSettingFrom } from '../pet/tips';
import {
  CLIENT_LABELS,
  UI_STEPS,
  buildClientSnippets,
  clientGroups,
  endpointUrls,
  isUiClient,
  splitMenuChains,
  type ClientId,
  type Snippet,
  type SnippetClient,
  type StepValue,
} from './clientConfigs';

function providerSlugOf(m: { publisher?: string | null; provider?: string | null; id: string }): string | null {
  return m.publisher ?? m.provider ?? (m.id.includes('/') ? m.id.split('/')[0] : null);
}

type ConfigTab = ClientId;
type SnippetTab = 'opencode' | SnippetClient;

// OpenCode hint literals, rendered LTR/mono in <bdi> (the Settings.tsx:56
// env-name pattern, generalised to several placeholders): each {{name}} is
// interpolated as a \u0001-delimited marker, so splitting on \u0001 yields
// text at even indices and placeholder names at odd ones.
const OPENCODE_HINT_LITERALS = { block: 'provider.nvidia-gateway', file: 'opencode.json', globalPath: '~/.config/opencode/opencode.json' } as const;
const HINT_MARKERS = { block: '\u0001block\u0001', file: '\u0001file\u0001', globalPath: '\u0001globalPath\u0001' };

const COPY_BUTTON = 'px-3.5 py-2 border border-border hover:border-accent-neon/60 bg-surface hover:bg-bg text-accent-neon text-xs font-medium rounded-lg flex items-center gap-1.5 shrink-0 transition-all cursor-pointer animate-tactile-tick';
const SMALL_COPY_BUTTON = 'flex items-center gap-1.5 text-xs font-semibold text-accent-neon hover:text-accent-neon/80 cursor-pointer animate-tactile-tick min-h-6';
const ROW_LABEL = 'block text-xs font-semibold text-textMuted uppercase tracking-wider mb-1.5';
const CHIP_ACTIVE = 'border border-accent-neon text-accent-neon bg-accent-neon/10 font-bold shadow-[0_0_10px_rgba(89,255,0,0.2)]';
const CHIP_IDLE = 'border border-border text-textMuted hover:border-textMuted hover:text-textMain bg-bg';

export function Endpoint() {
  const { t } = useTranslation();
  const lifecycle = useGatewayLifecycle();
  const { gatewayPort } = useConfigStore();
  const [showToken, setShowToken] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const [copyError, setCopyError] = useState<string | null>(null);
  const [configTab, setConfigTab] = useState<ConfigTab>('opencode');
  const [isConfigOpen, setIsConfigOpen] = useState(true);
  // undefined = "not chosen yet": the first enabled model is used.
  const [selectedModel, setSelectedModel] = useState<string | undefined>();

  // Fetch gateway credentials (port + token) via the get-gateway-credentials IPC.
  const credsQuery = useQuery({
    queryKey: ['gateway-credentials'],
    queryFn: () => window.electronAPI.getGatewayCredentials(),
    enabled: lifecycle.status?.state === 'running',
  });
  const gatewayToken = credsQuery.data?.gatewayToken ?? '';
  const port = credsQuery.data?.port ?? gatewayPort;
  // A FAILED credentials fetch used to render an empty token field while the
  // Copy buttons still copied '' and announced "Copied". Now the failure is
  // explicit (with Retry) and copying is disabled whenever there is no token.
  const credsFailed = credsQuery.isError;
  const hasToken = gatewayToken.length > 0;

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
  // HONESTY: `?? 0` used to print "0 keys" / "0 active models" while the query
  // was still loading (or had failed), presenting an unknown as a fact. The
  // count is only rendered when the list actually arrived; an absent list means
  // the value is not known yet, so the HUD shows the loading label instead of 0.
  const keysCount = knownCount(keysQuery.data?.keys);
  // Same predicate as keysCount: a null list is as unknown as an absent one.
  // knownCount decides known/unknown; the value stays the ENABLED count.
  const modelsCount = knownCount(modelsQuery.data?.models) === null ? null : models.length;
  // A failed query also has no data; without this it would show "loading" forever.
  // Data that already arrived still wins over a later refetch error.
  const keysLabel = keysQuery.isError ? t('keys_error') : t('loading');
  const modelsLabel = modelsQuery.isError ? t('models_error') : t('loading');

  const announceCopySuccess = (message: string) => {
    setCopyFeedback('');
    window.setTimeout(() => setCopyFeedback(message), 0);
  };

  // Copy goes through the main process: navigator.clipboard rejects with
  // NotAllowedError whenever this tray-resident window is not focused. A failure
  // is reported rather than discarded -- silently swallowing it is what made the
  // Copy buttons look like they did nothing.
  // `embedsToken` says whether this particular string was composed from the
  // gateway token. Only those are refused while the credentials are missing;
  // base URLs and a real model id must copy normally. The <model-id>
  // placeholder is refused everywhere.
  const copy = async (text: string, field: string, embedsToken = false) => {
    if (text.length === 0) return;
    if (hasUnresolvedPlaceholder(text, gatewayToken, { embedsToken })) {
      setCopyError(t('endpoint_copy_unresolved'));
      return;
    }
    try {
      await window.electronAPI.clipboard.writeText(text);
      setCopyError(null);
      setCopiedField(field);
      announceCopySuccess(t('copied'));
      window.setTimeout(() => setCopiedField(null), 2000);
    } catch (error) {
      setCopyError(`${t('copy_failed')} ${safeError(error, t('unknown_error'))}`);
    }
  };

  // OpenAI-compatible clients get .../v1; Anthropic clients (Claude Code) get
  // the bare origin because they append /v1/messages themselves.
  const urls = endpointUrls(port);
  const baseUrl = urls.openai;
  const anthropicBaseUrl = urls.anthropic;

  // HONESTY: when no model is known yet (loading) or none is enabled, snippets
  // must not present a real-looking hardcoded model id the user may not have.
  // A clearly-marked placeholder is used instead.
  const activeModel = models.find((m) => m.id === selectedModel) ?? models[0];
  const modelId = activeModel?.id ?? '<model-id>';
  const contextLength = (activeModel as { context_length?: number } | undefined)?.context_length;

  // Per-client blocks. All share the same base URLs, gateway token and the
  // selected model; only the per-client shape differs.
  const configs: Record<SnippetTab, Snippet> = {
    opencode: {
      label: 'OpenCode',
      lang: 'jsonc',
      file: 'opencode.json',
      embedsToken: true,
      content: buildOpenCodeConfig(baseUrl, gatewayToken, models),
    },
    ...buildClientSnippets({ openaiBaseUrl: baseUrl, anthropicBaseUrl, token: gatewayToken, modelId, contextLength }),
  };

  // Pet-advisor target page: see Dashboard for the same flow. Runs before the
  // gateway-stopped early return so the hooks are unconditional.
  const gatewayRunning = lifecycle.status?.state === 'running';
  const location = useLocation(); const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<unknown>(focusSettingFrom(location.state));
  useLayoutEffect(() => { if (pendingFocus.current !== null) headingRef.current?.focus(); }, []);
  useEffect(() => {
    if (pendingFocus.current !== null && gatewayRunning && !modelsQuery.isPending) {
      focusPendingSetting(pendingFocus.current);
      pendingFocus.current = null;
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [gatewayRunning, modelsQuery.isPending]);

  if (lifecycle.status?.state !== 'running') {
    return (
      <div role="alert" className="flex flex-col h-full p-4 sm:p-8 min-w-0 items-center justify-center text-center">
        <AlertTriangle aria-hidden size={40} className="text-warning mb-4" />
        <p className="text-lg">{t('gateway_stopped')}</p>
      </div>
    );
  }

  const groups = clientGroups();
  const clientCount = groups.reduce((n, g) => n + g.clients.length, 0);
  const uiSteps = isUiClient(configTab) ? UI_STEPS[configTab] : null;
  const active: Snippet = isUiClient(configTab)
    ? { label: CLIENT_LABELS[configTab], lang: 'text', content: '', embedsToken: false }
    : configs[configTab];
  const opencodeHintParts = t('endpoint_opencode_hint', HINT_MARKERS).split('\u0001');

  const maskedToken = '•'.repeat(Math.min(Math.max(gatewayToken.length, 8), 24));
  const stepValues: Record<StepValue, { label: string; value: string; shown: string }> = {
    base: { label: t('endpoint_base_url_openai'), value: baseUrl, shown: baseUrl },
    token: { label: t('endpoint_gateway_token'), value: gatewayToken, shown: showToken ? gatewayToken : maskedToken },
    model: { label: t('endpoint_model_id'), value: modelId, shown: modelId },
  };

  // WCAG 2.5.3 (label in name): the accessible name follows the visible Copy/Copied
  // text; `k` is the same field key the button passes to copy().
  const copyAria = (k: string, label: string) => `${copiedField === k ? t('copied') : t('copy')} ${label}`;
  // A snippet is refused while unresolved only when its own content is
  // composed FROM the token (per-generator flag: Zed and Codex reach the token
  // indirectly, so their blocks stay copyable). The <model-id> placeholder is
  // refused everywhere.
  const canCopyContent = (content: string, embedsToken: boolean): boolean =>
    content.length > 0 && !hasUnresolvedPlaceholder(content, gatewayToken, { embedsToken });
  const copyIcon = (field: string) => (copiedField === field ? <Check aria-hidden size={15} /> : <Copy aria-hidden size={15} />);
  const copyText = (field: string) => <span>{copiedField === field ? t('copied') : t('copy')}</span>;
  const smallCopyContent = (field: string) =>
    copiedField === field ? (
      <>
        <Check aria-hidden size={14} />
        <span>{t('copied')}</span>
      </>
    ) : (
      <>
        <Copy aria-hidden size={14} />
        <span>{t('copy')}</span>
      </>
    );

  return (
    <div className="flex flex-col h-full p-4 sm:p-8 min-w-0 overflow-y-auto">
      {/* View Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-textMain tracking-tight">{t('endpoint_title')}</h2>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">{copyFeedback}</p>

      {/* A failed copy must be visible: this view copies the base URL and the
          gateway token, so a silent failure leaves the user pasting nothing. */}
      {copyError && (
        <div role="alert" className="border border-error bg-error/10 text-error p-3 mb-4 break-words rounded">
          {copyError}
        </div>
      )}

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
            <div dir="ltr" className="font-mono text-base font-bold text-textMain">{port}</div>
          </div>

          <div className="bg-bg border border-border/70 p-3 rounded-lg">
            <div className="flex items-center gap-1.5 text-textMuted text-[11px] font-medium mb-1">
              <KeyRound size={13} className="text-accent-cyan" />
              <span>{t('endpoint_key_pool')}</span>
            </div>
            <div className="font-mono text-base font-bold text-textMain">{keysCount === null && keysQuery.isError ? (
              <span className="inline-flex items-center gap-1.5" title={t('keys_error')}><AlertTriangle aria-hidden size={14} className="shrink-0 text-error" /><span aria-hidden="true" className="text-textMuted">—</span><span className="sr-only">{t('keys_error')}</span></span>
            ) : keysCount === null ? keysLabel : `${keysCount} ${t('keys_short')}`}</div>
          </div>

          <div className="bg-bg border border-border/70 p-3 rounded-lg">
            <div className="flex items-center gap-1.5 text-textMuted text-[11px] font-medium mb-1">
              <Cpu size={13} className="text-accent-neon" />
              <span>{t('endpoint_active_models')}</span>
            </div>
            <div className="font-mono text-base font-bold text-textMain">{modelsCount === null && modelsQuery.isError ? (
              <span className="inline-flex items-center gap-1.5" title={t('models_error')}><AlertTriangle aria-hidden size={14} className="shrink-0 text-error" /><span aria-hidden="true" className="text-textMuted">—</span><span className="sr-only">{t('models_error')}</span></span>
            ) : modelsCount === null ? modelsLabel : modelsCount}</div>
          </div>

          <div className="bg-bg border border-border/70 p-3 rounded-lg">
            <div className="flex items-center gap-1.5 text-textMuted text-[11px] font-medium mb-1">
              <Activity size={13} className="text-purple-400" />
              <span>{t('endpoint_latency')}</span>
            </div>
            <div className="font-mono text-xs font-semibold text-purple-300 mt-1">{t('endpoint_latency_subms')}</div>
          </div>
        </div>
      </section>

      {/* Section 2: universal connection values, then the per-client configuration */}
      <section className="mb-6">
        {/* Works with any app: the four values every client asks for. */}
        <div className="mb-2.5 p-5 bg-surface border border-border rounded-xl space-y-4">
          <h3 className="text-sm font-bold text-textMain">{t('endpoint_universal_title')}</h3>

          {/* Base URL (OpenAI-compatible) */}
          <div>
            <label className={ROW_LABEL}>{t('endpoint_base_url_openai')}</label>
            <div className="flex items-center gap-2">
              <code dir="ltr" className="flex-1 bg-bg border border-border/90 px-3.5 py-2 text-sm font-mono text-accent-neon rounded-lg break-all select-all">
                {baseUrl}
              </code>
              <button type="button" onClick={() => copy(baseUrl, 'url')} className={COPY_BUTTON} aria-label={copyAria('url', t('endpoint_base_url_openai'))}>
                {copyIcon('url')}
                {copyText('url')}
              </button>
            </div>
          </div>

          {/* Base URL (Anthropic, no /v1) */}
          <div>
            <label className={ROW_LABEL}>{t('endpoint_base_url_anthropic')}</label>
            <div className="flex items-center gap-2">
              <code dir="ltr" className="flex-1 bg-bg border border-border/90 px-3.5 py-2 text-sm font-mono text-accent-neon rounded-lg break-all select-all">
                {anthropicBaseUrl}
              </code>
              <button id="endpoint-url-anthropic" type="button" onClick={() => copy(anthropicBaseUrl, 'url-anthropic')} className={COPY_BUTTON} aria-label={copyAria('url-anthropic', t('endpoint_base_url_anthropic'))}>
                {copyIcon('url-anthropic')}
                {copyText('url-anthropic')}
              </button>
            </div>
          </div>

          {/* API key = the gateway token (masked, eye toggle) */}
          <div>
            <label htmlFor="endpoint-gateway-token" className={ROW_LABEL}>{t('endpoint_gateway_token')}</label>
            {credsFailed && (
              <div role="alert" className="mb-2 flex flex-wrap items-center gap-2 text-xs text-error break-words">
                <span>{t('endpoint_creds_error')}</span>
                <button type="button" onClick={() => void credsQuery.refetch()} className="underline hover:text-accent-neon">{t('retry')}</button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  id="endpoint-gateway-token"
                  dir="ltr"
                  type={showToken ? 'text' : 'password'}
                  value={gatewayToken}
                  readOnly
                  className="w-full bg-bg border border-border/90 px-3.5 py-2 pe-10 font-mono text-sm text-textMain rounded-lg outline-none select-all"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  aria-label={showToken ? t('hide_key') : t('show_key')}
                  className="absolute end-2.5 top-1/2 -translate-y-1/2 text-textMuted hover:text-accent-neon p-1 transition-colors cursor-pointer"
                >
                  {showToken ? <EyeOff aria-hidden size={16} /> : <Eye aria-hidden size={16} />}
                </button>
              </div>
              <button type="button" onClick={() => copy(gatewayToken, 'token', true)} disabled={!hasToken} className={COPY_BUTTON} style={hasToken ? undefined : { opacity: 0.5, cursor: 'not-allowed' }} aria-label={copyAria('token', t('endpoint_gateway_token'))}>
                {copyIcon('token')}
                {copyText('token')}
              </button>
            </div>
          </div>

          {/* Model ID: feeds every snippet below */}
          <div>
            <label htmlFor="endpoint-model-id" className={ROW_LABEL}>{t('endpoint_model_id')}</label>
            <div className="flex items-center gap-2">
              <select
                id="endpoint-model-id"
                dir="ltr"
                value={modelId}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={models.length === 0}
                className="flex-1 min-w-0 bg-bg border border-border/90 text-textMain px-2.5 py-1.5 text-xs rounded-lg outline-none focus:border-accent-neon/60"
              >
                {models.length === 0 ? (
                  <option value={modelId}>{modelId}</option>
                ) : (
                  models.map((m) => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))
                )}
              </select>
              <button type="button" onClick={() => copy(modelId, 'model-id')} disabled={modelId === '<model-id>'} style={modelId === '<model-id>' ? { opacity: 0.5, cursor: 'not-allowed' } : undefined} className={COPY_BUTTON} aria-label={copyAria('model-id', t('endpoint_model_id'))}>
                {copyIcon('model-id')}
                {copyText('model-id')}
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsConfigOpen((v) => !v)}
          className="flex items-center justify-between w-full p-4 bg-surface/90 border border-border hover:border-accent-neon/50 rounded-xl transition-all text-start cursor-pointer"
          aria-expanded={isConfigOpen}
        >
          <div className="flex items-center gap-2.5">
            <Code aria-hidden size={18} className="text-nvidia" />
            <span className="text-sm font-bold text-textMain">{t('endpoint_configuration')}</span>
            <span className="text-xs font-mono text-textMuted">({clientCount} {t('endpoint_clients_count')})</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-textMuted">
            <span>{isConfigOpen ? t('endpoint_hide_config') : t('endpoint_show_config')}</span>
            {isConfigOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {isConfigOpen && (
          <div className="mt-2.5 p-5 bg-surface border border-border rounded-xl space-y-4">
            {/* Client chips, in three labeled groups */}
            {groups.map((group) => (
              <div key={group.id} data-client-group={group.id} role="group" aria-labelledby={`endpoint-group-${group.id}`}>
                <span id={`endpoint-group-${group.id}`} className={ROW_LABEL}>{t(group.labelKey)}</span>
                <div className="flex flex-wrap gap-2">
                  {group.clients.map((client) => (
                    <button
                      key={client}
                      type="button"
                      aria-pressed={configTab === client}
                      onClick={() => setConfigTab(client)}
                      className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${configTab === client ? CHIP_ACTIVE : CHIP_IDLE}`}
                    >
                      {CLIENT_LABELS[client]}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {uiSteps ? (
              /* App-settings client: the menu path, then each value to paste */
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-textMuted font-mono uppercase tracking-wider">{t('endpoint_config_snippet_title', { client: active.label })}</span>
                </div>
                <ol className="grid gap-2 text-xs text-textMain">
                  {/* Menu chains are LTR-isolated (the hint's <bdi> pattern) so → keeps its direction in RTL. */}
                  <li>{splitMenuChains(t(uiSteps.stepsKey)).map((part, i) => (part.chain ? <bdi key={i} dir="ltr">{part.text}</bdi> : part.text))}</li>
                  {uiSteps.values.map((key) => (
                    <li key={key} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-textMuted">{stepValues[key].label}</span>
                      <code dir="ltr" className="flex-1 min-w-0 font-mono break-all">{stepValues[key].shown}</code>
                      <button type="button" onClick={() => copy(stepValues[key].value, `step-${key}`, key === 'token')} disabled={stepValues[key].value.length === 0} className={`${SMALL_COPY_BUTTON} disabled:opacity-50 disabled:cursor-not-allowed`} aria-label={copyAria(`step-${key}`, `${active.label}: ${stepValues[key].label}`)}>
                        {smallCopyContent(`step-${key}`)}
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              /* Snippet client: whole-snippet copy, target file in the header row */
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex flex-wrap items-baseline gap-2 min-w-0">
                    <span className="text-xs text-textMuted font-mono uppercase tracking-wider">{t('endpoint_config_snippet_title', { client: active.label })}</span>
                    {active.file && <code dir="ltr" className="text-xs font-mono text-textMuted break-all">{active.file}</code>}
                  </div>
                  <button
                    type="button"
                    onClick={() => copy(active.content, `config-${configTab}`, active.embedsToken)}
                    disabled={!canCopyContent(active.content, active.embedsToken)}
                    aria-label={copyAria(`config-${configTab}`, active.label)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-accent-neon hover:text-accent-neon/80 cursor-pointer animate-tactile-tick min-h-6 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {smallCopyContent(`config-${configTab}`)}
                  </button>
                </div>
                {configTab === 'opencode' && <p className="text-xs text-textMuted mb-2">{opencodeHintParts.map((part, i) => (i % 2 === 1 ? <bdi key={i} dir="ltr" className="font-mono">{OPENCODE_HINT_LITERALS[part as keyof typeof OPENCODE_HINT_LITERALS]}</bdi> : part))}</p>}
                <pre dir="ltr" className="bg-[#080B09] border border-border p-4 text-xs font-mono text-textMain overflow-x-auto whitespace-pre-wrap break-all rounded-lg leading-relaxed shadow-inner">
                  {active.content}
                </pre>
                {active.extra && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-textMuted font-mono uppercase tracking-wider">{active.extra.label}</span>
                      <button type="button" onClick={() => copy(active.extra!.content, `config-${configTab}-extra`, active.extra!.embedsToken)} disabled={!canCopyContent(active.extra!.content, active.extra!.embedsToken)} className={`${SMALL_COPY_BUTTON} disabled:opacity-50 disabled:cursor-not-allowed`} aria-label={copyAria(`config-${configTab}-extra`, `${active.label} ${active.extra.label}`)}>
                        {smallCopyContent(`config-${configTab}-extra`)}
                      </button>
                    </div>
                    <pre dir="ltr" className="bg-[#080B09] border border-border p-4 text-xs font-mono text-textMain overflow-x-auto whitespace-pre-wrap break-all rounded-lg leading-relaxed shadow-inner">
                      {active.extra.content}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Section 3: Enabled Models List (Directly Below) */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-textMain tracking-tight">
            {modelsCount === null ? modelsLabel : t('endpoint_enabled_models', { count: modelsCount })}
          </h3>
        </div>

        {modelsCount === null ? (
          <div role="status" className="bg-surface/60 border border-border/80 p-6 rounded-xl text-center text-textMuted text-sm">
            <p>{modelsLabel}</p>
          </div>
        ) : models.length === 0 ? (
          <div className="bg-surface/60 border border-dashed border-border/80 p-6 rounded-xl text-center text-textMuted text-sm">
            <Cpu size={32} className="mx-auto mb-2 text-textMuted" />
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
                    <div dir="ltr" className="font-mono text-sm text-textMain font-semibold break-all">{m.id}</div>
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
                    aria-label={copyAria(`model-${m.id}`, m.id)}
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
