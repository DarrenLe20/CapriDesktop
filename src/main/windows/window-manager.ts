import { createOnboardingWindow } from './onboarding-window'
import { BrowserWindow, app, screen, globalShortcut } from 'electron'
import { createCompanionWindow } from './companion-window'
import { createDeckWindow } from './deck-window'
import { createScannerWindow } from './scanner-window'
import { IPC_CHANNELS, ScannerBounds } from '../ipc/channels'
import { roamingManager } from '../roaming/roaming-manager'
import { ollamaService } from '../services/ollama-service'
import { voiceService } from '../services/voice-service'
import { consciousnessService } from '../services/consciousness-service'
import { scannerService } from '../services/scanner-service'
import { isLinux, linuxCursorPosition } from '../services/platform'
import { foregroundWatch } from '../services/foreground-watch-service'
import { displayOfRect } from '../services/screen-coords'

export class WindowManager {
  private companionWin: BrowserWindow | null = null
  private onboardingWin: BrowserWindow | null = null
  private deckWin: BrowserWindow | null = null
  private scannerWin: BrowserWindow | null = null
  private isGamingMode = false
  private savedGamingPosition: { x: number; y: number } | null = null
  private gamingKeepAliveInterval: NodeJS.Timeout | null = null
  private gamingModeListeners: Array<(enabled: boolean) => void> = []
  private mouseForwardTimers = new Map<BrowserWindow, NodeJS.Timeout>()

  /**
   * Electron only honors { forward: true } on Windows and macOS. Without it, a click-through window
   * stops receiving mouse moves and could never tell that the cursor came back to one of its buttons,
   * so on Linux the moves are read from the screen and handed to the page (see the preload). They
   * don't go through sendInputEvent because it drops them while the window has no focus, which in a
   * game is always.
   */
  private forwardMouseOnLinux(win: BrowserWindow, active: boolean): void {
    if (!isLinux) return
    const running = this.mouseForwardTimers.get(win)
    if (running) clearInterval(running)
    this.mouseForwardTimers.delete(win)
    if (!active) return

    // Only real changes are told: starting outside isn't the mouse leaving
    let last = 'outside'
    let asking = false
    const timer = setInterval(async () => {
      if (asking) return
      if (win.isDestroyed()) {
        clearInterval(timer)
        this.mouseForwardTimers.delete(win)
        return
      }
      // screen.getCursorScreenPoint() stays frozen on X11 while the app gets no mouse events
      asking = true
      const raw = await linuxCursorPosition()
      asking = false
      if (this.mouseForwardTimers.get(win) !== timer || win.isDestroyed()) return
      const bounds = win.getBounds()
      const scale = screen.getDisplayMatching(bounds).scaleFactor || 1
      const cursor = raw ? { x: raw.x / scale, y: raw.y / scale } : screen.getCursorScreenPoint()
      const x = Math.round(cursor.x - bounds.x)
      const y = Math.round(cursor.y - bounds.y)
      const inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height
      const position = inside ? `${x},${y}` : 'outside'
      if (position === last) return
      last = position
      win.webContents.send(IPC_CHANNELS.WINDOW_FORWARDED_MOUSE, { x, y, inside })
    }, 100)
    this.mouseForwardTimers.set(win, timer)
  }

  public onGamingModeChanged(cb: (enabled: boolean) => void): () => void {
    this.gamingModeListeners.push(cb)
    return () => {
      this.gamingModeListeners = this.gamingModeListeners.filter((fn) => fn !== cb)
    }
  }

