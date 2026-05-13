import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './locales/zh-CN'
import en from './locales/en-US'

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': zh,
      'en-US': en,
    },
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    defaultNS: 'common',
    ns: ['common', 'palette', 'topbar', 'todo', 'session', 'transcript', 'wiki', 'settings', 'errors'],
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  })

export default i18n
