/**
 * Connects what happens around Capri to what she does about it: the user's focus moving to another monitor
 * (she looks, and after a while walks over), a monitor unplugged or plugged back in (she re-forms on a screen
 * that's there, then goes home), and the user coming back to the PC (she meets them on their monitor).
 * Everything goes through presenceService.canActNow(), so none of it happens while gaming, presenting or busy.
 */

import { app, screen } from 'electron'
import { agentManager } from '../agents/agent-manager'
import { roamingManager } from '../roaming/roaming-manager'
import { windowManager } from '../windows/window-manager'
import { consciousnessService } from './consciousness-service'
import { foregroundWatch } from './foreground-watch-service'
import { presenceService } from './presence-service'
import { displayById } from './screen-coords'

const MINUTE = 60 * 1000
/** The user's focus stays on another monitor this long before she walks over */
const DRIFT_AFTER_MS = 5 * MINUTE
/** She stays on a monitor at least this long before walking to another one */
const MIN_STAY_MS = 10 * MINUTE
const MAX_DRIFTS_PER_HOUR = 3

// English: the renderer translates them. Breezy, never about how long the user was gone
const RETURN_LINES_EN = ['There you are! Ready when you are.', 'Welcome back, choom.', 'Hey! Back on the net.', 'Oh good, the fun part is back.']
const UNPLUGGED_LINES_EN = ['Hey, who pulled my floor out?', 'Whoa, that screen just vanished. I am fine!', 'New floor. Close enough.']

const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]

class BehaviorDirector {
  private started = false
  private timer: NodeJS.Timeout | null = null
  private myDisplayId: number | null = null
  private myDisplaySince = Date.now()
  private focusSince = Date.now()
  private drifts: number[] = []

  public start(): void {
    if (this.started) return
    this.started = true
    foregroundWatch.start()
    presenceService.start()

    foregroundWatch.on('display', (id: number) => this.onFocusDisplay(id))
    presenceService.on('return', () => this.onReturn())
    presenceService.on('long-away', () => this.goHome())
    screen.on('display-removed', (_e, display) => this.onDisplayRemoved(display))
    screen.on('display-added', (_e, display) => this.onDisplayAdded(display))
    screen.on('display-metrics-changed', () => {
      roamingManager.ignoreMovesFor(1500)
      setTimeout(() => this.keepOnScreen(), 600)
    })
    this.timer = setInterval(() => this.everyFewSeconds(), 5000)
    app.on('will-quit', () => this.stop())
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    foregroundWatch.stop()
    presenceService.stop()
  }

  private herBounds(): Electron.Rectangle | null {
    const win = windowManager.getCompanionWindow()
    return win && !win.isDestroyed() ? win.getBounds() : null
  }

  private herDisplayId(): number | null {
    const b = this.herBounds()
    return b ? screen.getDisplayMatching(b).id : null
  }

  private wanderOn(): boolean {
    return consciousnessService.isMonitorWanderEnabled() && screen.getAllDisplays().length > 1
  }

  /** The user switched to a window on another monitor: she looks that way */
  private onFocusDisplay(id: number): void {
    this.focusSince = Date.now()
    if (id !== this.herDisplayId()) roamingManager.glanceAt(id)
  }

  private everyFewSeconds(): void {
    const mine = this.herDisplayId()
    if (mine !== this.myDisplayId) {
      this.myDisplayId = mine
      this.myDisplaySince = Date.now()
    }
    this.maybeDrift(mine)
  }

  /** After the user has worked on another monitor for a while, she walks over (a few times an hour at most) */
  private maybeDrift(mine: number | null): void {
    if (!this.wanderOn() || mine === null || presenceService.isAway() || roamingManager.isDrifting()) return
    const focus = foregroundWatch.focusedDisplayId()
    if (focus === null || focus === mine) return
    const now = Date.now()
    if (now - this.focusSince < DRIFT_AFTER_MS || now - this.myDisplaySince < MIN_STAY_MS) return
    this.drifts = this.drifts.filter((t) => now - t < 60 * MINUTE)
    if (this.drifts.length >= MAX_DRIFTS_PER_HOUR) return
    if (roamingManager.driftTo(focus)) this.drifts.push(now)
  }