  public init(): void {
    this.companionWin = createCompanionWindow()
    this.deckWin = createDeckWindow()
    // If that monitor isn't connected now she stays on the main one, and it's kept for when it's back
    const savedDisplay = consciousnessService.getCompanionDisplayId()
    if (savedDisplay !== null) this.moveCompanionToDisplay(savedDisplay, false)

    // First launch after installing: ask the user's name, language and set up dependencies
    if (!consciousnessService.isOnboardingDone()) {
      this.onboardingWin = createOnboardingWindow()
      this.onboardingWin.on('closed', () => {
        this.onboardingWin = null
      })
    }

    this.companionWin.on('closed', () => {
      this.companionWin = null
      // Quit app if companion window is closed
      ;(app as unknown as { isQuitting?: boolean }).isQuitting = true
      app.quit()
    })

    this.companionWin.on('moved', () => {
      if (this.isGamingMode && this.companionWin && !this.companionWin.isDestroyed()) {
        const bounds = this.companionWin.getBounds()
        this.savedGamingPosition = { x: bounds.x, y: bounds.y }
      }
    })

    this.companionWin.on('blur', () => {
      if (this.companionWin && !this.companionWin.isDestroyed()) {
        if (!this.companionWin.isVisible() || this.isDeckVisible()) {
          return
        }
        this.companionWin.setAlwaysOnTop(true, 'screen-saver', 1)
        this.companionWin.moveTop()
      }
    })

    // Register optional global shortcut (Ctrl+Alt+S) for Neural Scanner
    try {
      globalShortcut.register('CommandOrControl+Alt+S', () => {
        if (this.isScannerOpen()) {
          scannerService.scan()
        } else {
          this.showScanner()
        }
      })
    } catch (err) {
      console.warn('[WindowManager] Failed to register global shortcut Ctrl+Alt+S:', err)
    }

    // Register global shortcuts for Voice Command Mode:
    // Universal shortcut: Ctrl+Alt+V
    try {
      globalShortcut.register('CommandOrControl+Alt+V', () => {
        this.broadcast(IPC_CHANNELS.VOICE_TOGGLE_RECORDING)
      })
    } catch (err) {
      console.warn('[WindowManager] Failed to register global shortcut Ctrl+Alt+V:', err)
    }

    // Escape cancels a push-to-talk recording. Registered only while recording
    // (see setVoiceRecordingActive) so Esc keeps working normally in every other app.

    // Linux can't report Ctrl while Capri is click-through, so this replaces Ctrl + hover in Gaming Mode
    if (isLinux) {
      try {
        globalShortcut.register('CommandOrControl+Alt+G', () => {
          if (!this.isGamingMode || !this.companionWin || this.companionWin.isDestroyed()) return
          this.setCompanionClickThrough(!this.mouseForwardTimers.has(this.companionWin))
        })
      } catch (err) {
        console.warn('[WindowManager] Failed to register global shortcut Ctrl+Alt+G:', err)
      }
    }

    // The arrows are global only while another app has the focus: in her own windows they belong to
    // the text fields, and those windows handle them on their own
    this.syncArrowKeys()
    app.on('browser-window-focus', () => this.syncArrowKeys())
    app.on('browser-window-blur', () => setTimeout(() => this.syncArrowKeys(), 50))

    // Listen for language changes and broadcast to all windows
    consciousnessService.onLanguageChanged((lang) => {
      this.broadcast(IPC_CHANNELS.COMPANION_LANGUAGE_CHANGED, lang)
    })

    // Initialize desktop roaming listener and start autonomous behavior cycle
    roamingManager.init()
    roamingManager.startAutonomousCycle()
  }

  /** The setup again, for whoever skipped a step or had one fail */
  public openOnboarding(): void {
    if (this.onboardingWin && !this.onboardingWin.isDestroyed()) {
      this.onboardingWin.focus()
      return
    }
    this.onboardingWin = createOnboardingWindow()
    this.onboardingWin.on('closed', () => {
      this.onboardingWin = null
    })
  }

  private arrowKeysRegistered = false

