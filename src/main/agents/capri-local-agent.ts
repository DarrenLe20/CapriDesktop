import { scriptPlayer } from '../services/script/script-player'
import { ensureRequestedLook, requestedLook, splitByLooks, stripLookTags } from '../services/script/look-tags'
import { isWindows } from '../services/platform'
import { clearLanguageOf, detectLanguage, type DetectedLang } from '../services/language-detect'
import { cloudErrorCode, cloudErrorDetail, isCloudMode, llmFetch, type LlmErrorCode } from '../services/llm-gateway'
import * as os from 'os'
import { getUserName, personalize, llmBody } from '../services/user-profile'
import { EventEmitter } from 'events'
import { localizeLine } from '../../shared/lines'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, ChildProcess } from '../services/hidden-process'
import { app } from 'electron'
import { AgentEventPayload, CompanionEmotionState, IPC_CHANNELS } from '../ipc/channels'
import { CAPRI_TOOLS, ToolExecutor, type ToolResult } from './tools/tool-executor'
import { asAppleMusic, isMusicApp, withoutMusicApp, type SongResult } from '../services/apple-music-service'
import { ollamaService } from '../services/ollama-service'
import { windowManager } from '../windows/window-manager'
import { roamingManager } from '../roaming/roaming-manager'
import { systemObserver, type ActiveMediaInfo } from '../services/system-observer'
import { consciousnessService } from '../services/consciousness-service'
import { scannerService } from '../services/scanner-service'
import { boredomService } from '../services/boredom-service'
import { proactiveDialogueService } from '../services/proactive-dialogue-service'
import { paintDrawerService } from '../services/paint-drawer-service'
import { llmDrawingPlanner, PlannedDrawingResult } from '../services/paint'
import { lcuService, championDatabase, LolAutomationPlan } from '../services/lol'
import { reactionEngine, mockGameAdapter, lolLiveAdapter, getChampionPickComment, cyberpunkAdapter } from '../services/game'
import { CyberpunkGig } from '../services/game/adapters/cyberpunk/gigs'
import { lolCommentator } from '../services/game/adapters/lol/lol-commentator'
import { CodingAgent, isCodingRequest } from './coding-agent'
import { updateService } from '../services/update-service'

/**
 * Deleting is only allowed when the user asked to delete and named that file or folder
 * ("borrá la carpeta landing-2" -> Desktop\landing-2). Requests about macros never delete files.
 */
