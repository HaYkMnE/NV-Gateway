import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Wizard } from './views/Wizard';
import { Dashboard } from './views/Dashboard';
import { Logs } from './views/Logs';
import { Settings } from './views/Settings';
import { Models } from './views/Models';
import { Endpoint } from './views/Endpoint';
import { Layout } from './components/Layout';
import { FeedbackModal } from './components/FeedbackModal';
import { AboutDialog } from './components/AboutDialog';
import { DonationModal } from './pet/DonationModal';
import { ModalContext, type ActiveModal, type ModalContextValue, type ModalRequest } from './lib/modal-context';
import { useConfigStore } from './stores/config';
import { applyStoredLanguage } from './i18n/config';
import { reduceHydration } from './lib/frontend-behavior';
import { queryKeys } from './lib/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 3000,
    },
  },
});

export default function App() {
  const { hydrated, setupComplete, hydrate } = useConfigStore();
  const { t } = useTranslation();
  // Keep a stable ref to `t`: react-i18next hands every subscriber a NEW `t`
  // identity on each `languageChanged` emission, and i18next emits even for a
  // no-op changeLanguage. If `t` flowed into retryHydration's deps, every
  // emission would rebuild the callback and re-fire the hydration effect —
  // which re-applies the language and closes an infinite loop (measured: ~470
  // DOM mutations/s of <html lang> sets, ~90% of one CPU core, while idle).
  // Same tRef pattern as PetWidget.tsx.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const [hydration, dispatchHydration] = useReducer(reduceHydration, { state: 'loading' });
  const retryHydration = useCallback(async () => {
    dispatchHydration({ type: 'retry' });
    try {
      const state = await window.electronAPI.getRuntimeState();
      await applyStoredLanguage(state.language);
      hydrate(state);
      queryClient.setQueryData(queryKeys.runtime, state);
      if (state.status) {
        queryClient.setQueryData(['gateway-status'], state.status);
      }
      dispatchHydration({ type: 'resolve' });
    } catch (error) {
      dispatchHydration({ type: 'reject', message: error instanceof Error ? error.message : tRef.current('unknown_error') });
    }
  }, [hydrate]);
  useEffect(() => { void retryHydration(); }, [retryHydration]);

  // Every user request receives a monotonically increasing identity. Delayed
  // work may open/close only the identity it owns, so an older promise or timer
  // can never replace or close a newer dialog.
  const modalRequestRef = useRef<ModalRequest>(0);
  const [activeModalState, setActiveModalState] = useState<{
    modal: Exclude<ActiveModal, null>;
    request: ModalRequest;
  } | null>(null);
  const activeModalRef = useRef<typeof activeModalState>(null);
  const beginModalRequest = useCallback((): ModalRequest => {
    modalRequestRef.current += 1;
    return modalRequestRef.current;
  }, []);
  const isCurrentModalRequest = useCallback((request: ModalRequest): boolean => (
    request === modalRequestRef.current
  ), []);
  const openModal = useCallback((modal: Exclude<ActiveModal, null>, request?: ModalRequest): boolean => {
    const ownedRequest = request ?? beginModalRequest();
    if (ownedRequest !== modalRequestRef.current) return false;
    const next = { modal, request: ownedRequest };
    activeModalRef.current = next;
    setActiveModalState(next);
    return true;
  }, [beginModalRequest]);
  const closeModal = useCallback((expected: Exclude<ActiveModal, null>, request: ModalRequest): void => {
    const current = activeModalRef.current;
    if (current?.modal !== expected || current.request !== request || modalRequestRef.current !== request) return;
    // Revoke ownership synchronously. Async completions can run before React's
    // close render commits, so clearing state alone is not an ownership fence.
    modalRequestRef.current += 1;
    activeModalRef.current = null;
    setActiveModalState(null);
  }, []);
  const openFeedback = useCallback((request?: ModalRequest) => openModal('feedback', request), [openModal]);
  const openAbout = useCallback((request?: ModalRequest) => openModal('about', request), [openModal]);
  const openDonation = useCallback((request?: ModalRequest) => openModal('donation', request), [openModal]);
  const openSendErrors = useCallback((request?: ModalRequest) => openModal('send-errors', request), [openModal]);
  const activeModal = activeModalState?.modal ?? null;
  const activeModalRequest = activeModalState?.request ?? null;

  const modalValue = useMemo<ModalContextValue>(
    () => ({
      activeModal,
      activeModalRequest,
      beginModalRequest,
      isCurrentModalRequest,
      openFeedback,
      openAbout,
      openDonation,
      openSendErrors,
      closeModal,
    }),
    [activeModal, activeModalRequest, beginModalRequest, closeModal, isCurrentModalRequest, openAbout, openDonation, openFeedback, openSendErrors]
  );

  // Donation ascension: nv_pet_vip was persisted by DonationModal; nudge the
  // PetWidget (same-window storage events don't fire) to re-read the flag and
  // run the engine's celebration overlay.
  const handleAscension = useCallback(() => {
    window.dispatchEvent(new Event('nv-pet-ascension'));
  }, []);

  // Listen for menu-driven navigation events from the main process
  useEffect(() => {
    const offAbout = window.electronAPI.onNavigateAbout?.(() => { openAbout(); });
    const offFeedback = window.electronAPI.onNavigateFeedback?.(() => { openFeedback(); });
    return () => {
      offAbout?.();
      offFeedback?.();
    };
  }, [openAbout, openFeedback]);

  // Capture renderer errors and forward them to the main process error log
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      window.electronAPI.errorReport.log({
        timestamp: new Date().toISOString(),
        type: 'renderer',
        message: event.message,
        stack: event.error?.stack,
        source: 'renderer',
      });
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      window.electronAPI.errorReport.log({
        timestamp: new Date().toISOString(),
        type: 'renderer',
        message: event.reason instanceof Error ? event.reason.message : String(event.reason),
        stack: event.reason instanceof Error ? event.reason.stack : undefined,
        source: 'renderer',
      });
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  if (!hydrated && hydration.state === 'error') return <div className="h-full grid place-items-center p-6"><div role="alert" className="max-w-md border border-error p-5 break-words"><p>{t('hydration_error')}</p><p className="mt-2 text-sm text-textMuted break-all">{hydration.message}</p><button onClick={() => void retryHydration()} className="mt-4 text-accent-neon">{t('retry')}</button></div></div>;
  if (!hydrated) return <div className="h-full grid place-items-center" role="status">{t('loading')}</div>;

  return (
    <ModalContext.Provider value={modalValue}>
      <QueryClientProvider client={queryClient}>
        <Router>
          <Routes>
            <Route path="/" element={setupComplete ? <Navigate to="/dashboard" /> : <Navigate to="/wizard" />} />
            <Route path="/wizard" element={<Wizard />} />
            <Route element={<Layout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/models" element={<Models />} />
              <Route path="/endpoint" element={<Endpoint />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Routes>
        </Router>
      </QueryClientProvider>
      <FeedbackModal
        isOpen={activeModal === 'feedback'}
        session={activeModal === 'feedback' ? activeModalRequest : null}
        onClose={() => activeModalRequest !== null && closeModal('feedback', activeModalRequest)}
      />
      <AboutDialog
        isOpen={activeModal === 'about'}
        session={activeModal === 'about' ? activeModalRequest : null}
        onClose={() => activeModalRequest !== null && closeModal('about', activeModalRequest)}
      />
      <DonationModal
        open={activeModal === 'donation'}
        session={activeModal === 'donation' ? activeModalRequest : null}
        onClose={() => activeModalRequest !== null && closeModal('donation', activeModalRequest)}
        onAscension={handleAscension}
      />
    </ModalContext.Provider>
  );
}
