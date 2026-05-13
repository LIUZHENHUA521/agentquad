import zh from './locales/zh-CN'
import en from './locales/en-US'

export const resources = {
  'zh-CN': zh,
  'en-US': en,
} as const

export type SupportedLng = keyof typeof resources
