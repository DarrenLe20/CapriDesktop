import { getStorageRoot } from '../services/storage-location'
import { scriptPlayer } from '../services/script/script-player'
import { getLlmSettings, listCloudModels, setLlmSettings, testCloudConnection, type LlmSettingsUpdate } from '../services/llm-gateway'
import { setupService, SetupStep } from '../services/setup-service'
import * as os from 'os'
import { getUserName } from '../services/user-profile'
import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC_CHANNELS, CompanionEmotionState } from './channels'
import { windowManager } from '../windows/window-manager'
import { agentManager } from '../agents/agent-manager'
import { terminalManager } from '../terminal/terminal-manager'
import { roamingManager } from '../roaming/roaming-manager'
import { voiceService } from '../services/voice-service'
import { checkAddressed } from '../services/wake-word'
import { consciousnessService } from '../services/consciousness-service'
import { localizeLine } from '../../shared/lines'
import { isSupportedLang } from '../../shared/languages'
import { ToolExecutor } from '../agents/tools/tool-executor'
import { scannerService } from '../services/scanner-service'
import { boredomService } from '../services/boredom-service'
import { cyberpunkAdapter } from '../services/game'
import { CYBERPUNK_GIGS, getNextGig } from '../services/game/adapters/cyberpunk/gigs'
import { clipService } from '../services/clip-service'
import { welcomeSpeech } from '../services/welcome-speech'

