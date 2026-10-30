// Per-client connection configs for the Endpoint view ("Works with any app").
// Every generator is pure: it takes the two base URLs, the gateway token and the
// selected model id and returns the exact text a user pastes. Values are always
// escaped for the target syntax (JSON via JSON.stringify; YAML/TOML/Python/JS
// double-quoted strings via JSON.stringify, whose escapes are a valid subset of
// each; PowerShell via single-quoted literals with '' doubling).

/** Codex needs `/v1/responses` (wire_api = "responses"). Switch off here if that route is not shipped. */
export const CODEX_SUPPORTED = true;

/** Zed requires max_tokens per model; used only when the catalog has no context length. */
export const ZED_DEFAULT_MAX_TOKENS = 128000;

export type SnippetClient =
  | 'claude-code' | 'continue' | 'hermes' | 'zed' | 'librechat' | 'codex'
  | 'aider' | 'openai-python' | 'openai-js' | 'curl';
export type UiClient = 'cline' | 'roo' | 'kilo' | 'cursor' | 'copilot' | 'openwebui';
export type ClientId = 'opencode' | SnippetClient | UiClient;

export interface Snippet {
  label: string;
  lang: string;
  content: string;
  /**
   * Whether `content` is composed FROM the gateway token. Only token-bearing
   * blocks are refused while the credentials fetch is failing; a block that
   * reaches the token indirectly (Zed: NV_GATEWAY_API_KEY env var, Codex:
   * env_key indirection) stays valid and copyable.
   */
  embedsToken: boolean;
  /** Target file for "Config file" clients, shown in the header row. */
  file?: string;
  /** A second copyable block (PowerShell env setup). */
  extra?: { label: string; content: string; embedsToken: boolean };
}

export interface SnippetContext {
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  token: string;
  modelId: string;
  contextLength?: number;
}

export const CLIENT_LABELS: Record<ClientId, string> = {
  opencode: 'OpenCode', 'claude-code': 'Claude Code', continue: 'Continue', hermes: 'Hermes', zed: 'Zed', librechat: 'LibreChat', codex: 'Codex',
  aider: 'Aider', 'openai-python': 'OpenAI Python', 'openai-js': 'OpenAI JS', curl: 'curl',
  cline: 'Cline', roo: 'Roo', kilo: 'Kilo', cursor: 'Cursor', copilot: 'Copilot BYOK', openwebui: 'Open WebUI',
};

export interface ClientGroup { id: 'file' | 'env' | 'ui'; labelKey: string; clients: ClientId[] }

export function clientGroups(codexSupported: boolean = CODEX_SUPPORTED): ClientGroup[] {
  const file: ClientId[] = ['opencode', 'claude-code', 'continue', 'hermes', 'zed', 'librechat'];
  if (codexSupported) file.push('codex');
  return [
    { id: 'file', labelKey: 'endpoint_group_file', clients: file },
    { id: 'env', labelKey: 'endpoint_group_env', clients: ['aider', 'openai-python', 'openai-js', 'curl'] },
    { id: 'ui', labelKey: 'endpoint_group_ui', clients: ['cline', 'roo', 'kilo', 'cursor', 'copilot', 'openwebui'] },
  ];
}

export function isUiClient(id: ClientId): id is UiClient {
  return id in UI_STEPS;
}

/** OpenAI clients call {base}/chat/completions, Anthropic clients append /v1/messages themselves. */
export function endpointUrls(port: number | string): { openai: string; anthropic: string } {
  const origin = `http://127.0.0.1:${port}`;
  return { openai: `${origin}/v1`, anthropic: origin };
}

const q = (s: string) => JSON.stringify(s);
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
const setx = (name: string, value: string) => `setx ${name} ${ps(value)}`;

