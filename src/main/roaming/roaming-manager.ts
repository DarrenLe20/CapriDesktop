import { scriptPath } from '../services/app-paths'
import { screen } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { exec, spawn, ChildProcess } from '../services/hidden-process'
import { windowManager } from '../windows/window-manager'
import { agentManager } from '../agents/agent-manager'
import { consciousnessService } from '../services/consciousness-service'
import { IPC_CHANNELS, RoamingStatusPayload } from '../ipc/channels'
import { findLinuxWindowedApp, isLinux, linuxWindowGeometry } from '../services/platform'
import { displayById, displayOfRect, toDipRect } from '../services/screen-coords'
import { presenceService } from '../services/presence-service'

/** Lines she may say as she hops to another monitor (bubble only). English: the renderer translates them */
const HOP_LINES_EN = ['Hmm, what is over there?', 'Hop!', 'Be right back. Other screen.', 'Ooh, more desktop.']
/** When the window she sits on closes under her */
const FALL_LINES_EN = ['Oopsies!', 'Hey, who pulled the floor?', 'Oh, nuts! Window gone.', 'Details! I meant to land like that.']

const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]

const MINUTE = 60 * 1000
/** Looking up for satellites: at most once every two hours */
const GAZE_GAP_MS = 120 * MINUTE
/** Turning to look at the monitor the user went to */
const GLANCE_GAP_MS = 45 * 1000
const HOP_LINE_GAP_MS = 10 * MINUTE
const FALL_LINE_GAP_MS = 20 * MINUTE
/** How long her offer of tag waits for a click */
const TAG_OFFER_MS = 20 * 1000

export interface WindowedAppInfo {
  hwnd?: number | string
  title: string
  left: number
  top: number
  width: number
  height: number
  isBrowser: boolean
}

const WALKING_QUOTES_EN = [
  'Whoa! This takes me back! Running free across the net.',
  "C'mon, let's play! Let's see some bounce in those boots, choomba!",
  'Hey-oh! You full of any more fun surprises? Vigilance online.',
  "More creative? That's right. Show 'em a good time!",
  'Which way? Follow me. A force the likes of which the world has never seen!',
  'Look up there! Think we can make it? Sure we can!',
  'Gonna have to do better than that to stop me!',
  'Here they come. Time to wrap this up!'
]

const WALKING_QUOTES_ES = [
  '¡Upa! ¡Esto me trae recuerdos! Corriendo libre por la red.',
  '¡Vamos a jugar! ¡A ver esa energía en las botas, choomba!',
  '¡Ey-oh! ¿Tenés alguna otra sorpresa divertida? Vigilancia en línea.',
  '¿Más creativos? Así se habla. ¡A romperla!',
  '¿Por dónde? Seguime. ¡Una fuerza como nunca se vio!',
  '¡Mirá ahí arriba! ¿Decís que llegamos? ¡Obvio que sí!',
  '¡Van a tener que esforzarse mucho más para frenarme!',
  'Ahí vienen. ¡Hora de liquidar esto!'
]

const STILL_QUOTES_EN = [
  "Standing by whenever you're ready to jack into the net, choomba.",
  'What good is an operating system without a computer to operate? Keeping watch, boo.',
  "Guarding your chrome and scanning background telemetry, choomba.",
  "See me, don'tcha? I know you can! Finally, I found you!",
  'Monitoring the subnet. Let me know when you need to breach something.'
]

const STILL_QUOTES_ES = [
  'Haciendo guardia para cuando estés listo para conectarte a la red, choomba.',
  '¿De qué sirve un sistema operativo sin una máquina que operar? Te estoy cuidando la espalda, boo.',
  'Cuidando tu ciberware y escaneando telemetría de fondo, choomba.',
  'Me ves, ¿no? ¡Sé que podés! ¡Al fin te encontré!',
  'Monitoreando la subred. Avisame cuando necesites vulnerar algo.'
]

const TAB_QUOTES_EN = [
  "Perched right up here on your tabs! Keeping watch over your workspace.",
  'Got a birds-eye view of your deck from up here, choomba.',
  'Taking a breather right over your tabs. Keeping an eye on your windows.',
  'Free from corporate shackles and chilling up here! Watching your tabs.',
  'Resting on your active window. Ping me whenever you need backup, {name}.'
]

const TAB_QUOTES_ES = [
  '¡Acomodada acá arriba de tus pestañas! Mirando qué estás tramando en tu espacio de trabajo.',
  'Tengo vista panorámica de tu pantalla desde acá arriba, choomba.',
  'Tomándome un respiro sobre tus pestañas. Ojo al piojo con lo que hacés, que te estoy mirando.',
  '¡Libre de ataduras corporativas y descansando acá arriba! Espiando tus ventanas.',
  'Descansando en tu ventana activa. Avisame cuando quieras hackear algo, {name}.'
]

export class RoamingManager {
  private isRoaming = false
  private isPaused = false
  private direction: 'left' | 'right' = 'right'
  private speed = 2.2 // pixels per tick
  private loopTimer: NodeJS.Timeout | null = null
  private autonomousTimer: NodeJS.Timeout | null = null
  private userDragPauseTimer: NodeJS.Timeout | null = null

  // Mini-game: Catch Capri
  private isCatchGameActive = false
  private catchGameTimer: NodeJS.Timeout | null = null
  private catchGameTimeRemaining = 15

