import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en, ru, zh, es, hi, fr, ar } from './resources';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
    zh: { translation: zh },
    es: { translation: es },
    hi: { translation: hi },
    fr: { translation: fr },
    ar: { translation: ar }
  },
  lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false }, returnNull: false
});
i18n.on('languageChanged', (language) => { document.documentElement.lang = language; });

// i18next emits `languageChanged` even when changeLanguage is called with the
// already-active language (verified against the i18next@23 dist source: done()
// emits unconditionally). Paired with react-i18next handing every subscriber a
// new `t` identity per emission, a hydration effect that re-applies the stored
// language closes an infinite feedback loop (measured: ~470 DOM mutations/s of
// <html lang> sets and ~90% of one CPU core while the app sits idle). Apply the
// stored language only when it genuinely differs from the resolved one.
export async function applyStoredLanguage(language: string | undefined): Promise<void> {
  if (!language || language === i18n.resolvedLanguage) return;
  await i18n.changeLanguage(language);
}

export default i18n;