  private syncArrowKeys(): void {
    const wanted = consciousnessService.getArrowKeysEnabled() && !BrowserWindow.getFocusedWindow()
    if (wanted === this.arrowKeysRegistered) return
    this.arrowKeysRegistered = wanted
    const keys: [string, string][] = [
      ['Down', IPC_CHANNELS.VOICE_TOGGLE_RECORDING],
      ['Right', IPC_CHANNELS.VOICE_TOGGLE_ALWAYS_LISTENING],
      ['Left', IPC_CHANNELS.COMPANION_TOGGLE_CHAT]
    ]
    for (const [key, channel] of keys) {
      try {
        if (wanted) globalShortcut.register(key, () => this.broadcast(channel))
        else globalShortcut.unregister(key)
      } catch (err) {
        console.warn(`[WindowManager] Could not change the shortcut ${key}:`, err)
      }
    }
  }

  public setArrowKeysEnabled(enabled: boolean): void {
    consciousnessService.setArrowKeysEnabled(enabled)
    this.syncArrowKeys()
  }

  public finishOnboarding(): void {
    if (this.onboardingWin && !this.onboardingWin.isDestroyed()) this.onboardingWin.close()
    this.onboardingWin = null
  }

  public getCompanionWindow(): BrowserWindow | null {
    return this.companionWin
  }

  public getDeckWindow(): BrowserWindow | null {
    return this.deckWin
  }

  public isDeckVisible(): boolean {
    return !!(this.deckWin && !this.deckWin.isDestroyed() && this.deckWin.isVisible())
  }

  public toggleDeck(): boolean {
    if (!this.deckWin || this.deckWin.isDestroyed()) {
      this.showDeck()
      return true
    }

    if (this.deckWin.isVisible()) {
      this.hideDeck()
      return false
    } else {
      this.showDeck()
      return true
    }
  }

  public showDeck(): void {
    if (!this.deckWin || this.deckWin.isDestroyed()) {
      this.deckWin = createDeckWindow()
    }

    if (this.companionWin && !this.companionWin.isDestroyed()) {
      // Release screen-saver topmost before hiding so Windows DWM completely hides the frame
      this.companionWin.setAlwaysOnTop(false)
      this.companionWin.hide()
    }

    // Pause roaming while in deck mode
    roamingManager.pause()

    // Restore if minimized, then show, focus, and move to top
    if (this.deckWin.isMinimized()) {
      this.deckWin.restore()
    }
    this.deckWin.show()
    this.deckWin.focus()
    this.deckWin.moveTop()

    this.broadcast(IPC_CHANNELS.DECK_STATUS, true)
  }

  public hideDeck(): void {
    if (this.deckWin && !this.deckWin.isDestroyed() && this.deckWin.isVisible()) {
      this.deckWin.hide()
    }

    // Restore companion floating/walking on desktop
    if (this.companionWin && !this.companionWin.isDestroyed()) {
      this.companionWin.show()
      this.companionWin.setAlwaysOnTop(true, 'screen-saver', 1)
      this.companionWin.moveTop()
    }

    // Resume roaming if it was active
    roamingManager.resume()

    // always ensure capri IS full body (standing, walking, or sitting), never eyes
    const fallbackState = roamingManager.getStatus().isRoaming ? 'walking' : 'standing'
    this.broadcast(IPC_CHANNELS.COMPANION_STATE_CHANGED, fallbackState)
    this.broadcast(IPC_CHANNELS.DECK_STATUS, false)
  }

