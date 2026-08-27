import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Loader2, RefreshCw, Zap } from 'lucide-react';
import { useConfigStore, type AppLanguage } from '../stores/config';
import { validateGatewayPort } from '../lib/frontend-state';
import { selectRecommendedPort } from '../lib/frontend-behavior';
import { Logo } from '../components/Logo';

type Scan = 'available' | 'in-use' | 'unknown' | 'error';
const candidates = [12004, 8000, 24000];

export function Wizard() {
  const { t, i18n } = useTranslation(); const navigate = useNavigate(); const [params] = useSearchParams();
  const { setupComplete, language, gatewayPort, setConfig } = useConfigStore();
  const changeMode = params.get('mode') === 'change' || setupComplete;
  const [step, setStep] = useState(changeMode ? 2 : 1); const [lang, setLang] = useState(language);
  const [portInput, setPortInput] = useState(String(gatewayPort)); const port = Number(portInput);
  const [statuses, setStatuses] = useState<Record<number, Scan>>({}); const [scanning, setScanning] = useState(false);
  const [autoPort, setAutoPort] = useState<number | null>(null); const [saving, setSaving] = useState(false);
  const [runtimeError, setRuntimeError] = useState<GatewayStatus | null>(null);
  const validation = validateGatewayPort(portInput);

  const scan = async () => {
    setScanning(true); setStatuses(Object.fromEntries(candidates.map((p) => [p, 'unknown'])));
    try {
      const [result, found] = await Promise.all([window.electronAPI.checkPorts(candidates.flatMap((p) => [p, p + 1])), window.electronAPI.findFreePort()]);
      const nextStatuses = Object.fromEntries(candidates.map((p) => [p, result[p] || result[p + 1] ? 'in-use' : 'available'])) as Record<number, Scan>; setStatuses(nextStatuses); setAutoPort(found);
      const currentAvailable = result[gatewayPort] === undefined || result[gatewayPort + 1] === undefined ? null : !(result[gatewayPort] || result[gatewayPort + 1]);
      setPortInput(selectRecommendedPort({ changeMode, currentPort: gatewayPort, currentPairAvailable: currentAvailable, recommendedPort: found }));
    } catch { setStatuses(Object.fromEntries(candidates.map((p) => [p, 'error']))); setAutoPort(null); }
    finally { setScanning(false); }
  };
  useEffect(() => { if (step === 2) void scan(); }, [step]);

  const chooseLanguage = async (next: AppLanguage) => { setLang(next); setConfig({ language: next }); await i18n.changeLanguage(next); await window.electronAPI.setAppConfig({ language: next }); };
  const submit = async () => {
    if (step === 1) { setStep(2); return; }
    if (validation) return;
    setSaving(true); setRuntimeError(null);
    try {
      const pair = await window.electronAPI.checkPorts([port, port + 1]);
      if ((pair[port] || pair[port + 1]) && port !== gatewayPort) { setRuntimeError({ state: 'error', code: 'PORT_IN_USE', port }); return; }
      const status = await window.electronAPI.setGatewayPort(port);
      if (status.state !== 'running') { setRuntimeError(status); return; }
      const config = await window.electronAPI.setAppConfig({ language: lang, setupComplete: true });
      setConfig(config); navigate('/dashboard');
    } catch (error) { setRuntimeError({ state: 'error', code: 'START_FAILED', message: error instanceof Error ? error.message : undefined }); }
    finally { setSaving(false); }
  };

  const errorKey = validation ? `port_${validation}` : null;
  const languageOptions: Array<{ value: AppLanguage; labelKey: string }> = [\n    { value: 'en', labelKey: 'english' },\n    { value: 'zh', labelKey: 'chinese' },\n    { value: 'es', labelKey: 'spanish' },\n    { value: 'hi', labelKey: 'hindi' },\n    { value: 'fr', labelKey: 'french' },\n    { value: 'ar', labelKey: 'arabic' },\n    { value: 'ru', labelKey: 'russian' }\n  ];
  return <main className="h-full overflow-y-auto bg-bg px-4 py-4 sm:px-8 sm:py-8 flex items-start justify-center">
    <section className="bg-surface border border-border w-full min-w-0 max-w-[440px] max-h-[calc(100vh-2rem)] overflow-y-auto p-5 sm:p-8 shadow-2xl relative break-words" aria-labelledby="wizard-title">
      <div className="absolute inset-x-0 top-0 h-1 bg-accent-neon" /><Logo className="w-12 h-12 mx-auto mb-4" />
      <h1 id="wizard-title" className="text-2xl font-bold mb-6 text-center break-words">{step === 1 ? t('setup_title') : changeMode ? t('change_port_title') : t('port')}</h1>
      {step === 1 ? <fieldset className="grid gap-2"><legend className="sr-only">{t('language')}</legend>{languageOptions.map(({ value, labelKey }) => <label key={value} className={`p-3 border cursor-pointer flex items-center transition-colors ${lang === value ? 'border-nvidia text-nvidia bg-nvidia/10' : 'border-border hover:border-textMuted'}`}><input type="radio" name="language" value={value} checked={lang === value} onChange={() => void chooseLanguage(value)} className="mr-3" /><span>{t(labelKey)}</span></label>)}</fieldset> : <div className="grid gap-4">
        {runtimeError?.state === 'error' && <div role="alert" className="border border-error bg-error/10 p-3 text-error flex gap-2"><AlertTriangle aria-hidden size={18} /><span>{t(runtimeError.code === 'PORT_IN_USE' ? 'port_conflict' : 'start_failed')} {t('choose_other')}</span></div>}
        <div className="flex justify-end"><button type="button" onClick={() => void scan()} disabled={scanning} aria-label={t('refresh')} title={t('refresh')} className="p-2 text-textMuted hover:text-nvidia"><RefreshCw aria-hidden size={18} className={scanning ? 'animate-spin' : ''} /></button></div>
        <div aria-live="polite" className="text-sm text-textMuted">{scanning ? t('scanning') : autoPort ? `${t('recommended')}: ${autoPort}–${autoPort + 1}` : t('no_free_pair')}</div>
        {autoPort && <label className={`p-4 border flex items-center gap-3 cursor-pointer ${port === autoPort ? 'border-nvidia text-nvidia' : 'border-border'}`}><input type="radio" name="port" checked={port === autoPort} onChange={() => setPortInput(String(autoPort))} /><Zap aria-hidden size={16} />{autoPort}–{autoPort + 1}{port === autoPort && <Check aria-hidden size={16} />}</label>}
        <fieldset className="grid gap-2"><legend className="sr-only">{t('port')}</legend>{candidates.map((p) => { const state = statuses[p] ?? 'unknown'; return <label key={p} className={`p-3 border flex justify-between cursor-pointer ${port === p ? 'border-nvidia text-nvidia' : 'border-border'} ${state === 'in-use' || state === 'error' ? 'cursor-not-allowed text-textMuted' : ''}`}><span><input type="radio" name="port" checked={port === p} disabled={state !== 'available'} onChange={() => setPortInput(String(p))} className="mr-3" />{p}</span><span>{t(state.replace('-', '_'))}</span></label>; })}</fieldset>
        <div><label htmlFor="custom-port" className="block text-sm text-textMuted mb-2">{t('custom_port')}</label><input id="custom-port" inputMode="numeric" value={portInput} onChange={(event) => setPortInput(event.target.value)} aria-invalid={Boolean(validation)} aria-describedby={errorKey ? "port-help port-error" : "port-help"} className="w-full bg-bg border border-border p-3 font-mono" /><p id="port-help" className="text-xs text-textMuted mt-2">{t('port_help')}</p>{errorKey && <p id="port-error" role="alert" className="text-sm text-error mt-1">{t(errorKey)}</p>}</div>
      </div>}
      <div className="mt-7 flex justify-end"><button type="button" onClick={() => void submit()} disabled={saving || (step === 1 ? false : Boolean(validation))} className="bg-nvidia text-bg px-6 py-2 font-bold disabled:opacity-50">{saving ? <Loader2 aria-label={t('loading')} className="animate-spin" size={18} /> : t(step === 1 ? 'next' : 'save')}</button></div>
    </section>
  </main>;
}
