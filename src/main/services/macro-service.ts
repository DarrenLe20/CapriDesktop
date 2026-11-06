import { llmFetch } from './llm-gateway'
import { llmBody } from './user-profile'
/**
 * Voice macros ("when I say 'it's game time', open League and play my playlist").
 * The local LLM turns the sentence into actions; triggers are matched fuzzily.
 * Stored in userData/capri_macros.json.
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { ToolExecutor } from '../agents/tools/tool-executor'
import { windowManager } from '../windows/window-manager'

export type MacroActionType =
  | 'open_app'
  | 'close_app'
  | 'play_music'
  | 'open_url'
  | 'media'
  | 'gaming_mode'
  | 'say'
  | 'wait'
  | 'command'

export interface MacroAction {
  type: MacroActionType
  app?: string
  query?: string
  url?: string
  action?: 'next' | 'prev' | 'play' | 'pause'
  on?: boolean
  text?: string
  seconds?: number
  command?: string
}

export interface Macro {
  id: string
  trigger: string
  actions: MacroAction[]
  createdAt: number
  lastRunAt?: number
}

export interface MacroRunHooks {
  say: (text: string) => void
}

const VALID_TYPES: MacroActionType[] = ['open_app', 'close_app', 'play_music', 'open_url', 'media', 'gaming_mode', 'say', 'wait', 'command']

/**
 * Whisper often mishears "macros" ("Magros", "makros", "macro's"); requests about macros are
 * matched on this normalized text.
 */
export function normalizeMacroWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/(?<!\p{L})(?:magros|makros|macros'?|macro's|macrós|macroes)(?!\p{L})/gu, 'macros')
    .replace(/(?<!\p{L})(?:magro|makro)(?!\p{L})/gu, 'macro')
}

export function normalizeTrigger(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(?:hey\s+|hola\s+|ey\s+)?(?:capri|companion)[,:\s]*/i, '')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return dp[a.length][b.length]
}

export class MacroService {
  private static instance: MacroService
  private macros: Macro[] = []
  private loaded = false

  public static getInstance(): MacroService {
    if (!MacroService.instance) MacroService.instance = new MacroService()
    return MacroService.instance
  }

  private filePath(): string {
    return path.join(app.getPath('userData'), 'capri_macros.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const p = this.filePath()
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
        if (Array.isArray(data)) this.macros = data
      }
    } catch (err) {
      console.warn('[MacroService] Could not load macros:', err)
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath(), JSON.stringify(this.macros, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[MacroService] Could not save macros:', err)
    }
  }

  public list(): Macro[] {
    this.load()
    return [...this.macros]
  }

  public remove(triggerText: string): Macro | null {
    this.load()
    const m = this.findMatch(triggerText, 0.75)
    if (!m) return null
    this.macros = this.macros.filter((x) => x.id !== m.id)
    this.save()
    return m
  }

  /** Returns the macro whose trigger the user just said (fuzzy), if any. */
  public findMatch(prompt: string, minSimilarity = 0.8): Macro | null {
    this.load()
    const said = normalizeTrigger(prompt)
    if (!said) return null
    let best: { m: Macro; score: number } | null = null
    for (const m of this.macros) {
      const trig = normalizeTrigger(m.trigger)
      if (!trig) continue
      let score = 0
      if (said === trig) score = 1
      else if (said.includes(trig) && said.length <= trig.length + 14) score = 0.95
      else {
        const dist = levenshtein(said, trig)
        score = 1 - dist / Math.max(said.length, trig.length)
      }
      // Very short triggers must match exactly to avoid accidental firing
      const needed = trig.length < 8 ? 0.95 : minSimilarity
      if (score >= needed && (!best || score > best.score)) best = { m, score }
    }
    return best ? best.m : null
  }

  /**
   * "borrá el macro X", "listá mis macros", "editá el atajo X", "creá un macro"...: talking ABOUT
   * macros. These mention the trigger phrase, so they must never run the macro itself.
   */
  public isManagementRequest(text: string): boolean {
    const t = normalizeMacroWords(text)
    if (this.isDeleteAllRequest(t)) return true
    if (this.isCreationRequest(t)) return true
    if (this.parseDeleteRequest(t)) return true
    if (this.isListRequest(t)) return true
    return /\b(?:macros?|atajos?|shortcuts?|voice\s+commands?|comandos?\s+de\s+voz)\b/.test(t) &&
      /\b(?:borr|elimin|sac|quit|olvid|delete|remov|forget|edit|cambi|modific|renombr|renam|list|mostr|show|cu[aá]les)\w*/.test(t)
  }

