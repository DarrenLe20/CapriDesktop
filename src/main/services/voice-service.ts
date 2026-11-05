import { storageDir } from './storage-location'
import { detectLanguage } from './language-detect'
import { isSupportedLang } from '../../shared/languages'
import { isCloudMode, llmFetch } from './llm-gateway'
import { envFilePath, localFfmpegPath, pythonPath, scriptPath, voiceDataDir } from './app-paths'
import { spawn, ChildProcess } from 'child_process'
import { stripLookTags } from './script/look-tags'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { app } from 'electron'
import { consciousnessService } from './consciousness-service'
import { ollamaService } from './ollama-service'
function loadEnv(): void {
  const envCandidates = [envFilePath()]
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf-8')
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const eqIdx = trimmed.indexOf('=')
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim()
            let val = trimmed.slice(eqIdx + 1).trim()
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1)
            }
            if (!process.env[key]) {
              process.env[key] = val
            }
          }
        }
        break
      } catch {}
    }
  }
}
loadEnv()

export interface TranscribeResult {
  success: boolean
  text?: string
  error?: string
}

export interface SynthesizeResult {
  success: boolean
  audioDataUrl?: string
  error?: string
}

export class VoiceService {
  private static instance: VoiceService
  private sttWorker: ChildProcess | null = null
  /** The worker loads Whisper before it answers, and the first time it also downloads it */
  private sttState: 'off' | 'loading' | 'ready' | 'failed' = 'off'
  private lastTranscript: { text: string; lang: string; at: number } | null = null
  private pendingRequests: Map<string, {
    resolve: (res: TranscribeResult) => void
    reject: (err: any) => void
    tempIn: string
    timer: NodeJS.Timeout
  }> = new Map()
  private requestCounter = 0
  private workerLineBuffer = ''
  private audioCache: Map<string, string> = new Map()
  private prewarming = false

  public static getInstance(): VoiceService {
    if (!VoiceService.instance) {
      VoiceService.instance = new VoiceService()
    }
    return VoiceService.instance
  }

  public stopServer(): void {
    if (this.sttWorker) {
      try {
        this.sttWorker.kill()
      } catch {}
      this.sttWorker = null
    }
  }

