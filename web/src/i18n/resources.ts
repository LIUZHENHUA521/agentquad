import zh from './locales/zh-CN'
import en from './locales/en-US'

export const resources = {
  'zh-CN': zh,
  'en-US': en,
} as const

export type SupportedLng = keyof typeof resources

/** Structural mirror of a locale: every key from T must exist, with string leaves. */
export type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>
}