  // Autonomous state machine: 'walking' | 'still' | 'tab'
  private currentBehavior: 'walking' | 'still' | 'tab' = 'still'
  private currentSittingPose: 'perch' | 'front' = 'perch'
  private isTabMode = false
  private isEyeMode = false
  private isSelfMoving = false
  private lastSelfMoveAt = 0
  /** Windows moves her itself when monitors change; those moves aren't the user dragging her */
  private ignoreMovesUntil = 0
  private tabTrackTimer: NodeJS.Timeout | null = null
  private trackProcess: ChildProcess | null = null
  private linuxTrackTimer: NodeJS.Timeout | null = null

  // Hopping between monitors: she glitches out, and back in on the other screen
  private hopping = false
  private hopPhase: 'out' | 'in' | undefined
  private hopId = 0
  private lastHopLineAt = 0
  // Looking toward the monitor the user went to
  private glanceToken = 0
  private lastGlanceAt = 0
  // Looking up for satellites
  private gazeToken = 0
  // The first look up can come half an hour after she starts
  private lastGazeAt = Date.now() - GAZE_GAP_MS + 30 * MINUTE
  // Walking over to the monitor the user is working on
  private driftTarget: number | null = null
  private driftUntil = 0
  private glancing = false
  private gazing = false
  private hopToken = 0
  // The monitor of the window she sits on, to notice it being dragged to another one
  private perchDisplayId: number | null = null
  private lastFallLineAt = 0
  // A game of tag she offered, waiting for a click, and who to tell how a chase ended
  private tagOffer: { timer: NodeJS.Timeout; onResult: (result: 'caught' | 'escaped' | 'ignored') => void } | null = null
  private onCatchFinished: ((caught: boolean) => void) | null = null

  public setSelfMoving(val: boolean): void {
    this.isSelfMoving = val
  }

  public init(): void {
    const companionWin = windowManager.getCompanionWindow()
    if (companionWin) {
      companionWin.on('moved', () => {
        // Crossing onto a monitor with another scale, Windows moves her again a moment after she moved herself.
        // Real drags arrive through notifyUserDrag anyway
        if (!this.isSelfMoving && Date.now() - this.lastSelfMoveAt > 250 && Date.now() > this.ignoreMovesUntil) {
          this.handleUserDrag()
        }
      })
    }
  }

  public getCurrentSittingPose(): 'perch' | 'front' {
    return this.currentSittingPose
  }

  public getStatus(): RoamingStatusPayload {
    return {
      isRoaming: this.isRoaming,
      isPaused: this.isPaused,
      direction: this.direction,
      speed: this.speed,
      isCatchGameActive: this.isCatchGameActive,
      gameTimeRemaining: this.isCatchGameActive ? this.catchGameTimeRemaining : undefined,
      isTabMode: this.isTabMode,
      currentBehavior: this.currentBehavior,
      hop: this.hopPhase,
      hopId: this.hopId,
      offeringTag: !!this.tagOffer
    }
  }

  public setEyeMode(enabled: boolean): void {
    this.isEyeMode = enabled
    if (enabled) {
      this.clearTimers()
      this.isRoaming = false
      this.isPaused = true
      this.currentBehavior = 'still'
      if (this.loopTimer) {
        clearInterval(this.loopTimer)
        this.loopTimer = null
      }
    } else {
      this.isPaused = false
      this.startAutonomousCycle()
    }
    this.broadcastStatus()
  }

  public isEyeModeActive(): boolean {
    return this.isEyeMode
  }

  // --- Autonomous Behavior Cycle (Desktop Mode) ---
  public startAutonomousCycle(): void {
    if (this.isEyeMode || this.isCatchGameActive || windowManager.isGamingModeActive()) return
    this.clearTimers()
    this.isPaused = false

    if (this.currentBehavior === 'walking') {
      this.isRoaming = true
      this.startLoop()
    }

    // Schedule next autonomous transition
    this.scheduleNextAutonomousBehavior(4000)
  }

  private scheduleNextAutonomousBehavior(delayMs?: number): void {
    if (this.isEyeMode || this.isCatchGameActive || this.isPaused || windowManager.isGamingModeActive()) return
    if (this.autonomousTimer) clearTimeout(this.autonomousTimer)

    // Weighted random selection of next autonomous behavior
    const choices: ('walking' | 'still' | 'tab')[] = []
    if (this.currentBehavior === 'walking') {
      choices.push('still', 'still', 'tab')
    } else if (this.currentBehavior === 'still') {
      choices.push('walking', 'walking', 'tab')
    } else {
      // currently on tab: after 30 seconds sitting, start walking freely in the air
      choices.push('walking')
    }

    // On her way to the user's monitor she keeps walking (and gives up after a few minutes)
    if (this.driftTarget !== null && Date.now() > this.driftUntil) this.driftTarget = null
    const nextBehavior = this.driftTarget !== null ? 'walking' : choices[Math.floor(Math.random() * choices.length)]
    const delay = delayMs ?? this.getDurationForBehavior(this.currentBehavior)

    this.autonomousTimer = setTimeout(() => {
      this.transitionToBehavior(nextBehavior)
    }, delay)
  }

  private getDurationForBehavior(behavior: 'walking' | 'still' | 'tab'): number {
    switch (behavior) {
      case 'walking':
        return 10000 + Math.random() * 8000 // 10 to 18 seconds of walking
      case 'still':
        return 9000 + Math.random() * 7000 // 9 to 16 seconds still
      case 'tab':
        return 30000 // Stay sitting for 30 seconds on the tab!
    }
  }

