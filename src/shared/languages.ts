/** The languages Capri speaks, writes and listens in. Anything else falls back to the setting or English */
export const SUPPORTED_LANGS = ['en', 'es', 'ja'] as const

export type SupportedLang = (typeof SUPPORTED_LANGS)[number]

export function isSupportedLang(lang: string | null | undefined): lang is SupportedLang {
  return !!lang && (SUPPORTED_LANGS as readonly string[]).includes(lang)
}

/** A language setting: 'auto' or one of the supported languages, anything else becomes 'auto' */
export function toLangSetting(lang: string | null | undefined): string {
  return lang === 'auto' || isSupportedLang(lang) ? (lang as string) : 'auto'
}