  public setTabMode(
    enabled: boolean,
    windowRect?: { left: number; top: number; width: number; height: number; title?: string },
    keepPosition = true,
    sittingPose: 'perch' | 'front' = 'perch'
  ): boolean {
    if (!this.companionWin || this.companionWin.isDestroyed()) return false

    // Perched, she goes to the monitor of the window she sits on, even if it isn't hers
    const display = enabled && sittingPose === 'perch' && windowRect ? this.displayOfWindow(windowRect) : this.currentDisplay()
    const { workArea } = display

    if (enabled) {
      // In tab mode: comfortable window (360x360) so UI never squashes or clips
      const width = 360
      const height = 360
      let x = workArea.x + workArea.width - width - 25
      let y = workArea.y + 40

      if (sittingPose === 'front') {
        // En el medio de la pantalla (Screen Center: horizontal & vertical)
        x = workArea.x + Math.round((workArea.width - width) / 2)
        y = workArea.y + Math.round((workArea.height - height) / 2)
      } else if (windowRect) {
        // Horizontal: Top-right corner of the target window (offset slightly to the left of window control buttons)
        const targetRight = windowRect.left + windowRect.width
        const idealX = targetRight - 320
        const minX = workArea.x + 10
        const maxX = workArea.x + workArea.width - width - 10
        x = Math.max(minX, Math.min(maxX, idealX))

        // Vertical: Perched resting directly on top of the tab bar (raised by 15px from -200)
        const idealY = windowRect.top - 215
        y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height - 10, idealY))
      }

      this.companionWin.setBounds({ x, y, width, height }, false)
      this.companionWin.setAlwaysOnTop(true, 'screen-saver')
      this.companionWin.show()

