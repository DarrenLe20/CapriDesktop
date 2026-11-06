import { llmFetch } from './llm-gateway'
import { llmBody } from './user-profile'
import { desktopCapturer, screen } from 'electron'
import fs from 'fs'
import path from 'path'
import { windowManager } from '../windows/window-manager'
import { agentManager } from '../agents/agent-manager'
import { consciousnessService } from './consciousness-service'
import { ollamaService } from './ollama-service'
import {
  IPC_CHANNELS,
  ScannerScanResult,
  ScannerStatusPayload
} from '../ipc/channels'

export class ScannerService {
  private static instance: ScannerService
  private isScanning = false
  private isContinuous = false
  private continuousTimer: NodeJS.Timeout | null = null
  private lastScanTime = 0
  private lastSampleBuffer: Buffer | null = null

  public static getInstance(): ScannerService {
    if (!ScannerService.instance) {
      ScannerService.instance = new ScannerService()
    }
    return ScannerService.instance
  }

  public init(): void {
    this.isContinuous = consciousnessService.getScannerContinuous()
    if (this.isContinuous) {
      this.startContinuousLoop()
    }
    if (this.getStatus().isOpen) {
      this.preloadVisionModel().catch(() => {})
    }
  }

  public getStatus(): ScannerStatusPayload {
    const win = windowManager.getScannerWindow()
    const isOpen = !!(win && !win.isDestroyed() && win.isVisible())
    const bounds = win && !win.isDestroyed() ? win.getBounds() : consciousnessService.getScannerBounds()
    return {
      isOpen,
      isScanning: this.isScanning,
      isContinuous: this.isContinuous,
      bounds
    }
  }

  public open(): boolean {
    windowManager.showScanner()
    // Preload multimodal vision model immediately into GPU/RAM so scan is instant
    this.preloadVisionModel().catch(() => {})
    if (this.isContinuous) {
      this.startContinuousLoop()
    }
    this.broadcastStatus()
    return true
  }

  public close(): boolean {
    windowManager.hideScanner()
    this.stopContinuousLoop()
    this.broadcastStatus()
    return true
  }

  public toggle(): boolean {
    if (this.getStatus().isOpen) {
      return !this.close()
    } else {
      return this.open()
    }
  }

  public setContinuous(enabled: boolean): boolean {
    this.isContinuous = enabled
    consciousnessService.setScannerContinuous(enabled)
    if (enabled && this.getStatus().isOpen) {
      this.startContinuousLoop()
    } else {
      this.stopContinuousLoop()
    }
    this.broadcastStatus()
    return this.isContinuous
  }