  /**
   * "list macros", "List my macros.", "mostrame los macros", "qué macros tengo?", "mis atajos"...
   * (voice transcripts end with punctuation, so that is ignored)
   */
  public isListRequest(text: string): boolean {
    const t = normalizeMacroWords(text).replace(/[.!?¿¡,;:"'“”]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!/\b(?:macros?|atajos?|shortcuts?|voice\s+commands?|comandos\s+de\s+voz)\b/.test(t)) return false
    if (this.isCreationRequest(t) || this.parseDeleteRequest(t)) return false
    if (/^(?:mis\s+|my\s+|los\s+|the\s+)?(?:macros|atajos|shortcuts)$/.test(t)) return true
    // Unicode-aware word edges: \b treats "á" as a non-letter, so "mostrá" would not match
    return /(?<!\p{L})(?:list|lista|list[aá]|listame|mostr[aá](?:me)?|mu[eé]strame|ense[nñ][aá]me|decime|dime|le[eé](?:me)?|show|tell|read|what|which|cu[aá]les|qu[eé]|tengo|have|hay|saved|guardad[oa]s)(?!\p{L})/u.test(t)
  }

  /**
   * The macro name in a delete request, or null: "borrá el macro its game time",
   * "eliminá el atajo que se llama X", "olvidate del macro X", "delete the X macro",
   * or a plain "borrá its game time" when that is a saved trigger.
   */
  public parseDeleteRequest(text: string): string | null {
    const t = normalizeMacroWords(text.trim())
    if (this.isDeleteAllRequest(t)) return null
    const verb = /^(?:borr[aá](?:me)?|elimin[aá](?:me)?|sac[aá](?:me)?|quit[aá](?:me)?|olvid[aá]te\s+de(?:l)?|delete|remove|forget)\s+/
    const m = t.match(verb)
    if (!m) return null
    let rest = t.slice(m[0].length)
    const named = rest.match(
      /^(?:el\s+|la\s+|the\s+|ese\s+|este\s+)?(?:macro|atajo|shortcut|comando\s+de\s+voz|voice\s+command)\s+(?:de\s+|del\s+|que\s+se\s+llama\s+|llamado\s+|called\s+|named\s+)?(.+)$/
    )
    if (named) rest = named[1]
    else {
      const trailing = rest.match(/^(?:the\s+)?(.+?)\s+(?:macro|shortcut)$/)
      if (trailing) rest = trailing[1]
      // Plain "borrá X": only when X is one of the saved triggers
      else if (!this.findMatch(rest, 0.85)) return null
    }
    const name = rest.replace(/^["“'«]+|["”'»?!.]+$/g, '').trim()
    return name || null
  }

  /** "borrá todos los macros", "delete all macros", "eliminá todos mis atajos"... */
  public isDeleteAllRequest(text: string): boolean {
    const t = normalizeMacroWords(text).replace(/[.!?¿¡,]+/g, ' ').replace(/\s+/g, ' ').trim()
    return /(?<!\p{L})(?:borr|elimin|sac|quit|olvid|delet|remov|clear|wipe|limpi)\p{L}*\s+(?:\p{L}+\s+){0,2}?(?:todos|todas|all|every)\s+(?:(?:los|las|mis|my|the|of\s+my|of\s+the)\s+)*(?:macros|atajos|shortcuts|voice\s+commands|comandos\s+de\s+voz)(?!\p{L})/u.test(t) ||
      /(?<!\p{L})(?:clear|wipe|reset)\s+(?:my\s+|all\s+)?macros(?!\p{L})/u.test(t)
  }

  /** Deletes every macro, keeping a copy in capri_macros.backup.json. Returns how many were removed. */
  public removeAll(): number {
    this.load()
    const count = this.macros.length
    if (count) {
      try {
        fs.writeFileSync(this.filePath().replace(/\.json$/, '.backup.json'), JSON.stringify(this.macros, null, 2), 'utf-8')
      } catch {
        // the backup is best effort
      }
    }
    this.macros = []
    this.save()
    return count
  }

  // Creation

  /** Detects "cuando yo diga X, hacé Y" / "when I say X do Y" / "creá un macro ..." */
  public isCreationRequest(text: string): boolean {
    const t = text.toLowerCase()
    return (
      /(?:cuando|cada\s+vez\s+que|si)\s+(?:yo\s+)?(?:te\s+)?(?:diga|digo|dig[aá]s)\b/.test(t) ||
      /\bwhen(?:ever)?\s+i\s+say\b/.test(t) ||
      /\b(?:cre[aá]|crear|arm[aá]|hac[eé]|guard[aá]|agreg[aá]|nuevo|create|make|add|new)\s+(?:me\s+)?(?:un|una|a)?\s*(?:macro|atajo|shortcut|comando\s+de\s+voz|voice\s+command)\b/.test(t)
    )
  }

  public async createFromSentence(sentence: string, endpoint: string): Promise<Macro | null> {
    this.load()
    const parsed = (await this.parseWithLlm(sentence, endpoint)) || this.parseHeuristic(sentence)
    if (!parsed || !parsed.trigger || parsed.actions.length === 0) return null

    // Replace an existing macro with the same trigger
    const trig = normalizeTrigger(parsed.trigger)
    this.macros = this.macros.filter((m) => normalizeTrigger(m.trigger) !== trig)

    const macro: Macro = {
      id: `macro_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      trigger: parsed.trigger,
      actions: parsed.actions,
      createdAt: Date.now()
    }
    this.macros.push(macro)
    this.save()
    console.log('[MacroService] Created macro:', JSON.stringify(macro))
    return macro
  }

  private sanitizeActions(raw: any): MacroAction[] {
    if (!Array.isArray(raw)) return []
    const out: MacroAction[] = []
    for (const a of raw) {
      if (!a || !VALID_TYPES.includes(a.type)) continue
      const act: MacroAction = { type: a.type }
      if (a.app) act.app = String(a.app).slice(0, 80)
      if (a.query) act.query = String(a.query).slice(0, 160)
      if (a.url && /^https?:\/\//i.test(String(a.url))) act.url = String(a.url)
      if (a.action && ['next', 'prev', 'play', 'pause'].includes(a.action)) act.action = a.action
      if (typeof a.on === 'boolean') act.on = a.on
      if (a.text) act.text = String(a.text).slice(0, 300)
      if (a.seconds) act.seconds = Math.min(30, Math.max(1, Number(a.seconds) || 1))
      if (a.command) act.command = String(a.command).slice(0, 400)
      // drop actions that are missing what they need
      if ((act.type === 'open_app' || act.type === 'close_app') && !act.app) continue
      if (act.type === 'play_music' && !act.query) continue
      if (act.type === 'open_url' && !act.url) continue
      if (act.type === 'say' && !act.text) continue
      if (act.type === 'command' && !act.command) continue
      out.push(act)
    }
    return out.slice(0, 12)
  }

  private async parseWithLlm(sentence: string, endpoint: string): Promise<{ trigger: string; actions: MacroAction[] } | null> {
    const base = (endpoint || 'http://localhost:11434/v1').replace(/\/+$/, '').replace(/\/v1$/, '')
    try {
      const tags = await llmFetch(`${base}/api/tags`).then((r) => r.json() as Promise<{ models?: { name: string }[] }>)
      const names = (tags.models || []).map((m) => m.name).filter((n) => !/llava|vision|-vl\b/i.test(n))
      const size = (n: string) => Number((n.match(/(\d+(?:\.\d+)?)b\b/i) || [])[1] || 99)
      // A small, fast instruction model is plenty for parsing
      const model = names.filter((n) => /qwen|llama|mistral|gemma|phi/i.test(n)).sort((a, b) => Math.abs(size(a) - 7) - Math.abs(size(b) - 7))[0] || names[0]
      if (!model) return null

      const system = [
        'You convert a user\'s voice-macro request into JSON. Output ONLY JSON: {"trigger": string, "actions": Action[]}.',
        '"trigger" is the exact phrase the user will say (keep its original language/wording, without quotes).',
        'Action types:',
        '{"type":"open_app","app":"<game or app name, e.g. League of Legends, Cyberpunk 2077, Discord, Steam, OBS>"}',
        '{"type":"close_app","app":"<name>"}',
        '{"type":"play_music","query":"<song or artist to play on Apple Music>"}',
        '{"type":"open_url","url":"https://..."}',
        '{"type":"media","action":"next|prev|play|pause"}',
        '{"type":"gaming_mode","on":true|false}   (Capri\'s game mode / modo game)',
        '{"type":"say","text":"<something Capri should say>"}',
        '{"type":"wait","seconds":<1-30>}',
        '{"type":"command","command":"<windows cmd command>"}   (only if the user explicitly asks to run a command)',
        'Keep the actions in the order the user said them. Do not invent actions the user did not ask for.'
      ].join('\n')

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 45000) // first call may need to load the model
      const res = await llmFetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: llmBody({
          model,
          stream: false,
          format: 'json',
          keep_alive: '10m',
          options: { temperature: 0.1, num_predict: 400 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: 'cuando yo diga "hora de rankear" abri el lol y pone phonk en apple music' },
            { role: 'assistant', content: '{"trigger":"hora de rankear","actions":[{"type":"open_app","app":"League of Legends"},{"type":"play_music","query":"phonk"}]}' },
            { role: 'user', content: sentence }
          ]
        })
      })
      clearTimeout(timer)
      if (!res.ok) return null
      const data = (await res.json()) as { message?: { content?: string } }
      const json = JSON.parse(data.message?.content || '{}')
      const trigger = String(json.trigger || '').replace(/^["'“”]+|["'“”]+$/g, '').trim()
      const actions = this.sanitizeActions(json.actions)
      if (!trigger || actions.length === 0) return null
      return { trigger, actions }
    } catch (err) {
      console.warn('[MacroService] LLM parse failed, using heuristic parser:', (err as any)?.message || err)
      return null
    }
  }

  /** Offline fallback: split trigger / actions on the first action verb. */
  private parseHeuristic(sentence: string): { trigger: string; actions: MacroAction[] } | null {
    const s = sentence.trim()
    const quoted = s.match(/["“'‘]([^"”'’]{2,60})["”'’]/)
    let trigger = ''
    let rest = ''
    if (quoted) {
      trigger = quoted[1]
      rest = s.slice(s.indexOf(quoted[0]) + quoted[0].length)
    } else {
      const m = s.match(/(?:diga|digo|dig[aá]s|say)\s+(.+?)\s*,?\s+((?:vos\s+|you\s+)?(?:abr[ií]|abre|pon[eé]|pone|reproduc|cerr[aá]|cierra|activ[aá]|activa|desactiv|open|play|start|launch|put|turn|close|run|ejecut).*)$/i)
      if (!m) return null
      trigger = m[1]
      rest = m[2]
    }
    const actions: MacroAction[] = []
    for (const part of rest.split(/\s*(?:,|\by\b|\band\b|\bthen\b|\bdespu[eé]s\b|\bluego\b)\s*/i)) {
      const p = part.trim()
      if (!p) continue
      let m: RegExpMatchArray | null
      if ((m = p.match(/(?:pon[eé]|pone|reproduc[ií]|reproduce|play|put\s+on)\s+(?:la\s+|el\s+|my\s+|mi\s+)?(.+?)(?:\s+(?:en|on)\s+apple\s*music)?$/i))) {
        actions.push({ type: 'play_music', query: m[1] })
      } else if (/(?:activ[aá]|activa|turn\s+on|enable)\s+(?:el\s+)?(?:modo\s+)?(?:game|gaming|juego)/i.test(p)) {
        actions.push({ type: 'gaming_mode', on: true })
      } else if ((m = p.match(/(?:cerr[aá]|cierra|close)\s+(?:el\s+|la\s+)?(.+)$/i))) {
        actions.push({ type: 'close_app', app: m[1] })
      } else if ((m = p.match(/(?:abr[ií]|abre|abrime|open|launch|start)\s+(?:el\s+|la\s+)?(.+)$/i))) {
        actions.push({ type: 'open_app', app: m[1] })
      }
    }
    return trigger && actions.length ? { trigger, actions: this.sanitizeActions(actions) } : null
  }

  // Execution

  public async run(macro: Macro, hooks: MacroRunHooks): Promise<string[]> {
    const results: string[] = []
    const cwd = process.env.USERPROFILE || process.cwd()
    for (const a of macro.actions) {
      try {
        switch (a.type) {
          case 'open_app': {
            const r = await ToolExecutor.execute('open_application', { appOrUrl: a.app }, cwd)
            results.push(`${a.app}: ${r.success ? 'ok' : r.output}`)
            break
          }
          case 'close_app': {
            const r = await ToolExecutor.execute('close_application', { appName: a.app }, cwd)
            results.push(`close ${a.app}: ${r.success ? 'ok' : r.output}`)
            break
          }
          case 'play_music': {
            const r = await ToolExecutor.execute('open_application', { appOrUrl: 'apple_music', query: a.query }, cwd)
            results.push(`apple music "${a.query}": ${r.success ? 'ok' : r.output}`)
            break
          }
          case 'open_url': {
            const r = await ToolExecutor.execute('open_application', { appOrUrl: a.url, url: a.url }, cwd)
            results.push(`${a.url}: ${r.success ? 'ok' : r.output}`)
            break
          }
          case 'media': {
            const r = await ToolExecutor.execute('media_control', { action: a.action || 'play' }, cwd)
            results.push(`media ${a.action}: ${r.success ? 'ok' : r.output}`)
            break
          }
          case 'gaming_mode':
            windowManager.setGamingMode(a.on !== false, 'top-left')
            results.push(`gaming mode ${a.on !== false ? 'on' : 'off'}`)
            break
          case 'say':
            if (a.text) hooks.say(a.text)
            break
          case 'wait':
            await new Promise((r) => setTimeout(r, (a.seconds || 1) * 1000))
            break
          case 'command': {
            const r = await ToolExecutor.execute('run_command', { command: a.command }, cwd)
            results.push(`$ ${a.command}: ${r.success ? 'ok' : r.output}`)
            break
          }
        }
      } catch (err: any) {
        results.push(`${a.type}: ${err?.message || err}`)
      }
      // Small gap so launches don't fight over focus
      await new Promise((r) => setTimeout(r, 600))
    }
    macro.lastRunAt = Date.now()
    this.save()
    return results
  }

  /** Human-readable summary of the actions for Capri's confirmation */
  public describe(macro: Macro, lang: 'es' | 'en'): string {
    const es = lang === 'es'
    const parts = macro.actions.map((a) => {
      switch (a.type) {
        case 'open_app': return es ? `abro ${a.app}` : `open ${a.app}`
        case 'close_app': return es ? `cierro ${a.app}` : `close ${a.app}`
        case 'play_music': return es ? `pongo "${a.query}" en Apple Music` : `play "${a.query}" on Apple Music`
        case 'open_url': return es ? `abro ${a.url}` : `open ${a.url}`
        case 'media':
          return es
            ? ({ pause: 'pauso la música', next: 'paso al siguiente tema', prev: 'vuelvo al tema anterior', play: 'le doy play a la música' } as Record<string, string>)[a.action || 'play']
            : ({ pause: 'pause the music', next: 'skip to the next song', prev: 'go back a song', play: 'resume the music' } as Record<string, string>)[a.action || 'play']
        case 'gaming_mode': return es ? `${a.on === false ? 'desactivo' : 'activo'} el modo game` : `turn game mode ${a.on === false ? 'off' : 'on'}`
        case 'say': return es ? `digo "${a.text}"` : `say "${a.text}"`
        case 'wait': return es ? `espero ${a.seconds}s` : `wait ${a.seconds}s`
        case 'command': return es ? `ejecuto "${a.command}"` : `run "${a.command}"`
      }
    })
    if (parts.length <= 1) return parts.join('')
    return `${parts.slice(0, -1).join(', ')} ${es ? 'y' : 'and'} ${parts[parts.length - 1]}`
  }
}

export const macroService = MacroService.getInstance()