  /** Nobody at the PC for half an hour: she quietly goes back to her home monitor */
  private goHome(): void {
    const home = displayById(consciousnessService.getCompanionDisplayId())
    if (!home || !this.wanderOn() || windowManager.isGamingModeActive()) return
    if (this.herDisplayId() !== home.id) roamingManager.hopToDisplay(home.id)
  }

  /** The user is back after 15 minutes or more: she meets them on their monitor with one breezy line */
  private onReturn(): void {
    // Give the user a moment to land on a window first
    setTimeout(() => {
      if (windowManager.isGamingModeActive() || foregroundWatch.current()?.fullscreen) return
      if (!presenceService.canActNow('speak')) return
      const greet = (): void => {
        presenceService.noteLine()
        agentManager.setCompanionSpeech(pick(RETURN_LINES_EN), 4500, true)
      }
      const focus = foregroundWatch.focusedDisplayId()
      if (this.wanderOn() && focus !== null && focus !== this.herDisplayId() && roamingManager.hopToDisplay(focus)) {
        setTimeout(greet, 900)
      } else {
        greet()
      }
    }, 3000)
  }

  /** Her monitor was unplugged or turned off: she re-forms on one that's still there */
  private onDisplayRemoved(removed: Electron.Display): void {
    roamingManager.ignoreMovesFor(2000)
    const wasOnIt = this.myDisplayId === removed.id
    setTimeout(() => {
      const b = this.herBounds()
      if (!b) return
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      const visible = screen.getAllDisplays().some((d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height)
      if (visible && !wasOnIt) return

      const target = displayById(consciousnessService.getCompanionDisplayId()) ?? screen.getPrimaryDisplay()
      roamingManager.ignoreMovesFor(1500)
      if (windowManager.isGamingModeActive()) {
        // Docked for a game: just back on a screen, no fuss
        if (!visible) windowManager.moveCompanionToDisplay(target.id, false)
        return
      }
      if (!roamingManager.hopToDisplay(target.id) && !visible) {
        roamingManager.markSelfMove()
        windowManager.moveCompanionToDisplay(target.id, false)
      }
      // One line about it, out loud only if that's OK right now
      const line = pick(UNPLUGGED_LINES_EN)
      if (presenceService.canActNow('speak')) {
        presenceService.noteLine()
        setTimeout(() => agentManager.setCompanionSpeech(line, 3500, true), 500)
      } else if (presenceService.canActNow('bubble')) {
        presenceService.noteLine()
        setTimeout(() => agentManager.setCompanionSpeech(line, 3500, false), 500)
      }
      this.myDisplayId = this.herDisplayId()
      this.myDisplaySince = Date.now()
    }, 700)
  }

  /** Her home monitor is back: she quietly goes home */
  private onDisplayAdded(added: Electron.Display): void {
    roamingManager.ignoreMovesFor(2000)
    if (added.id !== consciousnessService.getCompanionDisplayId()) return
    setTimeout(() => {
      if (!this.wanderOn() || windowManager.isGamingModeActive() || this.herDisplayId() === added.id) return
      roamingManager.hopToDisplay(added.id)
    }, 2500)
  }

  /** A resolution or scale change can leave her half off screen: put her back on her monitor */
  private keepOnScreen(): void {
    const b = this.herBounds()
    if (!b) return
    const d = screen.getDisplayMatching(b)
    const wa = d.workArea
    const inside = b.x >= wa.x - 5 && b.y >= wa.y - 5 && b.x + b.width <= wa.x + wa.width + 5 && b.y + b.height <= wa.y + wa.height + 5
    if (inside) return
    roamingManager.markSelfMove()
    windowManager.moveCompanionToDisplay(d.id, false)
  }
}

export const behaviorDirector = new BehaviorDirector()