export function registerIpcHandlers(): void {
  // Deck window visibility
  ipcMain.handle(IPC_CHANNELS.DECK_TOGGLE, () => {
    return windowManager.toggleDeck()
  })

  ipcMain.handle(IPC_CHANNELS.DECK_SHOW, () => {
    windowManager.showDeck()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.DECK_HIDE, () => {
    windowManager.hideDeck()
    return false
  })

  ipcMain.handle(IPC_CHANNELS.DECK_STATUS, () => {
    const deck = windowManager.getDeckWindow()
    return deck ? deck.isVisible() : false
  })

  // Window control (minimize, close)
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win === windowManager.getDeckWindow()) {
        // If minimizing the deck, restore desktop companion
        windowManager.hideDeck()
      } else {
        win.minimize()
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win === windowManager.getDeckWindow()) {
        windowManager.hideDeck()
      } else {
        win.close()
      }
    }
  })

  // Desktop Roaming & Walking
  ipcMain.handle(IPC_CHANNELS.ROAMING_TOGGLE, () => {
    return roamingManager.toggle()
  })

  ipcMain.handle(IPC_CHANNELS.ROAMING_SET_ACTIVE, (_event, active: boolean) => {
    if (active) roamingManager.start()
    else roamingManager.stop()
    return roamingManager.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.ROAMING_GET_STATUS, () => {
    return roamingManager.getStatus()
  })

  // Mini-game Catch Capri
  ipcMain.handle(IPC_CHANNELS.GAME_CATCH_START, () => {
    roamingManager.startCatchGame()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.GAME_CATCH_SUCCESS, () => {
    roamingManager.handleCatchSuccess()
    return true
  })

  // External web tabs (game links, cyberpunk music, etc.)
  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, async (_event, url: string) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url)
      return true
    }
    return false
  })

  // Companion state & speech
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SET_STATE,
    (_event, state: CompanionEmotionState) => {
      agentManager.setCompanionState(state)
      return state
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SPEAK,
    (_event, payload: { text: string; durationMs?: number }) => {
      agentManager.setCompanionSpeech(payload.text, payload.durationMs)
      return true
    }
  )

  // Top-Right Tab Mode (Modo Pestaña en esquina superior derecha)
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SET_TAB_MODE,
    (_event, enabled: boolean, keepPosition = true) => {
      return windowManager.setTabMode(enabled, undefined, keepPosition)
    }
  )

  // Modo Ojos (Eye Mode - freezes walking and roaming completely)
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SET_EYE_MODE,
    (_event, enabled: boolean) => {
      roamingManager.setEyeMode(enabled)
      return true
    }
  )

  // Modo Gaming (Docked in corner, eyes loop, screen-saver topmost priority)
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SET_GAMING_MODE,
    (_event, enabled: boolean, corner = 'bottom-right') => {
      windowManager.setGamingMode(enabled, corner as any)
      return true
    }
  )

  // Always-listening gate: was this utterance addressed to Capri?
  ipcMain.handle(IPC_CHANNELS.VOICE_WAKE_CHECK, async (_event, text: string) => checkAddressed(text))

  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SET_CLICK_THROUGH,
    (_event, ignore: boolean) => {
      windowManager.setCompanionClickThrough(!!ignore)
      return true
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_GAMING_MODE, () => {
    return windowManager.isGamingModeActive()
  })

  // Shift + Drag move Capri across screen
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_MOVE_BY,
    (_event, payload: { dx: number; dy: number }) => {
      const win = windowManager.getCompanionWindow()
      if (win && !win.isDestroyed()) {
        const bounds = win.getBounds()
        const newX = bounds.x + payload.dx
        const newY = bounds.y + payload.dy
        win.setPosition(newX, newY)
        if (windowManager.isGamingModeActive()) {
          windowManager.setSavedGamingPosition({ x: newX, y: newY })
        } else {
          roamingManager.notifyUserDrag(newX, newY)
        }
        return { x: newX, y: newY }
      }
      return null
    }
  )

  // Autonomous Boredom Action (Trigger on-demand or test)
  ipcMain.handle(
    IPC_CHANNELS.BOREDOM_TRIGGER,
    async (_event, category?: 'spotify' | 'youtube' | 'web_search') => {
      return await boredomService.triggerBoredomAction(category)
    }
  )

  // Consciousness and reboot stats
  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_CONSCIOUSNESS, () => {
    return {
      ...consciousnessService.getData(),
      // The language lines go out in, not the stored one, which resets to English on load
      preferredLanguage: consciousnessService.getPreferredLanguage(),
      bootGreeting: localizeLine(consciousnessService.getBootGreeting(), consciousnessService.getPreferredLanguage())
    }
  })

  // Preferred Language management
  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_LANGUAGE, () => {
    return consciousnessService.getUiLanguage()
  })
  consciousnessService.onSpokenLanguageChanged((lang) => windowManager.broadcast(IPC_CHANNELS.COMPANION_LINE_LANGUAGE, lang))

  // Spoken language already configured from a previous session: warm the translator in the background
  if (consciousnessService.getLanguageSettings().speechLang !== 'auto') {
    setTimeout(() => voiceService.warmTranslator(), 5000)
  }

  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_LANGUAGE_SETTINGS, () => consciousnessService.getLanguageSettings())

  // First-run setup (onboarding window)
  ipcMain.handle(IPC_CHANNELS.SETUP_STATUS, () => setupService.getStatus())

  ipcMain.handle(IPC_CHANNELS.SETUP_RUN, async (_event, step: SetupStep) => {
    const ok = await setupService.run(step, (s, line) => windowManager.broadcast(IPC_CHANNELS.SETUP_LOG, { step: s, line }))
    return { ok, status: await setupService.getStatus() }
  })

  ipcMain.handle(IPC_CHANNELS.DISPLAYS_LIST, () => windowManager.listDisplays())
  ipcMain.handle(IPC_CHANNELS.DISPLAYS_MOVE, (_event, id: number) => windowManager.moveCompanionToDisplay(id))
  ipcMain.handle(IPC_CHANNELS.BOREDOM_GET_ENABLED, () => consciousnessService.isBoredomEnabled())
  ipcMain.handle(IPC_CHANNELS.BOREDOM_SET_ENABLED, (_event, enabled: boolean) => {
    consciousnessService.setBoredomEnabled(!!enabled)
    return !!enabled
  })

  ipcMain.handle(IPC_CHANNELS.COMPANION_SET_HIT_THROUGH, (_event, ignore: boolean) => {
    windowManager.setCompanionHitThrough(!!ignore)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.SETUP_GET_STORAGE, () => getStorageRoot())
  ipcMain.handle(IPC_CHANNELS.SETUP_CHOOSE_STORAGE, async (_event, reset?: boolean) => {
    if (reset) {
      await setupService.changeStorage(null)
      return null
    }
    const picked = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (picked.canceled || !picked.filePaths[0]) return getStorageRoot()
    await setupService.changeStorage(path.join(picked.filePaths[0], 'CapriData'))
    return getStorageRoot()
  })

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_OPEN, () => {
    windowManager.openOnboarding()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_FINISH, () => {
    const firstTime = !consciousnessService.isOnboardingDone()
    consciousnessService.setOnboardingDone(true)
    windowManager.finishOnboarding()
    // First install: Capri introduces herself once the setup window is gone
    if (firstTime) {
      const s = consciousnessService.getLanguageSettings()
      const lang = s.textLang && s.textLang !== 'auto' ? s.textLang : consciousnessService.getPreferredLanguage()
      setTimeout(() => {
        agentManager.setCompanionState('talking')
        agentManager.setCompanionSpeech(welcomeSpeech(lang), 22000, true)
      }, 1500)
    }
    return true
  })

  // How Capri calls the user (set during onboarding, editable later)
  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_USER_PROFILE, () => ({
    name: getUserName(),
    hasName: !!consciousnessService.getUserName(),
    onboardingDone: consciousnessService.isOnboardingDone()
  }))

  ipcMain.handle(IPC_CHANNELS.COMPANION_SET_USER_NAME, (_event, name: string) => {
    const clean = String(name || '').trim()
    if (!clean) return getUserName()
    consciousnessService.setUserName(clean)
    windowManager.broadcast(IPC_CHANNELS.COMPANION_USER_NAME_CHANGED, getUserName())
    return getUserName()
  })

  ipcMain.handle(IPC_CHANNELS.COMPANION_SET_LANGUAGE_SETTINGS, (_event, next: Record<string, string>) => {
    const saved = consciousnessService.setLanguageSettings(next || {})
    // Spoken language differs from the text: load the translation model now, not on the first line
    if (saved.speechLang && saved.speechLang !== 'auto') voiceService.warmTranslator()
    windowManager.broadcast(IPC_CHANNELS.COMPANION_LANGUAGE_CHANGED, consciousnessService.getUiLanguage())
    return saved
  })

  ipcMain.handle(IPC_CHANNELS.COMPANION_SET_LANGUAGE, (_event, lang: string) => {
    if (!isSupportedLang(lang)) lang = 'en'
    consciousnessService.setPreferredLanguage(lang)
    windowManager.broadcast(IPC_CHANNELS.COMPANION_LANGUAGE_CHANGED, lang)
    return lang
  })

  // Agent execution & configuration
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SEND_PROMPT,
    async (_event, payload: { prompt: string; projectPath: string; mode?: any; source?: 'pet' | 'editor' }) => {
      // No workspace picked yet: work from the user's home folder
      await agentManager.sendPrompt(payload.prompt, payload.projectPath || os.homedir(), payload.mode, payload.source)
      return true
    }
  )

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_CONFIG, () => {
    return agentManager.getConfig()
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SET_CONFIG, (_event, config) => {
    return agentManager.setConfig(config)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_GET_SETTINGS, () => getLlmSettings())
  ipcMain.handle(IPC_CHANNELS.LLM_SET_SETTINGS, (_event, update: LlmSettingsUpdate) => setLlmSettings(update))
  ipcMain.handle(IPC_CHANNELS.LLM_LIST_MODELS, (_event, baseUrl: string, apiKey?: string) => listCloudModels(baseUrl, apiKey))
  ipcMain.handle(IPC_CHANNELS.LLM_TEST, (_event, baseUrl: string, model: string, apiKey?: string) =>
    testCloudConnection(baseUrl, model, apiKey)
  )

  ipcMain.handle(IPC_CHANNELS.AGENT_DETECT_OLLAMA, async () => {
    return await agentManager.detectOllama()
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_CLEAR_HISTORY, () => {
    agentManager.clearHistory()
    return true
  })

  ipcMain.handle(
    IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
    (_event, payload: { requestId: string; approved: boolean }) => {
      agentManager.respondPermission(payload.requestId, payload.approved)
      return true
    }
  )

  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL, () => {
    agentManager.cancel()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUS, () => {
    return agentManager.getStatus()
  })

  // Terminal
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_INPUT,
    (_event, payload: { command: string; cwd: string }) => {
      terminalManager.execCommand(payload.command, payload.cwd)
      return true
    }
  )

  // Directory picker dialog
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, async () => {
    const deckWin = windowManager.getDeckWindow()
    const parentWin = (deckWin && !deckWin.isDestroyed() && deckWin.isVisible()) ? deckWin : undefined
    const result = await dialog.showOpenDialog(parentWin as any, {
      properties: ['openDirectory'],
      title: 'Select Project Workspace Folder // Capricorn Dev Deck'
    })

    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0]
    }
    return null
  })

  // System cwd
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_CWD, () => {
    return process.cwd()
  })

  // File System Helpers for Code Editor (Fast, Non-blocking, Text-code only)
  ipcMain.handle(IPC_CHANNELS.FS_LIST_FILES, async (_event, rootDir: string) => {
    try {
      const baseDir = rootDir || process.cwd()
      if (!fs.existsSync(baseDir)) return []

      const files: string[] = []
      const ignoreDirs = new Set([
        'node_modules', '.git', 'dist', 'out', '.vscode', 'build', '.idea',
        'coverage', '.venv', 'venv', '__pycache__', 'unused', 'target', '.next', '.cache'
      ])
      const codeExtensions = new Set([
        '.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css', '.scss',
        '.md', '.py', '.cs', '.ps1', '.bat', '.sh', '.rs', '.go', '.cpp',
        '.c', '.h', '.java', '.yaml', '.yml', '.toml', '.txt', '.xml', '.env', '.sql'
      ])

      function scan(currentDir: string, depth = 0): void {
        if (depth > 3 || files.length >= 60) return
        try {
          const entries = fs.readdirSync(currentDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory()) {
              if (!ignoreDirs.has(entry.name) && !entry.name.startsWith('.')) {
                scan(path.join(currentDir, entry.name), depth + 1)
              }
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase()
              if (codeExtensions.has(ext)) {
                const rel = path.relative(baseDir, path.join(currentDir, entry.name)).replace(/\\/g, '/')
                files.push(rel)
                if (files.length >= 60) break
              }
            }
          }
        } catch {
          // Skip inaccessible directories
        }
      }

      scan(baseDir, 0)
      return files
    } catch {
      return []
    }
  })

  // One directory level at a time (lazy file tree in the code editor)
  ipcMain.handle(IPC_CHANNELS.FS_LIST_DIR, async (_event, payload: { rootDir: string; relDir?: string }) => {
    try {
      const root = payload.rootDir || process.cwd()
      const rel = (payload.relDir || '').replace(/\\/g, '/').replace(/^\/+/, '')
      const dir = path.resolve(root, rel)
      if (!dir.startsWith(path.resolve(root)) || !fs.existsSync(dir)) return []
      const hidden = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.venv', 'venv', '__pycache__', '.next', '.cache', '.idea', '.vscode'])
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => !hidden.has(e.name) && !(e.isDirectory() && e.name.startsWith('.')))
        .filter((e) => e.isDirectory() || e.isFile())
        .map((e) => ({ name: e.name, path: (rel ? `${rel}/` : '') + e.name, isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1))
        .slice(0, 500)
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.FS_READ_FILE, async (_event, payload: { rootDir: string; relPath: string }) => {
    try {
      const fullPath = path.isAbsolute(payload.relPath)
        ? payload.relPath
        : path.join(payload.rootDir || process.cwd(), payload.relPath)
      if (!fs.existsSync(fullPath)) return null
      const stat = fs.statSync(fullPath)
      if (stat.size > 512 * 1024) {
        return `// [File is too large to load in preview (${(stat.size / 1024).toFixed(1)} KB)]\n// Open directly in your IDE for full editing.`
      }
      return fs.readFileSync(fullPath, 'utf-8')
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.FS_WRITE_FILE, async (_event, payload: { rootDir: string; relPath: string; content: string }) => {
    try {
      const fullPath = path.isAbsolute(payload.relPath)
        ? payload.relPath
        : path.join(payload.rootDir || process.cwd(), payload.relPath)
      const parent = path.dirname(fullPath)
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true })
      }
      fs.writeFileSync(fullPath, payload.content, 'utf-8')
      return true
    } catch {
      return false
    }
  })

  ipcMain.on(IPC_CHANNELS.VOICE_RECORDING_STATE, (_event, active: boolean) => {
    windowManager.setVoiceRecordingActive(!!active)
  })

  // Voice Core (Speech-to-Text and Text-to-Speech)
  ipcMain.handle(IPC_CHANNELS.VOICE_STT_STATE, () => voiceService.getSttState())
  ipcMain.handle(IPC_CHANNELS.ARROW_KEYS_GET, () => consciousnessService.getArrowKeysEnabled())
  ipcMain.handle(IPC_CHANNELS.ARROW_KEYS_SET, (_event, enabled: boolean) => {
    windowManager.setArrowKeysEnabled(!!enabled)
    return !!enabled
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_TRANSCRIBE, async (_event, audioData: ArrayBuffer | Uint8Array, partial?: boolean) => {
    try {
      const buffer = Buffer.isBuffer(audioData)
        ? audioData
        : audioData instanceof ArrayBuffer
        ? Buffer.from(audioData)
        : Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength)
      return await voiceService.transcribe(buffer, !!partial)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_SYNTHESIZE, async (_event, text: string, langOverride?: string) => {
    try {
      return await voiceService.synthesize(text, langOverride)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_GET_CONFIG, async () => {
    return voiceService.getConfig()
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_SET_CONFIG, async (_event, config: any) => {
    return voiceService.setConfig(config)
  })

  // Media Controls (Spotify)
  ipcMain.handle(
    IPC_CHANNELS.MEDIA_CONTROL,
    async (_event, action: 'play' | 'pause' | 'play_pause' | 'next' | 'prev') => {
      try {
        return await ToolExecutor.mediaControl(action)
      } catch (err: any) {
        return { success: false, output: err?.message || String(err) }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEDIA_GET_STATUS, async () => {
    try {
      return await ToolExecutor.getMediaStatus()
    } catch {
      return { isPlaying: false, title: '' }
    }
  })

  // Neural Scanner Mode Controls & Vision Events
  ipcMain.handle(IPC_CHANNELS.SCANNER_OPEN, () => {
    return scannerService.open()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_CLOSE, () => {
    return scannerService.close()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_TOGGLE, () => {
    return scannerService.toggle()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_GET_STATUS, () => {
    return scannerService.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_SET_BOUNDS, (_event, bounds) => {
    windowManager.setScannerBounds(bounds)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_SCAN, async (_event, query?: string) => {
    return await scannerService.scan(query)
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_SET_CONTINUOUS, (_event, enabled: boolean) => {
    return scannerService.setContinuous(enabled)
  })

  ipcMain.on(IPC_CHANNELS.COMPANION_SCRIPT_LINE_DONE, (_event, id: number) => scriptPlayer.onLineDone(id))
  ipcMain.on(IPC_CHANNELS.COMPANION_SCRIPT_CANCEL, () => scriptPlayer.cancel())

  ipcMain.handle(IPC_CHANNELS.SCANNER_SET_IGNORE_MOUSE, (_event, ignore: boolean) => {
    windowManager.setScannerIgnoreMouse(ignore)
    return true
  })

  // NVIDIA ShadowPlay Instant Replay Clipping
  ipcMain.handle(IPC_CHANNELS.SYSTEM_TRIGGER_CLIP, async () => {
    return await clipService.triggerClip()
  })

  // Cyberpunk 2077 Integration
  ipcMain.handle(IPC_CHANNELS.CYBERPUNK_MARK_POI, async (_event, target?: string) => {
    return cyberpunkAdapter.sendCommand({
      action: 'mark_closest',
      target: target || 'ripperdoc'
    })
  })

  ipcMain.handle(IPC_CHANNELS.CYBERPUNK_CLEAR_POI, async () => {
    await cyberpunkAdapter.sendCommand({
      action: 'clear_marker'
    })
    return true
  })

  ipcMain.handle(IPC_CHANNELS.CYBERPUNK_MARK_GIG, async (_event, gigId?: string) => {
    const gig = gigId ? CYBERPUNK_GIGS.find((g) => g.id === gigId) || getNextGig() : getNextGig()
    return await cyberpunkAdapter.markGig(gig)
  })
}