export function buildClientSnippets(c: SnippetContext): Record<SnippetClient, Snippet> {
  const { openaiBaseUrl: base, anthropicBaseUrl: anthropic, token, modelId: model } = c;
  return {
    // https://code.claude.com/docs/en/env-vars ; https://code.claude.com/docs/en/llm-gateway
    'claude-code': {
      label: 'Claude Code',
      lang: 'json',
      embedsToken: true,
      file: '%USERPROFILE%\\.claude\\settings.json',
      content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: anthropic, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model } }, null, 2),
      extra: { label: 'PowerShell', content: [setx('ANTHROPIC_BASE_URL', anthropic), setx('ANTHROPIC_AUTH_TOKEN', token), setx('ANTHROPIC_MODEL', model)].join('\n'), embedsToken: true },
    },
    // https://docs.continue.dev/customize/model-providers/top-level/openai ; the top-level
    // name / version / schema are required by https://docs.continue.dev/reference
    continue: {
      label: 'Continue',
      lang: 'yaml',
      embedsToken: true,
      file: '%USERPROFILE%\\.continue\\config.yaml',
      content: ['name: NV-Gateway', 'version: 1.0.0', 'schema: v1', 'models:', `  - name: ${q('NV-Gateway')}`, '    provider: openai', `    model: ${q(model)}`, `    apiBase: ${q(base)}`, `    apiKey: ${q(token)}`].join('\n'),
    },
    // https://hermes-agent.nousresearch.com/docs/integrations/providers
    hermes: {
      label: 'Hermes',
      lang: 'yaml',
      embedsToken: true,
      file: '~/.hermes/config.yaml',
      content: ['model:', '  provider: custom', `  base_url: ${q(base)}`, `  api_key: ${q(token)}`, `  default: ${q(model)}`].join('\n'),
    },
    // https://zed.dev/docs/ai/use-api-access#openai-compatible-endpoints : the key is never
    // put in settings.json; Zed reads <PROVIDER_ID upper snake>_API_KEY -> NV_GATEWAY_API_KEY.
    zed: {
      label: 'Zed',
      lang: 'json',
      embedsToken: false,
      file: 'settings.json',
      content: JSON.stringify({ language_models: { openai_compatible: { 'NV-Gateway': { api_url: base, available_models: [{ name: model, max_tokens: c.contextLength ?? ZED_DEFAULT_MAX_TOKENS }] } } } }, null, 2),
      extra: { label: 'PowerShell', content: setx('NV_GATEWAY_API_KEY', token), embedsToken: true },
    },
    // https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/custom_endpoint
    librechat: {
      label: 'LibreChat',
      lang: 'yaml',
      embedsToken: true,
      file: 'librechat.yaml',
      content: ['endpoints:', '  custom:', `    - name: ${q('NV-Gateway')}`, `      apiKey: ${q(token)}`, `      baseURL: ${q(base)}`, '      models:', `        default: [${q(model)}]`, '        fetch: true'].join('\n'),
    },
    // https://github.com/openai/codex/blob/main/docs/config.md (model_providers, env_key, wire_api)
    codex: {
      label: 'Codex',
      lang: 'toml',
      embedsToken: false,
      file: '%USERPROFILE%\\.codex\\config.toml',
      content: [`model = ${q(model)}`, 'model_provider = "nv-gateway"', '', '[model_providers.nv-gateway]', 'name = "NV-Gateway"', `base_url = ${q(base)}`, 'env_key = "NV_GATEWAY_TOKEN"', 'wire_api = "responses"'].join('\n'),
      extra: { label: 'PowerShell', content: setx('NV_GATEWAY_TOKEN', token), embedsToken: true },
    },
    // https://aider.chat/docs/llms/openai-compat.html (OPENAI_API_BASE / OPENAI_API_KEY,
    // model prefixed openai/). $env: sets them for this PowerShell session; the doc's setx
    // variant persists them but needs a new shell.
    aider: {
      label: 'Aider',
      lang: 'powershell',
      embedsToken: true,
      content: [`$env:OPENAI_API_BASE = ${ps(base)}`, `$env:OPENAI_API_KEY = ${ps(token)}`, `aider --model ${ps(`openai/${model}`)}`].join('\n'),
    },
    'openai-python': {
      label: 'OpenAI Python',
      lang: 'python',
      embedsToken: true,
      content: [
        'from openai import OpenAI', '', 'client = OpenAI(', `    base_url=${q(base)},`, `    api_key=${q(token)}`, ')', '',
        'response = client.chat.completions.create(', `    model=${q(model)},`, '    messages=[{"role": "user", "content": "Hello!"}]', ')',
        'print(response.choices[0].message.content)',
      ].join('\n'),
    },
    'openai-js': {
      label: 'OpenAI JS',
      lang: 'javascript',
      embedsToken: true,
      content: [
        "import OpenAI from 'openai';", '', 'const client = new OpenAI({', `  baseURL: ${q(base)},`, `  apiKey: ${q(token)},`, '});', '',
        'const response = await client.chat.completions.create({', `  model: ${q(model)},`, "  messages: [{ role: 'user', content: 'Hello!' }],", '});',
        'console.log(response.choices[0].message.content);',
      ].join('\n'),
    },
    // PowerShell-safe: Windows PowerShell 5.1 strips embedded quotes from native
    // arguments, so the JSON body goes through stdin (a literal here-string).
    curl: {
      label: 'curl',
      lang: 'powershell',
      embedsToken: true,
      content: [
        "$body = @'", JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello!' }] }), "'@",
        `$body | curl.exe -s ${ps(`${base}/chat/completions`)} -H 'Content-Type: application/json' -H ${ps(`Authorization: Bearer ${token}`)} --data-binary '@-'`,
      ].join('\n'),
    },
  };
}

