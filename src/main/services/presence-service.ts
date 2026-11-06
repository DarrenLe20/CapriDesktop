/**
 * Whether Capri may do something on her own right now, and whether the user is at the PC.
 * Every autonomous behavior asks canActNow() first, so they all respect the same rules: never while she's busy
 * answering, never in Gaming Mode, never when Windows says not to disturb (locked, fullscreen, presenting),
 * never onto a monitor that's showing something fullscreen, and at most one line on her own per minute.
 */

import { EventEmitter } from 'events'
import { powerMonitor } from 'electron'
import { agentManager } from '../agents/agent-manager'
import { windowManager } from '../windows/window-manager'
import { scannerService } from './scanner-service'
import { foregroundWatch } from './foreground-watch-service'

/** speak: voice and bubble. bubble: a silent bubble. move: walk or hop to another monitor. glance: look somewhere */
export type ActKind = 'speak' | 'bubble' | 'move' | 'glance'

const AWAY_AFTER_S = 15 * 60
const LONG_AWAY_AFTER_S = 30 * 60
const LINE_GAP_MS = 60 * 1000

class PresenceService extends EventEmitter {
  private started = false
  private locked = false
  private awaySince: number | null = null
  private longAwayEmitted = false
  private idleTimer: NodeJS.Timeout | null = null
  private lastLineAt = 0

  public start(): void {
    if (this.started) return
    this.started = true
    powerMonitor.on('lock-screen', () => {
      this.locked = true
      // Away since they last touched the PC, not since the lock
      let idle = 0
      try {
        idle = powerMonitor.getSystemIdleTime()
      } catch {}
      this.markAway(Date.now() - idle * 1000)
    })
    powerMonitor.on('unlock-screen', () => {
      this.locked = false
      this.markBack()
    })
    powerMonitor.on('suspend', () => this.markAway(Date.now()))
    powerMonitor.on('resume', () => {
      // A resume without a lock screen still means the user is back at the PC
      if (!this.locked) this.markBack()
    })
    this.idleTimer = setInterval(() => this.checkIdle(), 20 * 1000)
  }

  public stop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
  }

  /** Locked, asleep or away from the keyboard for a while */
  public isAway(): boolean {
    return this.locked || this.awaySince !== null
  }

  /** Something she said on her own, so the next one waits a minute */
  public noteLine(): void {
    this.lastLineAt = Date.now()
  }

  public msSinceLastLine(): number {
    return Date.now() - this.lastLineAt
  }

  public canActNow(kind: ActKind, displayId?: number | null): boolean {
    if (this.isAway() && kind !== 'move') return false
    if (agentManager.getStatus().isRunning) return false
    if (scannerService.getStatus().isOpen) return false
    if (agentManager.getCompanionState() === 'sleep') return false
    if (windowManager.isGamingModeActive()) return false
    if (foregroundWatch.isDoNotDisturb()) return false
    if (displayId != null && foregroundWatch.isFullscreenOn(displayId)) return false
    if ((kind === 'speak' || kind === 'bubble') && this.msSinceLastLine() < LINE_GAP_MS) return false
    return true
  }

  private checkIdle(): void {
    let idle = 0
    try {
      idle = powerMonitor.getSystemIdleTime()
    } catch {
      return
    }
    if (idle >= AWAY_AFTER_S && this.awaySince === null) this.markAway(Date.now() - idle * 1000)
    if (idle >= LONG_AWAY_AFTER_S && this.awaySince !== null && !this.longAwayEmitted) {
      this.longAwayEmitted = true
      this.emit('long-away')
    }
    if (idle < 30 && this.awaySince !== null && !this.locked) this.markBack()
  }

  private markAway(since: number): void {
    if (this.awaySince === null || since < this.awaySince) this.awaySince = since
  }

  private markBack(): void {
    if (this.awaySince === null) return
    const awayMs = Date.now() - this.awaySince
    this.awaySince = null
    this.longAwayEmitted = false
    // Short breaks (a coffee, a quick lock) don't count as coming back
    if (awayMs >= AWAY_AFTER_S * 1000) this.emit('return', awayMs)
  }
}

export const presenceService = new PresenceService()