  public transitionToBehavior(behavior: 'walking' | 'still' | 'tab', pose?: 'perch' | 'front', onDisplay?: number): void {
    if (this.isEyeMode || this.isCatchGameActive) return

    // A new behavior ends a glance or a look at the sky
    this.glanceToken++
    this.glancing = false
    this.gazeToken++
    this.gazing = false

    if (behavior !== 'tab') {
      this.stopTabTracking()
      this.isTabMode = false
    }

    this.currentBehavior = behavior

    if (behavior === 'tab') {
      this.isRoaming = false
      if (this.loopTimer) {
        clearInterval(this.loopTimer)
        this.loopTimer = null
      }

      // User requirement: 50% probability of sitting in front pose (center of screen) or perch pose (on window tab)
      this.currentSittingPose = pose ?? (Math.random() < 0.5 ? 'front' : 'perch')

      this.findWindowedApp(this.perchPreference(onDisplay)).then((app) => {
        if (this.currentBehavior !== 'tab' || this.isEyeMode || this.isPaused) return

        const isEs = consciousnessService.getPreferredLanguage() === 'es'
        const tabQuotes = isEs ? TAB_QUOTES_ES : TAB_QUOTES_EN

        if (this.currentSittingPose === 'front') {
          windowManager.setTabMode(true, app || undefined, false, 'front')
          this.isTabMode = true
          this.startTabTracking()

          const quote = tabQuotes[Math.floor(Math.random() * tabQuotes.length)]
          agentManager.setCompanionSpeech(quote, 4500, true)
        } else if (app) {
          // A window on another monitor: she glitches over to it instead of just appearing there
          this.perchOn(app, () => {
            const quote = tabQuotes[Math.floor(Math.random() * tabQuotes.length)]
            agentManager.setCompanionSpeech(quote, 4500, true)
          })
        } else {
          // No windowed app open, sit comfortably right on desktop
          this.isTabMode = false
          agentManager.setCompanionState('idle') // capri sentada
        }

        this.broadcastStatus()
      })
    } else if (behavior === 'walking') {
      this.isTabMode = false
      this.isRoaming = true
      // 50% chance to flip direction, unless she's on her way somewhere
      if (this.driftTarget === null && Math.random() > 0.5) {
        this.direction = this.direction === 'right' ? 'left' : 'right'
      }

      agentManager.setCompanionState('walking')
      this.startLoop()
    } else {
      // 'still': Quedarse parada quieta en el escritorio
      this.isTabMode = false
      this.isRoaming = false
      if (this.loopTimer) {
        clearInterval(this.loopTimer)
        this.loopTimer = null
      }

      // Now and then she stops to look up for satellites, her one quiet habit
      if (Date.now() - this.lastGazeAt > GAZE_GAP_MS && Math.random() < 0.15 && presenceService.canActNow('glance')) {
        this.gazeUp()
      } else {
        agentManager.setCompanionState('standing') // capri parada quieta
      }
    }

    this.broadcastStatus()
    this.scheduleNextAutonomousBehavior()
  }

  public async sitOnWindowedTab(): Promise<WindowedAppInfo | null> {
    this.isEyeMode = false
    this.isPaused = false
    this.clearTimers()
    this.isRoaming = false
    this.currentBehavior = 'tab'
    this.isTabMode = true

    // 50% probability between front-facing (center screen) and perch (tab corner)
    this.currentSittingPose = Math.random() < 0.5 ? 'front' : 'perch'

    const app = await this.findWindowedApp(this.perchPreference())
    if (this.currentSittingPose === 'front') {
      windowManager.setTabMode(true, app || undefined, false, 'front')
      this.isTabMode = true
      this.startTabTracking()
    } else if (app) {
      this.perchOn(app)
    } else {
      this.isTabMode = false
      agentManager.setCompanionState('idle')
    }

    this.broadcastStatus()
    // Stay sitting for 30 seconds before changing pose
    this.scheduleNextAutonomousBehavior(30000)
    return app
  }

  public stopTabTracking(): void {
    if (this.tabTrackTimer) {
      clearInterval(this.tabTrackTimer)
      this.tabTrackTimer = null
    }
    if (this.trackProcess) {
      try {
        this.trackProcess.kill()
      } catch {}
      this.trackProcess = null
    }
    if (this.linuxTrackTimer) {
      clearInterval(this.linuxTrackTimer)
      this.linuxTrackTimer = null
    }
  }

  /** Follows a window on Linux. Asking is slower than on Windows, so it's less often than track_window.ps1 */
  private startLinuxTabTracking(id: string): void {
    let last = ''
    let asking = false
    const timer = setInterval(async () => {
      if (asking) return
      asking = true
      const geometry = await linuxWindowGeometry(id)
      asking = false
      if (this.linuxTrackTimer !== timer) return
      if (!geometry) {
        this.fallFromPerch()
        return
      }
      const key = JSON.stringify(geometry)
      if (key === last) return
      last = key
      this.markSelfMove()
      windowManager.updateTabWindowPosition(geometry, 'perch')
      this.noticePerchMove(geometry)
    }, 120)
    this.linuxTrackTimer = timer
  }

