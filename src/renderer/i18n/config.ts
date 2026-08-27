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
export default i18n;
