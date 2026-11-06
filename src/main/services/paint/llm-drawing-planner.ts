import { llmFetch } from '../llm-gateway'
import { llmBody } from '../user-profile'
import { DrawingPlan, StrokeShape } from './types'
import { StrokeValidator } from './stroke-validator'
import { ollamaService } from '../ollama-service'
import { consciousnessService } from '../consciousness-service'

export interface PlannedDrawingResult {
  plan: DrawingPlan
  isFallback: boolean
  isLearned?: boolean
  learnedDescription?: string
  modelUsed?: string
  rawComment?: string
}

const SYSTEM_PROMPT = `You are Capri, an autonomous AI netrunner and drawing companion.
Your task is to plan clean, minimalist, expressive drawings for MS Paint on a normalized 100x100 grid (0,0 is top-left, 100,100 is bottom-right).

STYLE & COMPOSITION RULES:
- Style: Clean, expressive, minimalist cyber-sketch style (simple geometric outlines, stick figures, clean curves, recognizable silhouettes).
- IMPORTANT - NO DUPLICATE STROKES: Draw each contour, shape, or line EXACTLY ONCE. Never draw duplicate concentric copies or repeated layers of the same shape.
- TOTAL SHAPES: Keep it concise between 1 and 15 shapes total. (For simple shapes like a heart, circle, star, or smile: 1 to 3 shapes is enough; for animals, houses, or characters: 4 to 12 shapes).
- Keep all coordinates centered between 10 and 90.

PRIMITIVES ALLOWED:
1. "line": {"type": "line", "x1": number, "y1": number, "x2": number, "y2": number}
2. "polyline": {"type": "polyline", "points": [[x, y], [x, y], ...], "closed": boolean}
3. "circle": {"type": "circle", "cx": number, "cy": number, "r": number}
4. "ellipse": {"type": "ellipse", "cx": number, "cy": number, "rx": number, "ry": number}
5. "arc": {"type": "arc", "cx": number, "cy": number, "rx": number, "ry": number, "startAngle": number, "endAngle": number}
6. "curve": {"type": "curve", "p0": [x,y], "p1": [x,y], "p2": [x,y], "p3"?: [x,y]}

SCHEMA (OUTPUT MUST BE STRICTLY RAW JSON ONLY):
{
  "subject": "name of subject",
  "comment": "short witty note in character",
  "shapes": [ ...array of primitives... ]
}

FEW-SHOT EXAMPLES (FOR FORMAT GUIDANCE ONLY):
Example 1 (Stickman):
{
  "subject": "monigote",
  "comment": "Un monigote clasico",
  "shapes": [
    {"type": "circle", "cx": 50, "cy": 25, "r": 10},
    {"type": "arc", "cx": 50, "cy": 27, "rx": 5, "ry": 3, "startAngle": 0, "endAngle": 180},
    {"type": "line", "x1": 50, "y1": 35, "x2": 50, "y2": 65},
    {"type": "line", "x1": 50, "y1": 45, "x2": 25, "y2": 38},
    {"type": "line", "x1": 50, "y1": 45, "x2": 75, "y2": 38},
    {"type": "line", "x1": 50, "y1": 65, "x2": 30, "y2": 90},
    {"type": "line", "x1": 50, "y1": 65, "x2": 70, "y2": 90}
  ]
}

Example 2 (Heart):
{
  "subject": "corazón",
  "comment": "Un corazón simple y limpio",
  "shapes": [
    {"type": "curve", "p0": [50, 80], "p1": [15, 40], "p2": [30, 15], "p3": [50, 35]},
    {"type": "curve", "p0": [50, 35], "p1": [70, 15], "p2": [85, 40], "p3": [50, 80]}
  ]
}

Example 3 (House):
{
  "subject": "casa",
  "comment": "Una casita simple",
  "shapes": [
    {"type": "polyline", "points": [[25, 55], [75, 55], [75, 90], [25, 90], [25, 55]], "closed": true},
    {"type": "polyline", "points": [[20, 55], [50, 25], [80, 55]], "closed": false},
    {"type": "polyline", "points": [[42, 90], [42, 68], [58, 68], [58, 90]], "closed": false},
    {"type": "polyline", "points": [[60, 60], [70, 60], [70, 72], [60, 72], [60, 60]], "closed": true}
  ]
}

Example 4 (Cat Face):
{
  "subject": "gato",
  "comment": "Un michi con orejitas y bigotes",
  "shapes": [
    {"type": "circle", "cx": 50, "cy": 50, "r": 20},
    {"type": "polyline", "points": [[35, 34], [30, 18], [43, 30]], "closed": true},
    {"type": "polyline", "points": [[65, 34], [70, 18], [57, 30]], "closed": true},
    {"type": "circle", "cx": 43, "cy": 46, "r": 2.5},
    {"type": "circle", "cx": 57, "cy": 46, "r": 2.5},
    {"type": "arc", "cx": 50, "cy": 52, "rx": 5, "ry": 3, "startAngle": 0, "endAngle": 180},
    {"type": "line", "x1": 37, "y1": 52, "x2": 20, "y2": 48},
    {"type": "line", "x1": 37, "y1": 56, "x2": 22, "y2": 60},
    {"type": "line", "x1": 63, "y1": 52, "x2": 80, "y2": 48},
    {"type": "line", "x1": 63, "y1": 56, "x2": 78, "y2": 60}
  ]
}

Example 5 (Logo/Emblem - e.g. Arasaka Corporate Crest):
{
  "subject": "arasaka logo",
  "comment": "Emblema corporativo de Arasaka",
  "shapes": [
    {"type": "circle", "cx": 50, "cy": 48, "r": 42},
    {"type": "circle", "cx": 50, "cy": 44, "r": 8},
    {"type": "circle", "cx": 50, "cy": 22, "r": 12},
    {"type": "circle", "cx": 31, "cy": 54, "r": 12},
    {"type": "circle", "cx": 69, "cy": 54, "r": 12},
    {"type": "line", "x1": 50, "y1": 36, "x2": 50, "y2": 22},
    {"type": "line", "x1": 43, "y1": 48, "x2": 31, "y2": 54},
    {"type": "line", "x1": 57, "y1": 48, "x2": 69, "y2": 54},
    {"type": "polyline", "points": [[47, 52], [47, 84], [53, 84], [53, 52]], "closed": true},
    {"type": "line", "x1": 38, "y1": 84, "x2": 62, "y2": 84}
  ]
}

CRITICAL: Return ONLY valid raw JSON. Draw each contour ONCE without repeating or layering strokes.`

