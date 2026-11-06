/**
 * Knows which window the user is working in, on which monitor, and whether Windows says not to interrupt them.
 * One long-running PowerShell (watch_foreground.ps1) reports every change, so behaviors can react to where the
 * user's attention is without starting a script each time.
 */

import { EventEmitter } from 'events'
import * as fs from 'fs'
import { scriptPath } from './app-paths'
import { spawn, ChildProcess } from './hidden-process'
import { displayOfRect, toDipRect, WindowRect } from './screen-coords'

export interface ForegroundInfo {
  hwnd: number
  pid: number
  process: string
  title: string
  rect: WindowRect
  displayId: number
  fullscreen: boolean
  /** When it became the foreground window */
  since: number
}

/** SHQueryUserNotificationState: not present (locked, screensaver), busy (fullscreen), Direct3D fullscreen, presenting */
const DO_NOT_DISTURB = new Set([1, 2, 3, 4])

// The desktop, taskbar, Start and Alt+Tab aren't where the user works
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow', 'MultitaskingViewFrame', 'XamlExplorerHostIslandWindow', 'ForegroundStaging'])

interface RawLine {
  Hwnd: number
  Pid?: number
  Process?: string
  Class?: string
  Title?: string
  Left?: number
  Top?: number
  Width?: number
  Height?: number
  Fullscreen?: boolean
  Quns?: number
}

class ForegroundWatchService extends EventEmitter {
  private proc: ChildProcess | null = null
  private running = false
  private restartTimer: NodeJS.Timeout | null = null
  private failures = 0
  private latest: ForegroundInfo | null = null
  private quns = 0

  public start(): void {
    if (this.running || process.platform !== 'win32') return
    this.running = true
    this.launch()
  }

  public stop(): void {
    this.running = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    try {
      this.proc?.kill()
    } catch {}
    this.proc = null
  }

  /** The last window the user worked in, other than Capri herself and the desktop */
  public current(): ForegroundInfo | null {
    return this.latest
  }

  /** The monitor the user is working on, if known */
  public focusedDisplayId(): number | null {
    return this.latest?.displayId ?? null
  }

  /** Windows says not to interrupt: locked, screensaver, a fullscreen app or game, a presentation */
  public isDoNotDisturb(): boolean {
    return DO_NOT_DISTURB.has(this.quns)
  }

  /** The user's window fills that monitor (a game, a video, a presentation) */
  public isFullscreenOn(displayId: number): boolean {
    return !!this.latest && this.latest.fullscreen && this.latest.displayId === displayId
  }

  private launch(): void {
    const script = scriptPath('watch_foreground.ps1')
    if (!fs.existsSync(script)) return
    let proc: ChildProcess
    try {
      proc = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', script, '-ParentPid', String(process.pid)])
    } catch {
      this.scheduleRestart()
      return
    }
    this.proc = proc
    let buffer = ''
    proc.stdout?.on('data', (data: Buffer) => {
      this.failures = 0
      buffer += data.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          this.handle(JSON.parse(trimmed) as RawLine)
        } catch {}
      }
    })
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null
      this.scheduleRestart()
    })
    proc.on('error', () => {
      if (this.proc === proc) this.proc = null
    })
  }

  private scheduleRestart(): void {
    if (!this.running || this.restartTimer) return
    this.failures++
    const delay = Math.min(60000, 2000 * this.failures)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.running && !this.proc) this.launch()
    }, delay)
  }

  private handle(raw: RawLine): void {
    const quns = raw.Quns ?? 0
    if (quns !== this.quns) {
      const was = this.isDoNotDisturb()
      this.quns = quns
      if (was !== this.isDoNotDisturb()) this.emit('do-not-disturb', this.isDoNotDisturb())
    }

    if (!raw.Hwnd || raw.Pid === process.pid || SHELL_CLASSES.has(raw.Class || '')) return
    if (!raw.Width || !raw.Height) return

    const rect = toDipRect({ left: raw.Left ?? 0, top: raw.Top ?? 0, width: raw.Width, height: raw.Height })
    const displayId = displayOfRect(rect).id
    const prev = this.latest
    const sameWindow = prev?.hwnd === raw.Hwnd
    this.latest = {
      hwnd: raw.Hwnd,
      pid: raw.Pid ?? 0,
      process: raw.Process ?? '',
      title: raw.Title ?? '',
      rect,
      displayId,
      fullscreen: !!raw.Fullscreen,
      since: sameWindow && prev ? prev.since : Date.now()
    }
    if (!sameWindow) this.emit('window', this.latest, prev)
    if (prev?.displayId !== displayId) this.emit('display', displayId, prev?.displayId ?? null)
  }
}

export const foregroundWatch = new ForegroundWatchService()
