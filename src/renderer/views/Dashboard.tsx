import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Ban, CheckCircle2, ChevronDown, ChevronUp, Copy, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { api, queryKeys } from '../lib/api';
import { classifyDataState, isPlausibleNvidiaKey, moveItem, safeError } from '../lib/frontend-state';
import { createDashboardKeysQueryPolicy } from '../lib/frontend-behavior';
import { useGatewayLifecycle } from '../lib/gateway-lifecycle';

interface KeyUsage { success: number; fail: number; tokens: number; lastUsed: number }
interface ApiKey { id: string; key: string; status: 'active' | 'disabled' | 'quota-exceeded'; backoffUntil: number; usage: KeyUsage }

export function Dashboard() {
  const { t } = useTranslation(); const client = useQueryClient();
  const lifecycle = useGatewayLifecycle();
  const gatewayRunning = lifecycle.status?.state === 'running';
  const unavailable = !gatewayRunning;
  const keysPolicy = createDashboardKeysQueryPolicy();
  const query = useQuery({ queryKey: queryKeys.keys, queryFn: api.keys, refetchInterval: unavailable ? false : keysPolicy.refetchInterval, refetchOnWindowFocus: unavailable ? false : keysPolicy.refetchOnWindowFocus, refetchOnReconnect: unavailable ? false : keysPolicy.refetchOnReconnect, retry: keysPolicy.retry, enabled: !unavailable });
  const keys = (query.data?.keys ?? []) as ApiKey[]; const state = classifyDataState({ pending: query.isPending, error: query.isError, data: query.data?.keys, stale: query.isError && Boolean(query.data) });
  const [adding, setAdding] = useState(false); const [newKey, setNewKey] = useState(''); const [showToken, setShowToken] = useState(false); const [feedback, setFeedback] = useState(''); const [keyError, setKeyError] = useState(''); const [mutationError, setMutationError] = useState('');
  const invalidate = () => client.invalidateQueries({ queryKey: queryKeys.keys });
  const simpleMutation = useMutation({ mutationFn: async ({ action }: { action: () => Promise<unknown>; kind: 'delete'|'toggle' }) => action(), onSuccess: () => { setMutationError(''); void invalidate(); }, onError: (error, variables) => { setMutationError(`${t(variables.kind === 'delete' ? 'delete_failed' : 'toggle_failed')} ${safeError(error, t('unknown_error'))}`); void invalidate(); } });
  const reorder = useMutation({ mutationFn: (next: ApiKey[]) => window.electronAPI.adminReorder(next.map((key) => key.id)), onMutate: async (next) => { setMutationError(''); await client.cancelQueries({ queryKey: queryKeys.keys }); const previous = client.getQueryData(queryKeys.keys); client.setQueryData(queryKeys.keys, { keys: next }); return { previous }; }, onError: (error, _next, context) => { client.setQueryData(queryKeys.keys, context?.previous); setMutationError(`${t('reorder_failed')} ${safeError(error, t('unknown_error'))}`); }, onSettled: invalidate });
  // Add-key submission is wrapped in a TanStack mutation so its .isPending drives
  // the Save button — preventing a double activation while validation + the
  // adminAddKey call are in flight (both are awaited inside mutationFn).
  const addKeyMutation = useMutation({ mutationFn: async (key: string) => { const validation = await window.electronAPI.adminValidateKey(key); if (validation.valid === false || validation.status === 401 || validation.status === 403) { const err = new Error(t('key_auth')); err.name = 'KeyAuth'; throw err; } await window.electronAPI.adminAddKey(key); }, onSuccess: () => { setNewKey(''); setAdding(false); setShowToken(false); void invalidate(); }, onError: (error) => { if (error instanceof Error && error.name === 'KeyAuth') setKeyError(error.message); else { setKeyError(`${t('validate_failed')} ${safeError(error, t('unknown_error'))}`); setMutationError(t('mutation_error')); } } });

  const add = async () => {
    const key = newKey.trim(); setKeyError('');
    if (!isPlausibleNvidiaKey(key)) { setKeyError(t('key_malformed')); return; }
    addKeyMutation.mutate(key);
  };
  const move = (index: number, direction: -1 | 1) => { const next = moveItem(keys, index, index + direction); if (next !== keys) reorder.mutate(next); };
  const announce = (message: string) => { setFeedback(''); window.setTimeout(() => setFeedback(message), 0); };
  const copy = async (masked: string) => { try { await navigator.clipboard.writeText(masked); announce(t('copied')); setMutationError(''); } catch (error) { announce(t('copy_failed')); setMutationError(`${t('clipboard_failed')} ${safeError(error, t('unknown_error'))}`); } };
  const number = (value = 0) => value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);

  if (unavailable) {
    return <div role="alert" className="flex flex-col h-full p-4 sm:p-8 min-w-0 items-center justify-center text-center"><AlertTriangle aria-hidden size={40} className="text-warning mb-4" /><p className="text-lg">{t('gateway_stopped')}</p></div>;
  }

  return <div className="flex flex-col h-full p-4 sm:p-8 min-w-0">
    <header className="flex flex-wrap items-center justify-between gap-4 mb-6"><h2 className="text-2xl font-bold">{t('keys')}</h2><button onClick={() => setAdding(true)} disabled={unavailable} className="flex items-center gap-2 bg-nvidia text-bg px-4 py-2 font-medium disabled:opacity-50"><Plus aria-hidden size={18} />{t('add_key')}</button></header>
    <p className="sr-only" aria-live="polite">{feedback}</p>
    {mutationError && <div role="alert" className="border border-error bg-error/10 text-error p-3 mb-4 break-words">{mutationError}</div>}
    {adding && <div className="bg-surface border border-nvidia p-4 mb-4 flex flex-wrap gap-3"><div className="flex-1 min-w-[220px]"><label htmlFor="new-key" className="sr-only">{t('key_label')}</label><div className="relative"><input id="new-key" type={showToken ? 'text' : 'password'} value={newKey} onChange={(event) => setNewKey(event.target.value)} aria-invalid={Boolean(keyError)} aria-describedby={keyError ? "key-error" : undefined} className="w-full bg-bg border border-border p-2 pr-10 font-mono" autoFocus disabled={unavailable} /><button type="button" onClick={() => setShowToken((v) => !v)} onMouseDown={(event) => event.preventDefault()} aria-label={showToken ? t('hide_key') : t('show_key')} aria-pressed={showToken} className="absolute right-2 top-1/2 -translate-y-1/2 text-textMuted hover:text-accent-neon">{showToken ? <EyeOff aria-hidden size={16} /> : <Eye aria-hidden size={16} />}</button></div>{keyError && <p id="key-error" role="alert" className="text-error text-sm mt-2 break-words">{keyError}</p>}</div><button onClick={() => void add()} disabled={unavailable || addKeyMutation.isPending} className="bg-nvidia text-bg px-4 py-2 disabled:opacity-50">{t('save')}</button><button onClick={() => { setAdding(false); setNewKey(''); setKeyError(''); setShowToken(false); }} disabled={unavailable || addKeyMutation.isPending} className="px-3 text-textMuted">{t('cancel')}</button></div>}
    {state === 'loading' && <div role="status" className="flex-1 grid place-items-center">{t('loading')}</div>}
    {state === 'error' && <StateMessage text={t('keys_error')} retry={() => void query.refetch()} retryLabel={t('retry')} details={safeError(query.error, t('unknown_error'))} />}
    {state === 'stale' && <div role="status" className="border border-error/60 p-3 mb-3 text-textMuted">{t('stale')} <button onClick={() => void query.refetch()} className="text-nvidia ml-2">{t('retry')}</button></div>}
    {state === 'empty' && <button onClick={() => setAdding(true)} disabled={unavailable} className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-border text-textMuted"><Plus aria-hidden size={48} className="mb-4" />{t('no_keys')}</button>}
    {(state === 'success' || state === 'stale') && <div className="flex-1 overflow-y-auto overflow-x-hidden"><div className="grid gap-3">{keys.map((key, index) => <article key={key.id} className="group bg-surface border border-border p-4 grid min-w-0 grid-cols-1 min-[800px]:grid-cols-[minmax(180px,1fr)_auto_auto] items-center gap-4 focus-within:border-accent-neon focus-within:ring-1 focus-within:ring-accent-neon">
      <div className="min-w-[180px] flex-1"><div className="flex flex-wrap items-center gap-2"><span className={`px-2 py-1 border text-xs ${key.status === 'active' ? 'border-nvidia text-nvidia' : key.status === 'quota-exceeded' ? 'border-error text-error' : 'border-border text-textMuted'}`}>{t(key.status === 'quota-exceeded' ? 'quota' : key.status)}</span><code className="break-all">{key.key}</code></div></div>
      <dl className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-textMuted"><div><dt>{t('success')}</dt><dd className="text-textMain">{number(key.usage?.success)}</dd></div><div><dt>{t('failures')}</dt><dd className="text-textMain">{number(key.usage?.fail)}</dd></div><div><dt>{t('tokens')}</dt><dd className="text-textMain">{number(key.usage?.tokens)}</dd></div></dl>
      <div className="flex flex-wrap gap-1 opacity-100 sm:opacity-70 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <IconButton label={t('move_up')} disabled={unavailable || index === 0 || reorder.isPending} onClick={() => move(index, -1)}><ChevronUp /></IconButton><IconButton label={t('move_down')} disabled={unavailable || index === keys.length - 1 || reorder.isPending} onClick={() => move(index, 1)}><ChevronDown /></IconButton>
        <IconButton label={t('copy_masked')} disabled={unavailable} onClick={() => void copy(key.key)}><Copy /></IconButton><IconButton label={t(key.status === 'disabled' ? 'enable' : 'disable')} disabled={unavailable} onClick={() => simpleMutation.mutate({ kind:'toggle', action:()=>window.electronAPI.adminSetStatus(key.id, key.status === 'disabled' ? 'active' : 'disabled') })}>{key.status === 'disabled' ? <CheckCircle2 /> : <Ban />}</IconButton>
        <IconButton label={t('delete')} disabled={unavailable} onClick={() => { if (window.confirm(t('confirm_delete'))) simpleMutation.mutate({ kind:'delete', action:()=>window.electronAPI.adminRemoveKey(key.id) }); }}><Trash2 /></IconButton>
      </div>
    </article>)}</div></div>}
  </div>;
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactElement }) { return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="p-2 text-textMuted hover:text-accent-neon disabled:opacity-30">{children}</button>; }
function StateMessage({ text, retry, retryLabel, details }: { text: string; retry: () => void; retryLabel: string; details: string }) { const { t } = useTranslation(); return <div role="alert" className="border border-error p-5"><p>{text}</p><details className="text-sm text-textMuted mt-2"><summary>{t('details')}</summary><p className="break-all">{details}</p></details><button onClick={retry} className="mt-3 text-accent-neon">{retryLabel}</button></div>; }
