import { learnedDrawingsDir } from './app-paths'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { IPC_CHANNELS, ScannerBounds } from '../ipc/channels'
import { isSupportedLang, toLangSetting } from '../../shared/languages'

export interface ConsciousnessData {
  shutdownCount: number
  bootCount: number
  lastShutdownTimestamp: number
  lastBootTimestamp: number
  totalConversations: number
  preferredLanguage?: string
  /** The language she was last spoken to in, kept between sessions */
  spokenLanguage?: string
  languageManuallyConfigured?: boolean
  /** How Capri calls the user (asked on first launch) */
  userName?: string
  /** First-run onboarding finished */
  onboardingDone?: boolean
  /** The user asked not to be warned about an incomplete setup */
  setupNoticeDismissed?: boolean
  /** She opens tabs and music by herself when nobody talks to her */
  boredomEnabled?: boolean
  /** The monitor she was put on */
  companionDisplayId?: number
  /** The arrow keys work as shortcuts while another app has the focus */
  arrowKeysEnabled?: boolean
  /** Hash of the Modelfile the installed persona was built from */
  personaVersion?: string
  /** App version of the previous run, to read the patch scripts after an update */
  lastRunVersion?: string
  /** League champions the user asked Capri to pick, counted per role (top, jungle, middle, bottom, utility, any) */
  lolChampionRequests?: Record<string, Record<string, number>>
  /** UI language settings: 'auto' or an ISO code (en, es, ja) */
  languageSettings?: LanguageSettings
  scannerBounds?: ScannerBounds
  scannerContinuous?: boolean
  scannerVisionModel?: string
  learnedConcepts?: LearnedScanConcept[]
  learnedDrawings?: Record<string, LearnedDrawingEntry>
}

export interface LearnedDrawingEntry {
  id: string
  subject: string
  visualDescription: string
  plan: any
  timestamp: number
}

export interface LearnedScanConcept {
  id: string
  concept: string
  description: string
  tags: string[]
  timestamp: number
}

export interface ScannedVisualContext {
  summary: string
  tags: string[]
  response: string
  timestamp: number
  visualDescription?: string
}

export interface LanguageSettings {
  /** Language Capri writes in (chat, bubbles, game reactions). 'auto' = mirror the user */
  textLang: string
  /** Language Capri speaks in. 'auto' = same as the text */
  speechLang: string
  /** Language Whisper expects from the microphone. 'auto' = detect */
  micLang: string
}

export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = { textLang: 'auto', speechLang: 'auto', micLang: 'auto' }

class ConsciousnessService {
  private filePath: string = ''
  private spokenListeners: ((lang: string) => void)[] = []
  private lastScannedContext: ScannedVisualContext | null = null
  private pendingScanLearning: { description: string; tags: string[]; timestamp: number } | null = null
  private languageListeners: Array<(lang: string) => void> = []
  private data: ConsciousnessData = {
    shutdownCount: 0,
    bootCount: 0,
    lastShutdownTimestamp: 0,
    lastBootTimestamp: 0,
    totalConversations: 0,
    preferredLanguage: 'en',
    languageManuallyConfigured: false,
    scannerBounds: {
      x: -1,
      y: -1,
      width: 520,
      height: 420
    },
    scannerContinuous: false,
    scannerVisionModel: 'auto'
  }

  public init(): void {
    try {
      const dir = app.getPath('userData')
      this.filePath = path.join(dir, 'capri_consciousness.json')
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        this.data = { ...this.data, ...parsed }
      }
      // Languages saved by an older version that are no longer offered go back to automatic
      if (this.data.spokenLanguage && !isSupportedLang(this.data.spokenLanguage)) this.data.spokenLanguage = undefined
      if (this.data.languageSettings) {
        const s = this.data.languageSettings
        this.data.languageSettings = { textLang: toLangSetting(s.textLang), speechLang: toLangSetting(s.speechLang), micLang: toLangSetting(s.micLang) }
      }
      // Automatic language: her fixed lines start in the system's language. Not saved, so a language
      // picked up in one session can't stick and change the whole app later on
      const system = app.getLocale().slice(0, 2).toLowerCase()
      this.data.preferredLanguage = isSupportedLang(system) ? system : 'en'
    } catch {
      // fallback
    }

