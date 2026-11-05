import { app, BrowserWindow } from 'electron'
import { windowManager } from './windows/window-manager'
import { registerIpcHandlers } from './ipc/register-handlers'
import { systemObserver } from './services/system-observer'
import { cyberpunkAdapter } from './services/game/adapters/cyberpunk/cyberpunk-adapter'
import { setupService } from './services/setup-service'
import { ollamaService } from './services/ollama-service'
import { consciousnessService } from './services/consciousness-service'
import { boredomService } from './services/boredom-service'
import { gameEventBus } from './services/game'
import { voiceService } from './services/voice-service'
import { proactiveDialogueService } from './services/proactive-dialogue-service'
import { gamePresenceService } from './services/game-presence-service'
import { updateService } from './services/update-service'
import { legacyUserDataDir } from './services/legacy-data'
import { initOverwolfGepProbe } from './services/game/overwolf-gep-probe'
import fs from 'fs'
import path from 'path'

// Log unhandled exceptions to crash.log
process.on('uncaughtException', (err) => {
  const logMsg = `[${new Date().toISOString()}] Uncaught Exception: ${err?.stack || err}\n`
  console.error(logMsg)
  try {
    fs.appendFileSync(path.join(app.getAppPath(), 'crash.log'), logMsg)
  } catch {}
})

process.on('unhandledRejection', (reason) => {
  const logMsg = `[${new Date().toISOString()}] Unhandled Rejection: ${reason}\n`
  console.error(logMsg)
  try {
    fs.appendFileSync(path.join(app.getAppPath(), 'crash.log'), logMsg)
  } catch {}
})

// Set app name
app.setName('Capri Desktop')

// Existing data stays where it is, unless a folder was chosen by hand (--user-data-dir)
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const legacy = legacyUserDataDir(app.getPath('appData'), app.isPackaged, fs.existsSync)
  if (legacy) app.setPath('userData', legacy)
}

// Ensure single instance lock so multiple companions don't overlap
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const compWin = windowManager.getCompanionWindow()
    if (compWin && !compWin.isDestroyed()) {
      if (compWin.isMinimized()) compWin.restore()
      compWin.focus()
    }
  })

  // Disable hardware acceleration issues with transparency on certain Windows drivers if needed,
  // but keep GPU compositing enabled for smooth 60fps canvas/css animations
  app.commandLine.appendSwitch('enable-transparent-visuals')
  // Test: Overwolf game events for VALORANT (only active on Overwolf's Electron, npm run dev:ow)
  initOverwolfGepProbe()
  // Global hotkeys on a Wayland desktop go through its portal (X11 doesn't need it)
  if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
    app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
  }

  app.whenReady().then(() => {
    // Initialize consciousness & persistent self-awareness
    consciousnessService.init()

    // Register all IPC handlers
    registerIpcHandlers()

    // Initialize companion and deck windows
    windowManager.init()

    // Setup still pending: the wizard takes care of the voice
    if (consciousnessService.isOnboardingDone()) {
      setupService
        .repairVoiceEnv()
        .catch((err) => console.warn('[Setup] Voice repair failed:', err))
        // After the patch notes, so a dialog doesn't step on her first words
        .then(() => new Promise((r) => setTimeout(r, 25000)))
        .then(() => setupService.refreshPersona())
        .then(() => setupService.warnIfIncomplete())
        .catch((err) => console.warn('[Setup] Setup check failed:', err))
    }

    // The game only loads its mods when it opens, so the mod has to be there before that
    cyberpunkAdapter.installCetMod()

    // First run after an update: Capri reads the patch scripts (scripts-capri/) once she's on screen
    setTimeout(() => {
      updateService.announcePatchNotesIfUpdated().catch((err) => console.warn('[UpdateService] patch notes failed:', err))
    }, 9000)

    // Start background proactive system observer (RAM alerts, game detection like League of Legends, etc.)
    systemObserver.start()

    // Start autonomous boredom engine (opens tabs, searches videos, puts music on Spotify periodically)
    boredomService.start()
    proactiveDialogueService.start()
    gamePresenceService.start()
    gameEventBus.start()
    // Pre-warm local GPU Whisper STT worker for instant voice responses
    try {
      voiceService.ensureWorker()
    } catch {}

    // Auto-start Ollama in background if installed and not yet running
    ollamaService.ensureRunning().catch((err) => {
      console.warn('[OllamaService] Auto-start check failed:', err)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        windowManager.init()
      }
    })
  })

  app.on('window-all-closed', () => {
    boredomService.stop()
    proactiveDialogueService.stop()
    gamePresenceService.stop()
    gameEventBus.stop()
    systemObserver.stop()
    ollamaService.stop()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    ;(app as unknown as { isQuitting?: boolean }).isQuitting = true
    boredomService.stop()
    proactiveDialogueService.stop()
    gamePresenceService.stop()
    gameEventBus.stop()
    systemObserver.stop()
    ollamaService.stop()
  })
}