export class LlmDrawingPlanner {
  private static instance: LlmDrawingPlanner

  public static getInstance(): LlmDrawingPlanner {
    if (!LlmDrawingPlanner.instance) {
      LlmDrawingPlanner.instance = new LlmDrawingPlanner()
    }
    return LlmDrawingPlanner.instance
  }

  /**
   * Plans a drawing using Ollama, with robust parsing and up to 2 correction retries.
   * If a learned drawing exists in memory, returns the learned drawing plan immediately!
   */
  public async planDrawing(subject: string, language: 'es' | 'en' = 'es'): Promise<PlannedDrawingResult> {
    const cleanSubject = subject.trim() || 'dibujo'
    console.log(`[LlmDrawingPlanner] Planning drawing for subject: "${cleanSubject}"...`)

    // Check if Capri previously learned how to draw this subject with the scanner
    const learned = consciousnessService.getLearnedDrawing(cleanSubject)
    if (learned && learned.plan) {
      console.log(`[LlmDrawingPlanner] Using learned drawing memory for "${cleanSubject}" from scanner!`)
      return {
        plan: learned.plan,
        isFallback: false,
        isLearned: true,
        learnedDescription: learned.visualDescription,
        modelUsed: 'learned_scanner_memory',
        rawComment: `Aprendido con el scanner: ${learned.visualDescription}`
      }
    }

    // Ensure Ollama is running
    let status = await ollamaService.ensureRunning()
    if (!status.running) {
      console.warn('[LlmDrawingPlanner] Ollama is not running. Using in-character fallback.')
      return this.createFallbackPlan(cleanSubject)
    }

    // Select model
    const candidateModels = status.models || []
    let selectedModel = 'qwen2.5-coder:7b'
    if (candidateModels.length > 0) {
      if (candidateModels.includes('qwen2.5-coder:7b')) {
        selectedModel = 'qwen2.5-coder:7b'
      } else if (candidateModels.includes('qwen2.5-coder:1.5b')) {
        selectedModel = 'qwen2.5-coder:1.5b'
      } else if (candidateModels.some((m: string) => m.toLowerCase().includes('qwen'))) {
        selectedModel = candidateModels.find((m: string) => m.toLowerCase().includes('qwen'))!
      } else {
        selectedModel = candidateModels[0]
      }
    }

    console.log(`[LlmDrawingPlanner] Using model: ${selectedModel}`)

    // Conversation loop with up to 2 retries
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Plan a simple, expressive sketch of: "${cleanSubject}". Draw each element ONCE. Output ONLY the raw JSON object.`
      }
    ]

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const responseText = await this.queryOllama(selectedModel, messages)
        const extracted = this.extractJson(responseText)

        if (extracted) {
          const parsed = JSON.parse(extracted)
          const validation = StrokeValidator.validate(parsed)

          if (validation.valid && validation.sanitizedPlan) {
            console.log(
              `[LlmDrawingPlanner] Drawing plan for "${cleanSubject}" successfully generated on attempt ${attempt} with ${validation.sanitizedPlan.shapes.length} shapes.`
            )
            return {
              plan: validation.sanitizedPlan,
              isFallback: false,
              isLearned: false,
              modelUsed: selectedModel,
              rawComment: validation.sanitizedPlan.comment
            }
          } else {
            console.warn(
              `[LlmDrawingPlanner] Attempt ${attempt} validation errors:`,
              validation.errors
            )
            if (attempt < 3) {
              messages.push({ role: 'assistant', content: responseText })
              messages.push({
                role: 'user',
                content: `Validation error: ${validation.errors?.join(', ')}. Please fix and output ONLY the corrected JSON.`
              })
            }
          }
        } else {
          console.warn(`[LlmDrawingPlanner] Attempt ${attempt} did not produce a parseable JSON block.`)
          if (attempt < 3) {
            messages.push({ role: 'assistant', content: responseText })
            messages.push({
              role: 'user',
              content: 'Error: No valid JSON found. Please respond ONLY with the raw JSON object matching the schema.'
            })
          }
        }
      } catch (err: any) {
        console.warn(`[LlmDrawingPlanner] Attempt ${attempt} encountered error:`, err?.message || err)
      }
    }

    console.warn('[LlmDrawingPlanner] Retries exhausted. Falling back to procedural drawing.')
    return this.createFallbackPlan(cleanSubject)
  }

  /**
   * Synthesizes a new drawing plan based on a visual scan of a user drawing.
   * Stores the learned plan into persistent memory so Capri can draw it next time.
   */
  public async learnDrawingFromScan(subject: string, visualDescription: string): Promise<DrawingPlan> {
    const cleanSubj = subject.trim().toLowerCase()
    console.log(`[LlmDrawingPlanner] Learning drawing for "${cleanSubj}" from scanner description...`)

    let plan: DrawingPlan | null = null

    try {
      await ollamaService.ensureRunning()
      const status = await ollamaService.queryTags()
      const candidateModels = status.models || []
      const model =
        candidateModels.find((m: string) => m.includes('qwen2.5-coder:7b')) ||
        candidateModels.find((m: string) => m.includes('qwen')) ||
        candidateModels[0] ||
        'qwen2.5-coder:7b'

      const prompt = `{name} showed Capri a drawing of "${cleanSubj}" on the optical scanner.
Visual breakdown observed from the frame:
"""
${visualDescription}
"""

Convert this visual structure into a normalized 100x100 grid DrawingPlan JSON matching the schema.
Capture the unique style and components shown. Draw each element ONCE without duplicate or repeated strokes.
Output ONLY the raw JSON object.`

      const responseText = await this.queryOllama(model, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ])

      const extracted = this.extractJson(responseText)
      if (extracted) {
        const parsed = JSON.parse(extracted)
        const validation = StrokeValidator.validate(parsed)
        if (validation.valid && validation.sanitizedPlan) {
          plan = validation.sanitizedPlan
        }
      }
    } catch (e) {
      console.warn('[LlmDrawingPlanner] Error synthesizing learned drawing with LLM:', e)
    }

    if (!plan) {
      // Fallback plan if LLM failed
      const fallbackResult = this.createFallbackPlan(cleanSubj)
      plan = fallbackResult.plan
    }

    // Persist learned drawing in consciousness service and on disk
    consciousnessService.saveLearnedDrawing(cleanSubj, visualDescription, plan)
    return plan
  }

  private async queryOllama(
    model: string,
    messages: { role: string; content: string }[]
  ): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const res = await llmFetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: llmBody({
          model,
          messages,
          stream: false,
          options: {
            temperature: 0.35,
            num_predict: 800
          }
        }),
        signal: controller.signal
      })

      if (!res.ok) {
        throw new Error(`Ollama HTTP ${res.status}: ${res.statusText}`)
      }

      const data = (await res.json()) as any
      return data?.message?.content || ''
    } finally {
      clearTimeout(timeout)
    }
  }

  private extractJson(text: string): string | null {
    if (!text || typeof text !== 'string') return null

    // Strip code fences like ```json ... ```
    let cleaned = text.replace(/```(?:json)?([\s\S]*?)```/gi, '$1').trim()

    // Find the outermost balanced or matching { ... }
    const firstBrace = cleaned.indexOf('{')
    const lastBrace = cleaned.lastIndexOf('}')

    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return cleaned.slice(firstBrace, lastBrace + 1)
    }

    return null
  }

  /**
   * Procedural in-character fallback if Ollama is unavailable or retries fail.
   */
  /**
   * Generates high-fidelity vector primitives for well-known iconic logos and emblems
   */
  public getKnownLogoPlan(subject: string, visualDesc: string = ''): DrawingPlan | null {
    const combined = `${subject} ${visualDesc}`.toLowerCase()

    if (/arasaka/i.test(combined)) {
      return {
        subject: 'arasaka logo',
        comment: 'El legendario emblema corporativo de Arasaka',
        shapes: [
          { type: 'circle', cx: 50, cy: 48, r: 42 },
          { type: 'circle', cx: 50, cy: 44, r: 8 },
          { type: 'circle', cx: 50, cy: 22, r: 12 },
          { type: 'circle', cx: 31, cy: 54, r: 12 },
          { type: 'circle', cx: 69, cy: 54, r: 12 },
          { type: 'line', x1: 50, y1: 36, x2: 50, y2: 22 },
          { type: 'line', x1: 43, y1: 48, x2: 31, y2: 54 },
          { type: 'line', x1: 57, y1: 48, x2: 69, y2: 54 },
          { type: 'polyline', points: [[47, 52], [47, 84], [53, 84], [53, 52]], closed: true },
          { type: 'line', x1: 38, y1: 84, x2: 62, y2: 84 }
        ]
      }
    }

    if (/edgerunners/i.test(combined)) {
      return {
        subject: 'edgerunners logo',
        comment: 'El monograma cyber-hazard ER de Edgerunners',
        shapes: [
          { type: 'polyline', points: [[24, 22], [24, 78], [34, 78], [34, 22]], closed: true },
          { type: 'polyline', points: [[34, 22], [54, 22], [50, 32], [34, 32]], closed: true },
          { type: 'polyline', points: [[34, 45], [48, 45], [44, 55], [34, 55]], closed: true },
          { type: 'polyline', points: [[34, 68], [54, 68], [58, 78], [34, 78]], closed: true },
          { type: 'polyline', points: [[58, 22], [58, 78], [66, 78], [66, 22]], closed: true },
          { type: 'polyline', points: [[66, 22], [80, 22], [86, 35], [80, 48], [66, 48]], closed: true },
          { type: 'polyline', points: [[66, 30], [74, 30], [76, 35], [74, 40], [66, 40]], closed: true },
          { type: 'polyline', points: [[68, 48], [86, 78], [76, 78], [62, 52]], closed: true },
          { type: 'line', x1: 15, y1: 16, x2: 26, y2: 16 },
          { type: 'line', x1: 84, y1: 84, x2: 95, y2: 84 }
        ]
      }
    }

    if (/samurai/i.test(combined)) {
      return {
        subject: 'samurai logo',
        comment: 'El oni cyber-skull de Samurai',
        shapes: [
          { type: 'polyline', points: [[32, 28], [22, 12], [38, 20]], closed: true },
          { type: 'polyline', points: [[68, 28], [78, 12], [62, 20]], closed: true },
          { type: 'polyline', points: [[32, 28], [50, 34], [68, 28]], closed: false },
          { type: 'polyline', points: [[34, 38], [44, 42], [35, 45]], closed: true },
          { type: 'polyline', points: [[66, 38], [56, 42], [65, 45]], closed: true },
          { type: 'polyline', points: [[36, 62], [64, 62], [60, 78], [40, 78]], closed: true },
          { type: 'line', x1: 44, y1: 62, x2: 44, y2: 78 },
          { type: 'line', x1: 50, y1: 62, x2: 50, y2: 78 },
          { type: 'line', x1: 56, y1: 62, x2: 56, y2: 78 },
          { type: 'polyline', points: [[30, 48], [40, 85], [60, 85], [70, 48]], closed: false }
        ]
      }
    }

    if (/nike|swoosh/i.test(combined)) {
      return {
        subject: 'nike logo',
        comment: 'El clásico swoosh de Nike',
        shapes: [
          { type: 'curve', p0: [15, 50], p1: [40, 75], p2: [68, 68], p3: [88, 24] },
          { type: 'curve', p0: [88, 24], p1: [58, 52], p2: [32, 52], p3: [15, 50] }
        ]
      }
    }

    // Before the apple: Apple Music's logo is a music note in a rounded square
    if (/apple\s*music|itunes|music(?:al)?\s+note|nota\s+musical/i.test(combined)) {
      return {
        subject: 'apple music logo',
        comment: 'La nota musical de Apple Music',
        shapes: [
          { type: 'line', x1: 30, y1: 18, x2: 70, y2: 18 },
          { type: 'curve', p0: [70, 18], p1: [77, 18], p2: [82, 23], p3: [82, 30] },
          { type: 'line', x1: 82, y1: 30, x2: 82, y2: 70 },
          { type: 'curve', p0: [82, 70], p1: [82, 77], p2: [77, 82], p3: [70, 82] },
          { type: 'line', x1: 70, y1: 82, x2: 30, y2: 82 },
          { type: 'curve', p0: [30, 82], p1: [23, 82], p2: [18, 77], p3: [18, 70] },
          { type: 'line', x1: 18, y1: 70, x2: 18, y2: 30 },
          { type: 'curve', p0: [18, 30], p1: [18, 23], p2: [23, 18], p3: [30, 18] },
          { type: 'line', x1: 41, y1: 35, x2: 41, y2: 64 },
          { type: 'line', x1: 63, y1: 29, x2: 63, y2: 58 },
          { type: 'polyline', points: [[41, 35], [63, 29], [63, 35], [41, 41]], closed: true },
          { type: 'ellipse', cx: 36, cy: 64, rx: 6, ry: 4.5 },
          { type: 'ellipse', cx: 58, cy: 58, rx: 6, ry: 4.5 }
        ]
      }
    }

    if (/apple/i.test(combined)) {
      return {
        subject: 'apple logo',
        comment: 'La manzana mordida de Apple',
        shapes: [
          { type: 'curve', p0: [50, 32], p1: [25, 25], p2: [20, 65], p3: [40, 82] },
          { type: 'curve', p0: [40, 82], p1: [46, 85], p2: [54, 85], p3: [60, 82] },
          { type: 'curve', p0: [60, 82], p1: [80, 65], p2: [75, 55], p3: [68, 48] },
          { type: 'arc', cx: 72, cy: 48, rx: 12, ry: 12, startAngle: 90, endAngle: 270 },
          { type: 'curve', p0: [68, 48], p1: [75, 40], p2: [75, 25], p3: [50, 32] },
          { type: 'curve', p0: [52, 28], p1: [55, 15], p2: [68, 12], p3: [72, 18] },
          { type: 'curve', p0: [72, 18], p1: [68, 26], p2: [58, 28], p3: [52, 28] }
        ]
      }
    }

    if (/batman|bat-signal|murcielago/i.test(combined)) {
      return {
        subject: 'batman logo',
        comment: 'La batiseñal de Batman',
        shapes: [
          { type: 'ellipse', cx: 50, cy: 50, rx: 42, ry: 26 },
          { type: 'polyline', points: [[46, 38], [47, 34], [49, 36], [51, 36], [53, 34], [54, 38]], closed: false },
          { type: 'curve', p0: [46, 38], p1: [35, 32], p2: [25, 36], p3: [12, 45] },
          { type: 'curve', p0: [54, 38], p1: [65, 32], p2: [75, 36], p3: [88, 45] },
          { type: 'curve', p0: [12, 45], p1: [18, 56], p2: [28, 58], p3: [34, 52] },
          { type: 'curve', p0: [34, 52], p1: [38, 62], p2: [44, 65], p3: [50, 68] },
          { type: 'curve', p0: [88, 45], p1: [82, 56], p2: [72, 58], p3: [66, 52] },
          { type: 'curve', p0: [66, 52], p1: [62, 62], p2: [56, 65], p3: [50, 68] }
        ]
      }
    }

    if (/windows|microsoft/i.test(combined)) {
      return {
        subject: 'windows logo',
        comment: 'El logo de cuatro cuadrantes de Windows',
        shapes: [
          { type: 'polyline', points: [[22, 26], [46, 22], [46, 46], [22, 48]], closed: true },
          { type: 'polyline', points: [[54, 21], [78, 17], [78, 44], [54, 46]], closed: true },
          { type: 'polyline', points: [[22, 54], [46, 54], [46, 78], [22, 82]], closed: true },
          { type: 'polyline', points: [[54, 54], [78, 54], [78, 83], [54, 78]], closed: true }
        ]
      }
    }

    if (/mcdonald|mcdonalds|arcos/i.test(combined)) {
      return {
        subject: 'mcdonalds logo',
        comment: 'Los arcos dorados de McDonald\'s',
        shapes: [
          { type: 'curve', p0: [20, 80], p1: [22, 25], p2: [44, 25], p3: [50, 58] },
          { type: 'curve', p0: [50, 58], p1: [56, 25], p2: [78, 25], p3: [80, 80] },
          { type: 'curve', p0: [26, 80], p1: [28, 33], p2: [42, 33], p3: [50, 68] },
          { type: 'curve', p0: [50, 68], p1: [58, 33], p2: [72, 33], p3: [74, 80] }
        ]
      }
    }

    if (/youtube/i.test(combined)) {
      return {
        subject: 'youtube logo',
        comment: 'El reproductor de YouTube',
        shapes: [
          { type: 'polyline', points: [[24, 28], [76, 28], [84, 36], [84, 64], [76, 72], [24, 72], [16, 64], [16, 36], [24, 28]], closed: true },
          { type: 'polyline', points: [[42, 40], [62, 50], [42, 60]], closed: true }
        ]
      }
    }

    return null
  }

  public createFallbackPlan(subject: string): PlannedDrawingResult {
    const norm = subject.toLowerCase().trim()

    // Check known iconic logos first
    const known = this.getKnownLogoPlan(norm)
    if (known) {
      return {
        plan: known,
        isFallback: true
      }
    }

    let shapes: StrokeShape[] = []
    let comment = 'Dibujo improvisado a mi manera con implantes'

    if (/(?:coraz[oó]n|heart)/i.test(norm)) {
      comment = 'Un corazón cyberpunk'
      shapes = [
        { type: 'curve', p0: [50, 80], p1: [15, 40], p2: [30, 15], p3: [50, 35] },
        { type: 'curve', p0: [50, 35], p1: [70, 15], p2: [85, 40], p3: [50, 80] }
      ]
    } else if (/(?:gato|cat|michi|gatito)/i.test(norm)) {
      comment = 'Un michi cyberpunk con bigotes'
      shapes = [
        { type: 'circle', cx: 50, cy: 50, r: 20 },
        {
          type: 'polyline',
          points: [
            [35, 34],
            [30, 18],
            [43, 30]
          ],
          closed: true
        },
        {
          type: 'polyline',
          points: [
            [65, 34],
            [70, 18],
            [57, 30]
          ],
          closed: true
        },
        { type: 'circle', cx: 43, cy: 46, r: 2.5 },
        { type: 'circle', cx: 57, cy: 46, r: 2.5 },
        { type: 'arc', cx: 50, cy: 52, rx: 5, ry: 3, startAngle: 0, endAngle: 180 },
        { type: 'line', x1: 37, y1: 52, x2: 20, y2: 48 },
        { type: 'line', x1: 37, y1: 56, x2: 22, y2: 60 },
        { type: 'line', x1: 63, y1: 52, x2: 80, y2: 48 },
        { type: 'line', x1: 63, y1: 56, x2: 78, y2: 60 }
      ]
    } else if (/(?:casa|house|casita|hogar)/i.test(norm)) {
      comment = 'Una casita de campo con chimenea'
      shapes = [
        {
          type: 'polyline',
          points: [
            [25, 55],
            [75, 55],
            [75, 90],
            [25, 90],
            [25, 55]
          ],
          closed: true
        },
        {
          type: 'polyline',
          points: [
            [20, 55],
            [50, 25],
            [80, 55]
          ],
          closed: false
        },
        {
          type: 'polyline',
          points: [
            [62, 38],
            [62, 20],
            [72, 20],
            [72, 48]
          ],
          closed: false
        },
        {
          type: 'polyline',
          points: [
            [42, 90],
            [42, 68],
            [58, 68],
            [58, 90]
          ],
          closed: false
        },
        {
          type: 'polyline',
          points: [
            [60, 60],
            [70, 60],
            [70, 72],
            [60, 72],
            [60, 60]
          ],
          closed: true
        },
        { type: 'line', x1: 65, y1: 60, x2: 65, y2: 72 },
        { type: 'line', x1: 60, y1: 66, x2: 70, y2: 66 }
      ]
    } else if (/(?:sol|sun|estrella)/i.test(norm)) {
      comment = 'Un sol radiante de Night City'
      shapes = [
        { type: 'circle', cx: 50, cy: 50, r: 18 },
        { type: 'circle', cx: 44, cy: 46, r: 2 },
        { type: 'circle', cx: 56, cy: 46, r: 2 },
        { type: 'arc', cx: 50, cy: 51, rx: 7, ry: 4, startAngle: 0, endAngle: 180 },
        { type: 'line', x1: 50, y1: 29, x2: 50, y2: 15 },
        { type: 'line', x1: 50, y1: 71, x2: 50, y2: 85 },
        { type: 'line', x1: 29, y1: 50, x2: 15, y2: 50 },
        { type: 'line', x1: 71, y1: 50, x2: 85, y2: 50 },
        { type: 'line', x1: 35, y1: 35, x2: 25, y2: 25 },
        { type: 'line', x1: 65, y1: 35, x2: 75, y2: 25 },
        { type: 'line', x1: 35, y1: 65, x2: 25, y2: 75 },
        { type: 'line', x1: 65, y1: 65, x2: 75, y2: 75 }
      ]
    } else if (/(?:monigote|persona|hombre|chico|stickman|figura)/i.test(norm)) {
      comment = 'Un monigote simpático'
      shapes = [
        { type: 'circle', cx: 50, cy: 25, r: 10 },
        { type: 'arc', cx: 50, cy: 27, rx: 5, ry: 3, startAngle: 0, endAngle: 180 },
        { type: 'line', x1: 50, y1: 35, x2: 50, y2: 65 },
        { type: 'line', x1: 50, y1: 45, x2: 25, y2: 38 },
        { type: 'line', x1: 50, y1: 45, x2: 75, y2: 38 },
        { type: 'line', x1: 50, y1: 65, x2: 30, y2: 90 },
        { type: 'line', x1: 50, y1: 65, x2: 70, y2: 90 }
      ]
    } else {
      // Default: Clean cyber stick figure
      comment = `Una versión libre y estilizada de ${subject}`
      shapes = [
        {
          type: 'polyline',
          points: [
            [35, 30],
            [65, 30],
            [65, 60],
            [35, 60],
            [35, 30]
          ],
          closed: true
        },
        { type: 'circle', cx: 45, cy: 45, r: 4 },
        { type: 'circle', cx: 55, cy: 45, r: 4 },
        { type: 'line', x1: 42, y1: 54, x2: 58, y2: 54 },
        { type: 'line', x1: 50, y1: 30, x2: 50, y2: 18 },
        { type: 'circle', cx: 50, cy: 15, r: 3 },
        { type: 'line', x1: 35, y1: 45, x2: 20, y2: 60 },
        { type: 'line', x1: 65, y1: 45, x2: 80, y2: 60 },
        { type: 'line', x1: 42, y1: 60, x2: 42, y2: 85 },
        { type: 'line', x1: 58, y1: 60, x2: 58, y2: 85 }
      ]
    }

    return {
      plan: {
        subject,
        comment,
        shapes
      },
      isFallback: true
    }
  }
}

export const llmDrawingPlanner = LlmDrawingPlanner.getInstance()