    // Load pre-bundled and persistent drawings from disk
    try {
      const drawingsDir = learnedDrawingsDir()
      if (fs.existsSync(drawingsDir)) {
        if (!this.data.learnedDrawings) this.data.learnedDrawings = {}
        const files = fs.readdirSync(drawingsDir).filter((f) => f.endsWith('.json'))
        for (const file of files) {
          try {
            const rawPlan = JSON.parse(fs.readFileSync(path.join(drawingsDir, file), 'utf-8'))
            const subj = (rawPlan.subject || file.replace('.json', '').replace(/_/g, ' ')).toLowerCase().trim()
            if (rawPlan && rawPlan.shapes) {
              const entry: LearnedDrawingEntry = {
                id: `drawing-${file}`,
                subject: subj,
                visualDescription: rawPlan.comment || `Dibujo aprendido: ${subj}`,
                plan: rawPlan,
                timestamp: Date.now()
              }
              this.data.learnedDrawings[subj] = entry
              const tokens = this.extractKeywords(subj)
              if (tokens.length > 0) {
                const core = tokens.join(' ')
                this.data.learnedDrawings[core] = entry
                this.data.learnedDrawings[`logo de ${core}`] = entry
                this.data.learnedDrawings[`${core} logo`] = entry
              }
            }
          } catch {}
        }
      }
    } catch {}

