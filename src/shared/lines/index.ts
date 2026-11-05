/**
 * Capri's fixed lines in every language. The code only has them in English and Spanish, so a line
 * is translated as it leaves, at the few places every line goes through. en.json lists the English
 * lines (tools/extract-lines.cjs finds them) and each language file has its translations in the same
 * order. A line that isn't in the catalog, like anything the model wrote, goes out untouched.
 */

import source from './en.json'
import es from './es.json'
import ja from './ja.json'

const CATALOG: Record<string, (string | null)[]> = { es, ja }

const EMOJI = /[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu
const TAG = /\[[a-zA-Z][a-zA-Z0-9_ ,-]*\]/g
const SLOT = /\{(\d+|[a-zA-Z]+)\}/g

/** What two versions of a line have in common: emotion tags and emojis get added and removed on the way */
const bare = (text: string): string => text.replace(TAG, ' ').replace(EMOJI, ' ').replace(/\s+/g, ' ').trim()

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Longer than any line in the catalog: what the model wrote, no need to compare it */
const MAX_LINE = 700
const MAX_SENTENCES = 14

interface Pattern {
  index: number
  slots: string[]
  regex: RegExp
}

const exact = new Map<string, number>()
const patterns: Pattern[] = []

;(source as string[]).forEach((line, index) => {
  const key = bare(line)
  const slots = Array.from(key.matchAll(SLOT), (m) => m[1])
  if (!slots.length) {
    exact.set(key, index)
    return
  }
  // A line that's nothing but slots would match anything the model says
  if (key.replace(SLOT, '').replace(/[^\p{L}]/gu, '').length < 6) return
  const regex = new RegExp(`^${key.split(SLOT).map((part, i) => (i % 2 ? '(.+?)' : escape(part))).join('')}$`, 's')
  patterns.push({ index, slots, regex })
})

function find(text: string): { index: number; values: Record<string, string> } | null {
  const key = bare(text)
  if (key.length > MAX_LINE) return null
  const direct = exact.get(key)
  if (direct !== undefined) return { index: direct, values: {} }
  for (const pattern of patterns) {
    const match = key.match(pattern.regex)
    if (match) {
      const values: Record<string, string> = {}
      pattern.slots.forEach((slot, i) => (values[slot] = match[i + 1]))
      return { index: pattern.index, values }
    }
  }
  return null
}

/** A slot takes as little as it can, so the name of "..., {name}." can't swallow the lines after it */
function exactLine(text: string, code: string): string | null {
  const translations = CATALOG[code]
  const hit = translations ? find(text) : null
  const translated = hit ? translations[hit.index] : null
  if (!hit || !translated) return null
  if (Object.values(hit.values).some((value) => /[.!?]\s+\p{L}/u.test(value) && value.length > 30)) return null
  // A slot can hold a piece that's translated too: "the nearest bar", "your jungler"
  return translated.replace(SLOT, (all, slot: string) => {
    const value = hit.values[slot]
    return value === undefined ? all : localizeLine(value, code)
  })
}

/** Several lines said as one message: each stretch of sentences that is a known line gets translated */
function joinedLines(text: string, code: string): string | null {
  const sentences = text.split(/(?<=[.!?:])\s+/)
  if (sentences.length < 2 || sentences.length > MAX_SENTENCES) return null
  const out: string[] = []
  let translatedAny = false
  for (let i = 0; i < sentences.length; ) {
    let advanced = false
    for (let j = sentences.length; j > i; j--) {
      const line = exactLine(sentences.slice(i, j).join(' '), code)
      if (line) {
        out.push(line)
        i = j
        translatedAny = advanced = true
        break
      }
    }
    if (!advanced) out.push(sentences[i++])
  }
  return translatedAny ? out.join(' ') : null
}

export function localizeLine(text: string, lang: string | null | undefined): string {
  const code = String(lang || '').toLowerCase().slice(0, 2)
  if (!CATALOG[code] || !text) return text
  const filled = exactLine(text, code) ?? joinedLines(text, code)
  if (!filled) return text
  // A tag added to the line on its way here stays
  const opening = text.match(/^\s*(\[[a-zA-Z][a-zA-Z0-9_ ,-]*\])/)?.[1]
  return opening && !/^\s*\[/.test(filled) ? `${opening} ${filled}` : filled
}
