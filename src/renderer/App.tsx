import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
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
import { ModalContext, type ModalContextValue } from './lib/modal-context';
import { useConfigStore } from './stores/config';
import i18n from './i18n/config';
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
  const [hydration, dispatchHydration] = useReducer(reduceHydration, { state: 'loading' });
  const retryHydration = useCallback(async () => {
    dispatchHydration({ type: 'retry' });
    try {
      const state = await window.electronAPI.getRuntimeState();
      hydrate(state);
      queryClient.setQueryData(queryKeys.runtime, state);
      if (state.status) {
        queryClient.setQueryData(['gateway-status'], state.status);
      }
      await i18n.changeLanguage(state.language);
      dispatchHydration({ type: 'resolve' });
    } catch (error) {
      dispatchHydration({ type: 'reject', message: error instanceof Error ? error.message : t('unknown_error') });
    }
  }, [hydrate, t]);
  useEffect(() => { void retryHydration(); }, [retryHydration]);

  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [donationModalOpen, setDonationModalOpen] = useState(false);

  const modalValue = useMemo<ModalContextValue>(
    () => ({
      openFeedback: () => setFeedbackModalOpen(true),
      openAbout: () => setAboutDialogOpen(true),
      openDonation: () => setDonationModalOpen(true),
    }),
    []
  );

  // Donation ascension: nv_pet_vip was persisted by DonationModal; nudge the
  // PetWidget (same-window storage events don't fire) to re-read the flag and
  // run the engine's celebration overlay.
  const handleAscension = useCallback(() => {
    window.dispatchEvent(new Event('nv-pet-ascension'));
  }, []);

  // Listen for menu-driven navigation events from the main process
  useEffect(() => {
    const offAbout = window.electronAPI.onNavigateAbout?.(() => setAboutDialogOpen(true));
    const offFeedback = window.electronAPI.onNavigateFeedback?.(() => setFeedbackModalOpen(true));
    return () => {
      offAbout?.();
      offFeedback?.();
    };
  }, []);

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

  return (\n    <ModalContext.Provider value={modalValue}>\n      <QueryClientProvider client={queryClient}>\n        <Router>\n          <Routes>\n            <Route path=\"/\" element={setupComplete ? <Navigate to=\"/dashboard\" /> : <Navigate to=\"/wizard\" />} />\n            <Route path=\"/wizard\" element={<Wizard />} />\n            <Route element={<Layout />}>\n              <Route path=\"/dashboard\" element={<Dashboard />} />\n              <Route path=\"/models\" element={<Models />} />\n              <Route path=\"/endpoint\" element={<Endpoint />} />\n              <Route path=\"/logs\" element={<Logs />} />\n              <Route path=\"/settings\" element={<Settings />} />\n            </Route>\n          </Routes>\n        </Router>\n      </QueryClientProvider>\n      <FeedbackModal isOpen={feedbackModalOpen} onClose={() => setFeedbackModalOpen(false)} />\n      <AboutDialog isOpen={aboutDialogOpen} onClose={() => setAboutDialogOpen(false)} />\n      <DonationModal open={donationModalOpen} onClose={() => setDonationModalOpen(false)} onAscension={handleAscension} />\n    </ModalContext.Provider>\n  );
}