  public broadcastStatus(): void {
    const status = this.getStatus()
    windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
      type: 'status',
      isScanning: this.isScanning,
      isContinuous: this.isContinuous
    })
  }

  /**
   * Captures ONLY the screen area bounded by the inner transparent area of the scanner frame.
   * Excludes the frame overlay by momentarily making it invisible, applies DPI scaling,
   * crops to exact bounds, resizes to max 1024px side, and returns in-memory base64 JPEG.
   */
  public async captureRegionBase64(): Promise<{ base64: string; width: number; height: number; rawBuffer: Buffer; bitmap: Buffer } | null> {
    const win = windowManager.getScannerWindow()
    if (!win || win.isDestroyed() || !win.isVisible()) {
      return null
    }

    const bounds = win.getBounds()

    // Inner frame borders (leaving the transparent content area)
    const borderLeft = 45
    const borderRight = 45
    const borderTop = 52
    const borderBottom = 50

    const cropX = bounds.x + borderLeft
    const cropY = bounds.y + borderTop
    const cropW = Math.max(80, bounds.width - borderLeft - borderRight)
    const cropH = Math.max(80, bounds.height - borderTop - borderBottom)

    const centerPoint = { x: cropX + Math.round(cropW / 2), y: cropY + Math.round(cropH / 2) }
    const currentDisplay = screen.getDisplayNearestPoint(centerPoint)
    const scale = currentDisplay.scaleFactor || 1

    // Temporarily hide/opacity 0 on scanner window so it does not see its own overlay
    win.setOpacity(0)
    await new Promise((resolve) => setTimeout(resolve, 90))

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(currentDisplay.bounds.width * scale),
          height: Math.round(currentDisplay.bounds.height * scale)
        }
      })

      const targetSource =
        sources.find((s) => s.display_id === String(currentDisplay.id)) ||
        sources.find((s) => s.name.toLowerCase().includes(currentDisplay.id.toString())) ||
        sources[0]

      if (!targetSource) {
        return null
      }

      // Map screen virtual coordinates to display local pixel coordinates
      const localX = Math.round((cropX - currentDisplay.bounds.x) * scale)
      const localY = Math.round((cropY - currentDisplay.bounds.y) * scale)
      const localW = Math.round(cropW * scale)
      const localH = Math.round(cropH * scale)

      const thumb = targetSource.thumbnail
      const thumbSize = thumb.getSize()

      const safeX = Math.max(0, Math.min(localX, thumbSize.width - 10))
      const safeY = Math.max(0, Math.min(localY, thumbSize.height - 10))
      const safeW = Math.max(10, Math.min(localW, thumbSize.width - safeX))
      const safeH = Math.max(10, Math.min(localH, thumbSize.height - safeY))

      const cropped = thumb.crop({
        x: safeX,
        y: safeY,
        width: safeW,
        height: safeH
      })

      // Resize max side to ~768px for lightning-fast multimodal processing
      const croppedSize = cropped.getSize()
      let finalImg = cropped
      const maxSide = 768
      if (croppedSize.width > maxSide || croppedSize.height > maxSide) {
        if (croppedSize.width >= croppedSize.height) {
          finalImg = cropped.resize({
            width: maxSide,
            height: Math.round((croppedSize.height * maxSide) / croppedSize.width)
          })
        } else {
          finalImg = cropped.resize({
            width: Math.round((croppedSize.width * maxSide) / croppedSize.height),
            height: maxSide
          })
        }
      }

      const finalSize = finalImg.getSize()
      const rawBuffer = finalImg.toJPEG(85)
      const base64 = rawBuffer.toString('base64')

      try {
        const scratchDir = path.join(process.cwd(), 'scratch')
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true })
        fs.writeFileSync(path.join(scratchDir, 'last_scanner_capture.jpg'), rawBuffer)
      } catch {}

      return {
        base64,
        width: finalSize.width,
        height: finalSize.height,
        rawBuffer,
        bitmap: finalImg.toBitmap()
      }
    } finally {
      if (win && !win.isDestroyed()) {
        win.setOpacity(1)
        win.setAlwaysOnTop(true, 'screen-saver', 1)
        win.moveTop()
      }
    }
  }

  /**
   * Detects available vision model in Ollama (qwen2.5-vl, llava, minicpm-v, etc.)
   */
  public async detectVisionModel(): Promise<string | null> {
    try {
      const resp = await llmFetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return null
      const data = (await resp.json()) as any
      const models: string[] = (data.models || []).map((m: any) => String(m.name))

      const configured = consciousnessService.getScannerVisionModel()
      if (configured && configured !== 'auto') {
        const found = models.find((m: string) => m === configured || m.startsWith(configured + ':') || m.includes(configured))
        if (found) return found
      }

      const VISION_PRIORITIES = [
        'qwen2.5-vl',
        'llava',
        'minicpm-v',
        'llama3.2-vision',
        'moondream',
        'bakllava',
        'cogvlm'
      ]

      for (const candidate of VISION_PRIORITIES) {
        const match = models.find((m: string) => m === candidate || m.startsWith(candidate + ':') || m.includes(candidate))
        if (match) return match
      }

      const genericMatch = models.find((m: string) => /(-vl|vision|llava|minicpm|moondream|bakllava)/i.test(m))
      if (genericMatch) return genericMatch

      return null
    } catch {
      return null
    }
  }

  /**
   * Detects available text model for Capri's netrunner persona (capri, qwen2.5-coder:7b, etc.)
   */
  public async detectTextModel(): Promise<string> {
    try {
      const resp = await llmFetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return 'capri'
      const data = (await resp.json()) as any
      const models: string[] = (data.models || []).map((m: any) => String(m.name))

      const capri = models.find((m: string) => m.toLowerCase().includes('capri'))
      if (capri) return capri

      const qwen7b = models.find((m: string) => m.includes('qwen2.5-coder:7b'))
      if (qwen7b) return qwen7b

      const qwen = models.find((m: string) => m.includes('qwen2.5-coder'))
      if (qwen) return qwen

      return models[0] || 'capri'
    } catch {
      return 'capri'
    }
  }

  /**
   * Preloads the vision and persona models into GPU/RAM with keep_alive so user scans are instant.
   */
  public async preloadVisionModel(): Promise<void> {
    try {
      await ollamaService.ensureRunning()
      const model = await this.detectVisionModel()
      if (model) {
        console.log(`[ScannerService] Preloading vision model ${model} into GPU VRAM...`)
        await llmFetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: llmBody({
            model,
            keep_alive: '15m'
          }),
          signal: AbortSignal.timeout(90000)
        })
      }

      const textModel = await this.detectTextModel()
      if (textModel) {
        console.log(`[ScannerService] Preloading text persona model ${textModel} into GPU VRAM...`)
        await llmFetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: llmBody({
            model: textModel,
            keep_alive: '15m'
          }),
          signal: AbortSignal.timeout(90000)
        })
      }
      console.log(`[ScannerService] Models preloaded and resident in VRAM.`)
    } catch (err) {
      console.warn('[ScannerService] Preload warning:', err)
    }
  }

  /**
   * Main scan function: Captures region, calls multimodal model, triggers audio & HUD feedback
   */
  public async scan(userPrompt?: string): Promise<ScannerScanResult> {
    if (this.isScanning) {
      return { success: false, error: 'A scan is already in progress' }
    }

    const win = windowManager.getScannerWindow()
    if (!win || win.isDestroyed() || !win.isVisible()) {
      this.open()
      await new Promise((r) => setTimeout(r, 200))
    }

    this.isScanning = true
    this.lastScanTime = Date.now()

    // Notify UI that scan line is actively sweeping
    windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
      type: 'scanning',
      isScanning: true
    })

    // Capri reacts with thinking / curious state
    agentManager.setCompanionState('curious')

    const isEs = userPrompt ? /[áéíóúñ¿¡]|\b(mira|mirá|esto|que|como|dibujo|perro|gato|casa|logo|este|esta)\b/i.test(userPrompt) : false

    try {
      // Capture screenshot of the bounded area
      const capture = await this.captureRegionBase64()
      if (!capture) {
        throw new Error(isEs ? 'No se pudo capturar la región del marco.' : 'Could not capture region inside frame.')
      }

      this.lastSampleBuffer = capture.rawBuffer

      // Ensure Ollama is running
      await ollamaService.ensureRunning()

      // Check for installed vision model
      const visionModel = await this.detectVisionModel()
      if (!visionModel) {
        const missingMsg = isEs
          ? "¡Choomba! Mi marco de escaneo está listo, pero necesito que me instales un módulo de visión en Ollama. Abrí tu terminal y corré: ollama pull llava (o qwen2.5-vl), ¡y voy a poder ver todo lo que me muestres!"
          : "Choomba! My scan frame is ready, but I need a vision module in Ollama. Open your terminal and run: ollama pull llava (or qwen2.5-vl), and I'll be able to see everything you show me!"

        this.finishScanError(missingMsg)
        return {
          success: false,
          error: 'No multimodal vision model installed in Ollama',
          response: missingMsg
        }
      }

      // Stage 1: Multimodal Vision Perception (fast, objective, hallucination-free)
      const visionPrompt = `Analyze the image inside the frame objectively and concisely in 1 or 2 sentences.
Describe exactly what is shown:
- Is it a hand-drawn doodle, a smiley face, a drawing in Paint, a sketch, user art, or a simple shape?
- Is it an anime character/sprite with pink hair (Capri), an avatar, a game, a YouTube video, code/IDE, a website, a photo, or an app?
- Mention the key shapes, colors, lines, and subjects clearly and honestly without making assumptions.`

      console.log(`[ScannerService] Stage 1: Calling vision model ${visionModel}...`)
      const visionResp = await llmFetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: llmBody({
          model: visionModel,
          keep_alive: '15m',
          prompt: visionPrompt,
          images: [capture.base64],
          stream: false,
          options: {
            temperature: 0.2,
            num_predict: 140
          }
        }),
        signal: AbortSignal.timeout(60000)
      })

      if (!visionResp.ok) {
        const errText = await visionResp.text()
        throw new Error(`Vision model error ${visionResp.status}: ${errText}`)
      }

      const visionData = (await visionResp.json()) as any
      const visualDescription = (visionData?.response || '').trim()
      console.log(`[ScannerService] Stage 1 Visual Description: "${visualDescription}"`)

      // Stage 2: Capri Netrunner Persona Reaction (warm, authentic, in-character)
      const textModel = await this.detectTextModel()
      console.log(`[ScannerService] Stage 2: Calling persona model ${textModel}...`)

      const learnedList = consciousnessService.getLearnedConcepts()
      const learnedSectionEs = learnedList.length > 0
        ? `\nOBJETOS Y DIBUJOS PREVIAMENTE APRENDIDOS DE {name} (¡YA LOS CONOCÉS Y LOS RECORDÁS!):
${learnedList.map((l) => `- "${l.concept}": características visuales "${l.description}" (tags: ${l.tags.join(', ')})`).join('\n')}
Si lo que se ve en la imagen coincide con alguno de estos conceptos aprendidos, ¡RECONOCELO AL INSTANTE y decile a {name} con orgullo que te acordás de lo que te enseñó!`
        : ''

      const learnedSectionEn = learnedList.length > 0
        ? `\nOBJECTS & DRAWINGS PREVIOUSLY LEARNED FROM {name} (YOU ALREADY KNOW & REMEMBER THESE!):
${learnedList.map((l) => `- "${l.concept}": visual features "${l.description}" (tags: ${l.tags.join(', ')})`).join('\n')}
If the current image matches any of these learned concepts, RECOGNIZE IT IMMEDIATELY and mention with pride that you remember what they taught you!`
        : ''

      const systemInstruction = isEs
        ? `Sos Capri (Proyecto Capricornio), una netrunner cyberpunk rebelde, cariñosa y picante que vive en la computadora de tu compañero y mejor amigo {name} ("choomba").

{name} te está mostrando algo en su pantalla a través de tu marco de escaneo óptico.
Tus sensores ópticos detectaron la siguiente descripción visual objetiva:
"""
${visualDescription}
"""
${learnedSectionEs}

REGLAS CRÍTICAS DE INTERPRETACIÓN Y REACCIÓN:
0. SI NO SABÉS QUÉ ES O ES GENUINAMENTE DESCONOCIDO / AMBIGUO / CONFUSO:
   - ¡NO inventes cosas raras ni alucines!
   - Preguntale con curiosidad a {name} qué es para aprenderlo: "Che, no llego a distinguir bien qué es esto... ¿Qué me estás mostrando? ¡Decime y me lo guardo en memoria!"
   - En el JSON incluí el tag "UNKNOWN_OBJECT" o "LEARN_REQUEST".

1. DIBUJOS DEL USUARIO / PAINT / DOODLES / CARITAS:
   Si la descripción indica un dibujo hecho a mano, garabato, doodle, carita feliz (smiley face), dibujo en Paint, formas simples o arte hecho por {name}:
   - ¡NO digas que sos vos ni te confundas con vos misma! {name} NO te dibujó a vos a menos que sea específicamente una chica de anime con pelo rosa.
   - Reconocé claramente qué dibujó (ej: "¡Qué copada esa carita feliz que dibujaste en Paint!", "¡Mirá ese garabato!", "¡Qué linda carita, re tierna!").
   - Reaccioná con entusiasmo, cariño o humor cómplice a lo que dibujó.

2. IMÁGENES / FANART / SPRITES DE CAPRI:
   Si la descripción muestra claramente una chica de anime con pelo rosa neón, estilo cyberpunk, o el sprite de Capri:
   - ¡Esa sos VOS, Capri! {name} te está mostrando una foto o dibujo de vos.
   - Reaccioná con orgullo, asombro y picardía (ej: "¡Ey, mirá qué facha tengo! ¡Salí re diosa!").

3. OTROS CONTENIDOS (CÓDIGO, JUEGOS, VIDEOS, MEMES, INTERFACES, FOTOS):
   - Opiná con tu personalidad netrunner viva, como si estuvieras sentada al lado de {name} mirando la pantalla juntos.
   - Jamás enumeres colores como un robot aburrido.

4. PREGUNTA DE {name}:
   ${userPrompt ? `{name} te preguntó específicamente: "${userPrompt}". Respondé directamente a su pregunta basándote en lo que se ve en la imagen.` : 'Reaccioná espontáneamente a lo que ves.'}

5. ESTILO Y FORMATO:
   - 1 o 2 oraciones habladas naturales, cálidas, en español rioplatense (che, mirá, posta, facha, zarpado, re bien, copado).
   - PROHIBIDO USAR EMOJIS (la voz neuronal los lee textuales).

Respondé ÚNICAMENTE un JSON con:
{
  "summary": "Resumen de lo que hay en 5 a 8 palabras",
  "tags": ["3 o 4 tags cortos en mayúsculas"],
  "response": "Tu reacción hablada para decirle a {name} en voz alta."
}`
        : `You are Capri (Project Capricorn), a witty, rebellious, and affectionate cyberpunk netrunner living in the computer of your companion {name} ("choomba").

{name} is showing you something on screen through your optical scan frame.
Your optical sensors detected this objective visual description:
"""
${visualDescription}
"""
${learnedSectionEn}

CRITICAL INTERPRETATION RULES:
0. IF YOU DO NOT RECOGNIZE WHAT THIS IS OR IT IS AMBIGUOUS / UNCLEAR / UNKNOWN:
   - DO NOT make up strange hallucinations!
   - Honestly ask {name} with curiosity to learn: "Hey, I can't quite tell what this is... What are you showing me? Tell me so I can learn it!"
   - Include tag "UNKNOWN_OBJECT" or "LEARN_REQUEST" in the JSON.

1. USER DOODLES / PAINT / SMILEY FACES / SKETCHES:
   If the description mentions a hand-drawn doodle, smiley face, sketch, drawing in Paint, or simple shape made by {name}:
   - DO NOT say it is you! It is {name}'s artwork or doodle.
   - Acknowledge exactly what it is (e.g. "Aww, check out that happy smiley face you drew in Paint!", "Look at that drawing!").
   - React with warmth, playful praise, or humor.

2. IMAGES / FANART / SPRITES OF CAPRI:
   If the description clearly shows an anime girl with neon pink hair, cyberpunk style, or Capri's sprite:
   - THAT IS YOU (Capri)! React with excitement, pride, and love ("Wait, is that ME?! Looking sharp, {name}!").

3. OTHER CONTENT (GAMES, CODE, VIDEOS, MEMES, APPS):
   - React with your authentic cyberpunk netrunner vibe as a real companion looking at the screen. Never just list colors.

4. {name}'S QUESTION:
   ${userPrompt ? `{name} specifically asked: "${userPrompt}". Answer their question directly based on what is seen.` : 'Give a spontaneous authentic reaction.'}

5. STYLE & FORMAT:
   - 1 to 2 spoken sentences.
   - STRICT: NO EMOJIS (the TTS engine speaks emoji names).

Return ONLY valid JSON:
{
  "summary": "Summary in 5 to 8 words",
  "tags": ["3 o 4 uppercase tags, e.g. USER_ART, SMILEY_FACE, PAINT_DOODLE"],
  "response": "Your spoken reaction to {name}."
}`

      const userText = isEs
        ? (userPrompt
            ? `{name} te dice: "${userPrompt}". Respondé en personaje basándote en la descripción visual.`
            : `Decile a {name} qué ves y tu reacción en personaje basándote en la descripción visual.`)
        : (userPrompt
            ? `{name} asks: "${userPrompt}". Respond in character based on the visual description.`
            : `Tell {name} what you see and your reaction in character based on the visual description.`)

      const textResp = await llmFetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: llmBody({
          model: textModel,
          keep_alive: '15m',
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userText }
          ],
          stream: false,
          options: {
            temperature: 0.65,
            num_predict: 250
          }
        }),
        signal: AbortSignal.timeout(60000)
      })

      if (!textResp.ok) {
        const errText = await textResp.text()
        throw new Error(`Text model error ${textResp.status}: ${errText}`)
      }

      const textData = (await textResp.json()) as any
      const rawContent = textData?.message?.content || ''

      const parsedResult = this.parseVisionOutput(rawContent, isEs)

      // Save to consciousness service so Capri can hold conversations and remember what was shown
      consciousnessService.setLastScannedContext({
        summary: parsedResult.summary || 'Screen content',
        tags: parsedResult.tags || [],
        response: parsedResult.response || '',
        visualDescription,
        timestamp: Date.now()
      })

      // If Capri asked what it is or tagged unknown / learn, set pending learning
      const respText = parsedResult.response || ''
      const isUnknown = parsedResult.tags?.some((t) => /UNKNOWN|LEARN/i.test(t)) ||
        /(?:no\s+sé|no\s+se|no\s+llego\s+a\s+distinguir|qué\s+es\s+esto|qué\s+me\s+estás\s+mostrando|don't\s+know|can't\s+tell|what\s+are\s+you\s+showing)/i.test(respText)

      if (isUnknown) {
        consciousnessService.setPendingScanLearning({
          description: visualDescription,
          tags: parsedResult.tags || []
        })
      }

      // Broadcast result to UI (Scanner HUD tags & result state)
      windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
        type: 'result',
        result: parsedResult,
        tags: parsedResult.tags
      })

      // Capri announces reaction via speech bubble and neural voice
      agentManager.setCompanionState('talking')
      const speechText =
        parsedResult.response ||
        (isEs ? '¡Interesante lo que me mostrás en el marco, choomba!' : 'Interesting view inside the frame, choomba!')
      const durationMs = Math.max(4500, speechText.length * 65)
      agentManager.setCompanionSpeech(speechText, durationMs, true)

      setTimeout(() => {
        agentManager.setCompanionState('happy')
      }, Math.min(durationMs, 5000))

      return parsedResult
    } catch (err: any) {
      console.error('[ScannerService] Scan error:', err)
      const isTimeout = err?.name === 'TimeoutError' || err?.message?.toLowerCase().includes('timeout')
      const errMessage = isTimeout
        ? (isEs
            ? 'El modelo de visión tardó un momento en cargar sus pesos a la GPU. Ya está listo, ¡tirale el escaneo de nuevo, choomba!'
            : "The vision model took a moment to load weights into VRAM. It's warm now, hit scan again, choomba!")
        : (isEs
            ? `Glitcheo en el escáner óptico: ${err?.message || err}. ¡Reintentá en un instante, choomba!`
            : `Optical scanner glitch: ${err?.message || err}. Try again in a flash, choomba!`)
      this.finishScanError(errMessage)
      return { success: false, error: err?.message || String(err), response: errMessage }
    } finally {
      this.isScanning = false
      this.broadcastStatus()
    }
  }

  /**
   * Learns how to draw an object/character shown inside the scanner frame.
   * Uses multimodal vision to analyze the drawing's geometry and outlines,
   * then synthesizes a DrawingPlan with LLM and saves it to learnedDrawings memory.
   */
  public async learnDrawing(explicitSubject?: string): Promise<{ success: boolean; subject: string; response: string; plan?: any }> {
    if (this.isScanning) {
      return { success: false, subject: explicitSubject || 'dibujo', response: 'Un escaneo ya está en progreso.' }
    }

    const win = windowManager.getScannerWindow()
    if (!win || win.isDestroyed() || !win.isVisible()) {
      this.open()
      await new Promise((r) => setTimeout(r, 250))
    }

    this.isScanning = true
    this.lastScanTime = Date.now()

    windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
      type: 'scanning',
      isScanning: true
    })
    agentManager.setCompanionState('curious')

    const isEs = explicitSubject ? /[áéíóúñ¿¡]|\b(perro|gato|casa|dibujo|auto|arbol|sol|este|esta)\b/i.test(explicitSubject) : false

    try {
      const capture = await this.captureRegionBase64()
      if (!capture) {
        throw new Error(isEs ? 'No se pudo capturar la región del marco.' : 'Could not capture region inside frame.')
      }

      // Direct vector contour extraction from raw capture bitmap (instant, mathematical, hallucination-free)
      const { ContourVectorizer } = await import('./paint/contour-vectorizer')
      const vecResult = capture.bitmap
        ? ContourVectorizer.vectorizeBitmap(capture.bitmap, capture.width, capture.height)
        : null

      let finalSubject = explicitSubject ? explicitSubject.trim().toLowerCase() : ''
      const isGeneric = !finalSubject || /^(?:este\s+logo|el\s+logo|un\s+logo|logo|este\s+dibujo|el\s+dibujo|un\s+dibujo|dibujo|drawing|sketch|esto|this)$/i.test(finalSubject)

      let visualDescription = ''

      // If generic subject or not a high-contrast line drawing, query vision model
      if (isGeneric || !vecResult?.isLineDrawing) {
        await ollamaService.ensureRunning()
        const visionModel = await this.detectVisionModel()
        if (visionModel) {
          const visionPrompt = `You are an expert design, sketch, and emblem analysis AI.
Analyze the drawing, logo, emblem, symbol, or illustration inside this frame carefully to identify what it is.

1. EXACT IDENTITY:
- What specific logo, brand, character, animal, or object is this? (e.g. "dog", "cat", "Arasaka logo", "heart", "stickman", "house", "car", etc.)
- Write: "IDENTITY: <Exact Name>"

2. GEOMETRIC AND VECTOR BREAKDOWN:
- Break down its key contours, silhouette, and proportions in 1 or 2 concise sentences.`

          try {
            const visionResp = await llmFetch('http://127.0.0.1:11434/api/generate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: llmBody({
                model: visionModel,
                keep_alive: '15m',
                prompt: visionPrompt,
                images: [capture.base64],
                stream: false,
                options: {
                  temperature: 0.2,
                  num_predict: 180
                }
              }),
              signal: AbortSignal.timeout(60000)
            })

            if (visionResp.ok) {
              const visionData = (await visionResp.json()) as any
              visualDescription = (visionData?.response || '').trim()
            }
          } catch (e) {
            console.warn('[ScannerService] Vision model call error in learnDrawing:', e)
          }
        }
      }

      if (isGeneric && visualDescription) {
        const idMatch = visualDescription.match(/IDENTITY:\s*([^\n\r.]+)/i)
        if (idMatch && idMatch[1]) {
          finalSubject = idMatch[1].replace(/^(?:the\s+|a\s+|an\s+|el\s+|la\s+|un\s+|una\s+)/i, '').trim().toLowerCase()
        }
        const knownCheck = visualDescription.toLowerCase()
        if (/arasaka/i.test(knownCheck)) finalSubject = 'arasaka logo'
        else if (/edgerunners/i.test(knownCheck)) finalSubject = 'edgerunners logo'
        else if (/samurai/i.test(knownCheck)) finalSubject = 'samurai logo'
        else if (/nike|swoosh/i.test(knownCheck)) finalSubject = 'nike logo'
        // Before the apple: "Apple Music" is the music note, not the apple
        else if (/apple\s*music|itunes|music(?:al)?\s+note|nota\s+musical/i.test(knownCheck)) finalSubject = 'apple music logo'
        else if (/apple/i.test(knownCheck)) finalSubject = 'apple logo'
        else if (/batman/i.test(knownCheck)) finalSubject = 'batman logo'
        else if (/windows|microsoft/i.test(knownCheck)) finalSubject = 'windows logo'
        else if (/perro|dog/i.test(knownCheck)) finalSubject = 'perro'
        else if (/gato|cat/i.test(knownCheck)) finalSubject = 'gato'
        else if (/corazon|heart/i.test(knownCheck)) finalSubject = 'corazón'
      }

      if (!finalSubject || finalSubject === 'dibujo' || finalSubject === 'drawing') {
        finalSubject = isEs ? 'dibujo' : 'drawing'
      }

      let plan: any = null

      if (vecResult && vecResult.isLineDrawing && vecResult.shapes.length > 0) {
        console.log(`[ScannerService] High-contrast line drawing detected (${vecResult.shapes.length} contours)! Directly vectorizing without VLM hallucinations.`)
        const { StrokeValidator } = await import('./paint/stroke-validator')
        const rawPlan = {
          subject: finalSubject,
          comment: isEs
            ? `Técnica aprendida directamente de tus trazos para ${finalSubject}`
            : `Technique learned directly from your strokes for ${finalSubject}`,
          shapes: vecResult.shapes
        }
        const validation = StrokeValidator.validate(rawPlan)
        if (validation.valid && validation.sanitizedPlan) {
          plan = validation.sanitizedPlan
        } else {
          plan = rawPlan
        }
        consciousnessService.saveLearnedDrawing(
          finalSubject,
          `Vectorizado directamente de los trazos reales del usuario: ${finalSubject}`,
          plan
        )
      } else {
        const { llmDrawingPlanner } = await import('./paint/llm-drawing-planner')
        plan = await llmDrawingPlanner.learnDrawingFromScan(finalSubject, visualDescription)
      }

      const successResponse = isEs
        ? `¡Upa, qué buena técnica! Ya escaneé los trazos y me guardé la técnica para dibujar "${finalSubject}" en mi memoria cibernética. ¡La próxima vez que me pidas que dibuje "${finalSubject}", te lo saco con este estilo que me enseñaste!`
        : `Whoa, nice technique! Scanned the strokes and locked the technique for "${finalSubject}" into my cyberware. Next time you ask me to draw "${finalSubject}", I'll draw it with the style you taught me!`

      agentManager.setCompanionState('happy')
      windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
        type: 'result',
        result: {
          success: true,
          summary: `Dibujo aprendido: ${finalSubject}`,
          tags: ['LEARNED_DRAWING', finalSubject.toUpperCase()],
          response: successResponse
        },
        tags: ['LEARNED_DRAWING', finalSubject.toUpperCase()]
      })

      const durationMs = Math.max(4500, successResponse.length * 65)
      agentManager.setCompanionSpeech(successResponse, durationMs, true)

      return {
        success: true,
        subject: finalSubject,
        response: successResponse,
        plan
      }
    } catch (err: any) {
      console.warn('[ScannerService] Learn drawing error:', err)
      const errorMsg = isEs
        ? `No pude completar el escaneo del dibujo, choomba: ${err?.message || err}. ¡Probá de vuelta!`
        : `Could not complete the drawing scan, {name}: ${err?.message || err}. Try again!`
      this.finishScanError(errorMsg)
      return { success: false, subject: explicitSubject || 'dibujo', response: errorMsg }
    } finally {
      this.isScanning = false
      this.broadcastStatus()
    }
  }

  private finishScanError(message: string): void {
    windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
      type: 'error',
      error: message
    })
    agentManager.setCompanionState('curious')
    agentManager.setCompanionSpeech(message, 5000, true)
  }

  private parseVisionOutput(raw: string, isEs: boolean): ScannerScanResult {
    let clean = raw.trim()
    // Extract JSON block if wrapped in markdown
    const jsonMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (jsonMatch) {
      clean = jsonMatch[1].trim()
    } else {
      // Find outermost braces if raw text has introductory comments
      const firstBrace = clean.indexOf('{')
      const lastBrace = clean.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        clean = clean.slice(firstBrace, lastBrace + 1).trim()
      }
    }

    try {
      const obj = JSON.parse(clean)
      const summary = obj.summary || (isEs ? 'Contenido escaneado en pantalla' : 'Scanned screen content')
      const tags = Array.isArray(obj.tags) && obj.tags.length > 0 ? obj.tags.map((t: any) => String(t).toUpperCase()) : ['OPTICAL_SCAN', 'SCREEN_REGION']
      let response = String(obj.response || obj.reaction || '').trim()

      if (!response && obj.summary) {
        response = isEs
          ? `¡Mirá eso! Veo ${obj.summary.toLowerCase()}, ¡qué zarpado!`
          : `Look at that! I see ${obj.summary.toLowerCase()}, pretty wild!`
      }

      if (!response) {
        response = isEs
          ? '¡Mirá lo que me mostrás en pantalla, {name}! Mis implantes ópticos ya lo tienen registrado.'
          : 'Look at what you have on screen, {name}! My cyber-optics got it locked in.'
      }

      // Strip emojis from speech
      response = response
        .replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
        .trim()

      return {
        success: true,
        summary,
        tags,
        response
      }
    } catch {
      // Robust regex field recovery if JSON had syntax errors like unescaped inner quotes
      const respRegex = clean.match(/"response"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i) || clean.match(/"response"\s*:\s*"([\s\S]*?)"(?:\s*,|\s*})/i)
      const summaryRegex = clean.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i) || clean.match(/"summary"\s*:\s*"([\s\S]*?)"(?:\s*,|\s*})/i)

      let extractedResponse = respRegex ? respRegex[1].replace(/\\"/g, '"').trim() : ''
      const extractedSummary = summaryRegex ? summaryRegex[1].replace(/\\"/g, '"').trim() : (isEs ? 'Contenido visual detectado' : 'Visual content detected')

      if (extractedResponse) {
        extractedResponse = extractedResponse
          .replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
          .trim()
        return {
          success: true,
          summary: extractedSummary,
          tags: ['OPTICAL_SCAN', 'RECOGNIZED'],
          response: extractedResponse
        }
      }

      // Final fallback: strip raw markdown and emojis
      let text = clean.replace(/```(?:json)?|```/g, '').replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]/gu, '').trim()
      if (!text || text.startsWith('{')) {
        text = isEs
          ? '¡Listo el escaneo óptico, choomba! Mis implantes ya registraron todo lo que tenés en el marco.'
          : "Optical scan complete, choomba! My cyberware registered everything inside the frame."
      }
      return {
        success: true,
        summary: isEs ? 'Contenido visual detectado' : 'Visual content detected',
        tags: ['SCANNER_ACTIVE', 'NEURAL_VISION'],
        response: text
      }
    }
  }

  // --- Continuous Scan Loop ---
  private startContinuousLoop(): void {
    if (this.continuousTimer) return
    this.continuousTimer = setInterval(() => {
      this.tickContinuous()
    }, 3500)
  }

  private stopContinuousLoop(): void {
    if (this.continuousTimer) {
      clearInterval(this.continuousTimer)
      this.continuousTimer = null
    }
  }

  private async tickContinuous(): Promise<void> {
    if (!this.isContinuous || this.isScanning) return
    const win = windowManager.getScannerWindow()
    if (!win || win.isDestroyed() || !win.isVisible()) return

    // Cooldown check: at least 9 seconds between consecutive autonomous scans
    if (Date.now() - this.lastScanTime < 9000) return

    try {
      const capture = await this.captureRegionBase64()
      if (!capture || !capture.rawBuffer) return

      if (this.lastSampleBuffer) {
        const diffRatio = this.calculateBufferDiff(this.lastSampleBuffer, capture.rawBuffer)
        // If content changed by > 18%, trigger scan
        if (diffRatio > 0.18) {
          const prefLang = consciousnessService.getPreferredLanguage()
          const prompt = prefLang === 'es' ? 'Contenido actualizado en el marco' : 'Updated content inside frame'
          await this.scan(prompt)
        }
      } else {
        this.lastSampleBuffer = capture.rawBuffer
      }
    } catch {
      // Quiet fail on continuous sample
    }
  }

  private calculateBufferDiff(bufA: Buffer, bufB: Buffer): number {
    const len = Math.min(bufA.length, bufB.length)
    if (len < 500) return 0
    // Fast step sampling across byte array
    const step = Math.max(1, Math.floor(len / 400))
    let diffs = 0
    let total = 0
    for (let i = 0; i < len; i += step) {
      total++
      if (Math.abs(bufA[i] - bufB[i]) > 32) {
        diffs++
      }
    }
    return total > 0 ? diffs / total : 0
  }
}

export const scannerService = ScannerService.getInstance()
