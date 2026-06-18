import { createContext, useContext, useMemo } from "react";
import { DEFAULT_LOCALE, translations, type Locale, type TranslationKey, type TranslationParams } from "./locales";

type I18nContextValue = {
  locale: Locale;
  t: (key: TranslationKey, params?: TranslationParams) => string;
};

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  t: (key, params) => formatTranslation(translations[DEFAULT_LOCALE][key] ?? key, params)
});

function formatTranslation(template: string, params?: TranslationParams) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    t: (key, params) => formatTranslation(translations[locale][key] ?? translations[DEFAULT_LOCALE][key] ?? key, params)
  }), [locale]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