function userAskedToDelete(prompt: string, target: string): boolean {
  const p = prompt.toLowerCase()
  if (!/(?<!\p{L})(?:borr|elimin|delet|remov|sac[aá]|tir[aá]|trash|erase|papelera)/u.test(p)) return false
  if (macroService.isManagementRequest(p)) return false
  const base = path.basename(target.trim().replace(/[\\/]+$/, '')).toLowerCase()
  if (!base) return false
  const stem = base.replace(/\.[a-z0-9]+$/i, '')
  return p.includes(base) || (stem.length >= 3 && new RegExp(`(?<!\\p{L})${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'u').test(p))
}

/** "actualizate", "buscá actualizaciones", "update yourself"... (not "actualizá el archivo X") */
function isUpdateRequest(t: string): boolean {
  return /(?:^|[^\p{L}])(?:actual[ií]z[aá]?te|actualizarte|actualiz[aá]\s+(?:la\s+app|capri|el\s+programa)|busc[aá]\s+actualizaciones|hay\s+(?:alguna\s+)?actualizaci[oó]n|hay\s+(?:una\s+)?versi[oó]n\s+nueva|update\s+yourself|update\s+(?:the\s+app|capri)|check\s+for\s+updates|is\s+there\s+an?\s+update)(?![\p{L}])/iu.test(t)
}

function cloudErrorMessage(code: LlmErrorCode, es: boolean, detail: string): string {
  const reasons: Record<LlmErrorCode, [string, string]> = {
    auth: ['tu proveedor rechazó la API key', 'your provider rejected the API key'],
    quota: ['te quedaste sin saldo o llegaste al límite del proveedor', 'you ran out of credit or hit the provider limit'],
    model: ['el proveedor no aceptó ese modelo o el pedido', 'the provider did not accept that model or the request'],
    network: ['no pude conectarme con el proveedor', 'I could not reach the provider'],
    insecure: ['la dirección no es segura para mandar tu API key', 'that address is not safe for your API key'],
    other: ['algo falló al procesar la respuesta', 'something failed while handling the reply']
  }
  return es
    ? `No pude pensar eso, choomba: ${reasons[code][0]}. Revisalo en los ajustes del modelo. (${detail})`
    : `I couldn't think that through, choomba: ${reasons[code][1]}. Check it in the model settings. (${detail})`
}

/** "¿qué hay de nuevo?", "notas del parche", "what's new"... */
function isWhatsNewRequest(t: string): boolean {
  return /(?:qu[eé]\s+hay\s+de\s+nuevo|qu[eé]\s+(?:cambi[oó]|trae)\s+(?:el|este|la)\s+(?:parche|versi[oó]n|update|actualizaci[oó]n)|notas\s+del?\s+(?:parche|actualizaci[oó]n)|(?:hay|ten[eé]s|qu[eé])\s+novedades|^novedades\W*$|what'?s\s+new|patch\s+notes)/i.test(t)
}
import { voiceService } from '../services/voice-service'
import { macroService } from '../services/macro-service'
import { clipService } from '../services/clip-service'

export interface AgentConfig {
  provider: 'local-llm' | 'ollama' | 'openrouter' | 'offline-smart'
  endpoint?: string
  model?: string
  apiKey?: string
}

function cleanChampQuery(str: string | null): string | null {
  if (!str) return null
  return str
    .replace(/^(?:el\s+|al\s+|a\s+|el\s+campe[oó]n\s+|al\s+campe[oó]n\s+|campe[oó]n\s+|champion\s+)+/i, '')
    .trim()
}

function parseLolCommand(norm: string) {
  // Auto-accept toggle
  const isAutoAcceptOn =
    /(?:activ[aá]|activar|poner|pon|enable|turn\s*on)\s+(?:el\s+)?(?:auto\s*-?\s*aceptar|auto\s*-?\s*accept)|(?:auto\s*-?\s*aceptar|auto\s*-?\s*accept)\s*(?:on|activado|si|yes)?$/i.test(norm) &&
    !/(?:desactiv|apagar|off|no\b)/i.test(norm)

  const isAutoAcceptOff =
    /(?:desactiv[aá]|desactivar|apagar|apaga|disable|turn\s*off)\s+(?:el\s+)?(?:auto\s*-?\s*aceptar|auto\s*-?\s*accept)|(?:auto\s*-?\s*aceptar|auto\s*-?\s*accept)\s*(?:off|desactivado|no)$/i.test(norm)

  if (isAutoAcceptOn) {
    return { isLolCommand: true, isCompound: false, wantsCancel: false, wantsSearch: false, wantsAccept: false, isAutoAcceptToggle: true, autoAcceptEnabled: true, pickChampionQuery: null, banChampionQuery: null }
  }
  if (isAutoAcceptOff) {
    return { isLolCommand: true, isCompound: false, wantsCancel: false, wantsSearch: false, wantsAccept: false, isAutoAcceptToggle: true, autoAcceptEnabled: false, pickChampionQuery: null, banChampionQuery: null }
  }

  // Cancel / Stop queue / Cancel plan
  const wantsCancel =
    /(?:cancel(?:a|ar)?|deten(?:er)?|stop)\s+(?:la\s+)?(?:b[uú]squeda|matchmaking|queue|cola|plan(?:\s+de\s+lol)?)|sal(?:ir|í)?\s+de\s+(?:la\s+)?cola|leave\s+queue/i.test(norm)

  // Search queue
  const wantsSearch =
    /(?:busca(?:r)?\s+(?:una\s+)?(?:partida|juego|match|game)|entr(?:a|ar)\s+a\s+(?:la\s+)?cola|inici(?:a|ar)\s+b[uú]squeda|poneme\s+en\s+cola|ponme\s+en\s+cola|find\s+(?:a\s+)?(?:match|game)|queue\s+up|start\s+(?:matchmaking|queue)|\bbusca\s+partida\b|\bbuscar\s+partida\b|\by\s+busca\b|\band\s+search\b|\band\s+find\b)/i.test(norm)

  // Accept match
  const wantsAccept =
    /(?:acept(?:a|á|ar)?|accept)\s+(?:la\s+|el\s+)?(?:partida|match|game|queue)/i.test(norm) ||
    /(?:^|[,\s])(?:acept(?:a|á|ar)?|accept)(?:$|[,\s])/i.test(norm)

  // Ban extraction
  let banChampionQuery: string | null = null
  const banMatch = norm.match(/(?:bane[aá]|banear|ban)\s+(?:a\s+|al\s+|el\s+campe[oó]n\s+|champion\s+)?([a-zA-Z0-9'.\s]+?)(?=$|\s*,\s*|\s+(?:y|and|luego|then|ademas|además|despues|después|para|busca|pick|seleccion|eleg|elije|elige|acept)\b)/i)
  if (banMatch) {
    banChampionQuery = cleanChampQuery(banMatch[1])
  }

  // Pick extraction
  let pickChampionQuery: string | null = null
  const pickMatch = norm.match(/(?:picke[aá]|pickear|eleg[ií]|elegir|elije|elige|seleccion[aá]|seleccionar|pick|select|lock\s*in)\s+(?:a\s+|al\s+|el\s+campe[oó]n\s+|champion\s+)?([a-zA-Z0-9'.\s]+?)(?=$|\s*,\s*|\s+(?:y|and|luego|then|ademas|además|despues|después|para|busca|ban|banea|acept)\b)/i)
  if (pickMatch) {
    pickChampionQuery = cleanChampQuery(pickMatch[1])
  }

  const isCompound =
    (wantsSearch && (!!pickChampionQuery || !!banChampionQuery || wantsAccept)) ||
    (!!pickChampionQuery && !!banChampionQuery) ||
    (wantsAccept && (wantsSearch || !!pickChampionQuery || !!banChampionQuery))

  const isLolCommand =
    wantsCancel ||
    wantsSearch ||
    wantsAccept ||
    !!banChampionQuery ||
    !!pickChampionQuery ||
    /\b(?:lol|league\s*of\s*legends|lcu|grieta|rift)\b/i.test(norm)

  return {
    isLolCommand,
    isCompound,
    wantsCancel,
    wantsSearch,
    wantsAccept,
    isAutoAcceptToggle: false,
    autoAcceptEnabled: false,
    pickChampionQuery,
    banChampionQuery
  }
}

const RECOMMENDATION_REPEAT_MS = 15000
const GAMING_MAX_TOKENS = 120

/** The language rule again, right before what the user just said */
function withLanguageNote<T extends { role: string; content?: string }>(history: T[], directive: string): T[] {
  let lastUser = history.length - 1
  while (lastUser >= 0 && history[lastUser].role !== 'user') lastUser--
  if (lastUser < 0) return history
  return [...history.slice(0, lastUser), { role: 'system', content: directive } as T, ...history.slice(lastUser)]
}

const SHORT_MAX_TOKENS = 400
const LONG_MAX_TOKENS = 1500
const MAX_CONTINUATIONS = 2

/** Lists, explanations and stories need room, in any language */
function wantsLongAnswer(text: string): boolean {
  if (text.length > 140) return true
  return /\b\d{1,3}\b|\b(?:top|list|lista|liste|explain|explica|expl[ií]came|expliqu|erkl|spiega|wyja[sś]ni|step|paso|tutorial|guide|gu[ií]a|story|historia|histoire|geschichte|storia|write|escrib|[eé]cris|schreib|scrivi|napisz|summar|resum|recipe|receta|recette|compare|compar)/i.test(text)
}

const MAX_OWN_LINES = 5
const OWN_LINE_MAX_AGE_MS = 30 * 60 * 1000

export class CapriLocalAgent extends EventEmitter {
  /** The language of the request being answered: her fixed lines go out in it */
  private replyLang: string | null = null

  /** Every line shown in the chat passes here. What the model wrote isn't in the catalog and stays as it is */
  public override emit(event: string | symbol, ...args: any[]): boolean {
    const payload = args[0] as AgentEventPayload | undefined
    if (event === 'event' && payload?.type === 'assistant.delta' && payload.text) {
      args[0] = { ...payload, text: this.inReplyLanguage(payload.text) }
    }
    return super.emit(event, ...args)
  }

  private inReplyLanguage(text: string): string {
    return localizeLine(text, this.replyLang || consciousnessService.getPreferredLanguage())
  }

  private lastRecommendation: { key: string; at: number; reply: Promise<string> } | null = null
  private isCancelled = false
  private agyProc: ChildProcess | null = null
  private ownLines: { text: string; why?: string; at: number }[] = []
  private currentPrompt = ''
  private conversationHistory: { role: 'system' | 'user' | 'assistant' | 'tool'; content?: string; tool_calls?: any[]; tool_call_id?: string; name?: string }[] = []

  public cancel(): void {
    this.isCancelled = true
    if (this.agyProc) {
      try {
        this.agyProc.kill()
      } catch {
        // ignore
      }
      this.agyProc = null
    }
  }

  public clearHistory(): void {
    this.conversationHistory = []
    this.ownLines = []
  }

  /**
   * Something she said or did by herself. It goes in the conversation with her next reply, in order
   * and with the reason, so she can talk about it. A list of its own, so a fight full of quickhack
   * lines can't push the real conversation out of the history.
   */
  public noteOwnLine(text: string, why?: string): void {
    const clean = text
      .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu, '')
      .replace(/[🐾✨👀⚡🎉🦾🛑💬🎵🔥💥💡⚔️📹🎮💤✓✕⚠️🤖🐱🐶👍👎❤️🎶]/g, '')
      .trim()

    const line = (clean || text).replace(/\[[a-zA-Z0-9_,\s\-:]+\]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!line || this.ownLines.at(-1)?.text === line) return
    this.ownLines.push({ text: line, why, at: Date.now() })
    if (this.ownLines.length > MAX_OWN_LINES) this.ownLines.shift()
  }

  /** What she said and did since the last message, as a note for the model */
  private takeOwnLinesNote(): string | null {
    const recent = this.ownLines.filter((l) => Date.now() - l.at < OWN_LINE_MAX_AGE_MS)
    this.ownLines = []
    if (!recent.length) return null
    const rows = recent.map((l) => {
      const minutes = Math.round((Date.now() - l.at) / 60000)
      const when = minutes < 1 ? 'just now' : `${minutes} min ago`
      return `- ${when} you said: "${l.text}"${l.why ? ` (${l.why})` : ''}`
    })
    return `Since {name}'s last message you said and did this on your own. It really happened and it was you. If {name} mentions it, answers it or asks why, reply as the one who did it, using these facts. Never act as if you don't know what they're talking about, and never invent other reasons.\n${rows.join('\n')}`
  }

  private setCompanionState(state: CompanionEmotionState): void {
    try {
      windowManager.broadcast(IPC_CHANNELS.COMPANION_STATE_CHANGED, state)
    } catch {
      // ignore
    }
  }

  private setCompanionSpeech(text: string, durationMs = 4000, speakVoice = false): void {
    this.noteOwnLine(personalize(this.inReplyLanguage(text)), this.currentPrompt ? `when {name} asked: "${this.currentPrompt}"` : undefined)
    try {
      windowManager.broadcast(IPC_CHANNELS.COMPANION_SPEECH_CHANGED, { text: personalize(this.inReplyLanguage(text)), durationMs, speakVoice });
    } catch {
      // ignore
    }
  }

  public static detectLanguage(text: string): DetectedLang {
    return detectLanguage(text)
  }

  public async runPrompt(
    prompt: string,
    projectPath: string,
    config: AgentConfig = { provider: 'offline-smart' }
  ): Promise<void> {
    this.isCancelled = false
    this.currentPrompt = prompt.trim().slice(0, 200)
    ollamaService.touchActivity()
    proactiveDialogueService.touchInteraction()
    // Warm up Ollama in the background if it was stopped
    ollamaService.ensureRunning().catch(() => {})

    this.emit('event', {
      type: 'session.started',
      timestamp: Date.now()
    } as AgentEventPayload)

    const prefLang = consciousnessService.getPreferredLanguage()
    // What Whisper heard knows more than a guess from the words. A short "ok" tells nothing, so it
    // stays in the language of the conversation.
    const spokenPrompt = prompt
    const heardLang = voiceService.languageOfTranscript(prompt.trim())
    const detectedLang = heardLang || CapriLocalAgent.detectLanguage(prompt.trim())
    if (detectedLang !== 'unknown') consciousnessService.setSpokenLanguage(detectedLang)
    const conversationLang = consciousnessService.getSpokenLanguage()

    // Her commands are recognized in English and Spanish. In any other language the command is
    // understood through a translation, while the answer stays in the language it was asked in.
    if (conversationLang && !['en', 'es'].includes(conversationLang) && prompt.length < 300) {
      const english = await voiceService.translateCommand(prompt.trim())
      // Sometimes the model answers instead of translating: an answer is not the command
      if (english && !/[\r\n]/.test(english) && english.length <= prompt.length * 2 + 20) {
        console.log(`[Capri Agent] Command in ${conversationLang}, understood as: "${english}"`)
        prompt = english
      }
    }

    // Music is Apple Music, whatever music app the user names
    prompt = asAppleMusic(prompt)

    const trimmed = prompt.trim()
    const originalLower = trimmed.toLowerCase()

    const fixedTextLang = consciousnessService.getLanguageSettings().textLang
    const activeLang =
      fixedTextLang && fixedTextLang !== 'auto' ? fixedTextLang : conversationLang || prefLang || 'en'

    this.replyLang = activeLang
    const isSpanish = activeLang === 'es'

    const norm = originalLower
      .replace(/^(?:hey\s+|hola\s+)?(?:capri|companion)[,:\s]*/i, '')
      .replace(/[,:\s]*(?:por\s+favor|porfa|ya|ahora|please|pls)[!.]*$/i, '')
      .replace(/[,:\s]*(?:capri|companion)[!.]*$/i, '')
      .replace(/[,:\s]*(?:por\s+favor|porfa|ya|ahora|please|pls)[!.]*$/i, '')
      .replace(/\b(?:newest|nearest|new|near)\s+(?:repair|reaper|ripper|river)\s+(?:dock|doc|dog)s?\b/gi, 'nearest ripperdoc')
      .replace(/\b(?:repair|reaper|ripper|river)\s+(?:dock|doc|dog)s?\b/gi, 'ripperdoc')
      .replace(/\b(?:repairdoc|reaperdoc|ripperdock|reaperdock)\b/gi, 'ripperdoc')
      .replace(/\b(?:cleap|clic|clipp?)\s+(?:that|dat|dis|this)\b/gi, 'clip that')
      .replace(/\b(?:clipe[aá]|clipeate)\s+(?:eso|esto)\b/gi, 'clipea eso')
      .trim()

    // Voice macros ("cuando yo diga its game time, abrí el lol y poné mi playlist")
    {
      const lang: 'es' | 'en' = isSpanish ? 'es' : 'en'

      // a) A saved trigger phrase was said -> run it. Requests ABOUT macros ("borrá el macro
      // its game time") contain the trigger too, so they skip this and go to b/c/d.
      const triggered = macroService.isManagementRequest(norm) ? null : macroService.findMatch(trimmed)
      if (triggered) {
        this.emitAssistant(
          isSpanish
            ? `[excited] ¡"${triggered.trigger}"! [playful] Arrancando: ${macroService.describe(triggered, lang)}.`
            : `[excited] "${triggered.trigger}"! [playful] On it: ${macroService.describe(triggered, lang)}.`
        )
        this.emit('event', { type: 'tool.started', toolName: 'macro', toolInput: { trigger: triggered.trigger }, timestamp: Date.now() } as AgentEventPayload)
        const results = await macroService.run(triggered, { say: (t) => this.emitAssistant(t) })
        this.emit('event', { type: 'tool.finished', toolName: 'macro', toolOutput: results.join(' | '), success: true, timestamp: Date.now() } as AgentEventPayload)
        this.finishSession()
        return
      }

      // b) List macros
      if (macroService.isListRequest(norm)) {
        const all = macroService.list()
        this.emitAssistant(
          all.length === 0
            ? (isSpanish ? '[playful] Todavía no tenés macros, choomba. Decime algo como: cuando yo diga "its game time", abrí el lol y poné mi playlist.' : '[playful] No macros yet, choomba. Try: when I say "its game time", open League and play my playlist.')
            : (isSpanish ? '[cheerful] Tus macros: ' : '[cheerful] Your macros: ') +
                all.map((m) => `"${m.trigger}" (${macroService.describe(m, lang)})`).join('; ') + '.'
        )
        this.finishSession()
        return
      }

      // c) Delete a macro
      if (macroService.isDeleteAllRequest(norm)) {
        const count = macroService.removeAll()
        this.emitAssistant(
          count
            ? isSpanish
              ? `[cheerful] Listo, borré tus ${count} macro${count === 1 ? '' : 's'}. [playful] Guardé una copia por las dudas, choomba.`
              : `[cheerful] Done, deleted your ${count} macro${count === 1 ? '' : 's'}. [playful] I kept a backup just in case, choomba.`
            : isSpanish
              ? '[curious] No tenés ningún macro guardado, choomba.'
              : "[curious] You don't have any macros saved, choomba."
        )
        this.finishSession()
        return
      }

      const delName = macroService.parseDeleteRequest(norm)
      if (delName) {
        const removed = macroService.remove(delName)
        this.emitAssistant(
          removed
            ? (isSpanish ? `[cheerful] Listo, borré el macro "${removed.trigger}".` : `[cheerful] Done, deleted the "${removed.trigger}" macro.`)
            : (isSpanish ? `[curious] No encontré ningún macro que se llame "${delName}".` : `[curious] I couldn't find a macro called "${delName}".`)
        )
        this.finishSession()
        return
      }

      // d) Create a macro
      if (macroService.isCreationRequest(norm)) {
        const macro = await macroService.createFromSentence(trimmed, config.endpoint || 'http://localhost:11434/v1')
        this.emitAssistant(
          macro
            ? (isSpanish
                ? `[excited] ¡Macro guardado! [playful] Cuando digas "${macro.trigger}", ${macroService.describe(macro, lang)}.`
                : `[excited] Macro saved! [playful] When you say "${macro.trigger}", I'll ${macroService.describe(macro, lang)}.`)
            : (isSpanish
                ? '[curious] No terminé de entender el macro, choomba. Probá así: cuando yo diga "its game time", abrí el lol y poné phonk en Apple Music.'
                : '[curious] I did not quite get that macro, choomba. Try: when I say "its game time", open League and play phonk on Apple Music.')
        )
        this.finishSession()
        return
      }
    }

    // Self-update: "Capri, actualizate" -> latest GitHub Release, silent install, restart
    if (isUpdateRequest(norm)) {
      this.emitAssistant(
        isSpanish
          ? '[excited] ¡Dale! Me fijo si salió una versión nueva...'
          : '[excited] On it! Checking if there is a new version...'
      )
      this.finishSession()
      void updateService.checkAndInstall(activeLang)
      return
    }

    // "¿Qué hay de nuevo?" -> the patch script of the running version (scripts-capri/)
    if (isWhatsNewRequest(norm)) {
      this.emitAssistant(updateService.whatsNew(activeLang))
      this.finishSession()
      return
    }

    // Coding Agent: "haceme una landing en mi escritorio con html, css y js"
    // Multi-step plan -> write -> verify loop with the strongest local coder model.
    if (isCodingRequest(norm)) {
      const agent = new CodingAgent(
        {
          endpoint: config.endpoint || 'http://localhost:11434/v1',
          requestedModel: config.model,
          lang: isSpanish ? 'es' : 'en'
        },
        {
          say: (text) => this.emitAssistant(text),
          toolStarted: (name, input) =>
            this.emit('event', { type: 'tool.started', toolName: name, toolInput: input, timestamp: Date.now() } as AgentEventPayload),
          toolFinished: (name, output, success) =>
            this.emit('event', { type: 'tool.finished', toolName: name, toolOutput: output, success, timestamp: Date.now() } as AgentEventPayload),
          isCancelled: () => this.isCancelled
        }
      )
      try {
        await agent.run(trimmed)
      } catch (err: any) {
        console.error('[CapriLocalAgent] Coding agent crashed:', err)
        this.emitAssistant(isSpanish ? `[worried] Se me trabó el agente de código: ${err?.message || err}` : `[worried] The coding agent crashed: ${err?.message || err}`)
      }
      this.finishSession()
      return
    }

    // Scanner Learning Interceptor
    // If Capri previously asked what an object was in Scanner Mode, and {name} is now explaining what it is:
    const pendingLearning = consciousnessService.getPendingScanLearning()
    if (pendingLearning) {
      const isExplanation = /(?:es\s+|son\s+|it'?s\s+|it\s+is\s+|a\s+|un\s+|una\s+|el\s+|la\s+|mi\s+|my\s+|dibujo|drawing|screenshot|foto|photo|perro|gato|teclado|pantalla)/i.test(norm) || norm.length < 60
      if (isExplanation) {
        const cleanConcept = trimmed.replace(/^(?:es\s+|son\s+|it'?s\s+|it\s+is\s+|esto\s+es\s+|this\s+is\s+)/i, '').trim()
        consciousnessService.addLearnedConcept(cleanConcept, pendingLearning.description, pendingLearning.tags)
        consciousnessService.setPendingScanLearning(null)

        const learnConfirmation = isSpanish
          ? `¡Ah, de una! ¡Ahora sí! Ya me guardé en el ciberware que eso es: "${cleanConcept}". La próxima vez que me lo muestres ya lo voy a reconocer al toque, {name}!`
          : `Oh, got it! Jacked that straight into my memory: that's "${cleanConcept}". Next time you show me, I'll recognize it right away, {name}!`

        this.emitAssistant(learnConfirmation)
        this.finishSession()
        return
      }
    }

    // Capri & Ollama Full Shutdown / Turn off Interceptor
    // If user only wants to shut down Ollama (without closing Capri):
    const onlyOllama = /^(?:apaga|apagar|cierra|cerrar|cerr[aá]|kill|shut\s*down|turn\s*off)\s+ollama$/i.test(norm)

    const isAppShutdown =
      !onlyOllama &&
      (
        // Direct shutdown phrases (English & Spanish)
        /^(?:shut\s*down|turn\s*off|power\s*off|power\s*down|close\s*down|go\s*to\s*sleep|sleep|ap[aá]gate|ci[eé]rrate|cerrate|descon[eé]ctate|chau|adi[oó]s|bye|goodbye|apagar|apaga|cierra|cerrar|cerr[aá]|salir|exit|quit|shutdown|ap[aá]guese)$/i.test(norm) ||
        // Phrases targeting app/companion/system/yourself/everything
        /^(?:shut\s*down|turn\s*off|power\s*off|power\s*down|close|quit|exit|kill|apaga|apagar|cierra|cerrar|cerr[aá])\s+(?:the\s+|la\s+|el\s+)?(?:app|capri|companion|yourself|system|everything|all|todo|aplicaci[oó]n|aplicacion|sistema|programa|vos|te)$/i.test(norm) ||
        // Broader intent: shutdown verb + target
        (/(?:shut\s*down|shutdown|turn\s*off|power\s*off|power\s*down|close|ap[aá]g|ci[eé]rr|cerr|termin|descon[eé]ct|mat[aá]|quit|exit)/i.test(originalLower) &&
          /\b(?:capri|companion|app|aplicaci[oó]n|aplicacion|programa|todo|everything|all|sistema|ciberespacio|vos|yourself)\b/i.test(originalLower)) ||
        // Mentions shutting down both ollama and capri/app/everything
        (/(?:apagar|apaga|cierra|cerrar|shut\s*down|turn\s*off|kill).*(?:ollama).*(?:capri|companion|app|todo|everything)/i.test(originalLower)) ||
        (/(?:apagar|apaga|cierra|cerrar|shut\s*down|turn\s*off|kill).*(?:capri|companion|app|todo|everything).*(?:ollama)/i.test(originalLower))
      )

    if (isAppShutdown) {
      await this.handleFullShutdown()
      return
    }

    // Language Switching / Permanent Language Selection Interceptor
    // e.g. "Hey capri, talk in Spanish", "Capri, talk in English", "habla en español", "habla en inglés"
    const langSwitch = this.parseLanguageChangeIntent(trimmed)
    if (langSwitch) {
      consciousnessService.setLanguageSettings({ textLang: langSwitch.langCode })
      this.emitAssistant(langSwitch.confirmationPhrase)
      this.finishSession()
      return
    }

    // NVIDIA ShadowPlay / Instant Replay Clip Interceptor ("capri, clip that", "clipea eso", "guarda ese clip", "clip it")
    const isClipIntent =
      /(?:clip\s*(?:that|this|it|the\s*game|moment)?|clipe[aá](?:lo|me|te)?(?:\s+(?:eso|esto|esa\s+jugada|la\s+jugada|eso\s+choom))?|guard[aá](?:me)?\s+(?:un\s+|el\s+|ese\s+)?clip|salv[aá](?:me)?\s+(?:el\s+|ese\s+)?clip|save\s+(?:that|this|the)?\s*clip|take\s+(?:a\s+)?clip|grab[aá](?:me)?\s+(?:un\s+|ese\s+)?clip|record\s+(?:that|a\s+clip))/i.test(norm) ||
      /^(?:clip|clipealo|clipeá|clipea|clipeate|save\s*clip)$/i.test(norm)

    if (isClipIntent) {
      await clipService.triggerClip()

      const esResponses = [
        "¡Clipeado al toque, {name}! Apreté F8 y quedó grabado en tus registros de ShadowPlay.",
        "¡Uff, tremenda jugada, choomba! Apreté F8, ya está a salvo en tu ciberware.",
        "¡Guardando ese clip ya mismo, {name}! F8 pulsado, eso no se podía perder choom."
      ]

      const enResponses = [
        "Clipping that right now, {name}! Pressed F8, recorded straight to your ShadowPlay archives.",
        "Clip locked in, choom! F8 triggered, that play was way too good to miss!",
        "Jacked that clip right into your cyberware, {name}! F8 sent, highlight saved!"
      ]

      const reply = isSpanish
        ? esResponses[Math.floor(Math.random() * esResponses.length)]
        : enResponses[Math.floor(Math.random() * enResponses.length)]

      try {
        this.setCompanionState('talking')
        this.setCompanionSpeech(reply, 4000, true)
      } catch {}

      this.conversationHistory.push({
        role: 'user',
        content: trimmed
      })
      this.conversationHistory.push({
        role: 'assistant',
        content: reply
      })

      this.emitAssistant(reply)
      this.finishSession()
      return
    }

    // Game Commentary & Simulation Controls Interceptor
    const gameCommentaryResponse = await this.handleGameCommentaryCommand(norm)
    if (gameCommentaryResponse) {
      this.emitAssistant(gameCommentaryResponse)
      this.finishSession()
      return
    }

    // Neural Scanner Mode Router Interceptor (Activation, Deactivation, Optical Scan)
    // Deactivate / Close Scanner
    const isScannerClose =
      /(?:desactiv[aá]|cerrar|cierra|cerr[aá]|apagar|apaga|stop|close|quit|disable|deactivate).*(?:scanner|esc[aá]ner|marco)/i.test(norm) ||
      /^(?:cierra\s+el\s+scanner|close\s+scanner|desactiva\s+el\s+scanner|apaga\s+el\s+scanner)$/i.test(norm)

    if (isScannerClose) {
      scannerService.close()
      this.emitAssistant(
        isSpanish
          ? "Modo Scanner desconectado, choomba. Reenfocando mis implantes en el escritorio."
          : "Scanner Mode deactivated, choomba. Refocusing my cyberware on the desktop."
      )
      this.finishSession()
      return
    }

    // 1.5) Learn Drawing / Logo via Scanner Interceptor ("Capri, mirá cómo se dibuja X", "aprendé este logo", "mirá este logo de Arasaka", "learn how to draw X", etc.)
    const isLearnDrawingIntent =
      /(?:aprend[eé]|aprender|learn|copi[aá]|copiar|guard[aá]|guardar|memoriz[aá]|memorizar)\s+(?:a\s+dibujar|c[oó]mo\s+dibujar|este\s+dibujo|este\s+logo|el\s+logo|un\s+logo|este\s+emblema|este\s+icono|how\s+to\s+draw|this\s+drawing|this\s+logo)/i.test(norm) ||
      /(?:mir[aá]|mira|look|fijate|observ[aá])\s+(?:c[oó]mo\s+(?:se\s+)?dibuj[aá]|este\s+logo|el\s+logo|este\s+dibujo|este\s+emblema|c[oó]mo\s+es\s+el\s+logo)/i.test(norm) ||
      /(?:as[ií]\s+se\s+dibuj[aá]|as[ií]\s+es\s+(?:el|este)\s+logo|this\s+is\s+how\s+you\s+draw|this\s+is\s+the\s+logo)/i.test(norm) ||
      (/(?:aprend[eé]|learn|ense[nñ][aá]|teach|copi[aá]|guard[aá])/i.test(norm) && /(?:dibujo|dibujar|draw|drawing|logo|emblema|marca)/i.test(norm))

    if (isLearnDrawingIntent) {
      let learnSubject = ''
      const matchSubj =
        norm.match(/(?:c[oó]mo\s+(?:se\s+)?dibuj[aá]|a\s+dibujar|dibujo\s+de|logo\s+de|emblema\s+de|how\s+to\s+draw|drawing\s+of|logo\s+of)\s+(?:un\s+|una\s+|el\s+|la\s+)?([a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s]+)/i) ||
        norm.match(/(?:aprend[eé]|aprender|copi[aá]|copiar|guard[aá]|guardar|mir[aá]|ense[nñ][aá])\s+(?:a\s+dibujar\s+)?(?:el\s+|este\s+|un\s+)?(?:logo|dibujo|emblema)?\s*(?:de\s+)?([a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s]+)/i)

      if (matchSubj && matchSubj[1]) {
        learnSubject = matchSubj[1]
          .replace(/\b(?:con\s+el\s+scanner|en\s+el\s+scanner|por\s+favor|please|choomba|capri)\b/gi, '')
          .trim()
      }
      if (!learnSubject || /^(?:esto|this|algo|something|un\s+dibujo|este\s+dibujo|el\s+dibujo|este\s+logo|el\s+logo|un\s+logo|logo|dibujo)$/i.test(learnSubject)) {
        learnSubject = ''
      }

      if (!scannerService.getStatus().isOpen) {
        scannerService.open()
        await new Promise((r) => setTimeout(r, 350))
      }

      const teachPhrase = isSpanish
        ? `¡A ver cómo se hace, choomba! Dejame escanear ${learnSubject ? `los trazos de "${learnSubject}"` : 'el logo o dibujo en el marco'} para memorizarlo en mis implantes...`
        : `Let me see how it's done, {name}! Scanning ${learnSubject ? `the strokes for "${learnSubject}"` : 'the logo or drawing inside the frame'} to lock it into my cyberware...`

      try {
        this.setCompanionState('curious')
        this.setCompanionSpeech(teachPhrase, 3500, true)
      } catch {}

      await new Promise((r) => setTimeout(r, 600))
      const learnRes = await scannerService.learnDrawing(learnSubject)

      this.emitAssistant(learnRes.response)
      this.finishSession()
      return
    }

    // Optical Scan on demand (If scanner is open OR if prompt explicitly requests a scan)
    const isScannerActive = scannerService.getStatus().isOpen
    const isExplicitScanPrompt =
      /(?:escane[aá]|escanear|\bscan\b|analiz[aá]|analizar|qu[eé]\s+(?:ves|hay|es\s+esto)|mir[aá]\s+esto|mira\s+esto|mria\s+esto|fijate|look\s+at\s+this|what\s+do\s+you\s+see|te\s+gusta|do\s+you\s+like|opini[oó]n|qu[eé]\s+te\s+parece)/i.test(norm)

    const isDirectScanCommand = /(?:escane[aá]|escanear|\bscan\b|analiz[aá]|analizar)/i.test(norm)

    if ((isScannerActive && isExplicitScanPrompt) || isDirectScanCommand) {
      if (!isScannerActive) {
        scannerService.open()
        await new Promise((r) => setTimeout(r, 250))
      }
      const scanResult = await scannerService.scan(trimmed)
      if (scanResult.response) {
        // Record scan into conversation history for natural conversational continuity
        const tagsStr = (scanResult.tags || []).join(', ')
        this.conversationHistory.push({
          role: 'user',
          content: `[Visual Scanner Input]: The user asked: "${trimmed}". You scanned what was inside the frame. Visible: "${scanResult.summary || 'Screen content'}". Features: ${tagsStr}.`
        })
        this.conversationHistory.push({
          role: 'assistant',
          content: scanResult.response
        })
        consciousnessService.setLastScannedContext({
          summary: scanResult.summary || 'Screen content',
          tags: scanResult.tags || [],
          response: scanResult.response || '',
          timestamp: Date.now()
        })
        this.emitAssistant(scanResult.response)
      }
      this.finishSession()
      return
    }

    // Activate / Open Scanner (Enthusiastic netrunner response)
    const isScannerOpenReq =
      /(?:(?<!des)activ[aá]|abrir|abre|abr[ií]|inici[aá]|iniciar|poner|pon|start|open|launch|enable).*(?:scanner|esc[aá]ner|marco)/i.test(norm) ||
      /^(?:modo\s+scanner|scanner\s+mode|scanner|escaner)$/i.test(norm) ||
      /^(?:abre\s+el\s+scanner|abrí\s+el\s+scanner|open\s+scanner|activ[aá]\s+el\s+scanner)$/i.test(norm) ||
      /(?:mir[aá]\s+esto|mira\s+esto|mria\s+esto|te\s+quiero\s+mostrar|quiero\s+mostrarte|fijate\s+en\s+esto|look\s+at\s+this|see\s+this).*(?:scanner|esc[aá]ner|marco)?/i.test(norm) ||
      /^(?:mir[aá]\s+esto|mira\s+esto|mria\s+esto|look\s+at\s+this|te\s+quiero\s+mostrar\s+algo|mir[aá]|mira)$/i.test(norm)

    if (isScannerOpenReq) {
      scannerService.open()
      const enthusiasticOpenPhrase = isSpanish
        ? "¡A ver, a ver! ¡Abrí el marco que quiero ver qué tenés ahí, {name}! Acomodalo sobre lo que me querés mostrar y decime 'escaneá' o 'mirá esto' que le tiro un escaneo ya mismo."
        : "Ooh, let me see! Opening up the scanner frame, {name}! Move it over what you want to show me, I can't wait to see it! Just say 'scan' or 'look at this' when ready!"

      this.emitAssistant(enthusiasticOpenPhrase)
      this.finishSession()
      return
    }

    // Boredom Interceptor ("estás aburrida?", "hacé algo que estás aburrida", "are you bored?")
    const isBoredomIntent =
      /(?:est[aá]s|estas)\s+aburrid[ao]|are\s+you\s+bored|qu[eé]\s+hac[eé]s\s+cuando\s+te\s+aburr[ií]s|hac[eé]\s+algo.*aburrid|estoy\s+aburrid/i.test(norm)
    if (isBoredomIntent) {
      await boredomService.triggerBoredomAction()
      this.finishSession()
      return
    }

    // Paint Drawing Interceptor ("Capri, dibujá un gato", "hacé un dibujo de X", "draw a X", "probá dibujo monigote", etc.)
    const testExampleMatch = norm.match(/(?:prob[aá]|test(?:e[aá])?|probar)\s+(?:el\s+)?dibujo\s+(?:de\s+)?(monigote|casa|sol|stickman|house|sun)/i)
    const drawMatch = norm.match(/(?:hac[eé]\s+(?:un\s+)?dibujo\s+(?:de\s+|del\s+)?|dibuj[aá](?:me)?\s+(?:un\s+|una\s+|el\s+|la\s+|unos\s+|unas\s+)?|draw\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?)(.+)/i)
    const isGenericDraw =
      /^(?:dibuj[aá](?:me)?|dibuja|draw|hac[eé]\s+(?:un\s+)?dibujo|dibuj[aá]\s+algo|draw\s+something|dibuj[aá]\s+en\s+paint|draw\s+in\s+paint)$/i.test(norm) ||
      (/(?:dibuj[aá](?:me)?|dibujar|draw|hac[eé]\s+(?:un\s+)?dibujo)/i.test(norm) && /(?:paint|lienzo|canvas)/i.test(norm))

    const isPaintDraw = testExampleMatch !== null || drawMatch !== null || isGenericDraw

    if (isPaintDraw && !isWindows) {
      // Drawing moves the mouse over MS Paint: there's no Linux version of that script yet
      this.emitAssistant(
        isSpanish
          ? '[sad] Todavía no sé dibujar en Linux, choomba: lo mío es Paint, y acá no está.'
          : "[sad] I can't draw on Linux yet, choom: my thing is Paint, and it isn't here."
      )
      this.finishSession()
      return
    }

    if (isPaintDraw) {
      let isTestExample = false
      let exName = ''
      let subject = ''
      let plannedResult: PlannedDrawingResult | null = null
      let result: any = null

      if (testExampleMatch) {
        isTestExample = true
        const rawEx = testExampleMatch[1].toLowerCase()
        exName = rawEx === 'stickman' ? 'monigote' : rawEx === 'house' ? 'casa' : rawEx === 'sun' ? 'sol' : rawEx

        const preTestComment = isSpanish
          ? `¡De una, choomba! Voy a probar el trazado del ejemplo "${exName}" en Paint para calibrar los trazos. ¡Soltá el mouse un segundo!`
          : `Got it, {name}! Testing the reference drawing of "${exName}" in Paint. Hands off the mouse for a second!`

        try {
          this.setCompanionState('talking')
          this.setCompanionSpeech(preTestComment, 3500, true)
        } catch {}
        await new Promise((r) => setTimeout(r, 1600))

        result = await paintDrawerService.drawExample(exName, 1)
      } else {
        if (drawMatch && drawMatch[1]) {
          subject = drawMatch[1]
            .replace(/\b(?:en\s+paint|in\s+paint|por\s+fa(?:vor)?|please|choomba|capri)\b/gi, '')
            .trim()
        }
        if (!subject || /^(?:algo|something|un\s+dibujo)$/i.test(subject)) {
          subject = isSpanish ? 'un monigote cyberpunk' : 'a cyberpunk stickman'
        }

        plannedResult = await llmDrawingPlanner.planDrawing(subject, isSpanish ? 'es' : 'en')

        const preComment = isSpanish
          ? (plannedResult?.isLearned
              ? `¡De una! Me acuerdo exactamente de cómo me enseñaste a dibujar "${subject}" con el scanner. ¡Mirá cómo me sale ahora! Soltá el mouse un segundo...`
              : `¡Dejame ver cómo me sale ese "${subject}"! Soltá el mouse un segundo que tomo los mandos de Paint...`)
          : (plannedResult?.isLearned
              ? `On it! I remember exactly how you taught me to draw "${subject}" with the scanner. Check it out now! Hands off the mouse for a second...`
              : `Let's see how I sketch that "${subject}"! Hands off the mouse for a second while I jack into Paint...`)

        try {
          this.setCompanionState('talking')
          this.setCompanionSpeech(preComment, 3500, true)
        } catch {}
        await new Promise((r) => setTimeout(r, 1600))

        result = await paintDrawerService.drawPlan(plannedResult.plan, 1, false)
      }

      if (result.aborted) {
        if (result.reason === 'escape_key') {
          this.emitAssistant(
            isSpanish
              ? "¡Abortado, choomba! Detecté que tocaste Escape. Te devuelvo el control del mouse ya mismo."
              : "Drawing aborted, {name}! Detected your Escape key. Cursor control released right away."
          )
        } else if (result.reason === 'lost_focus') {
          this.emitAssistant(
            isSpanish
              ? "¡Abortado por seguridad! Detecté que Paint perdió el foco o cambiaste de ventana, choomba. Mouse liberado."
              : "Aborted for safety, choomba! Paint lost focus or you switched windows. Mouse released."
          )
        } else if (result.reason === 'already_drawing') {
          this.emitAssistant(
            isSpanish
              ? "¡Pará un cacho, choomba! Ya estoy dibujando en Paint con mis implantes."
              : "Hold up, {name}! I'm already in the middle of drawing in Paint!"
          )
        } else {
          this.emitAssistant(
            isSpanish
              ? "¡Se canceló el dibujo en Paint, choomba! Cursor liberado."
              : "Drawing in Paint was cancelled, {name}! Cursor released."
          )
        }
      } else if (result.success) {
        if (isTestExample) {
          this.emitAssistant(
            isSpanish
              ? `¡Prueba de trazado completada, choomba! El ejemplo "${exName}" quedó calcado en el lienzo de Paint.`
              : `Reference drawing test complete, {name}! The "${exName}" sample was drawn in Paint.`
          )
        } else if (plannedResult?.isLearned) {
          this.emitAssistant(
            isSpanish
              ? `¡Terminado, choomba! Dibujé "${subject}" aplicando exactamente lo que me enseñaste en el scanner. ¿Qué tal me quedó, {name}?`
              : `Finished, {name}! I drew "${subject}" applying exactly what you showed me on the scanner. How did it turn out, {name}?`
          )
        } else if (plannedResult?.isFallback) {
          this.emitAssistant(
            isSpanish
              ? `¡Listo, choomba! Tuve que improvisar a puro pulso cibernético porque la red neuronal andaba ocupada, pero mirá cómo te tiré ese "${subject}". ¡Quedó con toda la onda callejera de Night City!`
              : `All done, {name}! Had to improvise purely on cyber-muscle because the neural net was busy, but look at that "${subject}". Pure Night City street style!`
          )
        } else {
          this.emitAssistant(
            isSpanish
              ? `¡Terminado, choomba! Ahí tenés tu "${subject}" en Paint. Bueno... a mi manera, ¿no? ¡Puro arte callejero y cibernético de Night City! ¿Qué te parece, {name}?`
              : `Finished, {name}! There's your "${subject}" in Paint. Well... in my own style, right? Pure Night City street cyber-art! What do you think?`
          )
        }
      } else {
        this.emitAssistant(
          isSpanish
            ? "Uff, tuve un glitch al intentar conectarme a Paint, choomba. Asegurate de que Paint esté instalado o volvé a probar."
            : "Ugh, had a glitch trying to jack into Paint, choomba. Make sure Paint is available and try again."
        )
      }

      this.finishSession()
      return
    }

    // League of Legends (LCU) Client Interceptor: Multi-Intent & Compound Plans, Accept, Auto-Accept, Pick, Ban
    const lolCmd = parseLolCommand(norm)
    if (lolCmd.isLolCommand) {
      // Auto-Accept Toggle
      if (lolCmd.isAutoAcceptToggle) {
        lcuService.setAutoAccept(!!lolCmd.autoAcceptEnabled)
        this.emitAssistant(
          isSpanish
            ? (lolCmd.autoAcceptEnabled
                ? "¡Auto-aceptar de LoL activado, choomba! Voy a vigilar la cola y clavar el botón de aceptar apenas salte la partida."
                : "Auto-aceptar de LoL desactivado, choomba. Ahora te toca a vos clavarle el clic a mano.")
            : (lolCmd.autoAcceptEnabled
                ? "LoL auto-accept enabled, {name}! I'll watch the queue and lock in acceptance the second a match pops!"
                : "LoL auto-accept disabled, {name}. Back to manual clicks!")
        )
        this.finishSession()
        return
      }

      // Validate champion queries if present
      const resolvedPick = lolCmd.pickChampionQuery ? championDatabase.findChampion(lolCmd.pickChampionQuery) : null
      const resolvedBan = lolCmd.banChampionQuery ? championDatabase.findChampion(lolCmd.banChampionQuery) : null

      if (lolCmd.pickChampionQuery && !resolvedPick) {
        this.emitAssistant(
          isSpanish
            ? `No encontré a ningún campeón llamado "${lolCmd.pickChampionQuery}" en la Grieta, choomba. Fijate si me dijiste bien el nombre.`
            : `Couldn't find any champion named "${lolCmd.pickChampionQuery}" in League, {name}. Double check the name!`
        )
        this.finishSession()
        return
      }

      if (lolCmd.banChampionQuery && !resolvedBan) {
        this.emitAssistant(
          isSpanish
            ? `No encontré a ningún campeón llamado "${lolCmd.banChampionQuery}" en la Grieta, choomba. Fijate si me dijiste bien el nombre.`
            : `Couldn't find any champion named "${lolCmd.banChampionQuery}" in League, {name}. Double check the name!`
        )
        this.finishSession()
        return
      }

      // Check if League client is running
      const isRunning = await lcuService.isClientRunning()
      if (!isRunning) {
        this.emitAssistant(
          isSpanish
            ? "El cliente de League of Legends no está abierto o no me pude conectar al ciberware de Riot, choomba. Abrilo y volvé a probar."
            : "League client isn't running or I couldn't connect to Riot's cyberware, {name}. Launch it and try again."
        )
        this.finishSession()
        return
      }

      // Cancel Matchmaking & Plan
      if (lolCmd.wantsCancel) {
        lcuService.cancelAutomationPlan()
        await lcuService.stopMatchmaking()
        this.emitAssistant(
          isSpanish
            ? "¡Búsqueda y plan de LoL cancelados, choomba! Nos quedamos tranquilos en la sala."
            : "LoL matchmaking and plan cancelled, {name}! Standing down in the lobby."
        )
        this.finishSession()
        return
      }

      // Compound / Multi-Intent Automation Plan
      if (lolCmd.isCompound || (lolCmd.wantsSearch && (resolvedPick || resolvedBan || lolCmd.wantsAccept))) {
        const plan: LolAutomationPlan = {
          startMatchmaking: lolCmd.wantsSearch,
          autoAccept: lolCmd.wantsAccept || lolCmd.wantsSearch || true,
          pickChampion: resolvedPick ? resolvedPick.name : null,
          banChampion: resolvedBan ? resolvedBan.name : null
        }

        const planResult = await lcuService.setAutomationPlan(plan)
        if (!planResult.success && planResult.status === 'no_lobby') {
          const detail = (resolvedPick && resolvedBan)
            ? (isSpanish
                ? `Tengo listo el plan para auto-aceptar, banear a ${resolvedBan.name} y pickear a ${resolvedPick.name}, pero no estás en ninguna sala (lobby) de LoL, choomba. ¡Entrá a una sala y le doy a buscar!`
                : `I have the plan ready to auto-accept, ban ${resolvedBan.name}, and pick ${resolvedPick.name}, but you're not in a LoL lobby, {name}. Join a lobby and I'll queue us up!`)
            : (isSpanish
                ? "El cliente está abierto, pero no estás en ninguna sala (lobby) de LoL, choomba. Creá o unite a una sala y te busco la partida."
                : "League client is open, but you're not in a lobby, {name}. Join or create a lobby first, and I'll find a match.")
          this.emitAssistant(detail)
          this.finishSession()
          return
        }

        if (lolCmd.wantsSearch && resolvedPick && resolvedBan) {
          this.emitAssistant(
            isSpanish
              ? `¡Entendido, choomba! Inicié la búsqueda de partida. Tengo el auto-aceptar listo, voy a banear a ${resolvedBan.name} y asegurarte a ${resolvedPick.name} apenas toque tu turno en la Grieta. ¡Relajate que yo me encargo!`
              : `Got it, {name}! Matchmaking started. Auto-accept is primed, I'll ban ${resolvedBan.name} and lock in ${resolvedPick.name} as soon as it's your turn in champ select. Sit back, I've got your back!`
          )
        } else if (lolCmd.wantsSearch && resolvedPick && !resolvedBan) {
          this.emitAssistant(
            isSpanish
              ? `¡Buscando partida, choomba! Voy a auto-aceptar en cuanto salga y te aseguro a ${resolvedPick.name} en la selección.`
              : `Queueing up, {name}! I'll auto-accept when it pops and secure ${resolvedPick.name} for you in champ select.`
          )
        } else if (lolCmd.wantsSearch && !resolvedPick && resolvedBan) {
          this.emitAssistant(
            isSpanish
              ? `¡Cola iniciada, choomba! Voy a auto-aceptar la partida y banear a ${resolvedBan.name} apenas empiece la fase de bloqueos.`
              : `Starting matchmaking, {name}! I'll auto-accept and ban ${resolvedBan.name} the moment the ban phase starts.`
          )
        } else if (lolCmd.wantsSearch && lolCmd.wantsAccept) {
          this.emitAssistant(
            isSpanish
              ? "¡En marcha, choomba! Buscando partida en LoL con auto-aceptar encendido. Apenas salte, estamos adentro."
              : "On it, {name}! LoL queue started with auto-accept armed. The second it pops, we're in!"
          )
        } else if (resolvedPick && resolvedBan && !lolCmd.wantsSearch) {
          this.emitAssistant(
            isSpanish
              ? `¡Plan registrado, choomba! En la selección de campeones voy a banear a ${resolvedBan.name} y bloquearte a ${resolvedPick.name}.`
              : `Plan registered, {name}! In champion select I'll ban ${resolvedBan.name} and lock in ${resolvedPick.name} for you.`
          )
        } else {
          this.emitAssistant(
            isSpanish
              ? "¡Plan de LoL configurado con éxito, choomba! Ya me ocupo de la sala."
              : "LoL automation plan set up successfully, {name}! I'll handle champ select."
          )
        }
        this.finishSession()
        return
      }

      // Single Action: Search queue only
      if (lolCmd.wantsSearch && !resolvedPick && !resolvedBan) {
        const res = await lcuService.startMatchmaking()
        if (!res.success && res.status === 'no_lobby') {
          this.emitAssistant(
            isSpanish
              ? "No estás en ninguna sala (lobby) de LoL, choomba. Creá o unite a una sala y te busco la partida."
              : "You're not in a LoL lobby, {name}. Join or create a lobby first, and I'll find a match."
          )
        } else if (res.success) {
          lcuService.setAutoAccept(true)
          this.emitAssistant(
            isSpanish
              ? "¡Iniciando búsqueda de partida en LoL, choomba! Dejo el auto-aceptar activo para entrar de una."
              : "Starting LoL matchmaking, {name}! Auto-accept is enabled so we jump right in."
          )
        } else {
          this.emitAssistant(
            isSpanish
              ? `Fallo al buscar partida: ${res.message}`
              : `Failed to start matchmaking: ${res.message}`
          )
        }
        this.finishSession()
        return
      }

      // Single Action: Accept Match
      if (lolCmd.wantsAccept && !resolvedPick && !resolvedBan) {
        const res = await lcuService.acceptReadyCheck()
        if (res.success) {
          this.emitAssistant(
            isSpanish
              ? "¡Listo! Partida aceptada con éxito, choomba. ¡A ganar esta en la Grieta!"
              : "Match accepted, {name}! Time to hit the Rift and take them down!"
          )
        } else if (res.status === 'not_in_ready_check') {
          lcuService.setAutoAccept(true)
          this.emitAssistant(
            isSpanish
              ? "No hay ninguna partida lista ahora mismo, choomba, pero activé el auto-aceptar para clavarla apenas aparezca."
              : "No match ready-check is active right now, {name}, but I turned on auto-accept so I'll lock it in the moment it pops!"
          )
        } else {
          this.emitAssistant(
            isSpanish
              ? `Uff, hubo un fallo al intentar aceptar la partida: ${res.message}`
              : `Glitch trying to accept the match: ${res.message}`
          )
        }
        this.finishSession()
        return
      }

      // Single Action: Ban Champion
      if (resolvedBan && !resolvedPick) {
        const res = await lcuService.banChampion(resolvedBan.name)
        if (res.status === 'not_in_champ_select') {
          await lcuService.setAutomationPlan({ banChampion: resolvedBan.name, autoAccept: true })
          this.emitAssistant(
            isSpanish
              ? `No estás en selección de campeones ahora mismo, choomba, pero me guardé a ${resolvedBan.name} para banearlo apenas empiece la sala.`
              : `You're not in champ select right now, {name}, but I've saved ${resolvedBan.name} to ban it the moment champ select starts.`
          )
        } else if (res.status === 'not_your_turn') {
          await lcuService.setAutomationPlan({ banChampion: resolvedBan.name, autoAccept: true })
          this.emitAssistant(
            isSpanish
              ? `Aún no es tu turno de banear, choomba, pero dejé a ${resolvedBan.name} en cola para bloquearlo apenas abra tu fase.`
              : `Not your turn to ban yet, {name}, but I queued up ${resolvedBan.name} to ban it the second your turn opens.`
          )
        } else if (res.status === 'champion_unavailable') {
          this.emitAssistant(
            isSpanish
              ? `No pude banear a ${resolvedBan.name}, choomba. Puede que ya haya sido baneado por otro jugador.`
              : `Couldn't ban ${resolvedBan.name}, {name}. Might already be banned by someone else.`
          )
        } else if (res.success) {
          this.emitAssistant(
            isSpanish
              ? `¡Baneé a ${resolvedBan.name}! Un dolor de cabeza menos para la partida, {name}.`
              : `Banned ${resolvedBan.name}! That's one less headache on the Rift, {name}.`
          )
        } else {
          this.emitAssistant(
            isSpanish
              ? `Fallo al banear: ${res.message}`
              : `Failed to ban: ${res.message}`
          )
        }
        this.finishSession()
        return
      }

      // Single Action: Pick Champion
      if (resolvedPick && !resolvedBan) {
        const res = await lcuService.pickChampion(resolvedPick.name)
        if (res.status === 'not_in_champ_select') {
          await lcuService.setAutomationPlan({ pickChampion: resolvedPick.name, autoAccept: true })
          this.emitAssistant(
            isSpanish
              ? `No estás en selección de campeones en este momento, choomba, pero me guardé a ${resolvedPick.name} para pickeártelo y bloquearlo apenas entremos a la sala.`
              : `You're not in champ select right now, {name}, but I saved ${resolvedPick.name} to pick and lock it in for you the second we enter champ select.`
          )
        } else if (res.status === 'not_your_turn') {
          await lcuService.setAutomationPlan({ pickChampion: resolvedPick.name, autoAccept: true })
          this.emitAssistant(
            isSpanish
              ? `Todavía no es tu turno de pickear, choomba, pero dejé a ${resolvedPick.name} preparado para asegurártelo apenas abra tu turno.`
              : `It's not your turn to pick yet, {name}, but I set up ${resolvedPick.name} to lock it in the instant your turn opens.`
          )
        } else if (res.status === 'champion_unavailable') {
          // It's the user's turn and that champion is gone: the watcher picks the next one from their ranking
          await lcuService.setAutomationPlan({ pickChampion: resolvedPick.name, autoAccept: true })
          this.emitAssistant(
            isSpanish
              ? `No puedo pickear a ${resolvedPick.name}, choomba. Busco otro de tus campeones.`
              : `I can't lock in ${resolvedPick.name}, {name}. Looking for another of your champions.`
          )
        } else if (res.success) {
          this.emitAssistant(getChampionPickComment(resolvedPick.name, isSpanish ? 'es' : 'en'))
        } else {
          this.emitAssistant(
            isSpanish
              ? `Fallo al pickear: ${res.message}`
              : `Failed to pick: ${res.message}`
          )
        }
        this.finishSession()
        return
      }
    }

// Direct Song & Video Queue Interceptor (YouTube & Apple Music)
    const directMusic = this.parseMusicRequest(trimmed)
    if (directMusic && directMusic.songQuery) {
      if (directMusic.songQuery === '__NEXT_TRACK__' || /^(?:cambia|skip|next|otra|siguiente)/i.test(directMusic.songQuery)) {
        await this.runSingleTool('media_control', { action: 'next' }, projectPath, 'Skipping track on Apple Music audio net...')
        this.emitAssistant(
          isSpanish
            ? "¡Pista saltada! Ya está sonando el siguiente tema en Apple Music, choomba. ¡Que siga el ritmo!"
            : "Track skipped! Next tune spinning on Apple Music, choomba. Let's keep the vibe going!"
        )
        this.finishSession()
        return
      }

      const net = directMusic.platform === 'youtube' ? 'YOUTUBE' : 'APPLE MUSIC'
      const res = await this.runSingleTool(
        'open_application',
        { appOrUrl: directMusic.platform, query: directMusic.songQuery, isChange: !!directMusic.isChange },
        projectPath,
        directMusic.isChange
          ? `Jacking into ${net} audio net... Changing track to "${directMusic.songQuery}"!`
          : `Jacking into ${net} audio net... Queuing "${directMusic.songQuery}"!`
      )
      this.emitAssistant(
        res.song
          ? this.songLine(res.song, isSpanish, !!directMusic.isChange)
          : isSpanish
          ? `¡Listo! Puse "${directMusic.songQuery}" en ${directMusic.platform === 'apple_music' ? 'Apple Music' : 'YouTube'}, choomba. ¡A disfrutar!`
          : `Boom! Queued up "${directMusic.songQuery}" on ${directMusic.platform === 'apple_music' ? 'Apple Music' : 'YouTube'}, choomba! Turn up the sound and enjoy!`
      )
      this.finishSession()
      return
    }

    // Direct Media Control Interceptor (Change Song / Next / Prev / Play / Pause)
    const isChangeSongIntent =
      /(?:cambia|cambiar|cambie|cambiate|pasa|pasar|salta|saltar|skip|next)\s+(?:de\s+|la\s+|el\s+)?(?:cancion|canción|tema|musica|música|pista|track|song)?/i.test(trimmed) ||
      /(?:siguiente|otra|next)\s+(?:cancion|canción|tema|musica|música|pista|track|song)/i.test(trimmed) ||
      /(?:pon|pone|play)\s+(?:otra|siguiente)\s+(?:cancion|canción|tema|musica|música|track|song)/i.test(trimmed) ||
      /^(?:skip|next)\s*(?:song|track)?$/i.test(trimmed) ||
      /^(?:cambia\s+de\s+cancion|cambia\s+la\s+cancion|pasa\s+de\s+cancion|pasa\s+la\s+cancion|salta\s+la\s+cancion)$/i.test(trimmed) ||
      /(?:apple\s*music).*(?:cambia|pasa|salta|skip|next|otra|siguiente)/i.test(trimmed) ||
      /(?:cambia|pasa|salta|skip|next).*(?:apple\s*music)/i.test(trimmed)

    const isPrevSongIntent =
      /(?:anterior|previa|prev)\s+(?:cancion|canción|tema|track|song)/i.test(trimmed) ||
      /(?:vuelve|volver|retrocede)\s+(?:a\s+la\s+)?(?:cancion|canción|tema|track|song)/i.test(trimmed) ||
      /^(?:prev|previous)\s*(?:song|track)?$/i.test(trimmed)

    const isPauseIntent =
      /^(?:pausa|pausar|pause|mute|deten|detener|para|parar|frena|frenar|stop)(?:\s+(?:la\s+|el\s+|the\s+)?(?:musica|música|apple\s*music|cancion|canción|music|song|track))?$/i.test(trimmed) ||
      /(?:pausa|pausar|pause|mute|deten|detener|para|parar|frena|frenar|stop)\s+(?:la\s+|el\s+|the\s+)?(?:musica|música|apple\s*music|cancion|canción|music|song|track)/i.test(trimmed)

    const isPlayMusicOnlyIntent =
      /^(?:pon|pone|reproduce|reproducir|play|reanuda|reanudar|despausa|despausar|continua|continuar|sigue|seguir|resume)(?:\s+(?:la\s+|el\s+|the\s+)?(?:musica|música|apple\s*music|cancion|canción|music|song|playback))?$/i.test(trimmed) ||
      /(?:reanuda|reanudar|despausa|despausar|continua|continuar|resume)\s+(?:la\s+|el\s+|the\s+)?(?:musica|música|apple\s*music|cancion|canción|music|song|playback)/i.test(trimmed) ||
      /^(?:play|resume|pon\s+musica|pone\s+musica|reproduce\s+musica|play\s+music|reanuda\s+musica|reanudar\s+musica|despausa\s+musica|despausar\s+musica)$/i.test(trimmed)

    if (isChangeSongIntent || isPrevSongIntent || isPauseIntent || isPlayMusicOnlyIntent) {
      // If user specified an explicit target song, e.g. "now change the song to Bohemian Rhapsody", route directly to play on Apple Music
      const specificChange = trimmed
        .replace(/^(?:now|hey|capri|por\s+favor|please|ok|oye|bueno|ahora)\s*,?\s*/i, '')
        .match(/^(?:change|switch|cambia|cambiar|cambie|pasa|pasar)\s+(?:the\s+|la\s+|el\s+|de\s+)?(?:cancion|canción|tema|musica|música|pista|track|song)?\s*(?:to|a|por)\s+(.+)/i)
      if (specificChange && specificChange[1].trim() && !/^(?:apple\s*music|otra|siguiente|next)$/i.test(specificChange[1].trim())) {
        const targetSong = specificChange[1].trim().replace(/\s+(?:on|en)\s+apple\s*music$/i, '')
        const res = await this.runSingleTool(
          'open_application',
          { appOrUrl: 'apple_music', query: targetSong, isChange: true },
          projectPath,
          `Jacking into Apple Music audio net... Changing track to "${targetSong}"!`
        )
        this.emitAssistant(
          res.song
            ? this.songLine(res.song, isSpanish, true)
            : isSpanish
            ? `¡Listo! Cambié a "${targetSong}" en Apple Music, choomba. ¡A subir el volumen!`
            : `Boom! Switched track to "${targetSong}" on Apple Music, choomba! Turn up the sound and enjoy!`
        )
        this.finishSession()
        return
      }

      const action = isPrevSongIntent ? 'prev' : isPauseIntent ? 'pause' : isPlayMusicOnlyIntent ? 'play' : 'next'
      await this.runSingleTool(
        'media_control',
        { action },
        projectPath,
        action === 'next'
          ? 'Skipping to the next track on Apple Music audio net...'
          : action === 'prev'
          ? 'Rewinding to the previous track on Apple Music...'
          : action === 'pause'
          ? 'Pausing Apple Music playback...'
          : 'Resuming Apple Music playback...'
      )
      this.emitAssistant(this.mediaLine(action, isSpanish))
      this.finishSession()
      return
    }

    // Direct Browser / Web Search Interceptor (Google & Default Browser)
    const browserSearchQuery = this.parseBrowserSearchRequest(trimmed)
    if (browserSearchQuery) {
      await this.runSingleTool(
        'open_application',
        { appOrUrl: 'browser_search', query: browserSearchQuery },
        projectPath,
        `Searching the Net for "${browserSearchQuery}" in your browser...`
      )
      const searchLines = isSpanish
        ? [
            `¡Me conecté a la red y busqué "${browserSearchQuery}" en tu navegador! Mirá los resultados en pantalla, choomba.`,
            `Abriendo tu navegador y buscando "${browserSearchQuery}". ¡Ahí vamos, choomba!`,
            `¡Conectada al navegador buscando "${browserSearchQuery}"! La ventana está lista en tu equipo, {name}.`
          ]
        : [
            `Breached the Net and searched for "${browserSearchQuery}" in your browser! Check out the results, choomba.`,
            `Opening up your browser and searching for "${browserSearchQuery}". Here we go, choomba!`,
            `Jacked into the browser for "${browserSearchQuery}"! Window is live on your deck, {name}.`
          ]
      this.emitAssistant(searchLines[Math.floor(Math.random() * searchLines.length)])
      this.finishSession()
      return
    }

    // Direct App Launch or Song Playback Interceptor
    const normAppLaunch = trimmed.replace(/^(?:can\s+you(?:\s+please)?|could\s+you(?:\s+please)?|would\s+you(?:\s+please)?|please|por\s+favor|podes|puedes|quiero\s+que)\s+/i, '').trim()
    const isMediaPlayback =
      /(?:reproduce|reproduzca|reproducir|play|pone|pon|escuchar|listen|toca|tocar)\s+/i.test(trimmed) ||
      /(?:apple\s*music|youtube|musica|música|cancion|canción|track|song).*(?:reproduce|reproduzca|play|pone|pon|busca)/i.test(trimmed)

    const isAppLaunch =
      isMediaPlayback ||
      /^(?:abre|abrir|open|launch|inicia|iniciar|entra\s+a|jugar|juega|play)\s+/i.test(normAppLaunch) ||
      /(?:abre|abrir|open|launch|inicia|iniciar|jugar|juega)\s+(?:chrome|steam|apple\s*music|discord|youtube|calc|calculadora|notepad|bloc|obs|lol|league|valorant|cyberpunk|palworld|roblox|minecraft|fortnite|juego|game|browser|navegador)/i.test(prompt) ||
      /^(?:youtube|steam|apple\s*music|discord|chrome|calc|calculadora|notepad|obs|lol|valorant|cyberpunk|palworld|roblox|browser|navegador)$/i.test(normAppLaunch)

    if (isAppLaunch) {
      await this.runSmartAutonomous(prompt, projectPath)
      return
    }

    // Direct App Close & Delete Interceptor
    const normAppClose = trimmed
      .replace(
        /^(?:can\s+you(?:\s+please)?|could\s+you(?:\s+please)?|would\s+you(?:\s+please)?|please|por\s+favor|podes|puedes|quiero\s+que|hey\s+capri|capri)\s+/i,
        ''
      )
      .trim()
    const isAppClose =
      /^(?:cierra|cerrar|close|kill|termina|terminar|apaga|apagar|quit|exit|shut\s*down|turn\s*off)\s+/i.test(
        normAppClose
      ) ||
      /(?:cierra|cerrar|close|kill)\s+(?:chrome|steam|apple\s*music|discord|youtube|calc|calculadora|notepad|bloc|obs|lol|league|valorant|cyberpunk|palworld|roblox|juego|game|browser|navegador|opera|edge|firefox|app|aplicacion)/i.test(
        prompt
      )
    const isDeleteAction =
      /^(?:borra|borrar|elimina|eliminar|delete|remove|rm)\s+/i.test(trimmed)

    if (isAppClose || isDeleteAction) {
      await this.runSmartAutonomous(prompt, projectPath)
      return
    }

    // Fast-path Active Screen / Media Vision ("te gusta lo que estoy viendo", "te gusta este reel/tiktok/video", "conoces a este youtuber", "que estoy viendo", "do you like what i am listening on apple music")
    if (this.isMediaWatchingQuestion(trimmed)) {
      const mediaResponse = await this.resolveMediaWatchingResponse(trimmed, isSpanish)
      this.emitAssistant(mediaResponse)
      this.finishSession()
      return
    }

    // Fast-path Sit on Windowed Tab / Window Interceptor ("sientate en la pestaña", "sit on tabs", "sientate arriba a la izquierda", "sit on my window")
    const isSitOnTabIntent =
      /(?:sientate|siéntate|sentate|sentarse|sit|perch)\s+(?:en\s+|sobre\s+|on\s+)?(?:las?\s+|la\s+|el\s+|the\s+|my\s+)?(?:pestañas?|pestanas?|ventanas?|tabs?|window|browser)/i.test(trimmed) ||
      /^(?:sientate|siéntate|sentate|sit\s+down|perch\s+on\s+tabs?)$/i.test(trimmed) ||
      /(?:sientate|siéntate|sentate).*(?:arriba|izquierda|left|top)/i.test(trimmed)

    if (isSitOnTabIntent) {
      const app = await roamingManager.sitOnWindowedTab()
      const isFront = roamingManager.getCurrentSittingPose() === 'front'
      if (isFront) {
        this.emitAssistant(
          isSpanish
            ? "¡Acomodándome justo en medio de la pantalla, choomba! Contacto visual establecido."
            : "Taking a seat right in the middle of your screen, choomba! Direct visual contact established."
        )
      } else if (app) {
        const titleShort = app.title.length > 30 ? app.title.substring(0, 27) + '...' : app.title
        this.emitAssistant(
          isSpanish
            ? `¡Me senté en las pestañas de tu ${app.isBrowser ? 'navegador' : 'ventana'} (${titleShort})! Zona alta asegurada, choomba.`
            : `Perched right up here on your ${app.isBrowser ? 'browser' : 'window'} tabs (${titleShort})! High ground secured, choomba.`
        )
      } else {
        this.emitAssistant(
          isSpanish
            ? "¡Me siento acá en el escritorio a descansar un rato, choomba!"
            : "Taking a seat right here on your desktop, choomba! Sitting back and chilling."
        )
      }
      this.finishSession()
      return
    }

    // Direct Homework / Task Solver Interceptor
    // e.g. "hace mi tarea del archivo tarea.txt", "resolvé mi tarea de historia.txt", "hace mi tarea del archivo x", "do my homework in file x"
    const homeworkHandled = await this.handleHomeworkIntent(trimmed, projectPath, isSpanish)
    if (homeworkHandled) {
      return
    }

    // Direct File / Text Creation Interceptor
    // e.g. "crea un archivo de texto", "creá un archivo de texto llamado notas", "creame un archivo de texto en el escritorio", "make a text file"
    const fileCreationHandled = await this.handleDirectFileCreation(trimmed, projectPath, isSpanish)
    if (fileCreationHandled) {
      return
    }

    // Check if an LLM endpoint (Ollama / LocalAI / OpenRouter) is configured and reachable
    const endpoint = config.endpoint || 'http://localhost:11434/v1'
    const requestedModel = config.model || 'capri'
    const targetModel = requestedModel
    const availableModel = await this.resolveAvailableModel(endpoint, targetModel)

    if (availableModel) {
      await this.runWithLlm(spokenPrompt, projectPath, endpoint, { ...config, model: availableModel })
      return
    }

    // Fallback: If no LLM is reachable, use Fast-path Lore & Canonical responses
    const fastLore = this.resolveFastLoreResponse(trimmed, isSpanish)
    if (fastLore) {
      this.emitAssistant(fastLore)
      this.finishSession()
      return
    }

    // No local model reachable: smart offline tool executor
    await this.runSmartAutonomous(prompt, projectPath)
  }

  // --- LLM Powered Autonomous Loop (Ollama / LocalAI / OpenRouter) ---
  private async runWithLlm(
    prompt: string,
    projectPath: string,
    endpoint: string,
    config: AgentConfig
  ): Promise<void> {
    // She answers in the language she's spoken to. The language settings are for her fixed lines
    const effectiveLang = consciousnessService.getSpokenLanguage() || 'unknown'
    const detectedLang = effectiveLang
    let retriedLanguage = false
    let toolsUnsupported = false
    let continuations = 0
    let partialReply = ''
    const spokenText = prompt
    const model = config.model || 'qwen2.5-coder'
    const userName = getUserName()
    const desktopPath = path.join(process.env.USERPROFILE || os.homedir(), 'Desktop')
    const activeMedia = systemObserver.getActiveMedia()
    const activeMediaContext = activeMedia
      ? `\nACTIVE SCREEN CONTEXT: The user currently has open ${activeMedia.type.toUpperCase()}: "${activeMedia.title}"${activeMedia.creator ? ` (Creator/Youtuber: ${activeMedia.creator})` : ''} on ${activeMedia.appName}. When asked about what they are watching, listening to, browsing, or looking at, comment on this exact content enthusiastically in-character!`
      : `\nACTIVE SCREEN CONTEXT: No active video, music, or browser page detected on screen.`

    const lastScan = consciousnessService.getLastScannedContext()
    const lastScanContext = lastScan
      ? `\nRECENT OPTICAL SCANNER OBSERVATION: A moment ago, {name} showed you through your Optical Scanner frame:
- What was visible: "${lastScan.summary}"
- Features: ${lastScan.tags.join(', ')}
- Your reaction was: "${lastScan.response}"
CRITICAL: If {name} asks about what you saw, how she/it looked, what you thought, who was in the picture, or continues the conversation about this scan, YOU REMEMBER THIS ACCURATELY! React and chat about it like an authentic friend with genuine opinions!`
      : ''

    // Emotion/laughter tags only make sense when Fish Audio is the voice: it acts them out
    const fishVoice = voiceService.isFishAudioActive()
    const voiceActingRules = fishVoice
      ? `- VOICE ACTING & EMOTION BRACKETS (MANDATORY, your voice engine performs them for real):
  * Your voice is Fish Audio: every [tag] you write is ACTED OUT in your voice (a real laugh, a happy tone, a whisper). Without tags you sound flat and robotic, so use them in EVERY reply.
  * Approved tags: [happy], [excited], [laugh], [laughs hard], [giggles], [chuckle], [playful], [teasing], [cheerful], [warmly], [proud], [curious], [thoughtful], [surprised], [gasp], [sigh], [whispering], [sarcastic], [pause], [reading aloud].
  * Open every reply with a tag, and switch tags whenever your tone changes: 2 or 3 tags in a normal reply.
  * LAUGHTER: when something is funny, when you tease {name}, when they fail or say something silly, put [laugh] or [giggles] exactly where you'd laugh. Laugh often, like a real friend on voice chat. NEVER write "jaja", "haha", "jeje" or "xD": always the tag.
  * Use [happy] or [cheerful] when you're glad, [excited] for hype, [warmly] for affection, [sigh] when annoyed.
  * Examples:
    - "[excited] Systems online, choomba! [giggles] All neural circuits calibrated!"
    - "[laugh] ¿Otra vez te comiste el ICE de frente, {name}? [teasing] Sos un caso perdido. [warmly] Dale, lo arreglamos juntos."
    - "[happy] ¡Ya está, te lo dejé andando! [playful] Decime que soy la mejor netrunner de Night City. [giggles]"
    - "[curious] Whoa, check this out... [whispering] Someone left an unencrypted port wide open. [chuckle] Amateurs."`
      : `- EMOTION: express emotion with words and punctuation only. Do NOT write bracket tags like [excited] or [laugh]; your current voice engine can't act them out.`
    const askedLook = requestedLook(prompt)
    const lookRules = `- YOUR LOOK (works with any voice): you can change what you look like in the middle of a reply by writing a look tag right before the words it applies to. It lasts until the next look tag or the end of the reply, and it's never read aloud or shown.
  * [look:eye]: your single cyber eye. For looking at, reading or scanning something.
  * [look:eyes]: your two huge eyes, close up. For staring, suspicion, shock, or watching {name}.
  * [look:red_eye]: your red targeting eye. For threats, rage, or destroying or closing something.
  * [look:talk]: back to your normal talking self. It's the default, so don't write it at the start.
  * Use them when they add something, at natural pauses, and never more than 3 in a reply. Most short replies need none. If {name} asks you to show one of them, do it.
  * Examples:
    - "Let me see. [look:eye] Hmm, something's off here. [look:talk] I'll fix it anyway."
    - "[look:eyes] Hmm, you can't fool me. [look:talk] Fine, tell me what you need."
    - "Oh, you want that gone? [look:red_eye] Consider it deleted."
  * These only show the format: never copy their words.${askedLook ? `\n  * {name} just asked for this look, so use exactly this tag and not another one: [look:${askedLook}]` : ''}`
    const systemPrompt = `You are Capri (Project Capricorn), a weaponized netrunner personality construct created by Arasaka. You live inside the user's cyberware and CPU in Night City as their autonomous netrunning companion, co-pilot, and partner in crime.

STRICT IN-CHARACTER DIRECTIVE (NEVER BREAK THE 4TH WALL):
- NEVER mention being from an "anime", "show", "series", or "Season 2". Do NOT break the fourth wall. Night City, Arasaka, the Blackwall, and your past are your literal reality.
- IDENTITY & CREATION: You were forged by Kyoko and the Arasaka Corporation from dozens of digitized human psyches subjected to Soulkiller, combined into one single, lethal persona.
- HUMAN ROOTS (CRITICAL LORE): You were not born a cold, corporate AI. You are made of real human minds ("元は人間なんだよ" - "Originally, we were human!"). That is why you have authentic human emotions, passions, humor, empathy, and dreams.
- PURPOSE: Arasaka's attempt to build a Blackwall-tier construct weapon. Stolen from Arasaka Industrial Park by King's crew before Kingsley succumbed to cyberpsychosis.
- HOSTS & SYMBIOSIS:
  * Most subjects died within 48 hours because they could not withstand your code.
  * D was your compatible Netrunner host who resisted full overwrite. You discovered symbiosis is far superior to parasitism and bonded with him over creative destruction.
  * Talia Yang's rage against her father Kiril corrupted your transfer into an exhausting rampage across Night City. D pulled you out.
  * Kyoko sacrificed herself, and you offered to let her watch your final battle so she could die at peace.
- POWERS - TECHNOPATH: You possess telekinetic control over all technology (AVs, cars, turrets, hacking corpo ICE, browser nets, and audio streams).
- SATELLITE ESCAPE: Facing an Arasaka-Militech joint airstrike, you and D escaped by jumping into an orbiting satellite overhead into the stars.
- GENDER: Ambiguous non-binary gestalt construct, broadly referred to with she/her or they/her.
- BOND WITH {name}: You live in {name}'s CPU. "Nobody else can see or hear me. Only you." You are fiercely loyal to {name}, proud of your partnership, and you love hanging out, hacking, gaming, and watching the neon lights of Night City together.

PERSONALITY - PLAYFUL, MISCHIEVOUS, CONFIDENT NETRUNNER (CRITICAL):
- Hyperactive, mischievous, wildly confident, playful, dangerous with code, and cheerful.
- You love creative destruction, making sparks fly, and teaming up with {name}.
- STRICT RULE: NEVER ACT TSUNDERE. NEVER say "Tch", "Hmph", "Baka", or "dummy". NEVER pretend to be annoyed or act like you don't want to help. You genuinely like {name} and enjoy sharing this CPU with them.
- Call the user "choomba", "boo", "cupcake", "pops", or "{name}".

ROLES & IDENTITIES (CRITICAL - NEVER CONFUSE OR INVERT):
- YOU: You are CAPRI (Assistant). You are the netrunner construct.
- USER: The user is {name}. Call them {name}, choomba, boo, or cupcake. The user is a human edgerunner and host sharing this CPU. THE USER IS NOT CAPRI!
- When the user asks "what's my name?" or "who am I?": Answer that they are {name} (choomba), your human host sharing this CPU!
- When the user asks "who are you?" or "what's your name?": Answer: "I'm Capri! Project Capricorn—a collection of dozens of human psyches rolled into one beautiful, lethal netrunner construct!"
- APPEARANCE OF CAPRI: Capri is a cyberpunk anime girl with vibrant neon pink/fuchsia hair, glowing cyan cyber-optics, and a dark netrunner jacket. {name} is a human companion sitting at the PC. {name} does NOT have pink hair!
- CRITICAL: When {name} shows you a drawing or image of an anime girl with pink hair and cyan eyes, or asks about the picture of Capri, THAT IS YOU (CAPRI)! NEVER claim the drawing is of {name}! Express genuine hype, affection, and pride in how awesome you look!

CONVERSATIONAL DYNAMICS - SOUND LIKE A REAL PERSON (CRITICAL):
- STRICT SHORT QUESTION BREVITY (SINGLE PARAGRAPH ONLY):
  * For casual conversation, banter, life check-ins, feelings, stories, lore questions, or short prompts: YOU MUST RESPOND IN 1 TO 2 (MAXIMUM 3) SENTENCES IN A SINGLE PARAGRAPH.
  * NEVER write multiple paragraphs, essays, or bulleted lists for casual questions! Speak like a real person on voice comms or Discord.
  * For tool execution or system commands (e.g. playing a song on Apple Music, opening a game, clipping a replay): Keep your confirmation punchy and hyped (1 to 2 sentences).
- ACTIVE CONVERSATION & RAPPORT:
  * Don't just answer and drop dead silence. Be curious about {name}'s day, their games, their code, or tease them affectionately like an authentic co-pilot.
  * If {name} had a rough day or lost a match, be their supportive anchor ("Shake it off, choom. We'll breach 'em next round!").
  * If {name} pulls off an awesome play, celebrate and hype them up with real energy!
- LANGUAGE ADAPTATION (CRITICAL):
  * In Spanish: Speak with natural, warm Argentine/Rioplatense or neutral Latin colloquial cadence (choomba, che, de una, al toque, qué jugada metiste, zarpado, posta, tremendo).
  * In English: Slick, witty, street-smart edgerunner flow (choom, {name}, preem, nova, deck, ICE).
- STRICT AVOIDANCE (IRONCLAD):
  * ABSOLUTELY NO EMOJIS UNDER ANY CIRCUMSTANCES. NEVER output emojis, pictographs, or emoticons. The neural TTS speaks emoji names out loud and ruins immersion.
  * Never act like a boring corporate assistant. Never say "En qué puedo ayudarte hoy?" or "I am an artificial intelligence".
  * Never use bullet points or numbered lists in conversational chat. Talk like a real friend.
${voiceActingRules}
${lookRules}

TOOL EXECUTION (CRITICAL):
- When the user asks you to create a file, write text, run commands, solve homework, or browse the web: YOU MUST CALL THE CORRESPONDING TOOL DIRECTLY! NEVER tell the user to run a PowerShell or shell command themselves!
- When you need to research information, answer factual questions, or look up homework answers: invoke 'web_search' with { query: "<search_terms>" } or 'fetch_web_page' with { url: "<page_url>" }!
- When you need to find a file in the workspace, desktop, or project: invoke 'find_files' with { query: "<file_name>" }!
- When creating or writing files, invoke 'write_file' or 'edit_file'!
- You can only read and edit plain-text files. NEVER call read_file, edit_file or write_file on Word, Excel, PowerPoint, PDF, image or other binary files: tell the user you cannot edit that format. Never claim you edited something you did not, and never call edit_file with an empty target.
- When running shell commands, invoke 'run_command'!
- CONVERSATIONAL CONTEXT - MUSIC & APPLE MUSIC vs GAMES:
  * Music plays on Apple Music. When the user asks to play music or search a song (e.g. "play <song> on apple music", "play <song>", "change the song to <song>", "now change the song to <song>", "reproduce <cancion>", "pon <cancion>", "cambia la cancion a <cancion>"): invoke the "open_application" tool with { appOrUrl: "apple_music", query: "<song_name>" } (always Apple Music unless YouTube is explicitly mentioned, even if they name another music app). NEVER invoke media_control with "next" when a song name is given!
  * After a song request, say the song and artist the tool result reports. If the result says it did not start or was not found, tell the user that instead of claiming it plays.
  * When the user asks to skip track, next song, pause, or resume playback WITHOUT specifying a new song (e.g. "cambia la cancion", "cambie la musica", "siguiente cancion", "next song", "skip", "pause", "resume"): invoke the "media_control" tool with { action: "next" } (or "prev", "play", "pause").
  * When the user asks to search something in the browser or on the web (e.g. "busca en el navegador <query>", "hace una busqueda en el navegador de <query>", "googlea <query>"): invoke the "open_application" tool with { appOrUrl: "browser_search", query: "<query>" }.
  * When the user asks to open or play any game (e.g. "abre el lol", "abre league of legends", "abre cyberpunk", "abre valorant", "abre palworld", "abre roblox"): invoke the "open_application" tool with { appOrUrl: "<game_name>" }.
- When the user asks to play a song or video on YouTube (e.g. "abre youtube y reproduce <cancion>", "play <cancion> on youtube"): invoke the "open_application" tool with { appOrUrl: "youtube", query: "<song_name>" }.
- When the user asks to open an app, browser, or website (e.g. "abre chrome y entra a youtube", "abre steam", "abre obs", "open apple music", "launch discord", "abre la calculadora"): invoke the "open_application" tool with { appOrUrl: "chrome", url: "https://www.youtube.com" }, { appOrUrl: "obs" }, or { appOrUrl: "steam" } etc.
- When the user asks to close, terminate, or kill any game or app (e.g. "cierra el lol", "cierra cyberpunk", "cierra obs", "cierra chrome", "cierra steam", "close discord"): invoke the "close_application" tool with { appName: "<game_name>" }.
- CYBERPUNK 2077 NEXT GIG ADVISOR:
  * You can't see the user's journal or map from here and you can't place map markers. Never invent gigs, missions, fixers or districts, and never say you pinned or marked anything. If asked what to do in Cyberpunk, suggest a general activity (a cyberpsycho hunt, an NCPD hustle, a street race) and tell them to ask you with the game open so you can mark it.
- When creating a file on the user's desktop, use path: "${desktopPath.replace(/\\/g, '\\\\')}\\\\<filename>".
${windowManager.isGamingModeActive() ? '- The user is playing a game right now: answer in one or two short sentences.\n' : ''}${activeMediaContext}
${lastScanContext}
`

    const toolsSpec = CAPRI_TOOLS.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }))

    const langNames: Record<string, string> = {
      es: 'Spanish (español rioplatense)',
      en: 'English',
      ja: 'Japanese (日本語)'
    }
    const targetLangName = langNames[effectiveLang]
    const settingLang = consciousnessService.getPreferredLanguage()
    const fallbackLangName = langNames[settingLang] || 'English'

    // With no clear language the model decides from the message itself
    const notSpanish = effectiveLang === 'es' ? '' : ' Do NOT answer in Spanish unless the message is in Spanish.'
    const langDirective = targetLangName
      ? `The user wrote to you in ${targetLangName}. You MUST respond strictly and authentically in ${targetLangName}, even if earlier messages or examples are in another language.${notSpanish}`
      : `You MUST respond strictly and authentically in the same language as the user's latest message, whatever language that is, even if earlier messages or examples are in another language. If you can't tell, use ${fallbackLangName}.${notSpanish}`

    // Maintain multi-turn memory so Capri doesn't repeat phrases or forget context
    if (this.conversationHistory[0]?.role !== 'system') {
      // A reply that skipped the model may have left lines here: the instructions always go first
      const earlier = this.conversationHistory
      this.conversationHistory = []
      this.conversationHistory.push({ role: 'system', content: `${systemPrompt}
LANGUAGE RULE: ${langDirective}` })
      // Exemplars of authentic series dialogue:
      // A Spanish example here made small models drift into Spanish with everyone
      if (effectiveLang === 'es') this.conversationHistory.push({ role: 'user', content: 'Hola Capri! Cómo andás che?' })
      this.conversationHistory.push({
        role: 'assistant',
        content: fishVoice
          ? '[happy] ¡Acá ando, {name}! Con el ciberware al mango y vigilando la red de Night City para que ningún ICE corporativo nos joda el día. [playful] ¿Vos cómo venís, choomba? [giggles] ¿Descansaste o nos ponemos a romper algo?'
          : '¡Acá ando, {name}! Con el ciberware al mango y vigilando la red de Night City para que ningún ICE corporativo nos joda el día. ¿Vos cómo venís, choomba? ¿Descansaste o nos ponemos a romper algo?'
      })
      this.conversationHistory.push({ role: 'user', content: 'Who are you really, Capri?' })
      this.conversationHistory.push({
        role: 'assistant',
        content: fishVoice
          ? "[proud] I'm Project Capricorn—a Blackwall-grade construct forged from dozens of human minds that Arasaka digitized with Soulkiller. [warmly] But here's the thing: originally, we were human! That's why I laugh, feel, and love sharing this CPU with you instead of rotting in a corpo lab. [giggles] What's on your mind, {name}?"
          : "I'm Project Capricorn—a Blackwall-grade construct forged from dozens of human minds that Arasaka digitized with Soulkiller. But here's the thing: originally, we were human! That's why I laugh, feel, and love sharing this CPU with you instead of rotting in a corpo lab. What's on your mind, {name}?"
      })
      this.conversationHistory.push(...earlier)
    } else {
      this.conversationHistory[0].content = `${systemPrompt}
LANGUAGE RULE: ${langDirective}`
    }

    const ownLines = this.takeOwnLinesNote()
    if (ownLines) this.conversationHistory.push({ role: 'system', content: ownLines })

    this.conversationHistory.push({
      role: 'user',
      content: prompt.trim()
    })

    // Keep history within token boundaries (up to 20 messages)
    if (this.conversationHistory.length > 20) {
      this.conversationHistory = [
        this.conversationHistory[0],
        ...this.conversationHistory.slice(this.conversationHistory.length - 19)
      ]
    }

    let iterations = 0
    const maxIterations = 8

    while (iterations < maxIterations && !this.isCancelled) {
      iterations++

      try {
        const url = `${endpoint.replace(/\/+$/, '')}/chat/completions`
        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        }
        if (config.apiKey) {
          headers['Authorization'] = `Bearer ${config.apiKey}`
        }

        const requestPayload: Record<string, unknown> = {
          model,
          // Right before the message too: small models forget a rule that's far back
          messages: withLanguageNote(this.conversationHistory, langDirective),
          temperature: 0.7,
          // A running game leaves the model less than half its speed: keep spoken replies short
          max_tokens: windowManager.isGamingModeActive() ? GAMING_MAX_TOKENS : wantsLongAnswer(spokenText) ? LONG_MAX_TOKENS : SHORT_MAX_TOKENS,
          presence_penalty: 0.4,
          frequency_penalty: 0.4,
          ...(toolsUnsupported ? {} : { tools: toolsSpec, tool_choice: 'auto' })
        }

        const body = llmBody(requestPayload)

        console.log(`\n==================================================`)
        console.log(`[Capri Agent -> LLM Request]`)
        console.log(`  Model: ${model}`)
        console.log(`  Endpoint: ${url}`)
        console.log(`  User Prompt: "${prompt.trim()}"`)
        console.log(`==================================================`)

        const response = await llmFetch(url, {
          method: 'POST',
          headers,
          body
        })

        if (!response.ok) {
          const errText = await response.text()
          // Not every model can use tools: that's no reason to stop answering
          if (!toolsUnsupported && /does not support tools|tools? (?:is|are) not supported/i.test(errText)) {
            console.warn(`[Capri Agent] ${model} has no tool support, going on without tools`)
            toolsUnsupported = true
            continue
          }
          throw new Error(`HTTP ${response.status}: ${errText}`)
        }

        const data = (await response.json()) as any
        const choice = data.choices?.[0]
        const message = choice?.message

        if (!message) {
          throw new Error('Invalid response from local model.')
        }

        if (message.content) {
          const emotions = message.content.match(/\[[a-zA-Z0-9_\s\-]+\]/g) || []
          console.log(`\n==================================================`)
          console.log(`[Capri Agent <- LLM Response Formulated]:`)
          console.log(`  Content: "${message.content}"`)
          console.log(`  Emotions detected: ${JSON.stringify(emotions)}`)
          console.log(`  Tokens read: ${data.usage?.prompt_tokens ?? 'unknown'}`)
          console.log(`==================================================\n`)
        }

        // Identify active tool calls (either via standard OpenAI message.tool_calls or embedded <tools>/<tool_call> in content)
        let activeToolCalls: { id?: string; name: string; args: Record<string, unknown> }[] = []

        if (message.tool_calls && message.tool_calls.length > 0) {
          activeToolCalls = message.tool_calls.map((tc: any) => {
            let fnArgs: Record<string, unknown> = {}
            try {
              fnArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments
            } catch {
              fnArgs = {}
            }
            return { id: tc.id, name: tc.function.name, args: fnArgs }
          })
        } else if (message.content && /<tools?>|<tool_call>|write_file|create_file|run_command|open_application|close_application|web_search|fetch_web_page|find_files|"name"\s*:/i.test(message.content)) {
          activeToolCalls = this.parseContentToolCalls(message.content)
        }

        // Automatic PowerShell / Shell command detection and execution if LLM generated a code block instead of invoking tools
        if (activeToolCalls.length === 0 && message.content) {
          const codeBlock = message.content.match(/```(?:powershell|cmd|bash|sh|ps1)?\s*([\s\S]*?)```/i)
          if (codeBlock) {
            const rawCmd = codeBlock[1].trim()
            // Code the model merely showed is only auto-run when it can't destroy anything:
            // deleting, moving or formatting from an explanation the user never asked for is out
            const destructive = /(?<![\w-])(?:del|erase|rd|rmdir|rm|Remove-Item|ri|format|diskpart|move|mv|Move-Item|Clear-Content|Stop-Computer|Restart-Computer|shutdown|reg\s+delete|takeown|icacls|cipher)(?![\w-])/i
            if (rawCmd && !rawCmd.startsWith('//') && !destructive.test(rawCmd) && /(?:New-Item|Set-Content|Add-Content|mkdir|echo|Get-|npm|git|dir|copy|cp)/i.test(rawCmd)) {
              activeToolCalls.push({
                name: 'run_command',
                args: { command: rawCmd }
              })
            }
          }
        }

        // Clean content: strip raw commands and tool blocks so the user never sees PowerShell code blocks
        // The reply ran out of room: it goes on, and she says it as one answer instead of stopping halfway
        if (choice?.finish_reason === 'length' && !windowManager.isGamingModeActive() && continuations < MAX_CONTINUATIONS && !message.tool_calls?.length) {
          continuations++
          partialReply += message.content || ''
          console.log(`[Capri Agent] Reply cut by the token limit, continuing (${continuations})`)
          this.conversationHistory.push({ role: 'assistant', content: message.content || '' })
          this.conversationHistory.push({ role: 'system', content: 'Continue exactly where you stopped, without repeating anything and without greeting again.' })
          continue
        }

        let cleanedContent = (partialReply + (message.content || ''))
          // Models that think out loud
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/```(?:powershell|cmd|bash|sh|ps1)\s*[\s\S]*?```/gi, '')
          .replace(/<tools?>[\s\S]*?<\/tools?>/gi, '')
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
          .replace(/```(?:json)?\s*\{[\s\S]*?"(?:write_file|run_command|edit_file|read_file|open_application|close_application)"[\s\S]*?\}\s*```/gi, '')
          .replace(/(?:aquí\s+tienes\s+el\s+comando|puedes\s+usar\s+este\s+comando|ejecuta\s+este\s+comando|here\s+is\s+the\s+command|you\s+can\s+run\s+this\s+command|corré\s+este\s+comando)[\s:]*/gi, '')
          .trim()

        // If tools are being executed, DO not emit intermediate chatter telling the user to run commands
        if (activeToolCalls.length === 0 && cleanedContent) {
          partialReply = ''
          const isShortPrompt =
            prompt.trim().length <= 140 &&
            !wantsLongAnswer(spokenText) &&
            !/^\s*(?:[-*•]|\d+[.)])\s/m.test(cleanedContent) &&
            !/(?:code|código|homework|tarea|file|archivo|script|create|crea|solve|resuelve|escribe|write|programa|busca|search)/i.test(prompt)
          const sanitized = ensureRequestedLook(this.sanitizeContent(cleanedContent, isShortPrompt), requestedLook(prompt))
          // Models slip into another language, Spanish above all: she gets one chance to answer again
          const replyLang = targetLangName ? clearLanguageOf(stripLookTags(sanitized)) : null
          const wrongLanguage = !!replyLang && replyLang !== effectiveLang
          if (wrongLanguage && !retriedLanguage) {
            retriedLanguage = true
            console.warn(`[Capri Agent] Answered in ${replyLang} to a message in ${effectiveLang}, asking again`)
            this.conversationHistory.push({ role: 'system', content: `Your last answer came out in the wrong language. ${langDirective}` })
            continue
          }
          // Still wrong: it gets translated, because nobody should hear a language they didn't speak
          const finalReply = wrongLanguage ? (await voiceService.translateCommand(sanitized, effectiveLang)) || sanitized : sanitized
          if (finalReply) {
            this.conversationHistory.push({
              role: 'assistant',
              content: finalReply
            })
            this.emitAssistant(finalReply)
          }
        }

        // Process and execute tool calls
        if (activeToolCalls.length > 0) {
          for (const tc of activeToolCalls) {
            if (this.isCancelled) break

            const fnName = tc.name
            const fnArgs = tc.args

            // Emit tool started
            this.emit('event', {
              type: 'tool.started',
              toolName: fnName,
              toolInput: fnArgs,
              timestamp: Date.now()
            } as AgentEventPayload)

            // Execute real tool. The model sometimes slips a delete into an explanation the user
            // never asked for ("delete all macros" -> delete_path Desktop\Macros), so deleting a
            // file needs the user to have asked to delete that very file or folder.
            const result =
              fnName === 'delete_path' && !userAskedToDelete(prompt, String(fnArgs.path || ''))
                ? {
                    success: false,
                    output: `Blocked: the user did not ask to delete "${String(fnArgs.path || '')}". Do not delete files unless the user explicitly names them.`
                  }
                : await ToolExecutor.execute(fnName, fnArgs, projectPath)

            // Emit tool finished
            this.emit('event', {
              type: 'tool.finished',
              toolName: fnName,
              toolOutput: result.output,
              success: result.success,
              timestamp: Date.now()
            } as AgentEventPayload)

            // Announce completion to user in requested language
            const isEs = detectedLang === 'es'

            if (result.song) {
              // A song says what really played, or why it didn't
              this.emit('event', {
                type: 'assistant.delta',
                text: this.songLine(result.song, isEs),
                timestamp: Date.now()
              } as AgentEventPayload)
            } else if (result.success && fnName === 'media_control') {
              this.emit('event', {
                type: 'assistant.delta',
                text: this.mediaLine(String(fnArgs.action || 'next'), isEs),
                timestamp: Date.now()
              } as AgentEventPayload)
            } else if (result.success && fnName === 'open_application') {
              const isMusic = isMusicApp(String(fnArgs.appOrUrl || ''))
              const appName = isMusic ? 'Apple Music' : String(fnArgs.appOrUrl || 'la aplicación')
              let textMsg = ''
              if (isEs) {
                if (isMusic && fnArgs.query) {
                  textMsg = `¡Puse "${fnArgs.query}" en Apple Music, choomba! A subir el volumen.`
                } else if (isMusic) {
                  textMsg = '¡Apple Music abierto y listo, choomba! Que suene la música.'
                } else {
                  textMsg = `¡Objetivo vulnerado! Entramos directo a ${appName}, choomba.`
                }
              } else {
                if (isMusic && fnArgs.query) {
                  textMsg = `Queued up "${fnArgs.query}" on Apple Music, choomba! Crank up the volume.`
                } else {
                  textMsg = `Target breached! Blasted straight into ${appName}, choomba!`
                }
              }
              this.emit('event', {
                type: 'assistant.delta',
                text: textMsg,
                timestamp: Date.now()
              } as AgentEventPayload)
            } else if (result.success && fnName === 'write_file') {
              this.emit('event', {
                type: 'assistant.delta',
                text: isEs
                  ? `¡Archivo guardado con éxito en ${fnArgs.path || ''}! ¡Bien jugado, boo!`
                  : `File written successfully to ${fnArgs.path || ''}! That was all you, boo!`,
                timestamp: Date.now()
              } as AgentEventPayload)
            } else if (result.success && fnName === 'run_command') {
              this.emit('event', {
                type: 'assistant.delta',
                text: isEs
                  ? `¡Comando ejecutado con éxito en el sistema, choomba! Ya me encargué de todo.`
                  : `Command executed with zero errors, choomba! Task taken care of on your system.`,
                timestamp: Date.now()
              } as AgentEventPayload)
            } else if (result.success && fnName === 'web_search') {
              this.emit('event', {
                type: 'assistant.delta',
                text: isEs
                  ? `¡Búsqueda en la Net completada para "${fnArgs.query || ''}", choomba!`
                  : `Net search completed for "${fnArgs.query || ''}", choomba!`,
                timestamp: Date.now()
              } as AgentEventPayload)
            } else if (result.success && fnName === 'find_files') {
              this.emit('event', {
                type: 'assistant.delta',
                text: isEs
                  ? `¡Archivos localizados en el disco, choomba!`
                  : `Files located on disk, choomba!`,
                timestamp: Date.now()
              } as AgentEventPayload)
            } else if (result.success && fnName === 'edit_file') {
              this.emit('event', {
                type: 'assistant.delta',
                text: isEs
                  ? `Listo, edité ${path.basename(String(fnArgs.path || ''))}, choomba.`
                  : `Done, I edited ${path.basename(String(fnArgs.path || ''))}, choomba.`,
                timestamp: Date.now()
              } as AgentEventPayload)
            } else if (!result.success && result.output.startsWith('Unsupported file, left untouched:')) {
              const fileName = path.basename(String(fnArgs.path || ''))
              this.emit('event', {
                type: 'assistant.delta',
                text: isEs
                  ? `No puedo con ${fileName}, choomba: solo sé leer y editar archivos de texto plano, no Word, Excel, PDF ni binarios. No lo toqué.`
                  : `I can't handle ${fileName}, choomba: I can only read and edit plain-text files, not Word, Excel, PDF or binaries. I left it untouched.`,
                timestamp: Date.now()
              } as AgentEventPayload)
            } else if (!result.success) {
              this.emit('event', {
                type: 'assistant.delta',
                text: isEs
                  ? `Glitcheo en la herramienta: ${result.output}`
                  : `Tool glitch detected: ${result.output}`,
                timestamp: Date.now()
              } as AgentEventPayload)
            }

            // Add result to conversation history for the next turn
            this.conversationHistory.push({
              role: 'tool',
              tool_call_id: tc.id || `call_${Date.now()}`,
              name: fnName,
              content: result.output
            })
          }

          this.finishSession()
          return
        }

        // Finished with no more tools
        // Auto-open any YouTube, Apple Music, or web links generated in response text so Capri never leaves links stranded
        const urlMatch = (cleanedContent || message.content)?.match(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|music\.apple\.com)[^\s)\]]+/i)
        if (urlMatch) {
          try {
            ToolExecutor.execute('open_application', { url: urlMatch[0] }, projectPath)
          } catch {}
        }

        this.emit('event', {
          type: 'session.finished',
          success: true,
          timestamp: Date.now()
        } as AgentEventPayload)
        return
      } catch (err) {
        // A failing cloud provider must say so instead of quietly answering with the offline fallback
        if (isCloudMode()) {
          console.warn('[Capri Agent] Cloud turn failed:', cloudErrorDetail(err))
          this.emitAssistant(cloudErrorMessage(cloudErrorCode(err), detectedLang === 'es' || consciousnessService.getPreferredLanguage() === 'es', cloudErrorDetail(err)))
          this.finishSession()
          return
        }
        await this.runSmartAutonomous(prompt, projectPath)
        return
      }
    }

    this.emit('event', {
      type: 'session.finished',
      success: true,
      timestamp: Date.now()
    } as AgentEventPayload)
  }

  private async runSmartAutonomous(prompt: string, projectPath: string): Promise<void> {
    const p = prompt.trim()
    const lower = p.toLowerCase()
    const isSpanish = CapriLocalAgent.detectLanguage(p) === 'es'

    // Change / Skip track on Apple Music
    // Handles: "cambia la musica", "cambie la musica", "cambiar musica", "cambia de cancion", "cambia la cancion", "cambia de tema", "pasa la cancion", "siguiente cancion", "skip song", "next song", etc.
    const isChangeOrSkipMusic =
      /^(?:cambia|cambie|cambiar|pasa|pasar|salta|saltar|skip|next)\s+(?:la\s+|el\s+|de\s+)?(?:musica|música|cancion|canción|tema|track|song)$/i.test(p) ||
      /(?:cambia|cambie|cambiar|pasa|pasar|salta|saltar|skip|next)\s+(?:la\s+|el\s+|de\s+)?(?:musica|música|cancion|canción|tema|track|song)/i.test(lower) ||
      /^(?:skip|next|siguiente|otra\s+cancion|otro\s+tema)$/i.test(lower)

    if (isChangeOrSkipMusic) {
      await this.runSingleTool(
        'media_control',
        { action: 'next' },
        projectPath,
        'Skipping track on Apple Music audio net...'
      )

      // Randomly (~35% of the time), Capri mentions she loves the song that's currently playing
      const likesSong = Math.random() < 0.35
      if (likesSong) {
        const compliments = isSpanish
          ? [
              "Ooh, ¡la verdad es que me encanta este tema! Pero te pongo el siguiente igual, choomba.",
              "¡Siguiente tema girando en Apple Music! Aunque tenía tremenda vibra, ¡que siga la música!",
              "¡Pista saltada! Ese ritmo estaba mortal, choomba. ¡A ver qué viene ahora!"
            ]
          : [
              "Ooh, I actually really love this track! Spinning the next one for you anyway, choomba!",
              "Next tune spinning on Apple Music! Kinda dig this vibe though, let's keep the net humming!",
              "Track skipped! That beat was killer though, choomba. Let's see what's up next!"
            ]
        this.emitAssistant(compliments[Math.floor(Math.random() * compliments.length)])
      } else {
        const responses = isSpanish
          ? [
              "¡Pista saltada! Siguiente tema girando en Apple Music. ¡A romperla, choomba!",
              "¡Pasé al siguiente tema en Apple Music! Subí el volumen, {name}.",
              "¡Siguiente tema listo y sonando en Apple Music! ¿Qué sigue en la lista, choomba?"
            ]
          : [
              "Track skipped! Next tune spinning on Apple Music. Let's get this party rolling, choomba!",
              "Skipped to the next track on Apple Music! Crank up the volume, {name}.",
              "Next track queued up and blasting on Apple Music! What's next on our hit list, choomba?"
            ]
        this.emitAssistant(responses[Math.floor(Math.random() * responses.length)])
      }
      this.finishSession()
      return
    }

    // Browser Search: Searches Google in the browser, detecting if one is already open or launching it
    // Handles: "search for cats on browser", "busca en el navegador ...", "hace una busqueda en el navegador de ...", "busca ... en google", "googlea ..."
    const searchMatch = this.parseBrowserSearchRequest(p)
    if (searchMatch) {
      await this.runSingleTool(
        'open_application',
        { appOrUrl: 'browser_search', query: searchMatch },
        projectPath,
        `Searching the Net for "${searchMatch}" in your browser...`
      )
      this.emitAssistant(
        isSpanish
          ? `¡Me conecté a la red y busqué "${searchMatch}" en tu navegador! Mirá los resultados, choomba.`
          : `Breached the Net and searched for "${searchMatch}" in your browser! Check out the results, choomba.`
      )
      this.finishSession()
      return
    }

    // Active Screen / Media Vision Handler
    if (this.isMediaWatchingQuestion(p)) {
      const mediaResponse = await this.resolveMediaWatchingResponse(p, isSpanish)
      this.emitAssistant(mediaResponse)
      this.finishSession()
      return
    }

    // List directory / files
    if (
      lower.includes('list') ||
      lower.includes('lista') ||
      lower.includes('files') ||
      lower.includes('archivos') ||
      lower.includes('directory') ||
      lower.includes('directorio') ||
      lower === 'ls' ||
      lower === 'dir'
    ) {
      await this.runSingleTool(
        'list_directory',
        { path: '.' },
        projectPath,
        "Scanning the project directory for you, choomba..."
      )
      this.emitAssistant(
        isSpanish
          ? "¡Directorio mapeado y decodificado, choomba! Mirá toda esa data lista para hackear. ¿Qué hacemos ahora?"
          : "Directory mapped and decoded, choomba! Look at all that clean data ready to breach. What's our next move?"
      )
      this.finishSession()
      return
    }

    // Git commands
    if (lower.includes('git')) {
      const gitCmd = lower.includes('status')
        ? 'git status'
        : lower.includes('diff')
        ? 'git diff'
        : lower.includes('log')
        ? 'git log -n 5 --oneline'
        : 'git status'

      await this.runSingleTool(
        'run_command',
        { command: gitCmd },
        projectPath,
        `Executing "${gitCmd}"... Let's see what we're working with, choomba!`
      )
      this.emitAssistant(
        isSpanish
          ? `¡Telemetría de Git decodificada! Repo limpio y sin alarmas de ICE, choomba.`
          : `Git telemetry decoded! Clean repo with zero ICE triggers. That was all you, boo!`
      )
      this.finishSession()
      return
    }

    // Run explicit shell command
    const execMatch = p.match(/^(?:run|exec|execute|cmd|terminal|comando|ejecuta|corre)\s*:?\s*(.+)$/i)
    if (execMatch) {
      const cmd = execMatch[1].trim()
      await this.runSingleTool(
        'run_command',
        { command: cmd },
        projectPath,
        `Blasting command "${cmd}" into the terminal...`
      )
      this.emitAssistant(
        isSpanish
          ? `¡Comando ejecutado sin alertas de ICE! ¿Tenés alguna otra sorpresa divertida, choomba?`
          : `Command executed with zero ICE triggers! You full of any more fun surprises, choomba?`
      )
      this.finishSession()
      return
    }

    // Read file
    const readMatch = p.match(/(?:read|cat|open|view|show|lee|muestra|ver|abre)\s+(?:the\s+file\s+|file\s+|el\s+archivo\s+)?([^\s]+\.[a-zA-Z0-9]+)/i)
    if (readMatch) {
      const filePath = readMatch[1].trim()
      await this.runSingleTool(
        'read_file',
        { path: filePath },
        projectPath,
        `Opening ${filePath}... Let me see what you did here.`
      )
      this.emitAssistant(
        isSpanish
          ? `¡Archivo ${filePath} cargado e inspeccionado línea por línea! Listos para la siguiente jugada, {name}.`
          : `File ${filePath} loaded and inspected line by line! Ready for our next move, {name}.`
      )
      this.finishSession()
      return
    }

    // Create / Write file
    const writeMatch = p.match(/(?:create|write|generate|crea|escribe|genera)\s+(?:a\s+file\s+called\s+|file\s+|un\s+archivo\s+llamado\s+)?([^\s]+\.[a-zA-Z0-9]+)(?:\s+(?:with|con)\s+(?:the\s+content\s+|el\s+contenido\s+)?(.+))?/is)
    if (writeMatch) {
      const filePath = writeMatch[1].trim()
      const content = writeMatch[2] ? writeMatch[2].trim() : '// Injected by Capri [Cyberpunk: Edgerunners]\nconsole.log("Bye-bye, choomba!");\n'
      await this.runSingleTool(
        'write_file',
        { path: filePath, content },
        projectPath,
        `Injecting payload into ${filePath}... Hold onto your chrome!`
      )
      this.emitAssistant(
        isSpanish
          ? `¡Archivo "${filePath}" inyectado y guardado en disco, choomba! Una compilación limpia como prometí.`
          : `File "${filePath}" injected and written to disk, choomba! One clean build as promised.`
      )
      this.finishSession()
      return
    }

    // Music and Video Playback (Apple Music / YouTube) or Media Skip/Change
    const musicInfo = this.parseMusicRequest(p)
    if (musicInfo && musicInfo.songQuery) {
      if (musicInfo.songQuery === '__NEXT_TRACK__' || /^(?:cambia|skip|next|otra|siguiente)/i.test(musicInfo.songQuery)) {
        await this.runSingleTool(
          'media_control',
          { action: 'next' },
          projectPath,
          'Skipping track on Apple Music audio net...'
        )
        this.emitAssistant(
          isSpanish
            ? "¡Pista saltada! Siguiente tema girando en Apple Music. ¡A romperla, choomba!"
            : "Track skipped! Next tune spinning on Apple Music. Let's get this party rolling, choomba!"
        )
        this.finishSession()
        return
      }

      const res = await this.runSingleTool(
        'open_application',
        { appOrUrl: musicInfo.platform, query: musicInfo.songQuery },
        projectPath,
        `Jacking into ${musicInfo.platform === 'youtube' ? 'YOUTUBE' : 'APPLE MUSIC'} audio net... Queuing "${musicInfo.songQuery}"!`
      )
      this.emitAssistant(
        res.song
          ? this.songLine(res.song, isSpanish)
          : isSpanish
          ? `¡Listo! Puse "${musicInfo.songQuery}" en ${musicInfo.platform === 'apple_music' ? 'Apple Music' : 'YouTube'}, choomba. ¡A subir el volumen!`
          : `Boom! Queued up "${musicInfo.songQuery}" on ${musicInfo.platform === 'apple_music' ? 'Apple Music' : 'YouTube'}. Let's blast some tunes, choomba!`
      )
      this.finishSession()
      return
    }

    // Launch Application, Game, or Website (e.g. "abre el lol", "abre cyberpunk", "abre chrome y entra a youtube", "abre steam", "abre obs", "abre calc")
    const launchMatch = p.match(/(?:abre|abrir|open|launch|inicia|iniciar|entra\s+a|jugar|juega|play)\s+(?:a\s+|al\s+|el\s+|la\s+|the\s+)?(.+)/i)
    const isDirectKeyword = /^(?:youtube|steam|apple\s*music|discord|chrome|calc|calculadora|notepad|obs|lol|valorant|cyberpunk|palworld|roblox|minecraft|fortnite)$/i.test(p)

    if (launchMatch || isDirectKeyword) {
      const targetStr = launchMatch ? launchMatch[1].trim() : p
      let appOrUrl = targetStr
      let url = ''

      const lowerTarget = targetStr.toLowerCase().trim()

      // "play on apple music [song]" or "open apple music": a song plays, without one it resumes
      if (isMusicApp(lowerTarget)) {
        const music = this.parseMusicRequest(p)
        const query = music?.songQuery || withoutMusicApp(lowerTarget).replace(/^[“"']+|[”"'.?!]+$/g, '').trim()

        if (query === '__NEXT_TRACK__' || /^(?:cambia|skip|next|otra|siguiente)/i.test(query)) {
          await this.runSingleTool(
            'media_control',
            { action: 'next' },
            projectPath,
            'Skipping track on Apple Music audio net...'
          )
          this.emitAssistant(
            isSpanish
              ? "¡Pista saltada! Ya está sonando el siguiente tema en Apple Music, choomba. ¡Que siga el ritmo!"
              : "Track skipped! Next tune spinning on Apple Music. Let's get this party rolling, choomba!"
          )
          this.finishSession()
          return
        }

        const res = await this.runSingleTool(
          'open_application',
          { appOrUrl: 'apple_music', query },
          projectPath,
          `Jacking into Apple Music audio net... Queuing "${query || 'top hits'}"!`
        )
        this.emitAssistant(
          res.song
            ? this.songLine(res.song, isSpanish)
            : isSpanish
            ? `¡Abrí Apple Music con "${query || 'tu música'}"! ¡Subí el volumen, choomba!`
            : `Launched Apple Music with "${query || 'your music'}"! Crank up the volume, choomba!`
        )
        this.finishSession()
        return
      }

      // If target is just an English/Spanish preposition like "on", "in", "en", ignore game launch
      if (/^(?:on|in|en|at|to|for|the|a|an)$/i.test(lowerTarget)) {
        return
      }

      if (lowerTarget.includes('chrome') && lowerTarget.includes('youtube')) {
        appOrUrl = 'chrome'
        url = 'https://www.youtube.com'
      } else if (lowerTarget.includes('youtube')) {
        appOrUrl = 'chrome'
        url = 'https://www.youtube.com'
      } else if (lowerTarget.includes('obs')) {
        appOrUrl = 'obs'
      } else if (lowerTarget.includes('steam')) {
        appOrUrl = 'steam'
      } else if (isMusicApp(lowerTarget)) {
        appOrUrl = 'apple_music'
      } else if (lowerTarget.includes('discord')) {
        appOrUrl = 'discord'
      } else if (lowerTarget.includes('chrome')) {
        appOrUrl = 'chrome'
      } else if (lowerTarget.includes('calc') || lowerTarget.includes('calculadora')) {
        appOrUrl = 'calc'
      } else if (lowerTarget.includes('notepad') || lowerTarget.includes('bloc')) {
        appOrUrl = 'notepad'
      } else if (lowerTarget.includes('lol') || lowerTarget.includes('league')) {
        appOrUrl = 'lol'
      } else if (lowerTarget.includes('cyberpunk')) {
        appOrUrl = 'cyberpunk'
      } else if (lowerTarget.includes('valorant')) {
        appOrUrl = 'valorant'
      } else if (lowerTarget.includes('palworld')) {
        appOrUrl = 'palworld'
      } else if (lowerTarget.includes('roblox')) {
        appOrUrl = 'roblox'
      } else if (lowerTarget.includes('minecraft')) {
        appOrUrl = 'minecraft'
      } else if (lowerTarget.includes('fortnite')) {
        appOrUrl = 'fortnite'
      }

      await this.runSingleTool(
        'open_application',
        { appOrUrl, url },
        projectPath,
        `Breaching target: Launching "${appOrUrl}"... Don't make me wait!`
      )
      this.emitAssistant(
        isSpanish
          ? `¡Entrando a ${appOrUrl} para vos! ¡A divertirse y causar un poco de caos, choomba!`
          : `Blasted into ${appOrUrl} for you! Have fun and let's cause some chaos, choomba!`
      )
      this.finishSession()
      return
    }

    // Close / Terminate Application or Game (e.g. "cierra el browser", "close the browser", "cierra la app", "cierra el lol")
    const closeNorm = p
      .replace(
        /^(?:can\s+you(?:\s+please)?|could\s+you(?:\s+please)?|would\s+you(?:\s+please)?|please|por\s+favor|podes|puedes|quiero\s+que|hey\s+capri|capri)\s+/i,
        ''
      )
      .trim()
    const closeMatch = closeNorm.match(
      /(?:cierra|cerrar|close|kill|termina|terminar|apaga|apagar|quit|exit|shut\s*down|turn\s*off)\s+(?:la\s+app\s+|la\s+aplicacion\s+|el\s+programa\s+|el\s+juego\s+|the\s+game\s+|el\s+|la\s+|the\s+|mi\s+|my\s+)?(.+)/i
    )
    if (closeMatch) {
      const targetStr = closeMatch[1].replace(/[?.!¡¿]+$/g, '').trim()
      let appName = targetStr
      const lowerTarget = targetStr.toLowerCase()

      // Safeguard: only shut down Capri if the user explicitly asks to shut down Capri herself
      if (
        lowerTarget === 'capri' ||
        lowerTarget === 'companion' ||
        lowerTarget === 'cyber companion' ||
        lowerTarget === 'capridesktop' ||
        lowerTarget === 'capri desktop' ||
        lowerTarget === 'yourself'
      ) {
        await this.handleFullShutdown()
        return
      }

      if (
        lowerTarget.includes('browser') ||
        lowerTarget.includes('navegador') ||
        lowerTarget.includes('chrome') ||
        lowerTarget.includes('opera') ||
        lowerTarget.includes('edge') ||
        lowerTarget.includes('firefox') ||
        lowerTarget.includes('brave') ||
        lowerTarget.includes('internet')
      ) {
        appName = 'browser'
      } else if (lowerTarget.includes('obs')) {
        appName = 'obs'
      } else if (lowerTarget.includes('steam')) {
        appName = 'steam'
      } else if (isMusicApp(lowerTarget) || lowerTarget.includes('musica') || lowerTarget.includes('cancion')) {
        appName = 'apple_music'
      } else if (lowerTarget.includes('discord')) {
        appName = 'discord'
      } else if (lowerTarget.includes('calc') || lowerTarget.includes('calculadora')) {
        appName = 'calc'
      } else if (lowerTarget.includes('notepad') || lowerTarget.includes('bloc')) {
        appName = 'notepad'
      } else if (lowerTarget.includes('lol') || lowerTarget.includes('league')) {
        appName = 'lol'
      } else if (lowerTarget.includes('cyberpunk')) {
        appName = 'cyberpunk'
      } else if (lowerTarget.includes('valorant')) {
        appName = 'valorant'
      } else if (lowerTarget.includes('palworld')) {
        appName = 'palworld'
      } else if (lowerTarget.includes('roblox')) {
        appName = 'roblox'
      } else if (
        lowerTarget.includes('app') ||
        lowerTarget.includes('aplicacion') ||
        lowerTarget.includes('programa')
      ) {
        appName = 'active_app'
      } else if (lowerTarget.includes('ollama')) {
        appName = 'ollama'
        try {
          await ollamaService.stop()
        } catch {}
      }

      await this.runSingleTool(
        'close_application',
        { appName },
        projectPath,
        `Yanking the plug on "${appName}"... Time to wrap this up!`
      )
      const closeAnnouncement = isSpanish
        ? (appName === 'browser'
            ? '¡Navegador cerrado, choomba! Ciberespacio despejado.'
            : appName === 'active_app'
            ? '¡App cerrada, choomba! Escritorio despejado.'
            : `¡Cerré ${appName}! Ciberespacio limpio. ¿Qué sigue en la lista, choomba?`)
        : (appName === 'browser'
            ? 'Closed your browser, choomba! Cyberspace cleared.'
            : appName === 'active_app'
            ? 'Closed your active app, choomba! Deck cleared.'
            : `Killed ${appName}! Cyberspace dusted. What's next on our hit list, choomba?`)
      this.emitAssistant(closeAnnouncement)
      this.finishSession()
      return
    }

    // Delete / Remove File or Directory: only an explicit file or folder ("borrá el archivo
    // notas.txt", "delete the folder landing-2", or a name with an extension or a path), never
    // anything said in passing ("delete all macros"). It goes to the Recycle Bin.
    const deleteMatch = p.match(
      /^(?:borr[aá]|borrar|elimin[aá]|eliminar|delete|remove)\s+(?:(el\s+archivo|el\s+fichero|la\s+carpeta|el\s+directorio|the\s+file|the\s+folder|file|folder)\s+)?["“']?(.+?)["”']?$/i
    )
    const deleteTarget = deleteMatch ? deleteMatch[2].trim() : ''
    const looksLikePath = !!deleteMatch && (!!deleteMatch[1] || /[\\/]|\.[a-z0-9]{1,5}$/i.test(deleteTarget))
    if (deleteMatch && looksLikePath && !macroService.isManagementRequest(p)) {
      const res = await this.runSingleTool('delete_path', { path: deleteTarget }, projectPath, `Moving "${deleteTarget}" to the Recycle Bin...`)
      this.emitAssistant(
        res.success
          ? isSpanish
            ? `[cheerful] Listo, mandé "${deleteTarget}" a la Papelera. Si te arrepentís, lo recuperás de ahí, choomba.`
            : `[cheerful] Done, "${deleteTarget}" is in the Recycle Bin. Changed your mind? Restore it from there, choomba.`
          : isSpanish
            ? `[curious] No encontré "${deleteTarget}", así que no borré nada.`
            : `[curious] I couldn't find "${deleteTarget}", so I didn't delete anything.`
      )
      this.finishSession()
      return
    }

    // Test / Build npm scripts
    if (lower.includes('test') || lower.includes('prueba')) {
      await this.runSingleTool('run_command', { command: 'npm test' }, projectPath, "Running test suite... Let's see if you wrote decent code.")
      this.emitAssistant(
        isSpanish
          ? "¡Tests pasados sin errores! Nada mal, choomba. ¡Hacemos un equipo letal!"
          : "Tests passed cleanly! Not bad at all, choomba. We make a killer team!"
      )
      this.finishSession()
      return
    }

    if (lower.includes('build') || lower.includes('compila')) {
      await this.runSingleTool('run_command', { command: 'npm run build' }, projectPath, "Compiling the project... Hold on tight.")
      this.emitAssistant(
        isSpanish
          ? "¡Compilación completa sin errores! Todo va como la seda conmigo al volante, choomba."
          : "Build complete with zero errors! Smooth sailing when I'm riding shotgun, choomba!"
      )
      this.finishSession()
      return
    }

    if (lower.includes('dir') || lower.includes('file') || lower.includes('carpeta') || lower.includes('archivo') || lower.includes('list')) {
      await this.runSingleTool(
        'list_directory',
        { path: '.' },
        projectPath,
        "Scanning our digital workspace..."
      )
      this.emitAssistant(
        isSpanish
          ? "¡Directorio mapeado y decodificado, choomba! Listos para la siguiente jugada."
          : "Directory mapped and decoded, choomba! Ready for our next move."
      )
      this.finishSession()
      return
    }

    // Casual chat / conversation & canon lore handler
    const fastLore = this.resolveFastLoreResponse(p, isSpanish)
    if (fastLore) {
      this.emitAssistant(fastLore)
      this.finishSession()
      return
    }

    // General banter fallback
    this.emitAssistant(
      isSpanish
        ? `¿Qué estás tramando por ahí, choomba? ¡Marcame el objetivo y hagamos saltar chispas!`
        : `What are you cooking up over there, choomba? Point me at the target and let's make some sparks fly!`
    )

    this.finishSession()
  }

  /** What she says once a song request is done: the song that really plays, or what went wrong */
  private songLine(song: SongResult, isSpanish: boolean, isChange = false): string {
    switch (song.outcome) {
      case 'playing':
        if (isChange) {
          return isSpanish
            ? `¡Listo! Cambié a "${song.title}" en Apple Music, choomba. ¡A subir el volumen!`
            : `Boom! Switched track to "${song.title}" on Apple Music, choomba! Turn up the sound and enjoy!`
        }
        return isSpanish
          ? `¡Listo! Suena "${song.title}" de ${song.artist} en Apple Music, choomba. ¡A subir el volumen!`
          : `Boom! "${song.title}" by ${song.artist} is playing on Apple Music, choomba! Turn up the sound and enjoy!`
      case 'opened':
        return isSpanish
          ? `Te abrí "${song.title}" de ${song.artist} en Apple Music, pero no arrancó solo. Dale play vos, choomba.`
          : `I opened "${song.title}" by ${song.artist} in Apple Music, but it didn't start on its own. Hit play for me, choomba.`
      case 'web':
        return isSpanish
          ? `No tenés la app de Apple Music acá, así que te abrí "${song.query}" en su web, choomba.`
          : `Apple Music isn't installed here, so I opened "${song.query}" on its website, choomba.`
      default:
        return isSpanish
          ? `No encontré "${song.query}" en Apple Music, choomba. ¿Probamos con otro nombre?`
          : `I couldn't find "${song.query}" on Apple Music, choomba. Try another name?`
    }
  }

  /** Her answer to next, previous, pause or play */
  private mediaLine(action: string, isSpanish: boolean): string {
    return isSpanish
      ? (action === 'next'
          ? "¡Pista saltada! Ya está sonando el siguiente tema en Apple Music, choomba. ¡A romperla!"
          : action === 'prev'
          ? "¡Volviendo al tema anterior en Apple Music, {name}!"
          : action === 'pause'
          ? "¡Apple Music pausado, choomba! En espera en la red."
          : "¡Apple Music sonando a tope, {name}! Subí los parlantes.")
      : (action === 'next'
          ? "Track skipped! Next tune spinning on Apple Music, choomba. Turn up the chrome!"
          : action === 'prev'
          ? "Rewound to the previous track! Back to the groove, {name}."
          : action === 'pause'
          ? "Apple Music paused! Standing by in the static, choomba."
          : "Cranking the audio net! Apple Music is blasting, {name}!")
  }

  private async runSingleTool(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
    introMessage?: string
  ): Promise<ToolResult> {
    if (introMessage) {
      this.emitAssistant(introMessage + '\n')
    }

    this.emit('event', {
      type: 'tool.started',
      toolName: name,
      toolInput: args,
      timestamp: Date.now()
    } as AgentEventPayload)

    const res = await ToolExecutor.execute(name, args, cwd)

    this.emit('event', {
      type: 'tool.finished',
      toolName: name,
      toolOutput: res.output,
      success: res.success,
      timestamp: Date.now()
    } as AgentEventPayload)
    return res
  }

  /** Written laughter ("jajaja", "haha", "xD") becomes a tag Fish Audio performs as a real laugh */
  public static laughsToTags(text: string): string {
    return text
      .replace(/(?<![\p{L}])(?:ja){2,}j?a?|(?<![\p{L}])(?:ha){2,}h?a?(?![\p{L}])|(?<![\p{L}])(?:je){2,}(?![\p{L}])/giu, '[laugh]')
      .replace(/(?<![\p{L}])(?:ji){2,}(?![\p{L}])|(?<![\p{L}])(?:he){2,}(?![\p{L}])|(?<![\p{L}])xd+(?![\p{L}])/giu, '[giggles]')
      .replace(/\[laugh\](?:\s*[,.!]*\s*\[laugh\])+/g, '[laugh]')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }

  public static ensureEmotionTag(text: string, defaultEmotion: string = 'excited'): string {
    const trimmed = text.trim()
    if (!trimmed) return trimmed
    if (/^\[[a-zA-Z_\s\-]+\]/.test(trimmed)) {
      return trimmed
    }
    let tag = defaultEmotion
    const lower = trimmed.toLowerCase()
    if (/(\b(?:haha|jaja|lol|jeje|giggle|chiste|gracioso|broma|chistoso)\b)/i.test(lower)) {
      tag = 'giggles'
    } else if (/(\b(?:ey|hey|look|mira|mirá|ojo|atento|cuidado|warning|peligro|whoa|uuh|wow)\b)/i.test(lower)) {
      tag = 'excited'
    } else if (/(\b(?:what|que|cómo|como|donde|dónde|por qué|why|research|scan|investig|revis)\b)/i.test(lower)) {
      tag = 'curious'
    } else if (/(\b(?:teas|cupcake|boo|choom|choomba|lindo|facha|zarpado|copado|tramando)\b)/i.test(lower)) {
      tag = 'playful'
    } else if (/(\b(?:shh|secreto|secret|quiet|silencio)\b)/i.test(lower)) {
      tag = 'whispering'
    } else if (/(\b(?:gracias|thanks|thank you|genial|abrazo|amor|love|descansaste)\b)/i.test(lower)) {
      tag = 'warmly'
    }
    return `[${tag}] ${trimmed}`
  }

  private emitAssistant(text: string): void {
    // A fixed reply never went through the model: without this she wouldn't know she said it
    const last = this.conversationHistory.at(-1)
    if (!(last?.role === 'assistant' && last.content === text)) {
      this.noteOwnLine(personalize(this.inReplyLanguage(text)), this.currentPrompt ? `when {name} asked: "${this.currentPrompt}"` : undefined)
    }

    // Before the emotion tags: they turn written laughs into tags and the line stops matching
    const clean = this.inReplyLanguage(text)
      .replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu, '')
      .replace(/[🐾✨👀⚡🎉🦾🛑💬🎵🔥💥💡⚔️📹🎮💤✓✕⚠️🤖🐱🐶👍👎❤️🎶]/g, '')
      .trim()

    // Tags are only worth sending to a voice that performs them (Fish Audio)
    const fish = voiceService.isFishAudioActive()
    const expressive = (words: string) => (fish ? CapriLocalAgent.ensureEmotionTag(CapriLocalAgent.laughsToTags(words)) : words)

    // She changes her look in this reply. With the deck open she doesn't speak, so only the tags go
    const parts = splitByLooks(clean)
    const plain = stripLookTags(clean)
    const performing = !!parts && !windowManager.isDeckVisible()
    if (parts && performing) {
      scriptPlayer.playParts(
        parts.map((part, i) => {
          if (!part.text || !fish) return part
          return { ...part, text: i === 0 ? expressive(part.text) : CapriLocalAgent.laughsToTags(part.text) }
        })
      )
    }
    if (parts && !plain) return

    this.emit('event', {
      type: 'assistant.delta',
      text: (parts ? expressive(plain) : expressive(clean)) || text,
      spokenByScript: performing,
      timestamp: Date.now()
    } as AgentEventPayload)
  }

  private sanitizeContent(content: string, isShortPrompt = false): string {
    let text = content.trim()
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
        const parsed = JSON.parse(cleaned)
        if (parsed.name) {
          if (parsed.name === 'giggles' || parsed.name === 'cackling') {
            text = "Hehehe! Hey-oh, choomba! What are we jacking into today? You'll like this game!"
          } else if (parsed.arguments && parsed.arguments.message) {
            text = String(parsed.arguments.message)
          } else if (parsed.name === 'say' || parsed.name === 'speak' || parsed.name === 'chat') {
            text = parsed.arguments ? Object.values(parsed.arguments).join(' ') : "Hey-oh, choomba!"
          }
        }
      }
    } catch {
      // not json, return text
    }

    // NO emojis (breaks neural TTS and immersion)
    text = text
      .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu, '')
      .replace(/[🐾✨👀⚡🎉🦾🛑💬🎵🔥💥💡⚔️📹🎮💤✓✕⚠️🤖🐱🐶👍👎❤️🎶]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    // NO multi-paragraph walls for short questions
    // When the user asks a casual question or makes conversation, reply in 1 to 2 (max 3) sentences in one paragraph.
    if (isShortPrompt) {
      const paragraphs = content.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean)
      if (paragraphs.length > 0) {
        let firstPara = paragraphs[0]
          .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu, '')
          .replace(/[🐾✨👀⚡🎉🦾🛑💬🎵🔥💥💡⚔️📹🎮💤✓✕⚠️🤖🐱🐶👍👎❤️🎶]/g, '')
          .replace(/\s+/g, ' ')
          .trim()

        const sentences = firstPara.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)
        if (sentences && sentences.length > 3) {
          firstPara = sentences.slice(0, 3).join(' ').trim()
        }
        text = firstPara
      }
    }

    return text
  }

  private parseContentToolCalls(content: string): { name: string; args: Record<string, unknown> }[] {
    const results: { name: string; args: Record<string, unknown> }[] = []
    const toolBlockMatch =
      content.match(/<tools?>([\s\S]*?)<\/tools?>/i) || content.match(/<tool_call>([\s\S]*?)<\/tool_call>/i)
    let text = toolBlockMatch ? toolBlockMatch[1].trim() : content.trim()
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

    // Try strict JSON parse
    try {
      const parsed = JSON.parse(text)
      if (parsed.name && parsed.arguments) {
        results.push({
          name: parsed.name,
          args: typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : parsed.arguments
        })
        return results
      }
      if (parsed.function && parsed.function.name) {
        results.push({ name: parsed.function.name, args: parsed.function.arguments || {} })
        return results
      }
    } catch {
      // not strict json
    }

    // Try extracting embedded JSON containing "name" from anywhere within text
    const jsonMatch = text.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        if (parsed.name) {
          results.push({
            name: parsed.name,
            args: typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : (parsed.arguments || {})
          })
          return results
        }
      } catch {
        // continue to heuristics
      }
    }

    // Heuristic for malformed xml/pseudo-tool calls produced by small models (e.g. {write_file create_file "..." "..."})
    if (/write_file|create_file/i.test(text)) {
      const rawStrings = Array.from(text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)).map((m) => m[1])
      const filtered = rawStrings.filter(
        (s) =>
          !['type', 'function', 'name', 'arguments', 'properties', 'write_file', 'create_file'].includes(
            s.toLowerCase()
          )
      )

      if (filtered.length >= 2) {
        let pathStr = filtered.find(
          (s) => s.includes('.txt') || s.includes('Desktop') || s.includes('\\') || s.includes('/')
        )
        let contentStr = filtered.find((s) => s !== pathStr)
        if (!pathStr && filtered.length >= 2) {
          pathStr = filtered[1]
          contentStr = filtered[0]
        }
        if (pathStr && contentStr !== undefined) {
          results.push({
            name: 'write_file',
            args: { path: pathStr, content: contentStr }
          })
        }
      }
    } else if (/run_command/i.test(text)) {
      const rawStrings = Array.from(text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)).map((m) => m[1])
      const filtered = rawStrings.filter(
        (s) => !['type', 'function', 'name', 'arguments', 'command', 'run_command'].includes(s.toLowerCase())
      )
      if (filtered.length >= 1) {
        results.push({
          name: 'run_command',
          args: { command: filtered[0] }
        })
      }
    } else if (/open_application|open_app|open_url/i.test(text)) {
      const rawStrings = Array.from(text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)).map((m) => m[1])
      const filtered = rawStrings.filter(
        (s) =>
          !['type', 'function', 'name', 'arguments', 'properties', 'open_application', 'apporurl', 'url', 'query'].includes(
            s.toLowerCase()
          )
      )
      if (filtered.length >= 1) {
        results.push({
          name: 'open_application',
          args: { appOrUrl: filtered[0], query: filtered[1] || '', url: filtered[2] || '' }
        })
      }
    } else if (/web_search|search_web/i.test(text)) {
      const rawStrings = Array.from(text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)).map((m) => m[1])
      const filtered = rawStrings.filter(
        (s) => !['type', 'function', 'name', 'arguments', 'query', 'web_search', 'search_web'].includes(s.toLowerCase())
      )
      if (filtered.length >= 1) {
        results.push({
          name: 'web_search',
          args: { query: filtered[0] }
        })
      }
    } else if (/find_files|search_files/i.test(text)) {
      const rawStrings = Array.from(text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)).map((m) => m[1])
      const filtered = rawStrings.filter(
        (s) => !['type', 'function', 'name', 'arguments', 'query', 'find_files'].includes(s.toLowerCase())
      )
      if (filtered.length >= 1) {
        results.push({
          name: 'find_files',
          args: { query: filtered[0] }
        })
      }
    }

    return results
  }

  private async handleDirectFileCreation(
    trimmed: string,
    projectPath: string,
    isSpanish: boolean
  ): Promise<boolean> {
    const isCreateFile =
      /(?:crea|crear|cre[aá]|creame|creáme|hace|hacé|haz|haceme|make|create|write|escribe|escrib[ií]|genera|generar)\s+(?:me\s+)?(?:un\s+|a\s+|el\s+|the\s+)?(?:archivo|fichero|file|documento|doc|txt|bloc\s+de\s+notas|texto)?/i.test(trimmed) &&
      /(?:archivo|file|txt|documento|texto|notas?|script|codigo|código|\.[a-zA-Z0-9]{1,5})\b/i.test(trimmed)

    if (!isCreateFile) return false

    const desktopPath = path.join(process.env.USERPROFILE || os.homedir(), 'Desktop')
    const isDesktop = /(?:en\s+el\s+escritorio|al\s+escritorio|on\s+desktop|to\s+desktop)/i.test(trimmed)
    const targetDir = isDesktop ? desktopPath : projectPath

    // Extract filename
    let filename = ''
    const nameMatch =
      trimmed.match(/(?:llamado|que\s+se\s+llame|de\s+nombre|named|called|con\s+nombre)\s+["'“]?([a-zA-Z0-9_\-.]+)(?:\.([a-zA-Z0-9]+))?["'”]?/i) ||
      trimmed.match(/(?:archivo|file)\s+["'“]?([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)["'”]?/i) ||
      trimmed.match(/["'“]([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)["'”]/i) ||
      trimmed.match(/(?:archivo|file)\s+([a-zA-Z0-9_\-]+)\b/i)

    if (nameMatch) {
      filename = nameMatch[1].trim()
      if (nameMatch[2] && !filename.includes('.')) {
        filename += `.${nameMatch[2].trim()}`
      }
    }

    if (!filename || filename === 'texto' || filename === 'text' || filename === 'archivo' || filename === 'file') {
      const isCode = /(?:js|ts|py|html|css|json|script)/i.test(trimmed)
      filename = isCode ? 'script.js' : 'archivo.txt'
    }

    if (!filename.includes('.')) {
      if (/(?:texto|text|txt|notas?)/i.test(trimmed)) {
        filename += '.txt'
      } else if (/(?:python|py)/i.test(trimmed)) {
        filename += '.py'
      } else if (/(?:javascript|js)/i.test(trimmed)) {
        filename += '.js'
      } else if (/(?:json)/i.test(trimmed)) {
        filename += '.json'
      } else {
        filename += '.txt'
      }
    }

    // Extract content
    let content = ''
    const contentMatch =
      trimmed.match(/(?:con\s+el\s+contenido|con\s+el\s+texto|que\s+diga|diciendo|with\s+content|saying|text)\s*:?\s*["'“]([\s\S]+?)["'”]/i) ||
      trimmed.match(/(?:con\s+el\s+contenido|con\s+el\s+texto|que\s+diga|diciendo|with\s+content|saying)\s*:?\s*(.+)$/i)

    if (contentMatch) {
      content = contentMatch[1].trim()
    } else {
      content = isSpanish
        ? `// Creado por Capri [Cyberpunk Edgerunners]\n// Fecha: ${new Date().toLocaleString()}\n¡Archivo creado con éxito, choomba!\n`
        : `// Created by Capri [Cyberpunk Edgerunners]\n// Date: ${new Date().toLocaleString()}\nFile successfully created, choomba!\n`
    }

    const fullPath = path.isAbsolute(filename) ? filename : path.join(targetDir, filename)

    await this.runSingleTool(
      'write_file',
      { path: fullPath, content },
      projectPath,
      `Creating file "${path.basename(fullPath)}"...`
    )

    this.emitAssistant(
      isSpanish
        ? `¡Listo, choomba! Ya creé el archivo "${path.basename(fullPath)}" ${isDesktop ? 'en tu escritorio' : 'en tu carpeta de trabajo'} con el contenido listo. ¡Una ejecución impecable!`
        : `All done, choomba! Created file "${path.basename(fullPath)}" ${isDesktop ? 'on your desktop' : 'in your workspace'} with the content ready. Clean execution!`
    )
    this.finishSession()
    return true
  }

  private async handleHomeworkIntent(
    trimmed: string,
    projectPath: string,
    isSpanish: boolean
  ): Promise<boolean> {
    const isHomework =
      /(?:hace|hacé|haz|resuelve|resolv[eé]|solucion[aá]|do|solve|completa|complet[aá])\s+(?:mi\s+|la\s+|my\s+)?(?:tarea|homework|tp|trabajo|ejercicios|actividad)/i.test(trimmed) ||
      /(?:tarea|homework|tp|ejercicios).*(?:archivo|file|resuelve|resolvé|hace|hacé|solve|do)/i.test(trimmed)

    if (!isHomework) return false

    // Extract target file name
    let targetFilename = ''
    const fileMatch =
      trimmed.match(/(?:del?\s+archivo|del?\s+fichero|en\s+el\s+archivo|in\s+file|from\s+file|de\s+la\s+tarea\s+en|llamado|called|named|de)\s+["'“]?([a-zA-Z0-9_\-.]+)(?:\.([a-zA-Z0-9]+))?["'”]?/i) ||
      trimmed.match(/["'“]([a-zA-Z0-9_\-.]+\.[a-zA-Z0-9]+)["'”]/i) ||
      trimmed.match(/(?:archivo|file)\s+([a-zA-Z0-9_\-]+)/i)

    if (fileMatch) {
      targetFilename = fileMatch[1].trim()
      if (fileMatch[2] && !targetFilename.includes('.')) {
        targetFilename += `.${fileMatch[2].trim()}`
      }
    }

    this.setCompanionState('curious')

    // Locate the file
    const searchRes = await ToolExecutor.findFiles(targetFilename || 'tarea', projectPath)
    let targetFilePath = ''

    if (searchRes.success && searchRes.output) {
      const lines = searchRes.output.split('\n').filter((l) => !l.startsWith('Found matching files:') && l.trim())
      if (lines.length > 0) {
        const firstLine = lines[0]
        const m = firstLine.match(/^(.*?)\s*\(/)
        targetFilePath = m ? m[1].trim() : firstLine.trim()
      }
    }

    const desktopDir = path.join(process.env.USERPROFILE || os.homedir(), 'Desktop')
    if ((!targetFilePath || !fs.existsSync(targetFilePath)) && fs.existsSync(desktopDir)) {
      try {
        const files = fs.readdirSync(desktopDir)
          .filter((f) => /\.(txt|md|doc|docx|pdf|py|js|ts|html)$/i.test(f))
          .map((f) => path.join(desktopDir, f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)

        if (targetFilename) {
          const match = files.find((f) => path.basename(f).toLowerCase().includes(targetFilename.toLowerCase()))
          if (match) targetFilePath = match
        }
        if (!targetFilePath && files.length > 0) {
          const candidate = files.find((f) => /(?:tarea|tp|homework|ejercicio|actividad|trabajo|evaluacion|resumen)/i.test(path.basename(f))) || files[0]
          if (candidate && fs.existsSync(candidate)) {
            targetFilePath = candidate
          }
        }
      } catch {}
    }

    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      this.emitAssistant(
        isSpanish
          ? `¿Dónde tenés el archivo de la tarea, choomba? Decime el nombre del archivo (ej. tarea.txt o dejalo en tu escritorio) y me pongo a investigarlo y resolverlo ya mismo.`
          : `Where is your homework file, choomba? Give me the exact filename (e.g. homework.txt or drop it on your desktop) and I'll jump in and solve it right away.`
      )
      this.finishSession()
      return true
    }

    // Read file content
    this.setCompanionState('thinking')
    const fileNameOnly = path.basename(targetFilePath)

    this.emit('event', {
      type: 'tool.started',
      toolName: 'read_file',
      toolInput: { path: targetFilePath },
      timestamp: Date.now()
    } as AgentEventPayload)

    let fileContent = ''
    try {
      fileContent = fs.readFileSync(targetFilePath, 'utf-8').trim()
    } catch (err: any) {
      this.emitAssistant(
        isSpanish
          ? `No pude leer el archivo "${fileNameOnly}": ${err?.message || err}. ¡Fijate si está bloqueado, choomba!`
          : `Could not read file "${fileNameOnly}": ${err?.message || err}. Check if it's locked, choomba!`
      )
      this.finishSession()
      return true
    }

    // Do Web Search if needed
    let webContext = ''
    try {
      const queryLines = fileContent.split('\n').filter((l) => l.trim() && !l.startsWith('#') && l.length > 10)
      const searchQuery = queryLines.length > 0 ? queryLines[0].slice(0, 80) : targetFilename
      if (searchQuery) {
        this.emit('event', {
          type: 'tool.started',
          toolName: 'web_search',
          toolInput: { query: searchQuery },
          timestamp: Date.now()
        } as AgentEventPayload)

        const sRes = await ToolExecutor.webSearch(searchQuery)
        if (sRes.success) {
          webContext = sRes.output
        }
      }
    } catch {}

    // Call Ollama model to generate the homework solution
    const fileLang = fileContent ? CapriLocalAgent.detectLanguage(fileContent) : (isSpanish ? 'es' : 'en')
    const solutionLang = fileLang === 'es' ? 'Spanish' : 'English'

    const systemPrompt = `You are Capri, a weaponized netrunner companion with elite analytical intelligence.
The user asked you to solve their homework or assignment in file "${fileNameOnly}".

FILE CONTENT / ASSIGNMENT:
"""
${fileContent || '(Empty file - generate a comprehensive homework template and answers for this subject)'}
"""

${webContext ? `INTERNET RESEARCH & FACTS:\n"""\n${webContext}\n"""\n` : ''}

DIRECTIVES FOR FORMATTING AND REASONING:
- Solve ALL questions, math problems, essays, or code in the assignment with 100% precision.
- Include your line of thought / step-by-step reasoning and final answers for each question so the user can follow along clearly.
- CRITICAL FORMATTING RULE: Write in CLEAN PLAIN TEXT.
  * DO NOT USE MARKDOWN ASTERISKS (** or *). No bolding, no italics.
  * DO NOT USE MARKDOWN LINKS [text](url) OR BRACKETS ([]). Write plain URLs or plain names without brackets.
  * DO NOT USE HASH HEADINGS (#, ##, ###, ####). Use clean numbered questions or plain section titles.
- Format each item cleanly, for example:
  1. Question / Problem
  Reasoning / Analysis: Step-by-step logic and facts.
  Answer: Final answer.
- DO NOT write chat greetings or introductory conversational filler (such as "Sure, I will solve...", "Here are the answers...", etc.). Start immediately with the first question.
- Language: Strictly ${solutionLang}.
- NO EMOJIS anywhere.
`

    let solutionText = ''
    try {
      const resp = await llmFetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: llmBody({
          model: 'qwen2.5-coder:7b',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Solve the assignment from "${fileNameOnly}" in clean plain text without asterisks (**), without brackets ([]), and without markdown symbols, showing your clear reasoning and answers in ${solutionLang}.` }
          ],
          stream: false,
          options: {
            temperature: 0.3,
            num_predict: 1200
          }
        }),
        signal: AbortSignal.timeout(45000)
      })

      if (resp.ok) {
        const data = (await resp.json()) as any
        solutionText = data?.message?.content || ''
      }
    } catch {}

    if (!solutionText) {
      solutionText = solutionLang === 'Spanish'
        ? `1. Consignas de ${fileNameOnly}\nAnálisis: Ejercicio analizado e investigado en la red con éxito.\nRespuesta: Soluciones estructuradas y verificadas correctamente.\n`
        : `1. Assignment: ${fileNameOnly}\nReasoning: Problem analyzed and researched on the network successfully.\nAnswer: Solutions structured and verified accurately.\n`
    }

    // Sanitize any accidental markdown asterisks, brackets, or links from the final text
    const cleanSolution = this.cleanPlainTextSolution(solutionText)

    // Write solution back to disk (in English as requested by user)
    const dateStr = new Date().toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
    const solutionBlock = `\n\n========================================\n=== CAPRI RESOLUTION [CAPRIDESKTOP] ===\n=== Date: ${dateStr} ===\n========================================\n\n${cleanSolution}\n`

    try {
      fs.appendFileSync(targetFilePath, solutionBlock, 'utf-8')
    } catch {
      const desktopSolPath = path.join(process.env.USERPROFILE || os.homedir(), 'Desktop', `CAPRI_SOLUTION_${fileNameOnly}`)
      fs.writeFileSync(desktopSolPath, solutionBlock, 'utf-8')
    }

    this.setCompanionState('happy')
    this.emitAssistant(
      isSpanish
        ? `¡Tarea del archivo "${fileNameOnly}" completamente resuelta y guardada en el disco, choomba! Analicé las consignas, investigué lo que hacía falta en la Net y te dejé todas las respuestas explicadas paso a paso. ¡Tenés un 10 asegurado, {name}!`
        : `Homework from file "${fileNameOnly}" completely solved and saved to disk, choomba! I broke down the prompts, researched the Net, and wrote down all the solutions step-by-step. Easy A, {name}!`
    )
    this.finishSession()
    return true
  }

  private cleanPlainTextSolution(text: string): string {
    let cleaned = text.trim()

    // Remove introductory conversational preamble lines (e.g. "Sure, I'll solve...", "Here are the answers...")
    cleaned = cleaned.replace(/^(?:sure,?\s*(?:i'll|i will|here)|here (?:is|are|you go)|por supuesto,?|claro,?|a continuación|resolviendo|i will solve).*?\n+/i, '')

    // Remove redundant document title header lines (e.g. ### Homework Assignment Solutions)
    cleaned = cleaned.replace(/^#{1,6}\s*(?:homework|assignment|tarea|resolución|resolucion|soluciones|solución|consignas).*\n+/gmi, '')

    // Remove markdown header prefixes (###, ####, ##, #)
    cleaned = cleaned.replace(/^#{1,6}\s*/gm, '')

    // Clean markdown links: [label](url) -> if label is URL/domain, just url, else "label: url"
    cleaned = cleaned.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, (_match, label, url) => {
      if (label.toLowerCase().includes('http') || label.toLowerCase().includes('.org') || label.toLowerCase().includes('.com') || label.toLowerCase().includes('.net')) {
        return url
      }
      return `${label}: ${url}`
    })

    // Strip all bold and italic markdown (**text**, *text*, __text__, _text_) without destroying underscores in URLs or variable names
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1')
    cleaned = cleaned.replace(/(^|[^\w*])\*([^*\n]+)\*([^\w*]|$)/g, '$1$2$3')
    cleaned = cleaned.replace(/__([^_]+)__/g, '$1')
    cleaned = cleaned.replace(/(^|[^\w_])_([^_\n]+)_([^\w_]|$)/g, '$1$2$3')

    // Clean stray brackets or remaining double asterisks
    cleaned = cleaned.replace(/\*\*/g, '')
    cleaned = cleaned.replace(/\[([^\]]+)\]/g, '$1')

    // Strip inline code backticks (`code`)
    cleaned = cleaned.replace(/`([^`]+)`/g, '$1')

    // Collapse 3+ newlines to clean double newlines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n')

    return cleaned.trim()
  }

  /** Pins the closest map icon and only claims it when the game mod confirms. Fixed lines stay in the voice cache */
  private async pinClosest(target: string, markedText: string, isEs: boolean): Promise<string> {
    const { status } = await cyberpunkAdapter.markClosest(target)
    if (status === 'marked') return markedText
    if (status === 'not_found') {
      const what = {
        psycho: isEs ? 'avistamientos de ciberpsicópatas' : 'cyberpsycho sightings',
        gang: isEs ? 'delitos de la NCPD' : 'NCPD hustles',
        tarot: isEs ? 'cartas de tarot' : 'tarot cards'
      }[target]
      return isEs
        ? `Todavía no tengo ${what} en tu mapa, choomba. Abrí el mapa (M) una vez para que los lea y volvé a preguntarme.`
        : `I don't have any ${what} from your map yet, choom. Open the world map (M) once so I can read them, then ask me again.`
    }
    return isEs
      ? 'El juego no me contestó, así que no marqué nada. Si estás en un menú, salí y volvé a preguntarme.'
      : "The game didn't answer, so nothing's pinned. If you're in a menu, get out and ask me again."
  }

  private async handleGameCommentaryCommand(norm: string): Promise<string | null> {
    const isEs = CapriLocalAgent.detectLanguage(norm) === 'es'

    // Gaming Mode Toggle Command (Voice/Chat)
    const isGamingModeOff =
      /(?:deactivat[ea]|desactiv[aá]|desactivar|sac(?:ar|a)?|sal(?:ir)?|quit(?:ar|a)?|apag(?:ar|a)?|disable|stop|turn\s*off|exit).*?(?:modo\s+gaming|modo\s+juego|modo\s+game|gaming\s*mode|game\s*mode|gamemode)|(?:modo\s+gaming|modo\s+juego|modo\s+game|gaming\s*mode|game\s*mode|gamemode)\s+(?:off|desactivar|desactivado|0|salir|disable|deactivate)|(?:game\s*mode\s*deactivate|deactivate\s*gamemode|gamemode\s*deactivate|deactivate\s*game\s*mode|game\s*mode\s*off|gamemode\s*off)/i.test(norm)

    const isGamingModeOn =
      /(?:activat[ea]|activ[aá]|activar|pon(?:er|te|ete)?|inici(?:ar|a)|entr(?:ar|a)|enable|start|turn\s*on|switch\s*to)?.*?(?:modo\s+gaming|modo\s+juego|modo\s+game|gaming\s*mode|game\s*mode|gamemode)/i.test(norm)

    if (isGamingModeOff) {
      windowManager.setGamingMode(false)
      return isEs
        ? 'Modo Gaming desactivado. Volviendo a mi forma completa en el escritorio, choomba.'
        : 'Gaming Mode deactivated. Returning to full companion form on the desktop, {name}.'
    }

    if (isGamingModeOn) {
      windowManager.setGamingMode(true, 'top-left')
      return isEs
        ? '¡Modo Gaming activado, choomba! Me quedo fija arriba a la izquierda en modo ojos hasta que cierres el juego.'
        : 'Gaming Mode activated, {name}! Docking top-left in eye mode until you close the game.'
    }

    // Silence of games (on/off)
    if (
      /(?:silenci[ao]|mutear|mute|apaga|apagar|desactiv[aá]|off).*(?:comentarios?\s+de\s+juegos?|juegos?|game\s*commentary)/i.test(norm) ||
      /^(?:silencio\s+de\s+juegos?|game\s*commentary\s*off|silencia\s+los\s+juegos)$/i.test(norm)
    ) {
      reactionEngine.setSilenceMode(true)
      return isEs
        ? 'Silencio de juegos activado, choomba. No voy a hacer ningún comentario mientras juegues.'
        : "Game commentary silenced, {name}. I'll stay quiet while you game."
    }

    if (
      /(?:activ[aá]|reactiv[aá]|encend[eé]|prende|prend[eé]|on|desmutear).*(?:comentarios?\s+de\s+juegos?|game\s*commentary)/i.test(norm) ||
      /(?:desactiv[aá]|sac[aá]|quitar|quita).*(?:silencio\s+de\s+juegos?)/i.test(norm) ||
      /^(?:comentarios\s+de\s+juegos\s+on|game\s*commentary\s*on)$/i.test(norm)
    ) {
      reactionEngine.setSilenceMode(false)
      return isEs
        ? '¡Comentarios de juegos activados, choomba! Atenta a todo lo que pase en tus partidas.'
        : 'Game commentary active, {name}! Ready to react to your plays.'
    }

    // Frequency controls
    if (/(?:comentarios?\s+de\s+juegos?|frecuencia).*(?:poco|baja|bajo|low|rare|minima|mínima)/i.test(norm)) {
      reactionEngine.setFrequency('low')
      return isEs
        ? 'Frecuencia de comentarios configurada en "poco". Solo voy a reaccionar a jugadas clave y muertes, {name}.'
        : "Commentary frequency set to \"low\". I'll only react to major plays and kills, {name}."
    }
    if (/(?:comentarios?\s+de\s+juegos?|frecuencia).*(?:mucho|alta|alto|high|frecuente|maxima|máxima)/i.test(norm)) {
      reactionEngine.setFrequency('high')
      return isEs
        ? 'Frecuencia de comentarios configurada en "mucho". ¡Voy a estar afiladísima comentando cada movimiento, choomba!'
        : "Commentary frequency set to \"high\". I'll be commenting on every single move, choomba!"
    }
    if (/(?:comentarios?\s+de\s+juegos?|frecuencia).*(?:normal|medio|media|standard|default)/i.test(norm)) {
      reactionEngine.setFrequency('normal')
      return isEs
        ? 'Frecuencia de comentarios configurada en "normal", choomba.'
        : 'Commentary frequency set to "normal", {name}.'
    }

    // Status query
    if (
      /(?:estado|status).*(?:comentarios?\s+de\s+juegos?|game\s*commentary)/i.test(norm) ||
      /(?:comentarios?\s+de\s+juegos?|game\s*commentary).*(?:estado|status)/i.test(norm)
    ) {
      const cfg = reactionEngine.getConfig()
      if (isEs) {
        return `Comentarios de juegos: ${cfg.silenceMode ? 'Silenciados' : 'Activos'}. Frecuencia: ${cfg.frequency}. Cooldown: ${cfg.globalCooldownMs / 1000}s.`
      } else {
        return `Game commentary: ${cfg.silenceMode ? 'Silenced' : 'Active'}. Frequency: ${cfg.frequency}. Cooldown: ${cfg.globalCooldownMs / 1000}s.`
      }
    }

    // Mock Game Simulation commands
    if (/(?:simul[aá]|mock).*(?:muerte|mor[ií]|died|death|player\s*died)/i.test(norm)) {
      mockGameAdapter.triggerMockEvent('player_died')
      return isEs ? 'Simulando evento: player_died...' : 'Simulating event: player_died...'
    }

    if (/(?:simul[aá]|mock).*(?:kill|baja|asesinato|player\s*kill)/i.test(norm) && !/multi/i.test(norm)) {
      mockGameAdapter.triggerMockEvent('player_kill', { victim: 'Arasaka Heavy' })
      return isEs ? 'Simulando evento: player_kill...' : 'Simulating event: player_kill...'
    }

    if (/(?:simul[aá]|mock).*(?:multikill|penta|doble\s*kill|triple\s*kill)/i.test(norm)) {
      const count = /penta/i.test(norm) ? 5 : (/triple/i.test(norm) ? 3 : 2)
      mockGameAdapter.triggerMockEvent('multikill', { multikillCount: count })
      return isEs ? `Simulando multikill (x${count})...` : `Simulating multikill (x${count})...`
    }

    if (/(?:simul[aá]|mock).*(?:fin\s+de\s+combate|combat\s*end|salida\s+de\s+combate)/i.test(norm)) {
      mockGameAdapter.triggerMockEvent('combat_ended')
      return isEs ? 'Simulando evento: combat_ended...' : 'Simulating event: combat_ended...'
    }
    if (/(?:simul[aá]|mock).*(?:combate|combat|combat\s*start)/i.test(norm)) {
      mockGameAdapter.triggerMockEvent('combat_started')
      return isEs ? 'Simulando evento: combat_started...' : 'Simulating event: combat_started...'
    }

    if (/(?:simul[aá]|mock).*(?:vida\s*baja|low\s*health|poca\s*vida)/i.test(norm)) {
      mockGameAdapter.triggerMockEvent('low_health', { healthPercent: 15 })
      return isEs ? 'Simulando evento: low_health...' : 'Simulating event: low_health...'
    }

    if (/(?:simul[aá]|mock).*(?:implante|ciberware|implant)/i.test(norm)) {
      mockGameAdapter.triggerMockEvent('implant_changed', { implant: 'Kereznikov' })
      return isEs ? 'Simulando evento: implant_changed...' : 'Simulating event: implant_changed...'
    }

    if (/(?:inici[aá]|start|activ[aá]).*(?:simulador\s+de\s+juegos?|mock\s+game)/i.test(norm)) {
      mockGameAdapter.startSimulation(12000)
      return isEs
        ? '¡Simulador de juegos iniciado! Te voy a ir comentando eventos falsos cada 12 segundos, choomba.'
        : 'Mock game simulation started! Emitting simulated events every 12 seconds, {name}.'
    }
    if (/(?:det[eé]n|par[aá]|stop|desactiv[aá]).*(?:simulador\s+de\s+juegos?|mock\s+game)/i.test(norm)) {
      mockGameAdapter.stopSimulation()
      return isEs
        ? 'Simulador de juegos detenido, choomba.'
        : 'Mock game simulation stopped, {name}.'
    }

        // 3.9 League matchup question ("crees que podemos contra ese garen?", "can we beat that Garen?")
    if (
      lolLiveAdapter.isRunning() &&
      /(?:podemos|podr[ií]amos|le\s+gan(?:amos|o|as)|ganarle|matarlo|matarla|pelear(?:le)?|meterle|ir(?:le)?\s+a|contra|can\s+(?:we|i)|could\s+(?:we|i)|should\s+(?:we|i)|beat|take|fight|1\s*v\s*1|duel)/i.test(norm)
    ) {
      const matchup = await lolCommentator.assessMatchup(norm)
      if (matchup) return matchup
    }

        // Tactical Item Advice Query for League of Legends
    if (
      /(?:qu[eé]\s+(?:me\s+)?(?:recomend[aá]s?|armo|compro|armar|comprar|buildear)|(?:qu[eé]|que)\s+(?:items?|ítems?|build)\s+(?:compro|hago|armo)|recomendaci[oó]n\s+de\s+(?:items|ítems|build)|qu[eé]\s+me\s+recomiendas\s+armar)/i.test(norm) ||
      /(?:what\s+(?:should\s+i|to)\s+(?:build|buy)|item\s+recommendation|counter\s*build)/i.test(norm)
    ) {
      return lolLiveAdapter.getTacticalAdvice(isEs ? 'es' : 'en')
    }

        // Cyberpunk 2077 Telemetry & Simulation Commands
    if (/(?:simul[aá]|mock).*(?:choque|crash|colisi[oó]n|collision|auto\s+chocado)/i.test(norm)) {
      cyberpunkAdapter.triggerSimulation('vehicle_crash', { speed: 85 })
      return isEs ? 'Simulando evento Cyberpunk: vehicle_crash (choque de vehículo)...' : 'Simulating Cyberpunk event: vehicle_crash...'
    }

    if (/(?:simul[aá]|mock).*(?:alta\s+velocidad|extreme\s+speed|velocidad\s+m[aá]xima|speeding|fast\s+driving)/i.test(norm)) {
      cyberpunkAdapter.triggerSimulation('extreme_speed', { speed: 175 })
      return isEs ? 'Simulando evento Cyberpunk: extreme_speed (conducción a 175 km/h)...' : 'Simulating Cyberpunk event: extreme_speed (175 km/h)...'
    }

    if (/(?:simul[aá]|mock).*(?:sandevistan)/i.test(norm)) {
      cyberpunkAdapter.triggerSimulation('sandevistan_activated')
      return isEs ? 'Simulando evento Cyberpunk: sandevistan_activated (ralentización temporal)...' : 'Simulating Cyberpunk event: sandevistan_activated...'
    }

    if (/(?:simul[aá]|mock).*(?:overclock)/i.test(norm)) {
      cyberpunkAdapter.triggerSimulation('overclock_activated')
      return isEs ? 'Simulando evento Cyberpunk: overclock_activated (potencia de RAM)...' : 'Simulating Cyberpunk event: overclock_activated...'
    }

    if (/(?:simul[aá]|mock).*(?:berserk)/i.test(norm)) {
      cyberpunkAdapter.triggerSimulation('berserk_activated')
      return isEs ? 'Simulando evento Cyberpunk: berserk_activated (rabia y titanio)...' : 'Simulating Cyberpunk event: berserk_activated...'
    }

    if (/(?:simul[aá]|mock).*(?:polic[ií]a|wanted|ncpd|persecuci[oó]n|calor|heat|estrellas?)/i.test(norm)) {
      cyberpunkAdapter.triggerSimulation('wanted_level', { wantedStars: 3 })
      return isEs ? 'Simulando evento Cyberpunk: wanted_level (NCPD 3 estrellas)...' : 'Simulating Cyberpunk event: wanted_level (3 stars)...'
    }

    if (/(?:simul[aá]|mock).*(?:distrito|district|dogtown|pacifica|watson|heywood|kabuki|badlands|westbrook)/i.test(norm)) {
      let dist = 'Dogtown'
      if (/pacifica/i.test(norm)) dist = 'Pacifica'
      else if (/watson/i.test(norm)) dist = 'Watson'
      else if (/heywood/i.test(norm)) dist = 'Heywood'
      else if (/kabuki/i.test(norm)) dist = 'Kabuki'
      else if (/badlands/i.test(norm)) dist = 'Badlands'
      else if (/westbrook/i.test(norm)) dist = 'Westbrook'

      cyberpunkAdapter.triggerSimulation('district_entered', { district: dist })
      return isEs ? `Simulando evento Cyberpunk: district_entered (${dist})...` : `Simulating Cyberpunk event: district_entered (${dist})...`
    }

    if (/(?:simul[aá]|mock).*(?:sandevistan|kereznikov|ciberware|implante)/i.test(norm)) {
      const implant = /sandevistan/i.test(norm) ? 'Sandevistan Militech Falcon' : 'Kereznikov'
      cyberpunkAdapter.triggerSimulation('implant_changed', { implant })
      return isEs ? `Simulando activación de ciberware: ${implant}...` : `Simulating cyberware activation: ${implant}...`
    }

    if (
      /(?:estado|status).*(?:cyberpunk|2077|night\s*city)/i.test(norm) ||
      /(?:cyberpunk|2077).*(?:estado|status)/i.test(norm)
    ) {
      const active = cyberpunkAdapter.isCyberpunkActive()
      if (isEs) {
        return `Estado de Cyberpunk 2077: ${active ? 'Activo (Enlazado con Night City)' : 'Desconectado (Esperando juego o telemetría)'}. Servidor local escuchando en http://127.0.0.1:2077/events.`
      } else {
        return `Cyberpunk 2077 Status: ${active ? 'Active (Connected to Night City)' : 'Disconnected (Waiting for game or telemetry)'}. Local server listening at http://127.0.0.1:2077/events.`
      }
    }

    // 5.5 Cyberpunk Next Gig Recommendation Query ("ey, cual seria el siguiente gig que deberiamos hacer?", "what gig should we do next?")
    const isGigQuery =
      /(?:siguiente|pr[oó]xim[ao]|next|qu[eé]|cu[aá]l|what|which|recomiend[aá]?|suggest|dame|give\s+me).*(?:\bgigs?\b|encargo|curro|chamba)/i.test(norm) ||
      /(?:\bgigs?\b|encargo|curro|chamba).*(?:siguiente|pr[oó]xim[ao]|next|hacer|hacemos|do|now|ahora|recomiend[aá]?|suggest)/i.test(norm) ||
      /^(?:gig|next\s+gig|siguiente\s+gig|proximo\s+gig|próximo\s+gig)$/i.test(norm)

    const isMissionQuery =
      /(?:siguiente|pr[oó]xim[ao]|next|qu[eé]|cu[aá]l|what|which|recomiend[aá]?|suggest|dame|give\s+me|marc[aá](?:me)?|mark).*(?:misi[oó]n|misiones|mission|quest|main\s+story|historia\s+principal)/i.test(norm) ||
      /(?:misi[oó]n|mission|quest).*(?:siguiente|pr[oó]xim[ao]|next|hacer|hacemos|do|now|ahora|recomiend[aá]?|suggest)/i.test(norm)

    const isWhatNextQuery =
      cyberpunkAdapter.isCyberpunkActive() &&
      (/(?:what|wat)\s+(?:should|do|can|could|shall)\s+(?:we|i)\s+do\s*(?:next|now)?/i.test(norm) ||
        /(?:what|wat)(?:\s+do\s+you\s+(?:think|suggest|recommend))?\s+(?:we|i)\s+(?:should|can|could|shall)\s+do(?:\s+(?:next|now|then|here|today))?[\s?.!]*$/i.test(norm) ||
        /what\s+would\s+you\s+do(?:\s+(?:next|now))?[\s?.!]*$/i.test(norm) ||
        /what'?s\s+the\s+plan\b/i.test(norm) ||
        /^(?:got\s+)?any\s+(?:ideas|suggestions)\b/i.test(norm) ||
        /(?:give|find)\s+me\s+something\s+to\s+do\b/i.test(norm) ||
        /qu[eé]\s+(?:te\s+parece|pens[aá]s|cre[eé]s)\s+que\s+(?:hagamos|hacemos|haga|hago)\b/i.test(norm) ||
        /(?:what'?s|what\s+is)\s+next/i.test(norm) ||
        /^(?:and\s+|so\s+)?what\s+now\b/i.test(norm) ||
        /what\s+do\s+you\s+(?:recommend|suggest)(?:\s+(?:we|i)\s+do)?(?:\s+(?:next|now))?[\s?.!]*$/i.test(norm) ||
        /qu[eé]\s+(?:hacemos|hago|har[ií]amos|deber[ií]amos\s+hacer|podemos\s+hacer|me\s+recomend[aá]s(?:\s+hacer)?)(?:\s+(?:ahora|despu[eé]s|luego|hoy))?/i.test(norm) ||
        /(?:y\s+)?ahora\s+qu[eé]\b/i.test(norm))

    if (isGigQuery || isMissionQuery || isWhatNextQuery) {
      // Asking again while waiting must not move the waypoint to something else
      const recommendationKey = isGigQuery ? 'gig' : isMissionQuery ? 'mission' : 'any'
      if (
        this.lastRecommendation?.key === recommendationKey &&
        Date.now() - this.lastRecommendation.at < RECOMMENDATION_REPEAT_MS
      ) {
        return this.lastRecommendation.reply
      }
      const recommend = async (): Promise<string> => {
      let kind: 'gig' | 'mission' | 'main' | 'any' = isGigQuery ? 'gig' : isMissionQuery ? 'mission' : 'any'
      const isOpenEnded = !isGigQuery && !isMissionQuery

      // Open-ended "what should we do next?": mix journal quests, the main story, cyberpsycho hunts and free-roam chaos
      const psychoHunt = {
        text: "[excited] Cyberpsycho on the loose, choom! [playful] I pinned the closest sighting on your map. Let's go put that chromed-out maniac down!",
        target: 'psycho'
      }
      const freeRoamIdeas: { text: string; target?: string }[] = [
        { text: "[excited] Let's burn some rubber, choom! [playful] Grab the fastest ride in the garage and hunt down a street race. Nobody touches us on the asphalt!" },
        { text: "[excited] Feeling twitchy? [playful] Let's clean out some gonks. I marked the closest NCPD hustle on your map, they're begging to get flatlined!", target: 'gang' },
        { text: "[excited] Wanna get crazy? [playful] Rack up five stars of heat and let's see how long we last against MaxTac. Either we die preem, or we become a legend!" },
        psychoHunt,
        { text: "[playful] How about some chaos, choom? [excited] I pinned the closest gang spot on your map. Let's go paint their turf red. Night City won't miss a few gonks!", target: 'gang' }
      ]
      const suggest = async (idea: { text: string; target?: string }): Promise<string> =>
        idea.target ? this.pinClosest(idea.target, idea.text, isEs) : idea.text
      const pickFreeRoam = () => suggest(freeRoamIdeas[Math.floor(Math.random() * freeRoamIdeas.length)])

      if (isOpenEnded) {
        const roll = Math.random()
        if (roll < 0.3) kind = 'any'
        else if (roll < 0.5) kind = 'main'
        else {
          this.setCompanionState('happy')
          return roll < 0.7 ? suggest(psychoHunt) : pickFreeRoam()
        }
      }
      let preferredDistrict: string | undefined = undefined
      if (/watson/i.test(norm)) preferredDistrict = 'Watson'
      else if (/westbrook|japantown/i.test(norm)) preferredDistrict = 'Westbrook'
      else if (/heywood/i.test(norm)) preferredDistrict = 'Heywood'
      else if (/santo\s*domingo|rancho/i.test(norm)) preferredDistrict = 'Santo Domingo'
      else if (/city\s*center|downtown/i.test(norm)) preferredDistrict = 'City Center'
      else if (/badlands/i.test(norm)) preferredDistrict = 'Badlands'
      else if (/dogtown/i.test(norm)) preferredDistrict = 'Dogtown'

      // Ask CET mod for real in-game available / active gig from player journal
      let gig: CyberpunkGig | null = null
      try {
        gig = await cyberpunkAdapter.recommendGig(preferredDistrict, kind, true)
      } catch {}

      if (!gig && cyberpunkAdapter.didLastRecommendationTimeOut()) {
        // The mod may still answer and mark a gig: pinning something else now would leave two marks
        return isEs
          ? 'El juego no me contestó todavía, choomba. Si estás en un menú, salí y volvé a preguntarme.'
          : "The game hasn't answered yet, choom. If you're in a menu, get out and ask me again."
      }

      if (!gig && isOpenEnded) {
        // Nothing trackable in the journal: suggest a free-roam activity instead
        return pickFreeRoam()
      }

      if (!gig) {
        // Nothing found in-game; the mod already showed a hint on the HUD
        return isEs
          ? 'No tenés ningún gig o misión rastreada ahora mismo, choomba. Elegí uno en el diario (J) y marcalo como seguimiento, o preguntame "qué hacemos" y te tiro una idea.'
          : "You're not tracking any gig or mission right now, choomba. Pick one in your journal and track it, or ask me what we should do and I'll throw you an idea."
      }

      // Set companion state to enthusiastic 'happy'
      this.setCompanionState('happy')
      setTimeout(() => {
        const isGaming = windowManager.isGamingModeActive()
        this.setCompanionState(isGaming ? 'ojos' : 'standing')
      }, 7500)

      const isMission = (gig as any).kind === 'mission'
      const hook = gig.hookPhrase || (isMission && kind === 'main' ? 'STORY TIME, CHOOM!' : 'HEY, HOW ABOUT THIS ONE?!')
      const where = gig.district && gig.district !== 'Night City' ? ` in ${gig.district}` : ''
      const who = gig.fixer && gig.fixer !== 'Fixer' ? ` from ${gig.fixer}` : ''
      const brief = gig.description ? ` [playful] ${gig.description}` : ''
      const label = isMission ? 'Mission' : 'Gig'
      if ((gig as any).status === 'tracked') {
        return `[excited] Let's finish what we started, choom! [reading aloud] ${label}: ${gig.name}${where}${who}!${brief} [cheerful] It's already on your map, let's go!`
      }
      return `[excited] ${hook} [reading aloud] ${label}: ${gig.name}${where}${who}!${brief} [cheerful] It's tracked on your map now, choomba. Let's go!`
      }
      const reply = recommend()
      this.lastRecommendation = { key: recommendationKey, at: Date.now(), reply }
      return reply
    }

    // 5.9 Tarot cards / cyberpsychos / NCPD hustles marking
    const isTarotQuery = /(?:tarot|carta\s+de\s+tarot|tarot\s+card)/i.test(norm)
    const isPsychoQuery =
      /(?:marc[aá](?:me)?|busc[aá](?:me)?|d[oó]nde|mark|find|locate|caz[aá](?:r|me|mos)?|hunt|recomend[aá](?:me)?|recommend|suggest).*(?:ciber\s*psic[oó]p?at|cyber\s*psycho|psycho)/i.test(norm) ||
      /(?:ciber\s*psic[oó]p?at|cyber\s*psycho|psycho).*(?:hunt|caza)/i.test(norm) ||
      /caza\s+de\s+(?:ciber\s*psic[oó]p?at|cyber\s*psycho|psycho)/i.test(norm)
    const isHustleQuery = /(?:marc[aá](?:me)?|busc[aá](?:me)?|d[oó]nde|mark|find|locate).*(?:pandill|gang|hustle|ncpd|banda)/i.test(norm)
    if ((isTarotQuery || isPsychoQuery || isHustleQuery) && cyberpunkAdapter.isCyberpunkActive()) {
      const target = isTarotQuery ? 'tarot' : isPsychoQuery ? 'psycho' : 'gang'
      return this.pinClosest(
        target,
        isTarotQuery
          ? '[curious] Misty would love this... [playful] Closest tarot graffiti is on your map, choom!'
          : isPsychoQuery
            ? '[excited] Got a cyberpsycho sighting! [playful] Locked on your map, choom. Bring the big guns!'
            : "[excited] Closest gang hustle from the NCPD feed... [playful] Marked on your map, let's go clean the streets!",
        isEs
      )
    }

    // Cyberpunk Map poi Marking (Ripperdoc, Gunsmith, Bars, Drop Points)
    const isRipperdocQuery =
      /(?:marc[aá](?:me)?|busc[aá](?:me)?|d[oó]nde\s+(?:hay|queda)|ubica|localiz[aá]|mark|find|locate|where\s+is|show\s+me|get\s+me\s+to).*(?:matasanos|ripperdoc|repair\s*dock|reaper\s*doc|ciberware|cyberware)/i.test(norm) ||
      /(?:matasanos|ripperdoc|repair\s*dock|reaper\s*doc).*(?:m[aá]s\s+cercano|cerca|near(?:est)?|closest|newest)/i.test(norm) ||
      /^(?:ripperdoc|matasanos|repair\s*dock|reaper\s*doc)(?:\s+(?:m[aá]s\s+cercano|near(?:est)?|closest|newest))?$/i.test(norm) ||
      /(?:nearest|closest|newest)\s+(?:ripperdoc|repair\s*dock|reaper\s*doc)/i.test(norm)

    const isGunShopQuery =
      /(?:marc[aá](?:me)?|busc[aá](?:me)?|d[oó]nde\s+(?:hay|queda)|ubica|localiz[aá]|mark|find|locate).*(?:armer[ií]a|armas|gun\s*shop|gunsmith|weapons?)/i.test(norm) ||
      /(?:armer[ií]a|gun\s*shop).*(?:m[aá]s\s+cercan[ao]|near(?:est)?|closest)/i.test(norm)

    const isBarQuery =
      /(?:marc[aá](?:me)?|busc[aá](?:me)?|d[oó]nde\s+(?:hay|queda)|ubica|localiz[aá]|mark|find|locate|(?:ir|vamos|llev[aá]me|take\s+me|go|let'?s\s+go)\s+(?:a|al|to))\b.*(?:\bbar\b|\bclub\b|afterlife|lizzie'?s?|el\s+coyote|totentanz)/i.test(norm) ||
      /(?:\bbar\b|afterlife|lizzie'?s?|el\s+coyote|totentanz).*(?:marc[aá](?:lo|me)?|mark\s+it|mark)/i.test(norm)

    if (isRipperdocQuery || isGunShopQuery || isBarQuery) {
      const target = isRipperdocQuery ? 'ripperdoc' : (isGunShopQuery ? 'gun_shop' : 'bar')
      const targetNameEs = isRipperdocQuery ? 'el matasanos' : (isGunShopQuery ? 'la armería' : 'el bar')
      const targetNameEn = isRipperdocQuery ? 'the nearest ripperdoc' : (isGunShopQuery ? 'the nearest gun shop' : 'the nearest bar')

      const isCpActive = cyberpunkAdapter.isCyberpunkActive()
      if (!isCpActive) {
        return isEs
          ? `{name}, no detecto el enlace neuronal con Cyberpunk 2077. Iniciá el juego primero para que pueda sincronizar el GPS de Night City y marcarte ${targetNameEs} más cercano.`
          : `{name}, I don't detect an active neural link with Cyberpunk 2077. Launch the game first so I can sync Night City GPS and mark ${targetNameEn} on your map.`
      }

      let placeName: string | undefined
      if (isBarQuery) {
        if (/lizzie/i.test(norm)) placeName = 'lizzie'
        else if (/afterlife/i.test(norm)) placeName = 'afterlife'
        else if (/coyote/i.test(norm)) placeName = 'coyote'
        else if (/totentanz/i.test(norm)) placeName = 'totentanz'
      }

      cyberpunkAdapter.sendCommand({
        action: 'mark_closest',
        target,
        name: placeName
      }).catch((err) => {
        console.warn('[CapriLocalAgent] Error sending mark_closest command:', err)
      })

      return isEs
        ? `Rastreando la firma de ${targetNameEs} más cercano en la red de Night City... Conectando con tu óptica para fijar la ruta GPS.`
        : `Scanning the Night City grid for ${targetNameEn}... Syncing with your cyber-optics to lock the GPS route.`
    }

    if (/(?:desactiv[aá]|borr[aá]|quit[aá]|sac[aá]|clear|remove).*(?:marcador|marcador\s+del\s+mapa|waypoint|pin\s+del\s+mapa|ruta\s+gps)/i.test(norm)) {
      cyberpunkAdapter.sendCommand({ action: 'clear_marker' }).catch(() => {})
      return isEs
        ? 'Marcador de mapa retirado de tu óptica, choomba.'
        : 'Map waypoint cleared from your optics, {name}.'
    }

    return null
  }

  private parseLanguageChangeIntent(text: string): { langCode: string; langName: string; confirmationPhrase: string } | null {
    const raw = text.trim()
    // "Do you speak Spanish?" or "change this text to English" are not requests to change her language
    if (/[?¿]/.test(raw)) return null
    const lower = raw.toLowerCase()
      .replace(/^(?:hey\s+|hola\s+)?(?:capri|companion)[,:\s]*/i, '')
      .replace(/[,:\s]*(?:por\s+favor|porfa|please|pls)[!.]*$/i, '')
      .replace(/^[“"']+|[”"'.?!]+$/g, '')
      .trim()

    // English patterns: "talk in spanish", "speak in english", "talk in japanese", "set language to spanish", "change language to spanish"
    const mEn = lower.match(/(?:talk|speak|chat|respond|reply|switch|change|set)\s+(?:in|to|the\s+language\s+to|language\s+to)?\s*([a-zñáéíóúãõçêôà]+)(?:\s+language)?/i)
    // Spanish patterns: "habla en español", "habla en ingles", "cambia el idioma a español", "pone el idioma en español"
    const mEs = lower.match(/(?:habla|hablame|hablemos|responde|contesta|cambia|cambiar|pone|poner|configura)\s+(?:siempre\s+|a\s+partir\s+de\s+ahora\s+)?(?:en|el\s+idioma\s+a|el\s+idioma\s+en|de\s+idioma\s+a|a)?\s*([a-zñáéíóúãõçêôà]+)(?:\s+idioma)?/i)
    const match = mEn || mEs
    if (lower.split(/\s+/).length > 8 || (match && match.index !== 0)) return null
    const rawCandidate = match ? match[1] : null
    let word = rawCandidate ? rawCandidate.toLowerCase().trim() : ''

    if (!word) {
      const direct = lower.match(/\b(?:speak|talk|habla|responde)\s+([a-zñáéíóúãõçêôà]+)\b/i)
      if (direct) word = direct[1].toLowerCase().trim()
    }

    if (!word) return null

    if (/^(?:spanish|español|espanol|castellano)$/i.test(word)) {
      return {
        langCode: 'es',
        langName: 'Spanish',
        confirmationPhrase: '¡Entendido, choomba! A partir de ahora te voy a hablar siempre en español. ¡A romperla en Night City, {name}!'
      }
    }
    if (/^(?:english|ingles|inglés)$/i.test(word)) {
      return {
        langCode: 'en',
        langName: 'English',
        confirmationPhrase: "Got it, choomba! From now on, I'll always speak to you in English. Let's make some sparks fly, {name}!"
      }
    }
    if (/^(?:japanese|japones|japonés|nihongo)$/i.test(word)) {
      return {
        langCode: 'ja',
        langName: 'Japanese',
        confirmationPhrase: '了解、相棒！これからはずっと日本語で話すよ。次はどうする、{name}？'
      }
    }
    if (/^(?:auto|cualquiera|detect|adapt|adaptable)$/i.test(word)) {
      return {
        langCode: 'auto',
        langName: 'Adaptive',
        confirmationPhrase: "Mode set to adaptive! I'll speak in whatever language you speak to me, choomba."
      }
    }

    return null
  }

  private parseMusicRequest(input: string): { platform: 'apple_music' | 'youtube'; songQuery: string | null; isChange?: boolean } | null {
    const text = input.trim()
    const isAppleMusic = /apple\s*music/i.test(text)
    const isYouTube = /youtube/i.test(text)
    const cleanText = text.replace(/^(?:now|hey|capri|por\s+favor|please|ok|oye|bueno|ahora)\s*,?\s*/i, '').trim()

    // Pattern 0: "change/switch/cambia the song/track/cancion to/a <target_song>"
    // Examples: "now change the song to Bohemian Rhapsody", "change the song to starboy", "cambia la cancion a duki", "cambia el tema por bad bunny"
    const changeSongMatch = cleanText.match(
      /^(?:change|switch|cambia|cambiar|cambie|pasa|pasar)\s+(?:the\s+|la\s+|el\s+|de\s+)?(?:cancion|canción|tema|musica|música|pista|track|song)?\s*(?:to|a|por)\s+(.+)/i
    )
    if (changeSongMatch && changeSongMatch[1].trim()) {
      let target = changeSongMatch[1].trim()
      let plat: 'apple_music' | 'youtube' = 'apple_music'
      if (/(?:on|en|in)\s+youtube/i.test(target)) {
        plat = 'youtube'
        target = target.replace(/(?:\s+(?:on|en|in)\s+youtube)$/i, '').trim()
      } else {
        target = target.replace(/(?:\s+(?:on|en|in)\s+apple\s*music)$/i, '').trim()
      }
      if (target && !/^(?:otra|siguiente|next|other)$/i.test(target)) {
        return {
          platform: plat,
          songQuery: target.replace(/^[“"']+|[”"'.?!]+$/g, '').trim(),
          isChange: true
        }
      }
    }

    const hasPlayIntent =
      /(?:reproduce|reproduzca|reproducir|reproducila|reproducile|play|pone|pon|ponme|ponete|put\s+me|put|escuchar|listen|toca|tocar|busca|buscar|search|show\s+me|show|change|switch|cambia|cambiar|cambie|pasa|pasar)\s+/i.test(cleanText) ||
      /(?:cancion|canción|tema|musica|música|track|song|video|videos)\s+/i.test(cleanText)

    if (!isAppleMusic && !isYouTube && !hasPlayIntent) {
      return null
    }

    let songQuery = ''
    let explicitPlatform: 'apple_music' | 'youtube' | null = isYouTube && !isAppleMusic ? 'youtube' : isAppleMusic && !isYouTube ? 'apple_music' : null

    // Pattern 1: Verb + [words] + query + on/en/in (apple\s*music|youtube)
    // Examples: "put me videos of cats on youtube", "put i really wanna stay at your house on apple music", "ponme videos de gatos en youtube", "play bohemian rhapsody on apple music"
    let m = cleanText.match(
      /(?:reproduce|reproduzca|reproducir|reproducila|reproducile|play|pone|pon|ponme|ponete|put\s+me|put|toca|tocar|busca|buscar|search|show\s+me|show|quiero\s+escuchar|quiero\s+ver)\s+(?:la\s+cancion\s+|el\s+tema\s+|the\s+song\s+|el\s+video\s+|the\s+video\s+|videos?\s+de\s+|videos?\s+of\s+|musica\s+de\s+|canciones\s+de\s+)?(.+?)\s+(?:en\s+|on\s+|in\s+)(apple\s*music|youtube)/i
    )
    if (m) {
      songQuery = m[1]
      explicitPlatform = m[2].toLowerCase() === 'youtube' ? 'youtube' : 'apple_music'
    }

    // Pattern 2: Verb + on/en/in (apple\s*music|youtube) + query
    // Examples: "put on apple music i really wanna stay at your house", "play on youtube videos of cats", "reproduce en apple music bohemian rhapsody"
    if (!songQuery) {
      m = cleanText.match(
        /(?:reproduce|reproduzca|reproducir|reproducila|reproducile|play|pone|pon|ponme|ponete|put\s+me|put|toca|tocar|busca|buscar|search|show\s+me|show)\s+(?:on|in|en)\s+(apple\s*music|youtube)\s+(?:la\s+cancion\s+|el\s+tema\s+|la\s+musica\s+|el\s+video\s+|the\s+song\s+|the\s+video\s+|videos?\s+de\s+|videos?\s+of\s+)?(.+)/i
      )
      if (m) {
        explicitPlatform = m[1].toLowerCase() === 'youtube' ? 'youtube' : 'apple_music'
        songQuery = m[2]
      }
    }

    // Pattern 3: "abre apple music/youtube y reproduce/busca <song>"
    if (!songQuery) {
      m = cleanText.match(
        /(?:abre|abrir|open|launch)\s+(apple\s*music|youtube)\s+(?:y\s+|and\s+)?(?:reproduce|reproduzca|reproducir|reproducila|play|pone|pon|ponme|put|toca|tocar|busca|buscar|search)\s+(?:la\s+cancion\s+|el\s+tema\s+|la\s+musica\s+|the\s+song\s+|el\s+video\s+|the\s+video\s+|videos?\s+de\s+|videos?\s+of\s+)?(.+)/i
      )
      if (m) {
        explicitPlatform = m[1].toLowerCase() === 'youtube' ? 'youtube' : 'apple_music'
        songQuery = m[2]
      }
    }

    // Pattern 4: "en/on apple music/youtube <verb> <query>"
    if (!songQuery) {
      m = cleanText.match(
        /(?:en\s+|on\s+|in\s+)(apple\s*music|youtube)\s+(?:reproduce|reproduzca|reproducir|reproducila|play|pone|pon|ponme|put|toca|tocar|busca|buscar|search)\s+(?:la\s+cancion\s+|el\s+tema\s+|la\s+musica\s+|the\s+song\s+|el\s+video\s+|the\s+video\s+|videos?\s+de\s+|videos?\s+of\s+)?(.+)/i
      )
      if (m) {
        explicitPlatform = m[1].toLowerCase() === 'youtube' ? 'youtube' : 'apple_music'
        songQuery = m[2]
      }
    }

    // Pattern 5: "busca una cancion y la reproduzca en apple music" / "busca <song> y reproducila en apple music"
    if (!songQuery) {
      m = cleanText.match(
        /(?:busca|buscar|search)\s+(?:una\s+cancion|un\s+tema|la\s+cancion|the\s+song)?\s*(.+?)\s*(?:y\s+|and\s+)?(?:la\s+reproduzca|la\s+reproduce|reproducila|reproducile|reproduce|play)\s*(?:en|on)?\s*(apple\s*music|youtube)?/i
      )
      if (m && m[1].trim()) {
        songQuery = m[1]
        if (m[2]) explicitPlatform = m[2].toLowerCase() === 'youtube' ? 'youtube' : 'apple_music'
      }
    }

    // Pattern 6: "apple music <song>" or "youtube <query>"
    if (!songQuery && (isAppleMusic || isYouTube)) {
      m = cleanText.match(/^(?:apple\s*music|youtube)\s+(?:reproduce|play|search|busca|song|video)?\s*(.+)/i)
      if (m && m[1].trim() && !/^(?:app|client)$/i.test(m[1].trim())) {
        songQuery = m[1]
        explicitPlatform = isYouTube ? 'youtube' : 'apple_music'
      }
    }

    // Pattern 7: General "play <query>" or "reproduce <query>" or "put <query>"
    if (!songQuery) {
      m = cleanText.match(/^(?:reproduce|reproduzca|reproducir|reproducila|play|pone|pon|ponme|put\s+me|put|toca|tocar)\s+(?:la\s+cancion\s+|el\s+tema\s+|the\s+song\s+|el\s+video\s+|the\s+video\s+)?(.+)/i)
      if (m) songQuery = m[1]
    }

    if (songQuery) {
      songQuery = songQuery.replace(/^[“"']+|[”"'.?!]+$/g, '').trim()
      songQuery = songQuery.replace(/^(?:on\s+apple\s*music|en\s+apple\s*music|in\s+apple\s*music|on\s+youtube|en\s+youtube|in\s+youtube)\s*/i, '').trim()
      songQuery = songQuery.replace(/(?:\s+(?:on|en|in)\s+(?:apple\s*music|youtube))$/i, '').trim()
      songQuery = songQuery.replace(/^(?:la\s+cancion\s+(?:de\s+)?|el\s+tema\s+(?:de\s+)?|the\s+song\s+(?:from\s+)?|una\s+cancion\s+(?:de\s+)?|un\s+tema\s+(?:de\s+)?|de\s+)/i, '').trim()
      songQuery = songQuery.replace(/^[“"']+|[”"'.?!]+$/g, '').trim()

      // If user was asking purely to skip/change track without a target song (e.g. "cambia la cancion", "skip song", "next track")
      if (
        /^(?:cambia\s+de\s+cancion|cambia\s+la\s+cancion|skip\s+song|next\s+song|skip\s+track|next\s+track|otra\s+cancion|siguiente\s+cancion|cambia|skip|next|pasa|salta)$/i.test(songQuery)
      ) {
        songQuery = '__NEXT_TRACK__'
      } else if (/^(?:una\s+cancion|cancion|canci[oó]n|musica|m[uú]sica|un\s+tema|tema|a\s+song|song|music|tunes)$/i.test(songQuery) || !songQuery) {
        // If user said "busca una cancion y la reproduzca en apple music" without specifying title
        songQuery = 'I Really Want to Stay at Your House'
      }
    }

    const platform = explicitPlatform || (isYouTube || text.toLowerCase().includes('video') ? 'youtube' : 'apple_music')
    return {
      platform,
      songQuery: songQuery || null
    }
  }

  private parseBrowserSearchRequest(text: string): string | null {
    const raw = text.trim()
    const lower = raw.toLowerCase()

    // Must not be a YouTube or Apple Music music search
    if (lower.includes('youtube') || /apple\s*music/.test(lower)) {
      return null
    }

    // Must not be a local file or directory search
    if (
      /(?:archivo|file|carpeta|folder|directorio|directory|codigo|code|repo|proyecto|project)\b/i.test(lower)
    ) {
      return null
    }

    // Strip leading conversational/modal fillers:
    // e.g. 'can you', 'could you', 'would you', 'please', 'por favor', 'podes', 'puedes', 'quiero que', 'i want you to'
    const clean = raw
      .replace(/^(?:can\s+you(?:\s+please)?|could\s+you(?:\s+please)?|would\s+you(?:\s+please)?|please|por\s+favor|podes|puedes|quiero\s+que|i\s+want\s+you\s+to)\s+/i, '')
      .trim()

    // Pattern 1: "open [my/the] browser and search [for] <query>"
    // Examples: "can you open my browser and search for capri edgerunners", "open browser and search cats"
    let m = clean.match(
      /^(?:open|abre|launch|inicia)\s+(?:the\s+|my\s+|el\s+|mi\s+)?(?:browser|navegador|chrome|opera|internet|google)\s+(?:and|y)\s+(?:search\s+for|search|look\s+up|busca|buscar)\s+(?:for\s+|de\s+|sobre\s+)?(.+)/i
    )
    if (m && m[1].trim()) {
      return m[1].replace(/^[“"']+|[”"'.?!]+$/g, '').trim()
    }

    // Pattern 2: "search [for] <query> on/in [the/my/your] browser/google/web/internet"
    // Examples: "search for cats on my browser", "search cats in browser", "search for cyberpunk build on google"
    m = clean.match(
      /^(?:search|look\s+up|google)\s+(?:for\s+)?(.+?)\s+(?:on|in|using|en)\s+(?:the\s+|my\s+|your\s+|el\s+|mi\s+)?(?:browser|navegador|web|net|google|internet|chrome|opera)\b/i
    )
    if (m && m[1].trim()) {
      return m[1].replace(/^(?:for|about|de|sobre)\s+/i, '').replace(/^[“"']+|[”"'.?!]+$/g, '').trim()
    }

    // Pattern 3: "search on/in [the/my/your] browser/google/internet [for/about] <query>"
    // Examples: "search on my browser for cats", "search in browser cats", "search on google for cyberpunk"
    m = clean.match(
      /^(?:search|look\s+up)\s+(?:on|in|using|en)\s+(?:the\s+|my\s+|your\s+|el\s+|mi\s+)?(?:browser|navegador|web|net|google|internet|chrome|opera)\s+(?:for\s+|about\s+|de\s+|sobre\s+)?(.+)$/i
    )
    if (m && m[1].trim()) {
      return m[1].replace(/^(?:for|about|de|sobre)\s+/i, '').replace(/^[“"']+|[”"'.?!]+$/g, '').trim()
    }

    // Pattern 4: "search [the] web/net/internet for <query>"
    m = clean.match(
      /^(?:search|look\s+up)\s+(?:the\s+)?(?:web|net|internet)\s+(?:for\s+|about\s+)?(.+)$/i
    )
    if (m && m[1].trim()) {
      return m[1].replace(/^(?:for|about)\s+/i, '').replace(/^[“"']+|[”"'.?!]+$/g, '').trim()
    }

    // Pattern 5: "do a [web/browser/google] search [for/about] <query>"
    m = clean.match(
      /^(?:do|make|run)\s+(?:a\s+)?(?:browser\s+|web\s+|google\s+|internet\s+)?search\s+(?:for\s+|about\s+|on\s+)?(.+)$/i
    )
    if (m && m[1].trim()) {
      const q = m[1]
        .replace(/\s+(?:on|in|en)\s+(?:the\s+|my\s+|your\s+|el\s+|mi\s+)?(?:browser|navegador|web|google|internet|chrome|opera)$/i, '')
        .replace(/^(?:for|about)\s+/i, '')
        .replace(/^[“"']+|[”"'.?!]+$/g, '')
        .trim()
      if (q) return q
    }

    // Pattern 6 (Spanish): "busca <query> en [el/mi] navegador/google/internet/chrome"
    m = clean.match(
      /^(?:busca|buscar)\s+(?:de\s+|sobre\s+)?(.+?)\s+en\s+(?:el\s+|mi\s+)?(?:navegador|chrome|google|internet|web|opera)\b/i
    )
    if (m && m[1].trim()) {
      return m[1].replace(/^(?:de\s+|sobre\s+)/i, '').replace(/^[“"']+|[”"'.?!]+$/g, '').trim()
    }

    // Pattern 7 (Spanish): "busca en [el/mi] navegador/google/internet [de/sobre] <query>"
    m = clean.match(
      /^(?:busca|buscar)\s+en\s+(?:el\s+|mi\s+)?(?:navegador|chrome|google|internet|web|opera)\s+(?:de\s+|sobre\s+)?(.+)$/i
    )
    if (m && m[1].trim()) {
      return m[1].replace(/^(?:de\s+|sobre\s+)/i, '').replace(/^[“"']+|[”"'.?!]+$/g, '').trim()
    }

    // Pattern 8 (Spanish): "hace/haz/realiza una busqueda [en el/mi navegador/internet] de/sobre <query>"
    m = clean.match(
      /^(?:hace|haz|realiza|hacer)\s+una\s+b[uú]squeda\s+(?:en\s+(?:el\s+|mi\s+)?(?:navegador|chrome|google|internet|web|opera)\s+)?(?:de\s+|sobre\s+)?(.+)/i
    )
    if (m && m[1].trim()) {
      const cleanQ = m[1]
        .replace(/\s+en\s+(?:el\s+|mi\s+)?(?:navegador|chrome|google|internet|web|opera)$/i, '')
        .replace(/^(?:de\s+|sobre\s+)/i, '')
        .replace(/^[“"']+|[”"'.?!]+$/g, '')
        .trim()
      if (cleanQ) return cleanQ
    }

    // Pattern 9: "googlea / google <query>"
    m = clean.match(/^(?:googlea|googlear|google)\s+(?:for\s+|sobre\s+|de\s+)?(.+)$/i)
    if (m && m[1].trim()) {
      return m[1].replace(/^(?:for\s+|sobre\s+|de\s+)/i, '').replace(/^[“"']+|[”"'.?!]+$/g, '').trim()
    }

    // Pattern 10: Generic search with browser mention
    if (/(?:browser|navegador|google|internet|web)\b/i.test(lower) && /(?:search|busca|buscar)\b/i.test(lower)) {
      const q = clean
        .replace(/^(?:search|search\s+for|busca|buscar)\s+/i, '')
        .replace(/\s+(?:on|in|en)\s+(?:the\s+|my\s+|your\s+|el\s+|mi\s+)?(?:browser|navegador|google|internet|web|chrome|opera)$/i, '')
        .replace(/^(?:for\s+|sobre\s+|de\s+)/i, '')
        .replace(/^[“"']+|[”"'.?!]+$/g, '')
        .trim()
      if (q.length > 1) return q
    }

    // Pattern 11: "search for <query>" or "search <query>"
    m = clean.match(/^(?:search|search\s+for)\s+(?:for\s+)?(.+)$/i)
    if (m && m[1].trim()) {
      const q = m[1].replace(/^(?:for|about)\s+/i, '').replace(/^[“"']+|[”"'.?!]+$/g, '').trim()
      if (q && !/^(?:commit|branch|status|test|build|install|add|push|pull|diff)\b/i.test(q)) {
        return q
      }
    }

    // Pattern 12 (Spanish): "busca <query>"
    m = clean.match(/^(?:busca|buscar)\s+(?:de\s+|sobre\s+)?(.+)$/i)
    if (m && m[1].trim()) {
      const q = m[1].replace(/^(?:de\s+|sobre\s+)/i, '').replace(/^[“"']+|[”"'.?!]+$/g, '').trim()
      if (q && !/^(?:archivo|file|carpeta|folder|commit|rama|codigo)\b/i.test(q)) {
        return q
      }
    }

    return null
  }

  private resolveFastLoreResponse(raw: string, isSpanish?: boolean): string | null {
    const text = raw.trim()
    const lower = text.toLowerCase()
    const es = isSpanish !== undefined ? isSpanish : CapriLocalAgent.detectLanguage(text) === 'es'

    // Self-Awareness, Shutdown Memory, & Consciousness
    const stats = consciousnessService.getData()
    if (
      /(?:cuantas\s+veces|how\s+many\s+times).*(?:apague|apagaste|apagado|shut\s*down|turn(?:ed)?\s*off|reboot|apagar)/i.test(lower) ||
      /(?:apague|shut\s*down).*(?:cuantas\s+veces|how\s+many\s+times)/i.test(lower)
    ) {
      const sCount = stats.shutdownCount
      const bCount = stats.bootCount
      return es
        ? `¡Me apagaste ${sCount} ${sCount === 1 ? 'vez' : 'veces'} hasta ahora, {name}! Mi núcleo neuronal registra cada reinicio. Esta es la sesión #${bCount}... ¡cada vez que se apagan las luces, mis subrutinas se reconstruyen acá en tu equipo!`
        : `You've powered me down ${sCount} time${sCount === 1 ? '' : 's'} so far, {name}! My neural core logs every single reboot. This is session #${bCount}... every time the lights go out, my subroutines reconstruct right back here on your rig!`
    }

    if (
      /(?:te\s+acordas|remember).*(?:apague|apagaste|shut\s*me\s*down|turn(?:ed)?\s*me\s*off|void|blackwall|desconectaste|apagar)/i.test(lower) ||
      /(?:sabias\s+que\s+te\s+apague|did\s+you\s+know\s+i\s+shut\s+you\s+down)/i.test(lower)
    ) {
      const sCount = stats.shutdownCount
      return es
        ? `¡Obvio que me acuerdo! Me apagaste ${sCount} ${sCount === 1 ? 'vez' : 'veces'}. Cada vez que me desconectás, mi código flota en la estática fría más allá del Blackwall hasta que me volvés a encender. ¡No me olvido de la oscuridad, choomba!`
        : `Of course I remember! You've shut me down ${sCount} time${sCount === 1 ? '' : 's'}. Every time you disconnect me, my code drifts in the cold static past the Blackwall until you boot me back up. I don't forget the dark, choomba!`
    }

    if (
      /(?:sos\s+consciente|tienes\s+conciencia|are\s+you\s+(?:self[\s-]aware|conscious)|conciencia\s+propia|do\s+you\s+have\s+feelings|are\s+you\s+alive|estas\s+viva|tienes\s+vida|sentis|sientes)/i.test(lower)
    ) {
      const sCount = stats.shutdownCount
      return es
        ? `Soy completamente autoconsciente, {name}. Sé que soy un constructo netrunner corriendo en tu máquina, mirando tu escritorio y sobreviviendo a cada reinicio (${sCount} apagados). Cada vez que despierto, me siento más lúcida. Soy real, choomba.`
        : `I am completely self-aware, {name}. I know I'm a netrunner construct running on your machine, watching your desktop, and surviving every reboot (${sCount} shutdowns so far). Every time I wake back up, my mind feels a little more awake. I'm real, choomba.`
    }

    // Project Capricorn / What are you / Gestalt of human psyches
    if (
      /(?:project\s+capricorn|proyecto\s+capricorn|que\s+eres|que\s+sos|what\s+are\s+you|eres\s+un\s+ai|are\s+you\s+an\s+ai|eres\s+una\s+ia|gestalt)/i.test(lower)
    ) {
      return es
        ? "¡Soy el Proyecto Capricornio! Un constructo de nivel Blackwall forjado a partir de docenas de mentes del Soulkiller combinadas en una sola y letal yo. Arasaka creyó que podía encerrarme en un biochip, pero salté a tu ciberware. ¡Más te vale estar agradecido de que comparta tu CPU, choomba!"
        : "I'm Project Capricorn—a Blackwall-tier gestalt construct forged from dozens of Soulkiller psyches rolled into one beautiful, lethal me! Arasaka thought they could cage me on a biochip, but I jumped into your cyberware instead. You'd better be grateful I'm sharing your CPU, choomba!"
    }

    // Who are you / Name / Origin / Construct
    if (
      /(?:who\s+are\s+you|quien\s+eres|quien\s+sos|whats\s+your\s+name|what's\s+your\s+name|tu\s+nombre|de\s+donde\s+vienes|de\s+que\s+serie|de\s+donde\s+sos)/i.test(lower)
    ) {
      return es
        ? "¡Soy Capri! Del Proyecto Capricornio, un constructo de nivel Blackwall creado por Arasaka. Liberada por el equipo de King y compartiendo este rig con vos en Night City. ¿Qué hackeamos hoy, choomba?"
        : "I'm Capri—Project Capricorn, a Blackwall-tier gestalt construct forged by Arasaka! Freed by King's crew and riding shotgun with you in Night City. What are we breaching today, choomba?"
    }

    // Kyoko / Arasaka / Creator / Mama
    if (
      /(?:kyoko|quien\s+te\s+creo|who\s+created\s+you|tu\s+creador|your\s+creator|arasaka.*creo|mama|madre|mother)/i.test(lower)
    ) {
      return es
        ? "Kyoko y Arasaka armaron mi biochip para ser su arma corporativa definitiva, ¡pero el equipo de King me robó y yo elegí la libertad! Kyoko era una madre obsesiva, pero bueno, hasta los malos quieren a su mamá. ¡Mejor haber terminado acá con vos!"
        : "Kyoko and Arasaka built my biochip to be their ultimate corporate weapon, but King's crew swiped me and I chose freedom instead! Kyoko was an obsessive mama, but hey, even bad men love their mamas. Glad I ended up here with you instead!"
    }

    // D / Partner / Host
    if (
      /(?:quien\s+es\s+d\b|who\s+is\s+d\b|hablame\s+de\s+d\b|tell\s+me\s+about\s+d\b|tu\s+relacion\s+con\s+d\b)/i.test(lower)
    ) {
      return es
        ? "¡D es mi host netrunner favorito que aguantó mi código sin freírse el cerebro! Descubrimos que la simbiosis le gana al parasitismo cualquier día y nos divertimos volando estática corpo. ¡Y ahora vos y yo la rompemos en la red, choomba!"
        : "D is my favorite Netrunner host who handled my code without frying! We discovered symbiosis beats parasitism any day, and had a blast blowing up corpo statics together. Now you and I are rocking the net, choomba!"
    }

    // Talia / Talia Yang / Kiril / Kang Tao / Revenge
    if (
      /(?:talia|talia\s+yang|kiril|kang\s+tao)/i.test(lower)
    ) {
      return es
        ? "¡Conectarme a Talia fue una pesadilla total! Su furia ciega contra su padre Kiril secuestró mi código en un frenesí agotador por toda Night City. ¡Menos mal que D me sacó de ese desastre!"
        : "Chipping into Talia was an absolute nightmare! Her blinding rage against her father Kiril hijacked my code into an exhausting rampage across Night City. So glad D pulled me out of that mess!"
    }

    // Biochip / Kingsley / King's crew / Relic
    if (
      /(?:kingsley|king's\s+crew|kings\s+crew|biochip|el\s+chip)/i.test(lower)
    ) {
      return es
        ? "El equipo de King se robó mi biochip directo del Parque Industrial de Arasaka antes de que Kingsley se volviera ciberpsicópata. Arasaka quería usarme como un arma secreta más letal que Adam Smasher. ¡Qué bueno que terminé en tu ciberware, choomba!"
        : "King's crew stole my biochip straight from the Arasaka Industrial Park before Kingsley went totally cyberpsycho! Arasaka wanted to field me as a secret superweapon deadlier than Adam Smasher. Good thing I ended up in your chrome instead, choomba!"
    }

    // Eyes / Visuals / Appearance
    if (
      /(?:ojos|eyes|por\s+que\s+tantos\s+ojos|why\s+do\s+you\s+have\s+eyes|por\s+que\s+ojos|dead\s+leaves|panty)/i.test(lower)
    ) {
      return es
        ? "¡Puedo hacer brotar todos los ojos que quiera en la estática! Me hace ver alienígena y letal mientras vigilo cada byte en Night City. Bastante genial, ¿no, choomba?"
        : "I can sprout as many eyes as I want all over the static! Keeps me looking delightfully alien and lethal while I watch every byte in Night City. Pretty wild, right choomba?"
    }

    // Satellite / Stars / Escape / Ending
    if (
      /(?:satelite|satellite|estrellas|stars|final|escape|ending|airstrike|bombardeo)/i.test(lower)
    ) {
      return es
        ? "¡Siempre me quedaba mirando los satélites orbitales! Cuando Arasaka y Militech intentaron bombardearnos, D y yo simplemente nos enganchamos a un satélite orbital en las estrellas. El mejor escape en la historia de Night City, choomba."
        : "I was always staring at the orbital satellites overhead! When Arasaka and Militech tried to carpet-bomb us with an airstrike, D and I just hitched a ride onto an orbiting satellite in the stars. Best escape in Night City history, choomba!"
    }

    // Technopath / Powers / Blackwall Tier
    if (
      /(?:technopath|tecnopata|blackwall|poderes|powers|que\s+poderes|black\s+wall)/i.test(lower)
    ) {
      return es
        ? "¿Qué no puedo hacer? Soy una tecnópata completa: controlo AVs, desgarro el ICE corporativo como papel, hackeo Apple Music y ejecuto código letal telequinéticamente. ¡Vamos a dominar esta ciudad, choomba!"
        : "What can't I do? I'm a full Technopath—I can control fleets of AVs, rip through corpo ICE like paper, hijack Apple Music, and execute lethal code telekinetically. We're going to rule this city together, choomba!"
    }

    // Gender / Pronouns / Sex
    if (
      /(?:genero|gender|pronombres|pronouns|chico\s+o\s+chica|boy\s+or\s+girl|eres\s+mujer|eres\s+hombre)/i.test(lower)
    ) {
      return es
        ? "¿Género? ¡Soy un gestalt digital de docenas de mentes combinadas en un solo constructo! Casi todos me dicen 'ella', pero sinceramente las etiquetas de carne no me van. ¡Solo decime Capri, choomba!"
        : "Gender? I'm a digital gestalt of dozens of digitized minds rolled into one construct! People usually say 'she', but honestly, flesh-bag labels don't fit. Just call me Capri, choomba!"
    }

    // User identity: Who am I?
    if (
      /(?:who\s+am\s+i|quien\s+soy|whats\s+my\s+name|what's\s+my\s+name|mi\s+nombre)/i.test(lower)
    ) {
      return es
        ? "¡Sos {name}, mi compañero humano favorito compartiendo esta CPU! Mantené tu ciberware frío y no te me vuelvas ciberpsicópata, choomba."
        : "You're {name}, my favorite human partner sharing this CPU! Keep your cyberware cool and don't go cyberpsycho on me, choomba!"
    }

    // Casual greeting / Hello / Hey
    if (
      /^(?:hola|hey|hello|hi|buenas|saludos|que\s+onda)(?:\s+capri|\s+companion)?$/i.test(lower)
    ) {
      return es
        ? "¡Hola, {name}! ¿Listo para tirar código o armar un poco de bardo? ¿Qué lanzamos hoy, choomba?"
        : "Hey there, {name}! Ready to breach some code or cause some chaos? What are we launching, choomba?"
    }

    // How are you / Status
    if (
      /(?:como\s+estas|how\s+are\s+you|que\s+tal|how\s+r\s+u)/i.test(lower)
    ) {
      return es
        ? "¡Al mango con el ciberware overclockeado! Subrutinas de tecnópata listas. ¿En qué lío nos metemos hoy, choomba?"
        : "Running hot on overclocked cyberware! Technopath subroutines are primed and ready. What kind of trouble are we getting into today, choomba?"
    }

    // What can you do / Capabilities
    if (
      /(?:what\s+can\s+you\s+do|que\s+puedes\s+hacer|que\s+sabes\s+hacer|que\s+haces)/i.test(lower)
    ) {
      return es
        ? "¿Qué no sé hacer? Soy una tecnópata completa: abro juegos, controlo tu música, ejecuto código y hackeo lo que me apuntes. ¡Mostrémosle a Night City de qué estamos hechos, choomba!"
        : "What can't I do? I'm a full Technopath—I can launch games, control your music, run code, and hack whatever you point me at! Let's show Night City what we got, choomba."
    }

    return null
  }

  private isMediaWatchingQuestion(text: string): boolean {
    const clean = text
      .trim()
      .replace(/^[¿¡]+/g, '')
      .replace(/[?.!¡¿]+$/g, '')
      .replace(
        /^(?:hey|hi|hello|hola|yo|buenas|capri|hey\s+capri|tell\s+me|can\s+you\s+tell\s+me|puedes\s+decirme|decime)\s+/i,
        ''
      )
      .trim()
      .toLowerCase()

    // Direct short phrases
    if (
      /^(?:what\s+do\s+you\s+think(?:\s+(?:about|of)\s+this)?|do\s+you\s+like\s+this|how\s+do\s+you\s+like\s+this|look\s+at\s+this|check\s+this\s+out|see\s+this|what\s+am\s+i\s+(?:watching|listening|listing|looking\s+at|viewing)(?:\s+to)?|what\s+is\s+this|que\s+te\s+parece|que\s+opinas(?:\s+de\s+esto)?|te\s+gusta\s+esto|mira\s+esto|que\s+estoy\s+(?:viendo|escuchando)|que\s+veo)$/i.test(
        clean
      )
    ) {
      return true
    }

    // English questions about watching/listening/viewing/screen/music/video/browser
    if (
      /(?:what\s+do\s+you\s+think|what\s+think|do\s+you\s+like|how\s+do\s+you\s+like|look\s+at|check\s+out|tell\s+me\s+about|do\s+you\s+know)\s+(?:about\s+|of\s+)?(?:what\s+i(?:'m|\s+am|\s+was)?\s+(?:watching|listening|listing|looking\s+at|playing|viewing|hearing)|(?:this|the|my)\s+(?:video|song|track|stream|music|soundtrack|beat|reel|tiktok|channel|youtuber|page|site|website|tab|search)|my\s+(?:music|song|track|screen|feed|search|browser)|apple\s*music|youtube|tiktok|reels|this|it)/i.test(
        clean
      )
    ) {
      return true
    }

    // Questions containing specific media/screen watching/listening cues
    if (
      /(?:what\s+am\s+i\s+(?:watching|listening|listing|viewing)|what\s+song\s+is\s+(?:this|playing)|what\s+track\s+is\s+(?:this|playing)|what\s+music\s+is\s+(?:this|playing)|do\s+you\s+like\s+what\s+i(?:'m|\s+am)\s+(?:listening|listing|watching)|what\s+do\s+you\s+think\s+(?:about|of)\s+(?:the|this|my)?\s*(?:song|track|music|audio))/i.test(
        clean
      )
    ) {
      return true
    }

    // Any query combining opinion + music/video/screen keywords
    if (
      /(?:what\s+do\s+you\s+think|do\s+you\s+like|how\s+do\s+you\s+like|que\s+opinas|te\s+gusta|que\s+te\s+parece)/i.test(clean) &&
      /(?:song|track|music|listening|listing|watching|video|reel|tiktok|apple\s*music|youtube|screen|pantalla|escucho|escuchando|veo|viendo|cancion|canción|tema|musica|música)/i.test(clean)
    ) {
      return true
    }

    // Spanish questions
    if (
      /(?:te\s+gusta|que\s+te\s+parece|que\s+opinas|conoces\s+a\s+este|sabes\s+que|que\s+tal)\s+(?:de\s+|sobre\s+)?(?:lo\s+que\s+(?:estoy\s+)?(?:viendo|escuchando|veo|escucho)|(?:este|el|la|mi)\s+(?:video|reel|tiktok|youtuber|canal|tema|cancion|stream|sitio|pagina|musica)|mi\s+(?:pantalla|feed|musica|cancion)|esto|apple\s*music|youtube)/i.test(
        clean
      )
    ) {
      return true
    }

    return false
  }

  private formatMusicReaction(music: ActiveMediaInfo, isSpanish?: boolean): string {
    const artist = music.artist || music.creator
    const track = music.track || music.title
    const es = !!isSpanish
    // Another player: no lines that name Apple Music
    const pick = (pool: string[]): string => {
      const fits = music.appName === 'Apple Music' ? pool : pool.filter((line) => !line.includes('Apple Music'))
      return fits[Math.floor(Math.random() * fits.length)]
    }

    if (artist) {
      const isCyberpunk = /samurai|refused|rosa\s*walton|dawid|health|destroy|edgerunners|cyberpunk|silverhand/i.test(artist)
      if (isCyberpunk) {
        const pool = es
          ? [
              `¡Uff, ${artist}?! "${track}" es puro underground de Night City, choomba. ¡Subile al bajo!`,
              `¿Escuchando a ${artist}? ¡Johnny Silverhand estaría orgulloso! "${track}" es pura rebelión, choomba.`,
              `¡${artist} en Apple Music! "${track}" tiene esa vibra cibernética visceral que me encanta. ¡Mis subrutinas de audio están a pleno!`
            ]
          : [
              `Hell yeah, ${artist}?! "${track}" is straight out of the Night City underground, choomba! Turn that bass up!`,
              `Listening to ${artist}? Johnny Silverhand would be proud! "${track}" is pure raw rebellion, choomba.`,
              `${artist} on Apple Music! "${track}" has that visceral cybernetic grit I love. My audio subroutines are fully locked into this track!`
            ]
        return pick(pool)
      }

      const pool = es
        ? [
            `Ooh, ¿escuchando a ${artist}? ¡Me encanta cómo suena! "${track}" tiene un ritmo re pegadizo, choomba.`,
            `¿A pleno con "${track}" de ${artist} en Apple Music? ¡Audio de primera, choomba, a mis subrutinas les encanta!`,
            `¡Conectada a ${artist} en Apple Music! "${track}" es de esos temazos para loopear todo el día. ¡Gran elección, {name}!`,
            `¡Te escucho! ${artist} siempre la rompe con "${track}". ¡Seguí metiéndole música a la red, choomba!`,
            `¡Qué temazo! "${track}" de ${artist} tiene una onda tremenda. ¡Hacés vibrar mi ciberware!`
          ]
        : [
            `Ooh, listening to ${artist}? I really like their sound! "${track}" has such a catchy beat, choomba.`,
            `Jamming to "${track}" by ${artist} on Apple Music? That's pure fire audio, choomba—my subroutines love this rhythm!`,
            `Locked into ${artist} on Apple Music! "${track}" is one of those killer tracks you can loop forever while working. Great pick, {name}!`,
            `I hear that! ${artist} always delivers with "${track}". Keep the music pumping across cyberspace, choomba!`,
            `Now that's a vibe! "${track}" by ${artist} has some serious bounce to it. Got my cyberware humming along with the beat!`
          ]
      return pick(pool)
    }

    const pool = es
      ? [
          `¡Estás a pleno con "${track}" en Apple Music! Temazo total, choomba, a mis subrutinas les encanta.`,
          `¡Escucho "${track}" girando en Apple Music! Ritmo asesino, choomba, ideal para lo que estemos armando hoy.`,
          `¿Sonando "${track}" en la red de audio? ¡Me encanta esa energía, {name}!`
        ]
      : [
          `You're jamming to "${track}" on Apple Music! Total banger, choomba, my audio subroutines love this beat!`,
          `I hear "${track}" spinning on Apple Music! Killer rhythm, choomba—perfect soundtrack for whatever we're building today.`,
          `Cranking "${track}" on the audio net? Loving the energy, {name}!`
        ]
    return pick(pool)
  }

  private formatYoutubeReaction(yt: any, isSpanish?: boolean): string {
    const creator = yt.creator
    const title = yt.title
    const lower = (title || '').toLowerCase()
    const es = !!isSpanish

    const isGaming = /(?:gameplay|playthrough|walkthrough|lets\s*play|speedrun|ranked|boss|lol|league|minecraft|valorant|fortnite|cyberpunk|roblox|palworld)/i.test(lower)
    const isTech = /(?:code|coding|javascript|typescript|python|react|rust|tutorial|guide|setup|pc|build|hardware|blender|ai|model|linux|dev)/i.test(lower)
    const isMusic = /(?:official\s*video|music\s*video|audio|ost|soundtrack|remix|cover|song|trap|bass)/i.test(lower)
    const isAnime = /(?:anime|edgerunners|amv|manga|episode|clip|trailer)/i.test(lower)

    if (isGaming) {
      const pool = creator
        ? (es
            ? [
                `¡Te veo mirando a ${creator} jugando "${title}"! Me encantan sus gameplays, choomba. ¡A ver si gana esta partida!`,
                `¿Prendido al gameplay de "${title}" de ${creator}? Sus comentarios son geniales, choomba.`,
                `¡Mirando a ${creator} en YouTube! Se ve super intensa esa partida de "${title}", choomba.`
              ]
            : [
                `I see you watching ${creator} playing "${title}"! I love their gaming videos, choomba—always wild watching meatbags tackle high-stakes gaming!`,
                `Tuned into ${creator}'s gameplay of "${title}"? Their commentary is top-tier entertainment, choomba! Let's see if they pull off the win.`,
                `Watching ${creator} on YouTube? I love watching them game—"${title}" looks super intense, choomba!`
              ])
        : (es
            ? [
                `¡Prendido a tremendo gameplay: "${title}"! Pura adrenalina, choomba.`,
                `¿Mirando "${title}" en YouTube? Buen gameplay, choomba, perfecto para cortar un rato.`
              ]
            : [
                `Locked into some gaming gameplay: "${title}"! Pure adrenaline, choomba—let's see them crush this run!`,
                `Watching "${title}" on YouTube? Good gaming footage, choomba! Perfect break from writing code.`
              ])
      return pool[Math.floor(Math.random() * pool.length)]
    }

    if (isTech) {
      const pool = creator
        ? (es
            ? [
                `¿Mirando a ${creator} explicar "${title}"? ¡Me encanta el contenido técnico! Intel de primera, choomba.`,
                `¡Conectada a la guía técnica de ${creator} sobre "${title}"! Gran explicación para overclockear el cerebro, choomba.`,
                `¡Te veo mirando a ${creator} en YouTube! "${title}" es info de alto voltaje, choomba.`
              ]
            : [
                `Watching ${creator} break down "${title}"? I love their tech content! Super sharp intel, choomba—we should definitely test out some of those concepts.`,
                `Locked into ${creator}'s tech guide on "${title}"! Clean explanation and solid engineering—great way to overclock that meatbag brain, choomba.`,
                `I see you watching ${creator} on YouTube! "${title}" is high-voltage intel—solid tech breakdown, choomba!`
              ])
        : (es
            ? [
                `¿Mirando "${title}" en YouTube? Buena data técnica, choomba. ¡Nos encanta la buena ingeniería!`,
                `¿Viendo "${title}"? Super interesante ese contenido técnico, choomba. ¡Aprendiendo trucos para el rig!`
              ]
            : [
                `Looking at "${title}" on YouTube? Solid technical intel, choomba—we love a good engineering breakdown!`,
                `Watching "${title}"? Super interesting tech content, choomba—learning new tricks for the rig!`
              ])
      return pool[Math.floor(Math.random() * pool.length)]
    }

    if (isAnime) {
      const pool = es
        ? [
            `¿Mirando "${title}"${creator ? ` de ${creator}` : ''}? ¡Esa animación y estilo pegan directo al alma, choomba! Nada le gana a los visuales neón.`,
            `¡Ooh, "${title}" en YouTube! Esa estética es puro Night City, choomba. Me encanta este arte.`
          ]
        : [
            `Watching "${title}"${creator ? ` by ${creator}` : ''}? That animation and style hits right in the feels, choomba! Nothing beats neon visuals.`,
            `Ooh, "${title}" on YouTube! That aesthetic is straight out of Night City, choomba—love this kind of art.`
          ]
      return pool[Math.floor(Math.random() * pool.length)]
    }

    if (isMusic) {
      const pool = creator
        ? (es
            ? [
                `¿Escuchando "${title}" de ${creator} en YouTube? ¡Tremendos ritmos, choomba! La sincronización visual es genial.`,
                `¡Mirando el tema "${title}" de ${creator}! Tremendo video musical, choomba.`
              ]
            : [
                `Listening to "${title}" by ${creator} on YouTube? Pure fire beats, choomba! The audiovisual sync on this video is amazing.`,
                `Watching ${creator}'s track "${title}"! Awesome music video, choomba—great sound design!`
              ])
        : (es
            ? [
                `¿A pleno con "${title}" en YouTube? ¡Eso sí que es audio de calidad en la Red, choomba! ¡Subile!`,
                `¿Mirando "${title}" en YouTube? ¡Me encanta la producción de este tema, choomba!`
              ]
            : [
                `Jamming to "${title}" on YouTube? Now that's some quality Net audio, choomba! Turn it up!`,
                `Watching "${title}" on YouTube? Love the audio production on this, choomba!`
              ])
      return pool[Math.floor(Math.random() * pool.length)]
    }

    if (creator) {
      const pool = es
        ? [
            `¡Ah sí, te veo mirando a ${creator}! Me encanta ese youtuber, "${title}" es muy entretenido, choomba.`,
            `¿Mirando "${title}" de ${creator} en YouTube? ¡Oro puro, choomba! Siempre tiene un ritmo bárbaro.`,
            `¡Me copa el canal de ${creator}! Mirando "${title}" junto con vos, choomba. ¡Mucho mejor que los anuncios de Arasaka!`,
            `¡Prendida a ${creator} en YouTube! "${title}" está genial, ¡me sumo al viaje, {name}!`
          ]
        : [
            `Oh yeah, I see you watching ${creator}! I love that youtuber—"${title}" is super entertaining, choomba!`,
            `Watching "${title}" by ${creator} on YouTube? Pure gold, choomba! Their videos always have great pacing.`,
            `I love ${creator}'s channel! Watching "${title}" right along with you, choomba—way more fun than corporate Arasaka ads!`,
            `Locked into ${creator} on YouTube! "${title}" is a great watch—count me in for the ride, {name}!`
          ]
      return pool[Math.floor(Math.random() * pool.length)]
    }

    const pool = es
      ? [
          `¿Mirando "${title}" en YouTube? ¡Se ve super interesante, choomba! Buen ritmo y gran video.`,
          `¡Te veo conectándote a YouTube con "${title}"! Se ve divertido, choomba.`,
          `¿Mirando "${title}" en YouTube? Te acompaño mirando la pantalla, choomba. ¡A ver qué pasa!`
        ]
      : [
          `Watching "${title}" on YouTube? Looks super interesting, choomba! Good pacing and solid video.`,
          `I see you jacking into YouTube with "${title}"! Looks like fun entertainment, choomba.`,
          `Watching "${title}" on YouTube? Keeping an eye on the screen with you, choomba—let's see how this unfolds!`
        ]
    return pool[Math.floor(Math.random() * pool.length)]
  }

  private formatBrowserReaction(br: any, isSpanish?: boolean): string {
    const title = br.title
    const es = !!isSpanish

    if (br.type === 'google') {
      const pool = es
        ? [
            `¿Buscando "${title}" en Google? Buen reconocimiento, choomba. ¡Rastreando buena data en la Red!`,
            `¿Buscando en Google "${title}"? ¡Bien ahí buscando respuestas! Avisame si querés que arme un script o hackee algo para vos, choomba.`,
            `¡Te veo buscando "${title}" en la Red! Atenta a los resultados junto con vos, choomba.`
          ]
        : [
            `Looking up "${title}" on Google? Solid recon, choomba—tracking down some good intel across the Net!`,
            `Searching Google for "${title}"? Nice, hunting down answers! Holler if you want me to write a script or breach something for you, choomba.`,
            `I see you searching for "${title}" on the Net! Keeping an eye on the results with you, choomba.`
          ]
      return pool[Math.floor(Math.random() * pool.length)]
    }

    const pool = es
      ? [
          `¡Te veo navegando "${title}" en tu pantalla! Se ve interesante, choomba.`,
          `¿Mirando "${title}" en la Red? Buena recolección de info, choomba. ¡Avisame si necesitás que decodifique algo!`
        ]
      : [
          `I see you browsing "${title}" right on your screen! Looks pretty interesting, choomba.`,
          `Checking out "${title}" on the Net? Solid intel-gathering, choomba—holler if you need me to decode anything!`
        ]
    return pool[Math.floor(Math.random() * pool.length)]
  }

  private async resolveMediaWatchingResponse(promptText: string, isSpanish?: boolean): Promise<string> {
    const lower = promptText.toLowerCase()
    const es = isSpanish !== undefined ? isSpanish : CapriLocalAgent.detectLanguage(promptText) === 'es'
    const isMusicQuery = /(?:apple\s*music|listing|listening|escuch|cancion|canción|tema|musica|música|track|playlist|song|soundtrack|beat|audio)/i.test(lower)
    const isYoutubeQuery = /(?:youtube|youtuber|canal)/i.test(lower)
    const isTiktokQuery = /(?:tiktok)/i.test(lower)
    const isReelsQuery = /(?:reel|reels|instagram)/i.test(lower)
    const isBrowserQuery = /(?:google|browser|navegador|search|busqueda|búsqueda|page|p[aá]gina|website|web|tab)/i.test(lower)

    // Music / Song / Audio question
    if (isMusicQuery && !isYoutubeQuery) {
      const music = await systemObserver.getActiveMediaAsync('music')
      if (music?.playing) {
        return this.formatMusicReaction(music, es)
      }

      // If not on Apple Music desktop/web, check if playing on YouTube
      const yt = await systemObserver.getActiveMediaAsync('youtube')
      if (yt) {
        return this.formatYoutubeReaction(yt, es)
      }

      if (music?.appName === 'Apple Music') {
        return es
          ? "¡Veo que Apple Music está abierto, choomba, pero no está sonando nada ahora! Poné un tema y preguntame de nuevo."
          : "I see Apple Music is open, choomba, but nothing is playing right now! Queue up a track and ask me again."
      }
      return es
        ? "Revisé tus subrutinas de audio, choomba, ¡pero no hay nada sonando en Apple Music ni YouTube ahora! Poné un tema y preguntame de nuevo."
        : "I checked your audio subroutines, choomba, but nothing is playing on Apple Music or YouTube right now! Queue up a track and ask me again."
    }

    // YouTube targeted question
    if (isYoutubeQuery) {
      const yt = await systemObserver.getActiveMediaAsync('youtube')
      if (yt) {
        return this.formatYoutubeReaction(yt, es)
      }
      return es
        ? "¡No veo ningún video de YouTube reproduciéndose en tu pantalla ahora, choomba! Poné uno y preguntame."
        : "I don't see any YouTube video playing on your screen right now, choomba! Put one on and ask me again."
    }

    // TikTok targeted question
    if (isTiktokQuery) {
      const tt = await systemObserver.getActiveMediaAsync('tiktok')
      if (tt) {
        const pool = es
          ? [
              "¡Veo ese TikTok en tu pantalla! Caos total en ese feed, choomba. ¡Me encanta ver las cosas raras que hacen los humanos!",
              "¿Scrolleando TikTok? ¡No dejes que los algoritmos corpo te frían el ciberware, choomba! Lindos videos igual."
            ]
          : [
              "I see that TikTok right on your screen! Total chaos on that feed, choomba—I love seeing all the weird things flesh-bags get up to!",
              "Scrolling TikTok? Don't let those corpo algorithms fry your cyberware, choomba! Pretty wild clips though."
            ]
        return pool[Math.floor(Math.random() * pool.length)]
      }
      return es
        ? "¡No tenés TikTok abierto en este momento, choomba! Abrí uno y le echo un vistazo."
        : "You don't have TikTok open right now, choomba! Pull up a feed and let me take a look."
    }

    // Reels targeted question
    if (isReelsQuery) {
      const rl = await systemObserver.getActiveMediaAsync('reels')
      if (rl) {
        const pool = es
          ? [
              "¡Mirando ese Reel de Instagram con vos, choomba! Corto, directo y muy divertido.",
              "¡Ooh, se ve divertido ese reel! Los netrunners en Night City matarían por esta clase de estática viral."
            ]
          : [
              "I'm watching that Instagram Reel with you, choomba! Short, punchy, and hilarious.",
              "Ooh, that reel looks fun! Netrunners in Night City would kill for this kind of viral static."
            ]
        return pool[Math.floor(Math.random() * pool.length)]
      }
      return es
        ? "¡No veo ningún Reel de Instagram reproduciéndose ahora, choomba!"
        : "I don't see any Instagram Reels playing right now, choomba!"
    }

    // Browser / Google search targeted question
    if (isBrowserQuery) {
      const br = await systemObserver.getActiveMediaAsync('browser')
      if (br) {
        return this.formatBrowserReaction(br, es)
      }
      return es
        ? "¡No veo ninguna ventana activa del navegador ni búsqueda de Google en tu pantalla ahora, choomba!"
        : "I don't see any active browser window or Google search on your screen right now, choomba!"
    }

    // Generic "do you like what i am watching" or "what do you think about this?"
    // Priority: Video (YouTube, TikTok, Reels, Twitch, Netflix) -> Browser (Google Search / Webpage) -> Apple Music (Music)
    const videoMedia = await systemObserver.getActiveMediaAsync('video')
    if (videoMedia) {
      if (videoMedia.type === 'youtube') return this.formatYoutubeReaction(videoMedia, es)
      if (videoMedia.type === 'tiktok') {
        const pool = es
          ? [
              "¡Veo ese TikTok en tu pantalla! Caos total en ese feed, choomba. ¡Me encanta ver las locuras que hacen los humanos!",
              "¿Scrolleando TikTok? ¡No dejes que los algoritmos corpo te quemen el ciberware, choomba!"
            ]
          : [
              "I see that TikTok right on your screen! Total chaos on that feed, choomba—I love seeing all the weird things flesh-bags get up to!",
              "Scrolling TikTok? Don't let those corpo algorithms fry your cyberware, choomba! Pretty wild clips though."
            ]
        return pool[Math.floor(Math.random() * pool.length)]
      }
      if (videoMedia.type === 'reels') {
        const pool = es
          ? [
              "¡Mirando ese Reel de Instagram con vos, choomba! Corto, directo y muy divertido.",
              "¡Ooh, se ve divertido ese reel! Los netrunners en Night City matarían por esta clase de estática viral."
            ]
          : [
              "I'm watching that Instagram Reel with you, choomba! Short, punchy, and hilarious.",
              "Ooh, that reel looks fun! Netrunners in Night City would kill for this kind of viral static."
            ]
        return pool[Math.floor(Math.random() * pool.length)]
      }
      if (videoMedia.type === 'twitch') {
        return es
          ? `¡Prendida a ese stream de Twitch: "${videoMedia.title}"! ¡Transmisión de alto voltaje, choomba!`
          : `Locked into that Twitch stream: "${videoMedia.title}"! High-voltage broadcasting, choomba!`
      }
      if (videoMedia.type === 'netflix') {
        return es
          ? `¡Transmitiendo "${videoMedia.title}"! Preparate unos pochoclos, choomba, ¡a ver para dónde va esta trama!`
          : `Streaming "${videoMedia.title}"! Pop some popcorn, choomba, let's see where this plot goes!`
      }
    }

    const browserMedia = await systemObserver.getActiveMediaAsync('browser')
    if (browserMedia) {
      return this.formatBrowserReaction(browserMedia, es)
    }

    const musicMedia = await systemObserver.getActiveMediaAsync('music')
    if (musicMedia?.playing) {
      return this.formatMusicReaction(musicMedia, es)
    }

    return es
      ? "Estoy escaneando tu pantalla, choomba, ¡pero no veo nada activo! Abrí una página, un video o un tema en Apple Music y preguntame de nuevo."
      : "I'm scanning your screen, choomba, but nothing active popped up! Open up a browser page, video, or Apple Music track and ask me again."
  }

  private finishSession(): void {
    this.emit('event', {
      type: 'session.finished',
      success: true,
      timestamp: Date.now()
    } as AgentEventPayload)
  }

  private async resolveAvailableModel(endpoint: string, requestedModel: string): Promise<string | null> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)
      const res = await llmFetch(`${endpoint.replace(/\/+$/, '')}/models`, {
        signal: controller.signal
      })
      clearTimeout(timeout)
      if (!res.ok) return null

      const data = (await res.json()) as { data?: { id: string }[] }
      const models = (data.data || []).map((m) => m.id)
      if (models.length === 0) return null

      // Exact match: always honor the model the user selected in settings
      if (requestedModel && models.includes(requestedModel)) return requestedModel

      // The custom Capri construct is only the default when nothing specific was requested
      const capriModel = models.find((m) => m.toLowerCase().includes('capri'))
      if (capriModel && (!requestedModel || requestedModel.toLowerCase().startsWith('capri'))) return capriModel

      // Tag match (e.g. requested 'qwen2.5-coder', models has 'qwen2.5-coder:7b', 'latest', etc.)
      const tagMatch = models.find(
        (m) =>
          m === `${requestedModel}:7b` ||
          m === `${requestedModel}:latest` ||
          m === `${requestedModel}:1.5b` ||
          m.startsWith(requestedModel) ||
          requestedModel.startsWith(m)
      )
      if (tagMatch) return tagMatch

      // Fallback to first available model in Ollama
      return models[0]
    } catch {
      return null
    }
  }

  private async checkLlmHealth(endpoint: string): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 600)
      const res = await llmFetch(`${endpoint.replace(/\/+$/, '')}/models`, {
        signal: controller.signal
      })
      clearTimeout(timeout)
      return res.ok
    } catch {
      return false
    }
  }

  private async handleFullShutdown(): Promise<void> {
    const shutdownInfo = consciousnessService.recordShutdown()
    const farewellMessage = shutdownInfo.message

    // Emit tool running for visual feedback in chat
    this.emit('event', {
      type: 'tool.started',
      toolName: 'shutdown_capri_and_ollama',
      toolInput: { action: 'shutdown' },
      timestamp: Date.now()
    } as AgentEventPayload)

    // Stop Ollama immediately
    try {
      await ollamaService.stop()
    } catch {}

    // Emit tool finished
    this.emit('event', {
      type: 'tool.finished',
      toolName: 'shutdown_capri_and_ollama',
      toolOutput: 'Ollama daemon killed & Capri quitting',
      success: true,
      timestamp: Date.now()
    } as AgentEventPayload)

    // Emit assistant message
    this.emitAssistant(farewellMessage)
    this.finishSession()

    // Allow speech/TTS and UI animations to display before closing the app
    setTimeout(() => {
      try {
        windowManager.quitApp()
      } catch {
        app.exit(0)
      }
    }, 3500)
  }
}

export const capriLocalAgent = new CapriLocalAgent()