  /** Tells capri_voice.py where the (writable) voice config, keys and audio cache live */
  private pythonEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', CAPRI_VOICE_DIR: voiceDataDir(), CAPRI_ENV_FILE: envFilePath(), PYTHONIOENCODING: 'utf-8' }
    const ffmpeg = localFfmpegPath()
    if (ffmpeg && !env.CAPRI_FFMPEG) env.CAPRI_FFMPEG = ffmpeg
    // Whisper's model weighs about 500 MB
    const whisper = storageDir('whisper')
    if (whisper) env.HF_HOME = whisper
    return env
  }

  private findScriptPath(): string {
    return scriptPath('capri_voice.py')
  }

  private findPythonPath(): string {
    return pythonPath()
  }

  /**
   * Starts and maintains a persistent background Whisper STT worker for sub-second responses
   */
  public ensureWorker(): void {
    if (this.sttWorker && !this.sttWorker.killed) return

    this.sttState = 'loading'
    const scriptPath = this.findScriptPath()
    const pythonPath = this.findPythonPath()

    try {
      const worker = spawn(pythonPath, [scriptPath, 'stt-worker'], {
        windowsHide: true,
        env: this.pythonEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.sttWorker = worker

      this.sttWorker.stdout?.on('data', (chunk) => {
        this.workerLineBuffer += chunk.toString()
        const lines = this.workerLineBuffer.split('\n')
        this.workerLineBuffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const parsed = JSON.parse(trimmed)
            if (parsed.ready !== undefined) {
              console.log('[VoiceService] Local STT Whisper worker is ready:', parsed)
              if (this.sttWorker === worker) this.sttState = parsed.ready ? 'ready' : 'failed'
              continue
            }

            if (parsed.id && this.pendingRequests.has(parsed.id)) {
              const req = this.pendingRequests.get(parsed.id)!
              this.pendingRequests.delete(parsed.id)
              clearTimeout(req.timer)
              try {
                if (fs.existsSync(req.tempIn)) fs.unlinkSync(req.tempIn)
              } catch {}
              req.resolve(parsed)
            } else if (this.pendingRequests.size === 1) {
              const entry = this.pendingRequests.entries().next().value
              if (entry) {
                const [singleId, req] = entry
                this.pendingRequests.delete(singleId)
                clearTimeout(req.timer)
                try {
                  if (fs.existsSync(req.tempIn)) fs.unlinkSync(req.tempIn)
                } catch {}
                req.resolve(parsed)
              }
            }
          } catch (e) {
            console.warn('[VoiceService Worker] Unparseable line from python STT:', trimmed)
          }
        }
      })

      this.sttWorker.stderr?.on('data', (data) => {
        const str = data.toString()
        // Only log non-empty non-progress messages
        if (str.trim() && !str.includes('Processing') && !str.includes('%')) {
          console.warn('[VoiceService Worker STDERR]', str.trim())
        }
      })

      this.sttWorker.on('error', (err) => {
        console.error('[VoiceService Worker Error]', err)
        this.drainQueueWithError(err.message)
      })

      worker.on('close', (code) => {
        console.warn(`[VoiceService Worker] Process closed with code ${code}`)
        // Restarted on purpose: the new one is already running and this says nothing about it
        if (this.sttWorker !== worker) return
        this.drainQueueWithError(`Worker closed with code ${code}`)
        this.sttWorker = null
        this.sttState = 'failed'
      })
    } catch (err: any) {
      console.error('[VoiceService Worker Spawn Failed]', err)
      this.sttWorker = null
      this.sttState = 'failed'
    }
  }

  private drainQueueWithError(errorMsg: string): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer)
      try {
        if (fs.existsSync(req.tempIn)) fs.unlinkSync(req.tempIn)
      } catch {}
      req.resolve({ success: false, error: errorMsg })
    }
    this.pendingRequests.clear()
  }

  /**
   * Transcribes an audio Buffer into text using local faster-whisper on GPU
   */
  /** Starts over with whatever Python is installed now: the one it started with may not have had Whisper */
  public restartWorker(): void {
    if (this.sttWorker) {
      try {
        this.sttWorker.kill()
      } catch {}
      this.sttWorker = null
    }
    this.sttState = 'off'
    this.ensureWorker()
  }

  public getSttState(): 'off' | 'loading' | 'ready' | 'failed' {
    return this.sttState
  }

  /** The language Whisper heard, if this text is what it just transcribed */
  public languageOfTranscript(text: string): string | null {
    const last = this.lastTranscript
    if (!last || Date.now() - last.at > 15000 || !text.trim()) return null
    const clean = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    // A wake word may have been taken off the start
    return clean(last.text).includes(clean(text)) && isSupportedLang(last.lang) ? last.lang : null
  }

  public async transcribe(audioBuffer: Buffer, partial = false): Promise<TranscribeResult> {
    // Words on screen while talking are a nicety: they never make the real request wait in line
    if (partial && (this.sttState !== 'ready' || this.pendingRequests.size > 0)) {
      return { success: false, error: 'busy' }
    }
    // A worker that failed gets another try: Python may have been installed since
    if (this.sttState === 'failed') this.restartWorker()
    const id = `req_${++this.requestCounter}_${Date.now()}`
    const tempIn = path.join(os.tmpdir(), `capri_stt_${id}.webm`)
    fs.writeFileSync(tempIn, audioBuffer)

    try {
      this.ensureWorker()
      if (!this.sttWorker || this.sttWorker.killed || !this.sttWorker.stdin) {
        return await this.transcribeFallback(tempIn)
      }

      const prefLang = consciousnessService.getLanguageSettings().micLang || 'auto'
      const hint = consciousnessService.getPreferredLanguage()
      // Downloading Whisper or running on a slow CPU takes far longer than 18 seconds
      const waitMs = partial ? 15000 : this.sttState === 'ready' ? 90000 : 600000

      const result = await new Promise<TranscribeResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id)
          try {
            if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn)
          } catch {}
          // A worker that never answers would also swallow every later request
          if (!partial) this.restartWorker()
          resolve({ success: false, error: `STT Worker timeout (${waitMs}ms)` })
        }, waitMs)

        this.pendingRequests.set(id, { resolve, reject, tempIn, timer })
        const payload = JSON.stringify({ id, file: tempIn, lang: prefLang, hint }) + '\n'
        this.sttWorker!.stdin!.write(payload)
      })
      if (!partial && result.success && result.text && (result as { language?: string }).language) {
        this.lastTranscript = { text: result.text, lang: (result as { language?: string }).language as string, at: Date.now() }
      }
      return result
    } catch (err: any) {
      try {
        if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn)
      } catch {}
      return { success: false, error: err?.message || String(err) }
    }
  }

  private async transcribeFallback(tempIn: string): Promise<TranscribeResult> {
    const scriptPath = this.findScriptPath()
    const pythonPath = this.findPythonPath()
    const prefLang = consciousnessService.getLanguageSettings().micLang || 'auto'

    try {
      return await new Promise<TranscribeResult>((resolve) => {
        const procArgs = [scriptPath, 'stt', '--file', tempIn]
        if (prefLang && prefLang !== 'auto') {
          procArgs.push('--lang', prefLang)
        }

        const proc = spawn(pythonPath, procArgs, {
          windowsHide: true,
          env: this.pythonEnv()
        })

        let stdout = ''
        let stderr = ''

        proc.stdout.on('data', (d) => (stdout += d.toString()))
        proc.stderr.on('data', (d) => (stderr += d.toString()))

        proc.on('close', (code) => {
          try {
            if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn)
          } catch {}

          if (code !== 0) {
            console.warn('[VoiceService Fallback] Python STT process exited with code', code, stderr)
            resolve({ success: false, error: stderr || `Process exited with code ${code}` })
            return
          }

          try {
            const parsed = JSON.parse(stdout.trim())
            resolve(parsed)
          } catch {
            resolve({ success: false, error: stdout || 'Failed to parse STT response' })
          }
        })
      })
    } catch (err: any) {
      try {
        if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn)
      } catch {}
      return { success: false, error: err?.message || String(err) }
    }
  }

  /**
   * Synthesizes text into Capri's voice with exact acoustic profile and zero latency
   */
  public async synthesize(text: string, langOverride?: string, opts: { silent?: boolean } = {}): Promise<SynthesizeResult> {
    // Strip all emoji characters and pictorial symbols so TTS does not read them out loud
    const cleanText = stripLookTags(text)
      .replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu, '')
      .replace(/[🐾✨👀⚡🎉🦾🛑💬🎵🔥💥💡⚔️📹🎮💤✓✕⚠️🤖🐱🐶👍👎❤️]/g, '')
      .replace(/[*#_~>|`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!cleanText) {
      return { success: false, error: 'Empty text provided' }
    }

    const scriptPath = this.findScriptPath()
    const pythonPath = this.findPythonPath()
    const tempOut = path.join(os.tmpdir(), `capri_tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`)

    const isJapanese = /[\u3040-\u309F\u30A0-\u30FF]/.test(cleanText)

    // Strictly English function words that never appear in authentic Spanish sentences (NOTE: 'choomba' is neutral slang)
    const hasEnglishMarkers = /\b(the|what|doing|are|you|your|with|this|that|have|from|systems|online|jacked|neural|link|ready|catch|side|blackwall|construct|standing|powering|offline|reboot|shutdown|cupcake|boo|easy|desktop|homework|got\s+it|next\s+time|look|see|stop|dat|hack|hacking)\b/i.test(cleanText)

    const hasSpanishUnique = /[ñ¿¡]/i.test(cleanText)
    const hasSpanishWords = /\b(hola|buenas|estas|este|esto|bueno|dale|che|mira|mirá|posta|facha|zarpado|copado|hacer|podes|puedes|amigo|cancion|canción|musica|tarea|archivo|escritorio|estás|resolví|guardado|éxito|estoy|haciendo|pará|despeines|abriendo|cerrando|chau|adiós|dibuja|dibujá|dibujo|dibujar|dibújame|dibujame|perro|gato|casa|sol|arbol|árbol|monigote|aprende|aprendé|trazos|lienzo|paint|un|una|unos|unas|el|la|los|las|de|del|al|en|con|por|para|tambien|también|listo|lista|tranqui|de una|al toque|bienvenido|genial|espera|esperá)\b/i.test(cleanText)
    const hasSpanishAccents = /[áéíóú]/.test(cleanText)
    const isSpanish = hasSpanishUnique || hasSpanishWords || (hasSpanishAccents && !hasEnglishMarkers)

    const prefLang = consciousnessService.getPreferredLanguage()
    let targetLang = langOverride
    // Her own detector first: the checks below lean Spanish on words shared with other languages
    if (!targetLang) {
      const found = detectLanguage(cleanText)
      if (found !== 'unknown') targetLang = found
    }
    if (!targetLang) {
      if (isJapanese) targetLang = 'ja'
      else if (isSpanish) targetLang = 'es'
      else if (hasEnglishMarkers) targetLang = 'en'
      else if (prefLang && prefLang !== 'auto') targetLang = prefLang
      else targetLang = 'en'
    }

    // Spoken language from the settings: if Capri wrote the line in another language,
    // translate it (emotion tags preserved) and speak it in the chosen language
    let spokenText = cleanText
    const speechLang = consciousnessService.getLanguageSettings().speechLang
    if (!langOverride && speechLang && speechLang !== 'auto' && targetLang !== speechLang) {
      const translated = await this.translateForSpeech(cleanText, speechLang)
      if (translated) {
        spokenText = translated
        targetLang = speechLang
      }
    }

    const cacheKey = `${targetLang || 'auto'}:${spokenText}`
    const cached = this.audioCache.get(cacheKey)
    if (cached) {
      return { success: true, audioDataUrl: cached }
    }

    const emotions = spokenText.match(/\[[a-zA-Z0-9_\s\-]+\]/g) || []
    if (!opts.silent) {
      console.log(`\n==================================================`)
      console.log(`[VoiceService -> Python Engine] Synthesizing speech:`)
      console.log(`  Text: "${spokenText}"`)
      console.log(`  Emotions detected: ${JSON.stringify(emotions)}`)
      console.log(`  Target Language: ${targetLang || 'auto'}`)
      console.log(`==================================================`)
    }

    const ttsArgs = [scriptPath, 'tts', '--text', spokenText, '--out', tempOut]
    if (targetLang) {
      ttsArgs.push('--lang', targetLang)
    }

    try {
      return await new Promise<SynthesizeResult>((resolve) => {
        const proc = spawn(pythonPath, ttsArgs, {
          windowsHide: true,
          env: this.pythonEnv()
        })

        let stdout = ''
        let stderr = ''

        proc.stdout.on('data', (d) => (stdout += d.toString()))
        proc.stderr.on('data', (d) => {
          const str = d.toString()
          stderr += str
          if (str.trim() && !opts.silent) {
            console.log(str.trim())
          }
        })

        proc.on('close', async (code) => {
          if (code !== 0 || !fs.existsSync(tempOut)) {
            console.warn('[VoiceService] Python TTS process failed:', stderr || stdout)
            resolve({ success: false, error: stderr || `TTS process exited with code ${code}` })
            return
          }

          try {
            const audioBuffer = fs.readFileSync(tempOut)
            const base64Audio = audioBuffer.toString('base64')
            const audioDataUrl = `data:audio/mp3;base64,${base64Audio}`

            // Clean up temporary file
            try {
              fs.unlinkSync(tempOut)
            } catch {}

            // Broadcast audio‑play event to all renderer windows so UI can show the speech bubble instantly
            if (!opts.silent) {
              try {
                const { BrowserWindow } = require('electron')
                BrowserWindow.getAllWindows().forEach((win: any) => {
                  win.webContents.send('audio-play', { path: tempOut })
                })
              } catch (e) {
                console.warn('[VoiceService] Failed to broadcast audio‑play event:', e)
              }
            }

            // If the selected provider (Fish Audio / ElevenLabs) failed and Python fell back to
            // Edge-TTS, play it this once but never cache it, so the next try uses the real voice.
            let isFallback = false
            try {
              const lastLine = stdout.trim().split(/\r?\n/).pop() || '{}'
              isFallback = JSON.parse(lastLine).fallback === true
            } catch {}

            if (isFallback) {
              console.warn(`[VoiceService] Provider failed, Edge-TTS fallback used (not cached): "${cleanText}"`)
            } else {
              // Store in fast memory cache (limit to 400 phrases)
              if (this.audioCache.size >= 400) {
                const firstKey = this.audioCache.keys().next().value
                if (firstKey) this.audioCache.delete(firstKey)
              }
              this.audioCache.set(cacheKey, audioDataUrl)
            }

            resolve({ success: true, audioDataUrl })
          } catch (readErr: any) {
            resolve({ success: false, error: readErr?.message || 'Failed to read synthesized audio' })
          }
        })
      })
    } catch (err: any) {
      try {
        if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut)
      } catch {}
      return { success: false, error: err?.message || String(err) }
    }
  }

  private translationCache: Map<string, string> = new Map()

  private translatorModel: string | null = null
  private translatorWarm = false

  private async pickTranslatorModel(): Promise<string | null> {
    if (this.translatorModel) return this.translatorModel
    await ollamaService.ensureRunning().catch(() => {})
    const tags = (await llmFetch('http://127.0.0.1:11434/api/tags').then((r) => r.json())) as { models?: { name: string }[] }
    const models = (tags.models || []).map((m) => m.name).filter((n) => !/llava|vision|-vl\b/i.test(n))
    this.translatorModel = models.find((n) => /qwen2\.5.*7b/i.test(n)) || models.find((n) => !/^capri/i.test(n)) || models[0] || null
    return this.translatorModel
  }

  /**
   * A command in any language, in English, for the part of her that recognizes commands. Waits
   * as long as a spoken translation at most; without an answer the text goes as it came.
   */
  public async translateCommand(text: string, lang = 'en'): Promise<string | null> {
    return this.translateForSpeech(text, lang)
  }

  /** Loads the translation model into VRAM ahead of time (a cold load can take ~40s on this PC). */
  public warmTranslator(): void {
    if (this.translatorWarm || isCloudMode()) return
    this.translatorWarm = true
    this.pickTranslatorModel()
      .then((model) => {
        if (!model) return
        console.log(`[VoiceService] Warming up ${model} for spoken translations...`)
        return llmFetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, stream: false, keep_alive: '30m', messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 1 } })
        })
      })
      .catch(() => {
        this.translatorWarm = false
      })
  }

  /**
   * Translates a line to the chosen speech language with the local LLM, keeping [emotion] tags.
   * Waits at most 8s: if the model is still loading, the original text is spoken this time and
   * the translation keeps going in the background so it's cached for the next time.
   */
  private async translateForSpeech(text: string, lang: string): Promise<string | null> {
    const key = `${lang}:${text}`
    const hit = this.translationCache.get(key)
    if (hit) return hit
    this.warmTranslator()

    const names: Record<string, string> = {
      es: 'Rioplatense Spanish', en: 'English', ja: 'Japanese'
    }

    const job = (async (): Promise<string | null> => {
      const model = await this.pickTranslatorModel()
      if (!model) return null
      const res = await llmFetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: '30m',
          options: { temperature: 0.2, num_predict: 300 },
          messages: [
            {
              role: 'system',
              content: `Translate the user's text to ${names[lang] || lang}. Keep every [bracket tag] exactly as written and in the same position. Keep names, slang like "choom"/"choomba", and the casual tone. Output ONLY the translation.`
            },
            { role: 'user', content: text }
          ]
        })
      })
      if (!res.ok) return null
      const data = (await res.json()) as { message?: { content?: string } }
      const out = (data.message?.content || '').trim().replace(/^["“]|["”]$/g, '')
      if (!out) return null
      if (this.translationCache.size > 300) this.translationCache.clear()
      this.translationCache.set(key, out)
      console.log(`[VoiceService] Spoken translation (${lang}): "${out}"`)
      return out
    })().catch((err: any) => {
      console.warn('[VoiceService] Spoken translation failed:', err?.message || err)
      return null
    })

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))
    const result = await Promise.race([job, timeout])
    if (!result) console.warn('[VoiceService] Translator not ready yet, speaking the original text this time')
    return result
  }

  /**
   * Pre-synthesizes a list of phrases in the background (one at a time) so they play
   * instantly later. Audio lands in the memory cache and Python's disk cache.
   */
  public async prewarm(phrases: string[], label = 'phrases'): Promise<void> {
    if (this.prewarming) return
    this.prewarming = true
    console.log(`[VoiceService] Preloading ${phrases.length} ${label} in the background (nothing is played)`)
    let done = 0
    try {
      for (const phrase of phrases) {
        const res = await this.synthesize(phrase, undefined, { silent: true })
        if (res.success) done++
        await new Promise((r) => setTimeout(r, 300))
      }
      console.log(`[VoiceService] Prewarmed ${done}/${phrases.length} ${label}`)
    } catch (err) {
      console.warn('[VoiceService] Prewarm failed:', err)
    } finally {
      this.prewarming = false
    }
  }

  public getVoiceConfigPath(): string {
    return path.join(voiceDataDir(), 'voice_config.json')
  }

  /** voice_config.local.json (git-ignored) holds secrets and overrides provider for the Python engine */
  private getLocalConfigPath(): string {
    return path.join(path.dirname(this.getVoiceConfigPath()), 'voice_config.local.json')
  }

  private readLocalConfig(): any | null {
    const lp = this.getLocalConfigPath()
    try {
      if (fs.existsSync(lp)) return JSON.parse(fs.readFileSync(lp, 'utf-8'))
    } catch (e) {
      console.warn('[VoiceService] Could not read voice_config.local.json:', e)
    }
    return null
  }

  /** Fish Audio performs [laugh], [giggles], [happy]... as real voice acting; other engines can't */
  public isFishAudioActive(): boolean {
    const provider = String(this.getConfig()?.provider || '').toLowerCase()
    return provider === 'fish-audio' || provider === 'fish_audio' || provider === 'fishaudio'
  }

  public getConfig(): any {
    const p = this.getVoiceConfigPath()
    try {
      if (fs.existsSync(p)) {
        const base = JSON.parse(fs.readFileSync(p, 'utf-8'))
        // Same merge the Python TTS engine does, so the UI shows the provider really in use
        const local = this.readLocalConfig()
        if (local && typeof local === 'object') {
          for (const k of ['provider', 'synth_preset', 'pitch']) {
            if (local[k] !== undefined) base[k] = local[k]
          }
          for (const k of ['fish_audio', 'elevenlabs']) {
            if (local[k] && typeof local[k] === 'object') base[k] = { ...(base[k] || {}), ...local[k] }
          }
        }
        return base
      }
    } catch (e) {
      console.warn('[VoiceService] Could not read voice_config.json:', e)
    }
    return {
      provider: 'edge-tts',
      active_voice: 'en-US-AriaNeural',
      voice_es: 'es-AR-ElenaNeural',
      pitch: '+28Hz',
      rate: '+25%',
      synth_preset: 'none'
    }
  }

  public setConfig(config: any): { success: boolean; error?: string } {
    const p = this.getVoiceConfigPath()
    try {
      const parent = path.dirname(p)
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true })
      const local = this.readLocalConfig()
      if (local && typeof local === 'object') {
        // Keep the local override file in sync (it wins in the Python engine) and keep
        // API keys out of the git-tracked voice_config.json
        const nextLocal = { ...local }
        for (const k of ['provider', 'synth_preset', 'pitch']) {
          if (config[k] !== undefined) nextLocal[k] = config[k]
        }
        for (const k of ['fish_audio', 'elevenlabs']) {
          if (config[k] && typeof config[k] === 'object') nextLocal[k] = { ...(local[k] || {}), ...config[k] }
        }
        fs.writeFileSync(this.getLocalConfigPath(), JSON.stringify(nextLocal, null, 2), 'utf-8')

        const publicCfg = JSON.parse(JSON.stringify(config))
        for (const k of ['fish_audio', 'elevenlabs']) {
          if (publicCfg[k] && local[k]?.api_key) publicCfg[k].api_key = ''
        }
        fs.writeFileSync(p, JSON.stringify(publicCfg, null, 2), 'utf-8')
      } else {
        fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8')
      }
      this.audioCache.clear()
      return { success: true }
    } catch (err: any) {
      console.error('[VoiceService] Failed to save voice config:', err)
      return { success: false, error: err?.message || String(err) }
    }
  }
}

export const voiceService = VoiceService.getInstance()
