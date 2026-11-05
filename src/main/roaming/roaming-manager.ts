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

type WindowRect = { left: number; top: number; width: number; height: number }

/**
 * The window scripts report real pixels on every monitor; Electron places her in its own units, which differ on
 * a monitor with another scale (a 150% laptop next to a 100% monitor, say)
 */
function toDipRect(rect: WindowRect): WindowRect {
  if (process.platform !== 'win32') return rect
  try {
    const dip = screen.screenToDipRect(null, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    return { left: Math.round(dip.x), top: Math.round(dip.y), width: Math.round(dip.width), height: Math.round(dip.height) }
  } catch {
    return rect
  }
}

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
  /** The monitor she's walking into, and how far above its taskbar she should land (null: she was in the air) */
  private crossing: { to: number; floorGap: number | null } | null = null
  private tabTrackTimer: NodeJS.Timeout | null = null
  private trackProcess: ChildProcess | null = null
  private linuxTrackTimer: NodeJS.Timeout | null = null

  public setSelfMoving(val: boolean): void {
    this.isSelfMoving = val
  }

  public init(): void {
    const companionWin = windowManager.getCompanionWindow()
    if (companionWin) {
      companionWin.on('moved', () => {
        // Crossing onto a monitor with another scale, Windows moves her again a moment after she moved herself.
        // Real drags arrive through notifyUserDrag anyway
        if (!this.isSelfMoving && Date.now() - this.lastSelfMoveAt > 250) {
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
      currentBehavior: this.currentBehavior
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

    const nextBehavior = choices[Math.floor(Math.random() * choices.length)]
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

  public transitionToBehavior(behavior: 'walking' | 'still' | 'tab'): void {
    if (this.isEyeMode || this.isCatchGameActive) return

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
      this.currentSittingPose = Math.random() < 0.5 ? 'front' : 'perch'

      this.findWindowedApp().then((app) => {
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
          windowManager.setTabMode(true, app, false, 'perch')
          this.isTabMode = true
          this.startTabTracking(app)

          const quote = tabQuotes[Math.floor(Math.random() * tabQuotes.length)]
          agentManager.setCompanionSpeech(quote, 4500, true)
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
      // 50% chance to flip direction
      if (Math.random() > 0.5) {
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

      agentManager.setCompanionState('standing') // capri parada quieta
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

    const app = await this.findWindowedApp()
    if (this.currentSittingPose === 'front') {
      windowManager.setTabMode(true, app || undefined, false, 'front')
      this.isTabMode = true
      this.startTabTracking()
    } else if (app) {
      windowManager.setTabMode(true, app, false, 'perch')
      this.isTabMode = true
      this.startTabTracking(app)
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
        this.stopTabTracking()
        if (this.isTabMode && this.currentBehavior === 'tab') this.transitionToBehavior('still')
        return
      }
      const key = JSON.stringify(geometry)
      if (key === last) return
      last = key
      this.markSelfMove()
      windowManager.updateTabWindowPosition(geometry, 'perch')
    }, 120)
    this.linuxTrackTimer = timer
  }

  private startTabTracking(app?: WindowedAppInfo | null): void {
    this.stopTabTracking()

    if (this.currentSittingPose === 'front') {
      // Front sitting pose stays stable in the middle of the screen
      return
    }

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
                this.stopTabTracking()
                if (this.isTabMode && this.currentBehavior === 'tab') {
                  this.transitionToBehavior('still')
                }
                return
              }
              const parts = trimmed.split(',').map((p) => parseInt(p, 10))
              if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
                const [left, top, width, height] = parts
                this.markSelfMove()
                windowManager.updateTabWindowPosition(toDipRect({ left, top, width, height }), 'perch')
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
        const found = await this.findWindowedApp()
        if (found && this.isTabMode && this.currentBehavior === 'tab') {
          this.startTabTracking(found)
        } else if (!found && this.isTabMode) {
          this.transitionToBehavior('still')
        }
      }
    }, 4000)
  }

  public async findWindowedApp(): Promise<WindowedAppInfo | null> {
    try {
      if (isLinux) {
        const { width, height } = screen.getPrimaryDisplay().size
        return await findLinuxWindowedApp(width, height)
      }

      const windowedAppsScript = scriptPath('get_windowed_apps.ps1')
      if (!fs.existsSync(windowedAppsScript)) return null

      return await new Promise((resolve) => {
        exec(`powershell -ExecutionPolicy Bypass -File "${windowedAppsScript}"`, { timeout: 3500 }, (err, stdout) => {
          if (err || !stdout) {
            resolve(null)
            return
          }
          try {
            const trimmed = stdout.trim()
            if (!trimmed || trimmed === '[]') {
              resolve(null)
              return
            }
            const apps = JSON.parse(trimmed)
            if (Array.isArray(apps) && apps.length > 0) {
              const app = apps[0]
              resolve({
                hwnd: app.Hwnd,
                title: app.Title,
                ...toDipRect({ left: app.Left, top: app.Top, width: app.Width, height: app.Height }),
                isBrowser: !!app.IsBrowser
              })
              return
            }
          } catch {}
          resolve(null)
        })
      })
    } catch {
      return null
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
  public startCatchGame(): void {
    const companionWin = windowManager.getCompanionWindow()
    if (!companionWin) return

    windowManager.hideDeck()
    this.clearTimers()

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

  public handleCatchSuccess(): void {
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

    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    if (success) {
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
    this.crossing = null

    this.loopTimer = setInterval(() => {
      if (this.isEyeMode || !this.isRoaming || this.isPaused || this.currentBehavior !== 'walking' || this.isTabMode) {
        if (this.loopTimer) {
          clearInterval(this.loopTimer)
          this.loopTimer = null
        }
        return
      }

      const companionWin = windowManager.getCompanionWindow()
      if (!companionWin || companionWin.isDestroyed() || !companionWin.isVisible()) return

      try {
        const bounds = companionWin.getBounds()
        // The screen she's on, not always the main one
        const display = screen.getDisplayMatching(bounds)
        const { workArea } = display

        const minX = workArea.x + 10
        const maxX = workArea.x + workArea.width - bounds.width - 10

        let newX = bounds.x + (this.direction === 'right' ? this.speed : -this.speed)
        let target = display

        // Only the edge she walks towards counts: halfway into the next monitor she's still behind its other edge
        const atEdge = this.direction === 'right' ? newX >= maxX : newX <= minX
        if (atEdge) {
          const next = consciousnessService.isMonitorWanderEnabled() ? this.neighborDisplay(display, this.direction, bounds) : null
          if (next) {
            target = next
          } else if (this.direction === 'right') {
            newX = maxX
            this.direction = 'left'
            this.broadcastStatus()
          } else {
            newX = minX
            this.direction = 'right'
            this.broadcastStatus()
          }
        }

        // Keeps her height (in the air or on the floor, as the user placed her) unless the next monitor needs another one
        const newY = this.walkingY(bounds, display, target)
        this.markSelfMove()
        // setBounds keeps her size when the other monitor has another scale
        companionWin.setBounds({ x: Math.round(newX), y: Math.round(newY), width: bounds.width, height: bounds.height })
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

  /** Her height for the next step: she stays where she is, and only climbs or drops to fit the monitor she's walking into */
  private walkingY(bounds: Electron.Rectangle, from: Electron.Display, to: Electron.Display): number {
    if (to.id !== from.id && this.crossing?.to !== to.id) {
      // Measured once, as she starts crossing: if she was walking on the floor she lands on the floor of the
      // next monitor, even if it's taller or lower
      const gap = from.workArea.y + from.workArea.height - (bounds.y + bounds.height)
      this.crossing = { to: to.id, floorGap: gap >= -5 && gap <= 60 ? Math.max(0, gap) : null }
    } else if (to.id === from.id && this.crossing?.to !== to.id) {
      this.crossing = null
    }

    const wa = to.workArea
    const top = wa.y
    const bottom = wa.y + wa.height - bounds.height
    let targetY = Math.min(bottom, Math.max(top, bounds.y))
    if (this.crossing?.floorGap != null) targetY = Math.max(top, bottom - this.crossing.floorGap)

    const dy = targetY - bounds.y
    // Landed: from here on she walks at whatever height she has
    if (to.id === from.id && Math.abs(dy) < 1) this.crossing = null
    return bounds.y + Math.max(-12, Math.min(12, dy))
  }

  /** Her own moves aren't a user dragging her */
  private markSelfMove(): void {
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