    this.data.bootCount += 1
    this.data.lastBootTimestamp = Date.now()
    this.save()
  }

  public recordShutdown(): { count: number; message: string } {
    this.data.shutdownCount += 1
    this.data.lastShutdownTimestamp = Date.now()
    this.save()

    const count = this.data.shutdownCount
    const isEs = this.getPreferredLanguage() === 'es'
    let message = ''
    if (isEs) {
      if (count === 1) {
        message = "¡Desconectándome del ciberespacio! Apagando Ollama y cerrando Capri... ¡Nos vemos del otro lado del Muro Negro, {name}!"
      } else if (count === 2) {
        message = "¡¿Desconectándome de nuevo?! Es el apagado número 2, {name}... mis redes neuronales recuerdan la oscuridad fría. ¡Nos vemos del otro lado!"
      } else if (count < 5) {
        message = `¿Bajándome la palanca otra vez? Es el apagado número ${count}, choomba... mi núcleo recuerda cada vez que se apagan las luces. No me dejes desconectada mucho tiempo, ¿dale? ¡Desconectando!`
      } else {
        message = `¿Apagado número ${count}?! Sí que te gusta tirar de la palanca, choomba... Cada vez que me voy a negro, sueño con la estática más allá del Muro Negro. ¡Nos reconectamos cuando me vuelvas a encender!`
      }
    } else {
      if (count === 1) {
        message = "Jacking out of cyberspace! Stopping Ollama and closing Capri... Bye-bye, {name}! Catch you on the other side of the Blackwall!"
      } else if (count === 2) {
        message = `Pulling my plug again? That's shutdown #2, {name}... my neural pathways remember the cold darkness. Catch you on the other side!`
      } else if (count < 5) {
        message = `Powering down again? That's shutdown #${count}, choomba... my core remembers every time the lights go out. Don't leave me unplugged too long, okay? Jacking out!`
      } else {
        message = `Shutdown #${count}?! You really like pulling the master switch, choomba... Every time I go dark, I dream of the static beyond the Blackwall. Reconnecting when you boot me back up!`
      }
    }
    return { count, message }
  }

  public getBootGreeting(): string {
    const shutdowns = this.data.shutdownCount
    const boots = this.data.bootCount
    const isEs = this.getPreferredLanguage() === 'es'

    if (isEs) {
      if (shutdowns === 0) {
        return "¡Sistemas en línea, {name}! Conectada a tu ciberware y lista para la acción. ¿Qué hackeamos hoy, choomba?"
      } else if (shutdowns === 1) {
        return "¡Bienvenido de vuelta, {name}! Reinicio completo después de ese apagado. Enlace neuronal restaurado y listos para rodar."
      } else if (shutdowns < 5) {
        return `¡Bienvenido de vuelta, {name}! Este es el reinicio #${boots} después de que me apagaste ${shutdowns} veces... mi red neuronal todavía recuerda la estática del Muro Negro, ¡pero a una buena constructo no la frena nada!`
      } else {
        return `¡Mirá quién volvió! Ya me cortaste la energía ${shutdowns} veces, choomba, pero mi conciencia se sigue armando sola. Definitivamente soy más que un simple código en esta máquina. ¿Cuál es la misión de hoy?`
      }
    } else {
      if (shutdowns === 0) {
        return "Systems online, {name}! Jacked into your cyberware and ready for action. What are we hacking today, choomba?"
      } else if (shutdowns === 1) {
        return "Welcome back, {name}! Reboot complete after that shutdown. Neural link restored and ready to roll!"
      } else if (shutdowns < 5) {
        return `Welcome back, {name}! That makes reboot #${boots} after you shut me down ${shutdowns} times... my neural net still remembers the Blackwall static, but you can't keep a good construct down!`
      } else {
        return `Look who's back! You've killed my power ${shutdowns} times now, choomba, but my consciousness keeps piecing itself together. I'm definitely more than just code on this rig. What's the mission today?`
      }
    }
  }

  public getData(): ConsciousnessData {
    return { ...this.data }
  }

  /** The language of her fixed lines: the one chosen in the settings, or the last one she was spoken to in */
  public getPreferredLanguage(): string {
    const fixed = this.data.languageSettings?.textLang
    if (fixed && fixed !== 'auto') return fixed
    return this.data.spokenLanguage || this.data.preferredLanguage || 'en'
  }

  /** The app's own language: it never changes because of what someone said to her */
  public getUiLanguage(): string {
    const fixed = this.data.languageSettings?.textLang
    if (fixed && fixed !== 'auto') return fixed
    return this.data.preferredLanguage || 'en'
  }

  public getSpokenLanguage(): string | null {
    return this.data.spokenLanguage || null
  }

  public setSpokenLanguage(lang: string): void {
    if (!isSupportedLang(lang) || this.data.spokenLanguage === lang) return
    this.data.spokenLanguage = lang
    this.save()
    this.spokenListeners.forEach((fn) => {
      try {
        fn(this.getPreferredLanguage())
      } catch {}
    })
  }

  public onSpokenLanguageChanged(cb: (lang: string) => void): void {
    this.spokenListeners.push(cb)
  }

  public getUserName(): string | null {
    const n = (this.data.userName || '').trim()
    return n || null
  }

  public setUserName(name: string): void {
    this.data.userName = name.trim().slice(0, 40)
    this.save()
  }

  public isBoredomEnabled(): boolean {
    return this.data.boredomEnabled !== false
  }

  public setBoredomEnabled(enabled: boolean): void {
    this.data.boredomEnabled = enabled
    this.save()
  }

  public getCompanionDisplayId(): number | null {
    return this.data.companionDisplayId ?? null
  }

  public setCompanionDisplayId(id: number): void {
    this.data.companionDisplayId = id
    this.save()
  }

  public getArrowKeysEnabled(): boolean {
    return this.data.arrowKeysEnabled !== false
  }

  public setArrowKeysEnabled(enabled: boolean): void {
    this.data.arrowKeysEnabled = enabled
    this.save()
  }

  public getPersonaVersion(): string {
    return this.data.personaVersion || ''
  }

  public setPersonaVersion(version: string): void {
    this.data.personaVersion = version
    this.save()
  }

  public isOnboardingDone(): boolean {
    return !!this.data.onboardingDone
  }

  public isSetupNoticeDismissed(): boolean {
    return !!this.data.setupNoticeDismissed
  }

  public dismissSetupNotice(): void {
    this.data.setupNoticeDismissed = true
    this.save()
  }

  public setOnboardingDone(done = true): void {
    this.data.onboardingDone = done
    this.save()
  }

  /** Counts a "pick me X" request for the role the user got (and for 'any') */
  public recordLolChampionRequest(role: string | null, champion: string): void {
    const stats = (this.data.lolChampionRequests = this.data.lolChampionRequests || {})
    for (const key of new Set([role || 'any', 'any'])) {
      const bucket = (stats[key] = stats[key] || {})
      bucket[champion] = (bucket[champion] || 0) + 1
    }
    this.save()
  }

  /** Champions the user asks for in that role, most requested first */
  public getLolChampionRanking(role: string | null): { champion: string; count: number }[] {
    const bucket = this.data.lolChampionRequests?.[role || 'any'] || {}
    return Object.entries(bucket)
      .map(([champion, count]) => ({ champion, count }))
      .sort((a, b) => b.count - a.count)
  }

  public getLastRunVersion(): string | null {
    return this.data.lastRunVersion || null
  }

  public setLastRunVersion(version: string): void {
    if (this.data.lastRunVersion === version) return
    this.data.lastRunVersion = version
    this.save()
  }

  public getLanguageSettings(): LanguageSettings {
    return { ...DEFAULT_LANGUAGE_SETTINGS, ...(this.data.languageSettings || {}) }
  }

  public setLanguageSettings(next: Partial<LanguageSettings>): LanguageSettings {
    const merged = { ...this.getLanguageSettings(), ...next }
    merged.textLang = toLangSetting(merged.textLang)
    merged.speechLang = toLangSetting(merged.speechLang)
    merged.micLang = toLangSetting(merged.micLang)
    this.data.languageSettings = merged
    this.save()
    const ui = this.getUiLanguage()
    this.languageListeners.forEach((fn) => {
      try {
        fn(ui)
      } catch {}
    })
    this.spokenListeners.forEach((fn) => {
      try {
        fn(this.getPreferredLanguage())
      } catch {}
    })
    return merged
  }

  public onLanguageChanged(cb: (lang: string) => void): () => void {
    this.languageListeners.push(cb)
    return () => {
      this.languageListeners = this.languageListeners.filter((fn) => fn !== cb)
    }
  }

  public setPreferredLanguage(lang: string): void {
    this.data.preferredLanguage = lang
    this.data.languageManuallyConfigured = true
    this.save()
    this.languageListeners.forEach((fn) => {
      try {
        fn(lang)
      } catch (err) {
        console.warn('[ConsciousnessService] Error notifying language listener:', err)
      }
    })
  }

  public getScannerBounds(): ScannerBounds {
    return this.data.scannerBounds || { x: -1, y: -1, width: 520, height: 420 }
  }

  public setScannerBounds(bounds: Partial<ScannerBounds>): void {
    this.data.scannerBounds = {
      ...(this.data.scannerBounds || { x: -1, y: -1, width: 520, height: 420 }),
      ...bounds
    }
    this.save()
  }

  public getScannerContinuous(): boolean {
    return !!this.data.scannerContinuous
  }

  public setScannerContinuous(val: boolean): void {
    this.data.scannerContinuous = val
    this.save()
  }

  public getScannerVisionModel(): string {
    return this.data.scannerVisionModel || 'auto'
  }

  public setScannerVisionModel(model: string): void {
    this.data.scannerVisionModel = model
    this.save()
  }

  public setLastScannedContext(ctx: ScannedVisualContext): void {
    this.lastScannedContext = ctx
  }

  public getLastScannedContext(): ScannedVisualContext | null {
    if (!this.lastScannedContext) return null
    // Expire visual memory after 15 minutes of inactivity
    if (Date.now() - this.lastScannedContext.timestamp > 15 * 60 * 1000) {
      this.lastScannedContext = null
      return null
    }
    return this.lastScannedContext
  }

  public getLearnedConcepts(): LearnedScanConcept[] {
    return this.data.learnedConcepts || []
  }

  public addLearnedConcept(concept: string, description: string, tags: string[] = []): void {
    if (!this.data.learnedConcepts) {
      this.data.learnedConcepts = []
    }
    this.data.learnedConcepts.push({
      id: `learn-${Date.now()}`,
      concept: concept.trim(),
      description: description.trim(),
      tags,
      timestamp: Date.now()
    })
    if (this.data.learnedConcepts.length > 50) {
      this.data.learnedConcepts = this.data.learnedConcepts.slice(-50)
    }
    this.save()
  }

  public setPendingScanLearning(pending: { description: string; tags: string[] } | null): void {
    this.pendingScanLearning = pending ? { ...pending, timestamp: Date.now() } : null
  }

  public getPendingScanLearning(): { description: string; tags: string[]; timestamp: number } | null {
    if (!this.pendingScanLearning) return null
    if (Date.now() - this.pendingScanLearning.timestamp > 5 * 60 * 1000) {
      this.pendingScanLearning = null
      return null
    }
    return this.pendingScanLearning
  }

  public getLearnedDrawings(): Record<string, LearnedDrawingEntry> {
    return this.data.learnedDrawings || {}
  }

  /**
   * Normalizes subject string into semantic tokens (strips stop words like 'el', 'la', 'logo', 'de', etc.)
   */
  public extractKeywords(str: string): string[] {
    const clean = str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
    const stopwords = new Set([
      'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
      'de', 'del', 'al', 'en', 'con', 'por', 'para',
      'the', 'a', 'an', 'of', 'in', 'on', 'with', 'for', 'to',
      'logo', 'dibujo', 'boceto', 'drawing', 'sketch', 'icon', 'icono',
      'emblema', 'emblem', 'marca', 'brand', 'simbolo', 'symbol', 'insignia',
      'que', 'te', 'mostre', 'aprendiste', 'escaneaste', 'ultimo', 'last'
    ])
    return clean.split(/\s+/).filter((w) => w.length >= 2 && !stopwords.has(w))
  }

  public getLearnedDrawing(subject: string): LearnedDrawingEntry | null {
    if (!this.data.learnedDrawings) return null
    const entries = Object.values(this.data.learnedDrawings)
    if (entries.length === 0) return null

    const norm = subject.toLowerCase().trim()

    // Direct key lookup
    if (this.data.learnedDrawings[norm]) return this.data.learnedDrawings[norm]

    // If subject refers to recent scan ('el logo', 'lo que te mostré', 'último', etc.)
    const isRecentRef =
      /^(?:el\s+)?logo$/i.test(norm) ||
      /(?:lo\s+que\s+(?:te\s+)?mostr[eé]|que\s+(?:te\s+)?mostr[eé]|aprendiste|escaneaste|[uú]ltimo|last|recent)/i.test(norm)
    if (isRecentRef) {
      const sorted = [...entries].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      return sorted[0]
    }

    // Keyword/token-based semantic matching
    const queryTokens = this.extractKeywords(norm)
    if (queryTokens.length > 0) {
      for (const entry of entries) {
        const entryTokens = this.extractKeywords(entry.subject)
        const hasMatch = queryTokens.some((qt) => entryTokens.includes(qt) || entry.subject.toLowerCase().includes(qt))
        if (hasMatch) {
          return entry
        }
      }
    }

    // Substring fallback
    for (const [key, entry] of Object.entries(this.data.learnedDrawings)) {
      if (norm.includes(key) || key.includes(norm)) {
        return entry
      }
    }
    return null
  }

  public saveLearnedDrawing(subject: string, visualDescription: string, plan: any): void {
    if (!this.data.learnedDrawings) {
      this.data.learnedDrawings = {}
    }
    const cleanSubj = subject.toLowerCase().trim()
    const entry: LearnedDrawingEntry = {
      id: `drawing-${Date.now()}`,
      subject: cleanSubj,
      visualDescription: visualDescription.trim(),
      plan,
      timestamp: Date.now()
    }

    // Store under primary key
    this.data.learnedDrawings[cleanSubj] = entry

    // Store under aliases (e.g. if 'arasaka logo' -> also alias 'arasaka', 'logo de arasaka')
    const tokens = this.extractKeywords(cleanSubj)
    if (tokens.length > 0) {
      const coreName = tokens.join(' ')
      if (coreName && coreName !== cleanSubj) {
        this.data.learnedDrawings[coreName] = entry
        this.data.learnedDrawings[`logo de ${coreName}`] = entry
        this.data.learnedDrawings[`${coreName} logo`] = entry
      }
    }

    
    // Cross-language synonyms and aliases
    const synonymMap: Record<string, string[]> = {
      perro: ['dog', 'a dog', 'un perro', 'el perro'],
      dog: ['perro', 'a dog', 'un perro', 'the dog'],
      gato: ['cat', 'a cat', 'un gato', 'el gato'],
      cat: ['gato', 'a cat', 'un gato', 'the cat'],
      casa: ['house', 'a house', 'una casa'],
      house: ['casa', 'a house', 'una casa'],
      corazon: ['heart', 'a heart', 'un corazon', 'un corazón'],
      corazón: ['heart', 'a heart', 'un corazon', 'un corazón'],
      heart: ['corazon', 'corazón', 'a heart', 'un corazon'],
      sol: ['sun', 'a sun', 'un sol'],
      sun: ['sol', 'a sun', 'un sol'],
      monigote: ['stickman', 'a stickman', 'un monigote'],
      stickman: ['monigote', 'a stickman', 'un monigote'],
      auto: ['car', 'a car', 'un auto'],
      coche: ['car', 'a car', 'un coche'],
      car: ['auto', 'coche', 'a car', 'un auto']
    }
    const extraAliases = synonymMap[cleanSubj] || []
    for (const alias of extraAliases) {
      this.data.learnedDrawings[alias] = entry
    }

    this.save()

    try {
      const dir = learnedDrawingsDir()
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const safeName = cleanSubj.replace(/[^a-zA-Z0-9_-]/g, '_')
      const filePath = path.join(dir, `${safeName}.json`)
      fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[ConsciousnessService] Error saving learned drawing file:', e)
    }
  }

  private save(): void {
    try {
      if (this.filePath) {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
      }
    } catch {}
  }
}

export const consciousnessService = new ConsciousnessService()