      this.broadcast(IPC_CHANNELS.COMPANION_SET_TAB_MODE, true)
      // Broadcast appropriate sitting state: 'idle_front' for center pose, 'idle' for tab perch
      const targetState = sittingPose === 'front' ? 'idle_front' : 'idle'
      this.broadcast(IPC_CHANNELS.COMPANION_STATE_CHANGED, targetState)
      return true
    } else {
      const width = 420
      const height = 520
      let x = workArea.x + workArea.width - width - 20
      let y = workArea.y + workArea.height - height - 20

      if (keepPosition && this.companionWin && !this.companionWin.isDestroyed()) {
        const cur = this.companionWin.getBounds()
        // Anchor bottom-center so Capri stays exactly under the cursor when switching window dimensions
        const targetX = cur.x + Math.round((cur.width - width) / 2)
        const targetY = cur.y + (cur.height - height)
        x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, targetX))
        y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, targetY))
      }

      this.companionWin.setBounds({ x, y, width, height }, false)
      this.companionWin.setAlwaysOnTop(true, 'screen-saver', 1)

      this.broadcast(IPC_CHANNELS.COMPANION_SET_TAB_MODE, false)
      this.broadcast(IPC_CHANNELS.COMPANION_STATE_CHANGED, 'standing')
      return false
    }
  }

  public updateTabWindowPosition(
    windowRect: { left: number; top: number; width: number; height: number },
    sittingPose: 'perch' | 'front' = 'perch'
  ): void {
    if (!this.companionWin || this.companionWin.isDestroyed()) return
    // She follows the window even when it's dragged onto another monitor
    const display = sittingPose === 'perch' ? this.displayOfWindow(windowRect) : this.currentDisplay()
    const { workArea } = display
    const width = 360
    const height = 360

    let x = workArea.x + workArea.width - width - 25
    let y = workArea.y + 40

    if (sittingPose === 'front') {
      x = workArea.x + Math.round((workArea.width - width) / 2)
      y = workArea.y + Math.round((workArea.height - height) / 2)
    } else {
      const targetRight = windowRect.left + windowRect.width
      const idealX = targetRight - 320
      const minX = workArea.x + 10
      const maxX = workArea.x + workArea.width - width - 10
      x = Math.max(minX, Math.min(maxX, idealX))

      const idealY = windowRect.top - 215
      y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height - 10, idealY))
    }

    this.companionWin.setBounds({ x, y, width, height }, false)
  }

    public isGamingModeActive(): boolean {
    return this.isGamingMode
  }

  /**
   * In Gaming Mode Capri is click-through so she never eats clicks meant for the game
   * (mouse events are still forwarded so the renderer can re-enable clicks while Ctrl is held).
   */
  public setCompanionClickThrough(ignore: boolean): void {
    if (!this.companionWin || this.companionWin.isDestroyed()) return
    const effective = ignore && this.isGamingMode
    if (effective) {
      this.companionWin.setIgnoreMouseEvents(true, { forward: true })
    } else {
      this.companionWin.setIgnoreMouseEvents(false)
    }
    this.forwardMouseOnLinux(this.companionWin, effective)
  }

  public listDisplays(): { id: number; label: string; width: number; height: number; primary: boolean; current: boolean }[] {
    const primary = screen.getPrimaryDisplay().id
    const current = this.currentDisplay().id
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      label: d.label || '',
      width: d.size.width,
      height: d.size.height,
      primary: d.id === primary,
      current: d.id === current
    }))
  }

  /** Puts her in the corner of a monitor and remembers it for the next start */
  public moveCompanionToDisplay(id: number, remember = true): boolean {
    const display = screen.getAllDisplays().find((d) => d.id === id)
    if (!display || !this.companionWin || this.companionWin.isDestroyed()) return false
    const { width, height } = this.companionWin.getBounds()
    const { workArea } = display
    this.companionWin.setBounds({ x: workArea.x + workArea.width - width - 20, y: workArea.y + workArea.height - height - 20, width, height }, false)
    if (remember) consciousnessService.setCompanionDisplayId(id)
    return true
  }

  /** The monitor most of a window is on */
  private displayOfWindow(rect: { left: number; top: number; width: number; height: number }): Electron.Display {
    return displayOfRect(rect)
  }

  /** The screen she's on, so moving her to another monitor keeps her there */
  private currentDisplay(): Electron.Display {
    if (this.companionWin && !this.companionWin.isDestroyed()) return screen.getDisplayMatching(this.companionWin.getBounds())
    return screen.getPrimaryDisplay()
  }

  /** Outside her body clicks go to whatever is behind her window */
  public setCompanionHitThrough(ignore: boolean): void {
    if (this.isGamingMode || !this.companionWin || this.companionWin.isDestroyed()) return
    if (ignore) this.companionWin.setIgnoreMouseEvents(true, { forward: true })
    else this.companionWin.setIgnoreMouseEvents(false)
  }

  public setSavedGamingPosition(pos: { x: number; y: number } | null): void {
    this.savedGamingPosition = pos
  }

  public getSavedGamingPosition(): { x: number; y: number } | null {
    return this.savedGamingPosition
  }

  /**
   * Where she watches a game from: another monitor than the game's, preferring her home monitor.
   * Without a known game monitor, a fullscreen window in the foreground counts as the game.
   */
  private spectatorDisplay(gameDisplayId?: number): Electron.Display {
    const mine = this.currentDisplay()
    const fg = foregroundWatch.current()
    const gameId = gameDisplayId ?? (fg?.fullscreen ? fg.displayId : undefined)
    if (gameId === undefined || gameId !== mine.id) return mine
    const others = screen.getAllDisplays().filter((d) => d.id !== gameId)
    if (!others.length) return mine
    const home = others.find((d) => d.id === consciousnessService.getCompanionDisplayId())
    return home ?? others.find((d) => d.id === screen.getPrimaryDisplay().id) ?? others[0]
  }

  public setGamingMode(
    enabled: boolean,
    corner: 'bottom-right' | 'top-right' | 'bottom-left' | 'top-left' = 'top-left',
    /** The monitor the game runs on, when the caller knows it */
    gameDisplayId?: number
  ): void {
    this.isGamingMode = enabled

    if (!this.companionWin || this.companionWin.isDestroyed()) return

    if (this.gamingKeepAliveInterval) {
      clearInterval(this.gamingKeepAliveInterval)
      this.gamingKeepAliveInterval = null
    }

    if (enabled) {
      // Freeze desktop roaming & engage eye mode
      roamingManager.setEyeMode(true)
      roamingManager.stop()
      this.gamingModeListeners.forEach((fn) => {
        try {
          fn(true)
        } catch {}
      })

      // Dock to position with ample vertical room for downward speech bubble
      // If the user already moved Capri in Gaming Mode, prioritize her saved position
      const primaryDisplay = this.savedGamingPosition ? this.currentDisplay() : this.spectatorDisplay(gameDisplayId)
      const workArea = primaryDisplay.workArea
      const width = 360
      const height = 540

      let x = workArea.x + 8
      let y = workArea.y + 8

      if (this.savedGamingPosition) {
        x = this.savedGamingPosition.x
        y = this.savedGamingPosition.y
      } else {
        if (corner === 'bottom-right') {
          x = workArea.x + workArea.width - width - 15
          y = workArea.y + workArea.height - height - 15
        } else if (corner === 'top-right') {
          x = workArea.x + workArea.width - width - 15
          y = workArea.y + 15
        } else if (corner === 'bottom-left') {
          x = workArea.x + 15
          y = workArea.y + workArea.height - height - 15
        }
      }

      this.companionWin.setBounds({ x, y, width, height }, false)
      this.companionWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      this.companionWin.setAlwaysOnTop(true, 'screen-saver', 1)
      this.companionWin.moveTop()

      // Periodic top-most keepalive so DirectX full-screen games cannot cover Capri
      this.gamingKeepAliveInterval = setInterval(() => {
        if (
          this.companionWin &&
          !this.companionWin.isDestroyed() &&
          this.companionWin.isVisible() &&
          !this.isDeckVisible()
        ) {
          this.companionWin.setAlwaysOnTop(true, 'screen-saver', 1)
          this.companionWin.moveTop()
        }
      }, 700)

      this.setCompanionClickThrough(true)
      this.broadcast(IPC_CHANNELS.COMPANION_GAMING_MODE_CHANGED, true)
      this.broadcast(IPC_CHANNELS.COMPANION_SET_GAMING_MODE, true)
      this.broadcast(IPC_CHANNELS.COMPANION_STATE_CHANGED, 'ojos')
      console.log(`[WindowManager] Gaming Mode ACTIVATED (corner: ${corner}, screen-saver priority)`)
    } else {
      roamingManager.setEyeMode(false)
      this.gamingModeListeners.forEach((fn) => {
        try {
          fn(false)
        } catch {}
      })

      const primaryDisplay = this.currentDisplay()
      const workArea = primaryDisplay.workArea
      const width = 420
      const height = 520
      const x = workArea.x + workArea.width - width - 20
      const y = workArea.y + workArea.height - height - 20

      this.companionWin.setBounds({ x, y, width, height }, false)
      this.companionWin.setAlwaysOnTop(true, 'screen-saver', 1)
      this.setCompanionClickThrough(false)

      this.broadcast(IPC_CHANNELS.COMPANION_GAMING_MODE_CHANGED, false)
      this.broadcast(IPC_CHANNELS.COMPANION_SET_GAMING_MODE, false)
      this.broadcast(IPC_CHANNELS.COMPANION_STATE_CHANGED, 'standing')
      console.log('[WindowManager] Gaming Mode DEACTIVATED')
    }
  }

  private escapeCancelRegistered = false

  /** While a push-to-talk recording runs, a global Esc discards it (Down still sends it) */
  public setVoiceRecordingActive(active: boolean): void {
    try {
      if (active && !this.escapeCancelRegistered) {
        this.escapeCancelRegistered = globalShortcut.register('Escape', () => {
          this.broadcast(IPC_CHANNELS.VOICE_CANCEL_RECORDING)
        })
      } else if (!active && this.escapeCancelRegistered) {
        globalShortcut.unregister('Escape')
        this.escapeCancelRegistered = false
      }
    } catch (err) {
      console.warn('[WindowManager] Escape shortcut for cancelling voice failed:', err)
    }
  }

  public broadcast(channel: string, ...args: unknown[]): void {
    if (this.companionWin && !this.companionWin.isDestroyed()) {
      this.companionWin.webContents.send(channel, ...args)
    }
    if (this.deckWin && !this.deckWin.isDestroyed()) {
      this.deckWin.webContents.send(channel, ...args)
    }
    if (this.scannerWin && !this.scannerWin.isDestroyed()) {
      this.scannerWin.webContents.send(channel, ...args)
    }
    if (this.onboardingWin && !this.onboardingWin.isDestroyed()) {
      this.onboardingWin.webContents.send(channel, ...args)
    }
  }

  // --- Neural Scanner Window Controls ---
  public getScannerWindow(): BrowserWindow | null {
    return this.scannerWin
  }

  public isScannerOpen(): boolean {
    return !!(this.scannerWin && !this.scannerWin.isDestroyed() && this.scannerWin.isVisible())
  }

  public showScanner(): void {
    if (!this.scannerWin || this.scannerWin.isDestroyed()) {
      this.scannerWin = createScannerWindow()
      this.scannerWin.on('closed', () => {
        this.scannerWin = null
      })
    }
    // Maintain screen-saver level and float above MS Paint, Notepad, and game windows
    this.scannerWin.setAlwaysOnTop(true, 'screen-saver', 1)
    this.scannerWin.moveTop()
    // Show without stealing focus from whatever application the user is currently looking at
    this.scannerWin.showInactive()
    this.broadcast(IPC_CHANNELS.SCANNER_EVENT, { type: 'status', isScanning: false })
  }

  public hideScanner(): void {
    if (this.scannerWin && !this.scannerWin.isDestroyed()) {
      this.scannerWin.hide()
      this.broadcast(IPC_CHANNELS.SCANNER_EVENT, { type: 'status', isScanning: false })
    }
  }

  public toggleScanner(): boolean {
    if (this.isScannerOpen()) {
      this.hideScanner()
      return false
    } else {
      this.showScanner()
      return true
    }
  }

  public setScannerBounds(bounds: Partial<ScannerBounds>): void {
    if (this.scannerWin && !this.scannerWin.isDestroyed()) {
      const cur = this.scannerWin.getBounds()
      const newBounds = {
        x: typeof bounds.x === 'number' ? Math.round(bounds.x) : cur.x,
        y: typeof bounds.y === 'number' ? Math.round(bounds.y) : cur.y,
        width: typeof bounds.width === 'number' ? Math.max(220, Math.round(bounds.width)) : cur.width,
        height: typeof bounds.height === 'number' ? Math.max(200, Math.round(bounds.height)) : cur.height
      }
      this.scannerWin.setBounds(newBounds)
      this.scannerWin.setAlwaysOnTop(true, 'screen-saver', 1)
      consciousnessService.setScannerBounds(newBounds)
    }
  }

  public setScannerIgnoreMouse(ignore: boolean): void {
    if (this.scannerWin && !this.scannerWin.isDestroyed()) {
      this.scannerWin.setIgnoreMouseEvents(ignore, { forward: true })
      this.forwardMouseOnLinux(this.scannerWin, ignore)
      // Crucial on Windows: toggling ignoreMouseEvents can alter DWM z-order flags; reassert topmost level
      this.scannerWin.setAlwaysOnTop(true, 'screen-saver', 1)
      this.scannerWin.moveTop()
    }
  }

  public quitApp(): void {
    ;(app as unknown as { isQuitting?: boolean }).isQuitting = true
    try {
      globalShortcut.unregisterAll()
    } catch {}
    try {
      roamingManager.stop()
    } catch {}
    try {
      ollamaService.stop()
    } catch {}
    try {
      voiceService.stopServer()
    } catch {}

    if (this.scannerWin && !this.scannerWin.isDestroyed()) {
      this.scannerWin.destroy()
      this.scannerWin = null
    }
    if (this.deckWin && !this.deckWin.isDestroyed()) {
      this.deckWin.removeAllListeners('close')
      this.deckWin.destroy()
      this.deckWin = null
    }
    if (this.companionWin && !this.companionWin.isDestroyed()) {
      this.companionWin.destroy()
      this.companionWin = null
    }
    app.exit(0)
  }
}

export const windowManager = new WindowManager()
