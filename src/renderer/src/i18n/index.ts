import { en, MessageKey, Messages } from './en'
import { es } from './es'
import { ja } from './ja'

export const UI_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'ja', label: '日本語' }
] as const

export type UiLang = (typeof UI_LANGUAGES)[number]['code']
export type { MessageKey }

const CATALOG: Record<UiLang, Messages> = { en, es, ja }

/** The interface language for any language code ('ja-JP' -> 'ja'), English when there is no translation */
export function toUiLang(lang: string | null | undefined): UiLang {
  const code = String(lang || '').toLowerCase().slice(0, 2)
  return (code in CATALOG ? code : 'en') as UiLang
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

export function translator(lang: UiLang): Translate {
  const messages = CATALOG[lang]
  return (key, vars) => {
    const text = messages[key] ?? en[key]
    return vars ? text.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all)) : text
  }
}