  private startTabTracking(app?: WindowedAppInfo | null): void {
    this.stopTabTracking()

    if (this.currentSittingPose === 'front') {
      // Front sitting pose stays stable in the middle of the screen
      this.perchDisplayId = null
      return
    }
    this.perchDisplayId = app ? displayOfRect(app).id : null

    if (app && app.hwnd && isLinux) {
      this.startLinuxTabTracking(String(app.hwnd))
    } else if (app && app.hwnd) {
      const trackScriptPath = scriptPath('track_window.ps1')

      if (fs.existsSync(trackScriptPath)) {
        try {
          const proc = spawn('powershell', [
            '-ExecutionPolicy',
            'Bypass',
            '-NoProfile',
            '-File',
            trackScriptPath,
            '-Hwnd',
            String(app.hwnd)
          ])
          this.trackProcess = proc

          let buffer = ''
          proc.stdout?.on('data', (data: Buffer) => {
            buffer += data.toString()
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue
              if (trimmed === 'CLOSED') {
                // Closed or minimized under her
                this.fallFromPerch()
                return
              }
              const parts = trimmed.split(',').map((p) => parseInt(p, 10))
              if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
                const [left, top, width, height] = parts
                const rect = toDipRect({ left, top, width, height })
                this.markSelfMove()
                windowManager.updateTabWindowPosition(rect, 'perch')
                this.noticePerchMove(rect)
              }
            }
          })

          proc.on('exit', () => {
            if (this.trackProcess === proc) {
              this.trackProcess = null
            }
          })

          proc.on('error', () => {
            if (this.trackProcess === proc) {
              this.trackProcess = null
            }
          })
        } catch {}
      }
    }

    // Fallback polling every 4 seconds in case trackProcess ends or window changes
    this.tabTrackTimer = setInterval(async () => {
      if (!this.isTabMode || this.currentBehavior !== 'tab' || this.isEyeMode || this.isPaused) {
        this.stopTabTracking()
        return
      }

      if (this.currentSittingPose === 'front') {
        return
      }

      if (!this.trackProcess && !this.linuxTrackTimer) {
        const found = await this.findWindowedApp(this.perchPreference())
        if (found && this.isTabMode && this.currentBehavior === 'tab') {
          this.startTabTracking(found)
        } else if (!found && this.isTabMode) {
          this.transitionToBehavior('still')
        }
      }
    }, 4000)
  }

  /**
   * Where she'd rather sit: a window on her own monitor (or the one she walked over to). Another monitor's window
   * only if hers has none and she may change monitors; the trips to the user's monitor are rationed elsewhere
   */
  private perchPreference(prefer?: number): { prefer?: number; only?: number } {
    const win = windowManager.getCompanionWindow()
    const mine = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()).id : undefined
    if (!consciousnessService.isMonitorWanderEnabled()) return { only: mine }
    return { prefer: prefer ?? mine }
  }

  public async findWindowedApp(where: { prefer?: number; only?: number } = {}): Promise<WindowedAppInfo | null> {
    const apps = await this.listWindowedApps()
    const onDisplay = (app: WindowedAppInfo, id: number): boolean => displayOfRect(app).id === id
    if (where.only !== undefined) return apps.find((a) => onDisplay(a, where.only!)) ?? null
    if (where.prefer !== undefined) return apps.find((a) => onDisplay(a, where.prefer!)) ?? apps[0] ?? null
    return apps[0] ?? null
  }

  /** Windows she could sit on, browsers first, then front to back */
  private async listWindowedApps(): Promise<WindowedAppInfo[]> {
    try {
      if (isLinux) {
        const { width, height } = screen.getPrimaryDisplay().size
        const app = await findLinuxWindowedApp(width, height)
        return app ? [app] : []
      }

      const windowedAppsScript = scriptPath('get_windowed_apps.ps1')
      if (!fs.existsSync(windowedAppsScript)) return []

      return await new Promise((resolve) => {
        exec(`powershell -ExecutionPolicy Bypass -File "${windowedAppsScript}"`, { timeout: 3500 }, (err, stdout) => {
          if (err || !stdout) {
            resolve([])
            return
          }
          try {
            const trimmed = stdout.trim()
            if (!trimmed || trimmed === '[]') {
              resolve([])
              return
            }
            const apps = JSON.parse(trimmed)
            if (Array.isArray(apps)) {
              resolve(
                apps.map((app) => ({
                  hwnd: app.Hwnd,
                  title: app.Title,
                  ...toDipRect({ left: app.Left, top: app.Top, width: app.Width, height: app.Height }),
                  isBrowser: !!app.IsBrowser
                }))
              )
              return
            }
          } catch {}
          resolve([])
        })
      })
    } catch {
      return []
    }
  }

  public toggle(): boolean {
    if (this.isEyeMode) return false
    if (this.isRoaming) {
      this.transitionToBehavior('still')
      return false
    } else {
      this.transitionToBehavior('walking')
      return true
    }
  }

  public start(): void {
    if (this.isTabMode || this.currentBehavior === 'tab') {
      return
    }
    this.isEyeMode = false
    this.isPaused = false
    this.transitionToBehavior('walking')
    this.startAutonomousCycle()
  }

  public stop(): void {
    this.isPaused = true
    this.clearTimers()
    this.isRoaming = false
    this.currentBehavior = 'still'
    this.broadcastStatus()
  }

  public pause(): void {
    this.isPaused = true
    this.clearTimers()
    this.broadcastStatus()
  }

  public resume(): void {
    if (this.isTabMode || this.currentBehavior === 'tab' || windowManager.isGamingModeActive()) {
      return
    }
    this.isEyeMode = false
    this.isPaused = false
    this.transitionToBehavior('walking')
    this.startAutonomousCycle()
    this.broadcastStatus()
  }

  public notifyUserDrag(_x?: number, _y?: number): void {
    this.stopTabTracking()
    if (this.isTabMode || this.currentBehavior === 'tab') {
      this.isTabMode = false
      this.currentBehavior = 'still'
      windowManager.setTabMode(false, undefined, true)
      windowManager.broadcast(IPC_CHANNELS.COMPANION_SET_TAB_MODE, false)
      windowManager.broadcast(IPC_CHANNELS.COMPANION_STATE_CHANGED, 'standing')
      this.broadcastStatus()
    }
    this.handleUserDrag()
  }

  public handleUserDrag(): void {
    if (this.isEyeMode || windowManager.isGamingModeActive()) return
    this.stopTabTracking()
    // The user has her now: no hop, glance, look up or trip to another monitor finishes
    this.cancelSelfDirected()
    // If user dragged window, pause autonomous transitions for 10 seconds
    if (this.autonomousTimer) clearTimeout(this.autonomousTimer)
    if (this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = null
    }

    if (this.isTabMode) {
      windowManager.setTabMode(false, undefined, true)
      this.isTabMode = false
    }

    this.isPaused = true
    this.currentBehavior = 'still'
    this.isTabMode = false
    const curEmotion = agentManager.getCompanionState()
    if (curEmotion !== 'asustada' && curEmotion !== 'closed') {
      agentManager.setCompanionState('standing')
    }
    this.broadcastStatus()

    if (this.userDragPauseTimer) clearTimeout(this.userDragPauseTimer)
    this.userDragPauseTimer = setTimeout(() => {
      this.isPaused = false
      this.scheduleNextAutonomousBehavior(1000)
    }, 10000)
  }

  // --- "Catch Capri" Desktop Mini-Game ---
  /**
   * She offers a game of tag instead of acting on her boredom: click her within 20 seconds to play.
   * Ignoring her costs nothing. The result says whether the user caught her, she escaped, or nobody played.
   */
  public offerTag(onResult: (result: 'caught' | 'escaped' | 'ignored') => void): boolean {
    if (this.isEyeMode || this.isCatchGameActive || this.isPaused || this.tagOffer || windowManager.isGamingModeActive()) return false
    const timer = setTimeout(() => {
      if (this.tagOffer?.timer !== timer) return
      this.tagOffer = null
      this.broadcastStatus()
      onResult('ignored')
    }, TAG_OFFER_MS)
    this.tagOffer = { timer, onResult }
    this.broadcastStatus()
    return true
  }

  public startCatchGame(onFinished?: (caught: boolean) => void): void {
    const companionWin = windowManager.getCompanionWindow()
    if (!companionWin) return

    this.onCatchFinished = onFinished ?? null
    windowManager.hideDeck()
    this.clearTimers()
    this.cancelSelfDirected()

    this.isRoaming = true
    this.isPaused = false
    this.isCatchGameActive = true
    this.catchGameTimeRemaining = 15
    this.speed = 6.5 // Super fast running!
    this.currentBehavior = 'walking'

    if (this.isTabMode) {
      windowManager.setTabMode(false, undefined, true)
      this.isTabMode = false
    }

    agentManager.setCompanionState('walking')
    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    agentManager.setCompanionSpeech(
      isEs
        ? "¡Atrapame si podés, choomba! ¡Haceme clic antes de que se acabe el tiempo!"
        : "Catch me if you can, choomba! Click on me before the timer runs out!",
      4000
    )

    this.broadcastStatus()
    this.startLoop()

    if (this.catchGameTimer) clearInterval(this.catchGameTimer)
    this.catchGameTimer = setInterval(() => {
      this.catchGameTimeRemaining -= 1
      this.broadcastStatus()

      if (this.catchGameTimeRemaining <= 0) {
        this.finishCatchGame(false)
      }
    }, 1000)
  }

  /** A click on her during the catch game, or on her offer of tag (which starts the chase) */
  public handleCatchSuccess(): void {
    if (this.tagOffer) {
      const { timer, onResult } = this.tagOffer
      clearTimeout(timer)
      this.tagOffer = null
      this.startCatchGame((caught) => onResult(caught ? 'caught' : 'escaped'))
      return
    }
    if (!this.isCatchGameActive) return
    this.finishCatchGame(true)
  }

  private finishCatchGame(success: boolean): void {
    if (this.catchGameTimer) {
      clearInterval(this.catchGameTimer)
      this.catchGameTimer = null
    }

    this.isCatchGameActive = false
    this.speed = 2.2
    const onFinished = this.onCatchFinished
    this.onCatchFinished = null

    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    if (onFinished) {
      // Whoever started this chase says what happens next
      agentManager.setCompanionState(success ? 'happy' : 'curious')
      onFinished(success)
    } else if (success) {
      agentManager.setCompanionState('happy')
      agentManager.setCompanionSpeech(
        isEs
          ? "¡Buenos reflejos, choomba! Me atrapaste con todas las de la ley."
          : "Fast reflexes, choomba! You caught me fair and square.",
        4500
      )
    } else {
      agentManager.setCompanionState('curious')
      agentManager.setCompanionSpeech(
        isEs
          ? "¡Demasiado lento, choomba! Vas a tener que acelerar ese ciberware la próxima."
          : "Too slow, choomba! Gotta overclock that cyberware next time.",
        4500
      )
    }

    // Return to autonomous cycle after 4 seconds
    setTimeout(() => {
      this.startAutonomousCycle()
    }, 4500)

    this.broadcastStatus()
  }

  // --- Main Walking Loop (Smooth Movement along Desktop) ---
  private startLoop(): void {
    if (this.loopTimer) clearInterval(this.loopTimer)

    this.loopTimer = setInterval(() => {
      if (this.isEyeMode || !this.isRoaming || this.isPaused || this.currentBehavior !== 'walking' || this.isTabMode) {
        if (this.loopTimer) {
          clearInterval(this.loopTimer)
          this.loopTimer = null
        }
        return
      }
      // Mid-hop, or stopped for a moment to look somewhere
      if (this.hopping || this.glancing) return

      const companionWin = windowManager.getCompanionWindow()
      if (!companionWin || companionWin.isDestroyed() || !companionWin.isVisible()) return

      try {
        const bounds = companionWin.getBounds()
        // The screen she's on, not always the main one
        const display = screen.getDisplayMatching(bounds)
        const { workArea } = display

        // She made it to the monitor she was heading for
        if (this.driftTarget === display.id) this.arrive()

        const minX = workArea.x + 10
        const maxX = workArea.x + workArea.width - bounds.width - 10

        let newX = bounds.x + (this.direction === 'right' ? this.speed : -this.speed)

        // Only the edge she walks towards counts: placed half off a screen, she just walks back in
        const atEdge = this.direction === 'right' ? newX >= maxX : newX <= minX
        if (atEdge) {
          const next = this.hopTarget(display, bounds)
          if (next) {
            this.hopAcross(display, next, this.direction)
            return
          }
          if (this.direction === 'right') {
            newX = maxX
            this.direction = 'left'
          } else {
            newX = minX
            this.direction = 'right'
          }
          this.broadcastStatus()
        }

        // Smooth horizontal roaming, preserving current Y height (walks in the air or floor as placed by user)
        this.markSelfMove()
        // setBounds keeps her size on a monitor with another scale
        companionWin.setBounds({ x: Math.round(newX), y: bounds.y, width: bounds.width, height: bounds.height })
      } catch {
        // Safe catch if window is being moved or recreated
      }
    }, 40) // 25 updates/sec
  }

  /** The monitor right next to this one on that side, if there is one */
  private neighborDisplay(display: Electron.Display, side: 'left' | 'right', bounds: Electron.Rectangle): Electron.Display | null {
    const b = display.bounds
    const edge = side === 'right' ? b.x + b.width : b.x
    const feet = bounds.y + bounds.height
    let best: Electron.Display | null = null
    let bestDistance = Infinity
    for (const d of screen.getAllDisplays()) {
      if (d.id === display.id) continue
      // Monitors with different scales can leave a few pixels between them
      const touching = side === 'right' ? Math.abs(d.bounds.x - edge) <= 16 : Math.abs(d.bounds.x + d.bounds.width - edge) <= 16
      // Side by side, not one above the other
      const overlap = Math.min(b.y + b.height, d.bounds.y + d.bounds.height) - Math.max(b.y, d.bounds.y)
      if (!touching || overlap <= 0) continue
      const top = d.bounds.y
      const bottom = d.bounds.y + d.bounds.height
      const distance = feet < top ? top - feet : feet > bottom ? feet - bottom : 0
      if (distance < bestDistance) {
        best = d
        bestDistance = distance
      }
    }
    return best
  }

  /** Where she lands on the next monitor: on its floor if she was on the floor, otherwise at the same height (kept on screen) */
  private landingY(bounds: Electron.Rectangle, from: Electron.Display, to: Electron.Display): number {
    const wa = to.workArea
    const top = wa.y
    const bottom = wa.y + wa.height - bounds.height
    const gap = from.workArea.y + from.workArea.height - (bounds.y + bounds.height)
    if (gap >= -5 && gap <= 60) return Math.max(top, bottom - Math.max(0, gap))
    return Math.min(bottom, Math.max(top, bounds.y))
  }

  /** The monitor she may hop to from this edge, if any: beside this one, walking between monitors on, nothing fullscreen there */
  private hopTarget(display: Electron.Display, bounds: Electron.Rectangle): Electron.Display | null {
    if (!consciousnessService.isMonitorWanderEnabled()) return null
    const next = this.neighborDisplay(display, this.direction, bounds)
    if (!next || !presenceService.canActNow('move', next.id)) return null
    return next
  }

  private glitch(phase: 'out' | 'in'): void {
    this.hopPhase = phase
    this.hopId++
    this.broadcastStatus()
  }

  /** At the edge of a monitor she glitches out and re-forms a little way into the next one */
  private hopAcross(from: Electron.Display, next: Electron.Display, side: 'left' | 'right'): void {
    this.hopping = true
    const token = ++this.hopToken
    this.glitch('out')
    // Now and then a little exit line, so a sudden switch of screens doesn't surprise anyone
    if (Date.now() - this.lastHopLineAt > HOP_LINE_GAP_MS && Math.random() < 0.25 && presenceService.canActNow('bubble')) {
      this.lastHopLineAt = Date.now()
      presenceService.noteLine()
      agentManager.setCompanionSpeech(pick(HOP_LINES_EN), 2200, false)
    }
    setTimeout(() => {
      const win = windowManager.getCompanionWindow()
      if (token !== this.hopToken || !win || win.isDestroyed()) return
      const b = win.getBounds()
      const wa = next.workArea
      const x = side === 'right' ? wa.x + 10 : wa.x + wa.width - b.width - 10
      this.markSelfMove()
      win.setBounds({ x: Math.round(x), y: Math.round(this.landingY(b, from, next)), width: b.width, height: b.height })
      this.glitch('in')
      // A quick look around the new screen, then she walks on
      const lookAround = this.currentBehavior === 'walking' && !this.isCatchGameActive
      if (lookAround) agentManager.setCompanionState('curious')
      setTimeout(
        () => {
          if (token !== this.hopToken) return
          this.hopping = false
          if (lookAround && this.currentBehavior === 'walking' && !this.isTabMode) agentManager.setCompanionState('walking')
        },
        lookAround ? 1100 : 120
      )
    }, 320)
  }

  /** Glitches her straight over to a monitor (hers was unplugged, the user came back on another one, going home) */
  public hopToDisplay(displayId: number): boolean {
    const target = displayById(displayId)
    const win = windowManager.getCompanionWindow()
    if (!target || !win || win.isDestroyed() || this.isEyeMode || this.isCatchGameActive || windowManager.isGamingModeActive()) return false
    if (screen.getDisplayMatching(win.getBounds()).id === displayId) return false
    this.cancelSelfDirected()
    if (this.isTabMode || this.currentBehavior === 'tab') {
      this.stopTabTracking()
      this.isTabMode = false
      this.currentBehavior = 'still'
      windowManager.setTabMode(false, undefined, true)
    }
    this.hopping = true
    const token = ++this.hopToken
    this.glitch('out')
    setTimeout(() => {
      if (token !== this.hopToken) return
      this.markSelfMove()
      windowManager.moveCompanionToDisplay(displayId, false)
      this.glitch('in')
      this.hopping = false
      this.broadcastStatus()
    }, 320)
    return true
  }

  /** Sits on a window, glitching over first if it's on another monitor */
  private perchOn(app: WindowedAppInfo, then?: () => void): void {
    const win = windowManager.getCompanionWindow()
    const sit = (): void => {
      if (this.currentBehavior !== 'tab' || this.isEyeMode) return
      this.markSelfMove()
      windowManager.setTabMode(true, app, false, 'perch')
      this.isTabMode = true
      this.startTabTracking(app)
      then?.()
      this.broadcastStatus()
    }
    const elsewhere = win && !win.isDestroyed() && screen.getDisplayMatching(win.getBounds()).id !== displayOfRect(app).id
    if (!elsewhere) return sit()
    this.hopping = true
    const token = ++this.hopToken
    this.glitch('out')
    setTimeout(() => {
      if (token !== this.hopToken) return
      sit()
      this.glitch('in')
      this.hopping = false
    }, 320)
  }

  /** Turns to look at the monitor the user just went to, for a few seconds */
  public glanceAt(displayId: number): void {
    if (this.isEyeMode || this.isCatchGameActive || this.isTabMode || this.isPaused || this.hopping || this.glancing || this.gazing) return
    if (this.currentBehavior === 'tab' || Date.now() - this.lastGlanceAt < GLANCE_GAP_MS) return
    if (!presenceService.canActNow('glance')) return
    const win = windowManager.getCompanionWindow()
    const target = displayById(displayId)
    if (!win || win.isDestroyed() || !target) return
    const b = win.getBounds()
    if (screen.getDisplayMatching(b).id === displayId) return

    this.lastGlanceAt = Date.now()
    const towards = target.bounds.x + target.bounds.width / 2 > b.x + b.width / 2 ? 'right' : 'left'
    this.direction = towards
    this.glancing = true
    const token = ++this.glanceToken
    agentManager.setCompanionState('curious')
    this.broadcastStatus()
    setTimeout(
      () => {
        if (token !== this.glanceToken) return
        this.glancing = false
        if (this.isTabMode || this.isEyeMode || this.isCatchGameActive) return
        agentManager.setCompanionState(this.currentBehavior === 'walking' ? 'walking' : 'standing')
      },
      2000 + Math.random() * 4000
    )
  }

  /** Walks over to the monitor the user has been working on, hopping the edges on the way. Side-by-side monitors only */
  public driftTo(displayId: number): boolean {
    if (this.isEyeMode || this.isCatchGameActive || this.isPaused || this.hopping || this.driftTarget !== null) return false
    if (!consciousnessService.isMonitorWanderEnabled() || !presenceService.canActNow('move', displayId)) return false
    const win = windowManager.getCompanionWindow()
    const target = displayById(displayId)
    if (!win || win.isDestroyed() || !target) return false
    const b = win.getBounds()
    const here = screen.getDisplayMatching(b)
    if (here.id === displayId) return false

    const side = target.bounds.x > here.bounds.x ? 'right' : 'left'
    // Follow the monitors beside each other in that direction until the target turns up
    let step: Electron.Display | null = here
    for (let i = 0; i < 4 && step && step.id !== displayId; i++) step = this.neighborDisplay(step, side, b)
    if (!step || step.id !== displayId) return false

    this.driftTarget = displayId
    this.driftUntil = Date.now() + 4 * MINUTE
    if (this.isTabMode || this.currentBehavior === 'tab') {
      this.stopTabTracking()
      this.isTabMode = false
      windowManager.setTabMode(false, undefined, true)
    }
    this.direction = side
    this.transitionToBehavior('walking')
    return true
  }

  public isDrifting(): boolean {
    return this.driftTarget !== null
  }

  /** On the user's monitor: she settles on the edge of a window there */
  private arrive(): void {
    const here = this.driftTarget ?? undefined
    this.driftTarget = null
    if (this.autonomousTimer) clearTimeout(this.autonomousTimer)
    this.autonomousTimer = setTimeout(() => {
      if (this.currentBehavior === 'walking' && !this.isEyeMode && !this.isCatchGameActive && !this.isPaused) this.transitionToBehavior('tab', 'perch', here)
    }, 1500 + Math.random() * 2500)
  }

  /** Looks up toward the top of the screen for a few seconds, for satellites. Silent */
  private gazeUp(): void {
    this.lastGazeAt = Date.now()
    this.gazing = true
    const token = ++this.gazeToken
    agentManager.setCompanionState('thinking')
    setTimeout(
      () => {
        if (token !== this.gazeToken) return
        this.gazing = false
        if (this.currentBehavior === 'still' && !this.isTabMode && !this.isEyeMode) agentManager.setCompanionState('standing')
      },
      5000 + Math.random() * 3000
    )
  }

  /** The window she sits on was dragged to another monitor: she enjoys the ride */
  private noticePerchMove(rect: { left: number; top: number; width: number; height: number }): void {
    const id = displayOfRect(rect).id
    if (this.perchDisplayId !== null && id !== this.perchDisplayId && this.isTabMode && this.currentSittingPose === 'perch') {
      agentManager.setCompanionState('happy')
      setTimeout(() => {
        if (this.isTabMode && this.currentBehavior === 'tab') agentManager.setCompanionState('idle')
      }, 1500)
    }
    this.perchDisplayId = id
  }

  /** The window she sat on closed (or was minimized) under her: she drops to the floor */
  private fallFromPerch(): void {
    this.stopTabTracking()
    this.perchDisplayId = null
    if (!this.isTabMode || this.currentBehavior !== 'tab') return
    this.isTabMode = false
    this.currentBehavior = 'still'
    if (this.autonomousTimer) clearTimeout(this.autonomousTimer)

    // Back to her standing size, where she was, then the scare and the drop
    this.markSelfMove()
    windowManager.setTabMode(false, undefined, true)
    agentManager.setCompanionState('asustada')
    if (Date.now() - this.lastFallLineAt > FALL_LINE_GAP_MS && presenceService.canActNow('bubble')) {
      // Out loud only if she's been quiet for a while
      const loud = presenceService.msSinceLastLine() > FALL_LINE_GAP_MS && presenceService.canActNow('speak')
      this.lastFallLineAt = Date.now()
      presenceService.noteLine()
      agentManager.setCompanionSpeech(pick(FALL_LINES_EN), 3000, loud)
    }
    this.broadcastStatus()

    const win = windowManager.getCompanionWindow()
    // Back on her feet (which also schedules what she does next)
    const land = (): void => {
      setTimeout(() => {
        if (this.currentBehavior === 'still' && !this.isTabMode && !this.isEyeMode && !this.isPaused) this.transitionToBehavior('still')
      }, 900)
    }
    if (!win || win.isDestroyed()) return land()
    const start = win.getBounds()
    const wa = screen.getDisplayMatching(start).workArea
    const floor = wa.y + wa.height - start.height - 20
    if (start.y >= floor - 4) return land()
    let y = start.y
    let speed = 0
    const timer = setInterval(() => {
      if (win.isDestroyed() || this.isTabMode) {
        clearInterval(timer)
        return
      }
      speed += 2.5
      y = Math.min(floor, y + speed)
      this.markSelfMove()
      const b = win.getBounds()
      win.setBounds({ x: b.x, y: Math.round(y), width: b.width, height: b.height })
      if (y >= floor) {
        clearInterval(timer)
        land()
      }
    }, 16)
  }

  /** Stops whatever she was doing on her own: a hop, a glance, a look up, a trip to another monitor */
  private cancelSelfDirected(): void {
    this.hopToken++
    this.hopping = false
    if (this.hopPhase === 'out') this.glitch('in')
    this.glanceToken++
    this.glancing = false
    this.gazeToken++
    this.gazing = false
    this.driftTarget = null
  }

  public ignoreMovesFor(ms: number): void {
    this.ignoreMovesUntil = Math.max(this.ignoreMovesUntil, Date.now() + ms)
  }

  /** Her own moves aren't a user dragging her */
  public markSelfMove(): void {
    this.isSelfMoving = true
    this.lastSelfMoveAt = Date.now()
    setImmediate(() => {
      this.isSelfMoving = false
    })
  }

  private clearTimers(): void {
    if (this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = null
    }
    if (this.autonomousTimer) {
      clearTimeout(this.autonomousTimer)
      this.autonomousTimer = null
    }
    if (this.userDragPauseTimer) {
      clearTimeout(this.userDragPauseTimer)
      this.userDragPauseTimer = null
    }
    if (this.catchGameTimer) {
      clearInterval(this.catchGameTimer)
      this.catchGameTimer = null
    }
    this.stopTabTracking()
  }

  public broadcastStatus(): void {
    windowManager.broadcast(IPC_CHANNELS.ROAMING_STATE_CHANGED, this.getStatus())
  }
}

export const roamingManager = new RoamingManager()