// A menu chain is 2+ Latin menu names joined by " → " (e.g. "Cline → Settings →
// API Provider"). It is rendered inside <bdi dir="ltr"> so that in Arabic the
// arrows still point from the first menu to the last; the surrounding localized
// text stays outside the isolate.
const MENU_SEGMENT = '[A-Za-z0-9](?:[A-Za-z0-9 ]*[A-Za-z0-9])?';
const MENU_CHAIN_SOURCE = `${MENU_SEGMENT}(?: → ${MENU_SEGMENT})+`;

export function splitMenuChains(text: string): Array<{ text: string; chain: boolean }> {
  const parts: Array<{ text: string; chain: boolean }> = [];
  const re = new RegExp(MENU_CHAIN_SOURCE, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), chain: false });
    parts.push({ text: m[0], chain: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), chain: false });
  return parts;
}

export type StepValue = 'base' | 'token' | 'model';

/** App-settings clients: the menu path (i18n key), then the values to paste, in on-screen order. */
export const UI_STEPS: Record<UiClient, { stepsKey: string; values: StepValue[] }> = {
  // https://docs.cline.bot/provider-config/openai-compatible : settings (gear) -> API Provider
  // "OpenAI Compatible" -> Base URL, API Key, Model ID.
  cline: { stepsKey: 'endpoint_steps_cline', values: ['base', 'token', 'model'] },
  // https://docs.roocode.com/providers/openai-compatible : same three fields as Cline.
  roo: { stepsKey: 'endpoint_steps_roo', values: ['base', 'token', 'model'] },
  // https://kilo.ai/docs/providers/openai-compatible : Settings -> Providers tab -> Custom provider,
  // Provider API "OpenAI Compatible"; models are auto-fetched from /v1/models.
  kilo: { stepsKey: 'endpoint_steps_kilo', values: ['base', 'token'] },
  // https://cursor.com/docs/settings/api-keys (Cursor Settings > Models). BYOK requests are sent
  // from Cursor's servers, so a 127.0.0.1 base URL is unreachable (Cursor staff,
  // https://forum.cursor.com/t/connecting-local-ai-server-to-cursor-does-not-work/152940).
  cursor: { stepsKey: 'endpoint_steps_cursor', values: ['token', 'base', 'model'] },
  // https://code.visualstudio.com/docs/copilot/customization/language-models#_add-a-custom-endpoint-model
  copilot: { stepsKey: 'endpoint_steps_copilot', values: ['token', 'base', 'model'] },
  // https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible :
  // Settings > Admin > Connections -> Manage OpenAI API Connections -> Add Connection -> URL + API Key -> Save.
  // The gateway listens on 127.0.0.1 only, so Open WebUI must run on this PC, not in Docker.
  openwebui: { stepsKey: 'endpoint_steps_openwebui', values: ['base', 'token'] },
};
