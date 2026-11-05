import type { LlmPublicSettings, LlmSettingsUpdate } from '../main/services/llm-gateway'
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  CompanionEmotionState,
  AgentEventPayload,
  RoamingStatusPayload,
  AgentMode,
  AgentConfigPayload,
  ScannerBounds,
  ScannerStatusPayload,
  ScannerScanResult,
  ScannerEventPayload
} from '../main/ipc/channels'

// Linux: mouse moves over a click-through window arrive from the main process (Electron only
// forwards them by itself on Windows and macOS). The page handles them as ordinary mouse events.
let forwardedTarget: Element | null = null
ipcRenderer.on(IPC_CHANNELS.WINDOW_FORWARDED_MOUSE, (_event, m: { x: number; y: number; inside: boolean }) => {
  const init = { bubbles: true, cancelable: true, clientX: m.x, clientY: m.y, view: window }
  if (m.inside) {
    const target = document.elementFromPoint(m.x, m.y) || document.documentElement
    if (target !== forwardedTarget) {
      forwardedTarget?.dispatchEvent(new MouseEvent('mouseout', { ...init, relatedTarget: target }))
      target.dispatchEvent(new MouseEvent('mouseover', { ...init, relatedTarget: forwardedTarget }))
      forwardedTarget = target
    }
    target.dispatchEvent(new MouseEvent('mousemove', init))
  } else {
    forwardedTarget?.dispatchEvent(new MouseEvent('mouseout', { ...init, relatedTarget: null }))
    document.documentElement.dispatchEvent(new MouseEvent('mouseleave', { ...init, bubbles: false }))
    forwardedTarget = null
  }
})

const api = {
  // Deck Window Controls
  deck: {
    toggle: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.DECK_TOGGLE),
    show: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.DECK_SHOW),
    hide: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.DECK_HIDE),
    getStatus: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.DECK_STATUS),
    onStatusChanged: (callback: (isOpen: boolean) => void): (() => void) => {
      const subscription = (_event: IpcRendererEvent, isOpen: boolean): void => callback(isOpen)
      ipcRenderer.on(IPC_CHANNELS.DECK_STATUS, subscription)
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.DECK_STATUS, subscription)
      }
    }
  },

  // Window Controls
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    close: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE)
  },

  // Roaming & Desktop Walking
  roaming: {
    toggle: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.ROAMING_TOGGLE),
    setActive: (active: boolean): Promise<RoamingStatusPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.ROAMING_SET_ACTIVE, active),
    getStatus: (): Promise<RoamingStatusPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.ROAMING_GET_STATUS),
    onStateChanged: (callback: (status: RoamingStatusPayload) => void): (() => void) => {
      const subscription = (_event: IpcRendererEvent, status: RoamingStatusPayload): void => callback(status)
      ipcRenderer.on(IPC_CHANNELS.ROAMING_STATE_CHANGED, subscription)
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.ROAMING_STATE_CHANGED, subscription)
      }
    }
  },

  // Mini-Games & Playful actions
  game: {
    startCatchGame: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.GAME_CATCH_START),
    catchSuccess: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.GAME_CATCH_SUCCESS),
    markCyberpunkPoi: (target?: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CYBERPUNK_MARK_POI, target),
    clearCyberpunkPoi: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CYBERPUNK_CLEAR_POI),
    markCyberpunkGig: (gigId?: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CYBERPUNK_MARK_GIG, gigId),
    openExternal: (url: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, url)
  },

  // Companion Character Controls & Events
  companion: {
    setState: (state: CompanionEmotionState): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_SET_STATE, state),

    setTabMode: (enabled: boolean, keepPosition = true): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_SET_TAB_MODE, enabled, keepPosition),

    setEyeMode: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_SET_EYE_MODE, enabled),

    setGamingMode: (enabled: boolean, corner?: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_SET_GAMING_MODE, enabled, corner),

    getGamingMode: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_GET_GAMING_MODE),

    onScriptEvent: (callback: (event: any) => void): (() => void) => {
      const subscription = (_event: IpcRendererEvent, event: any): void => callback(event)
      ipcRenderer.on(IPC_CHANNELS.COMPANION_SCRIPT_EVENT, subscription)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.COMPANION_SCRIPT_EVENT, subscription)
      }
    },
    scriptLineDone: (id: number): void => ipcRenderer.send(IPC_CHANNELS.COMPANION_SCRIPT_LINE_DONE, id),
    cancelScript: (): void => ipcRenderer.send(IPC_CHANNELS.COMPANION_SCRIPT_CANCEL),

    setHitThrough: (ignore: boolean): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.COMPANION_SET_HIT_THROUGH, ignore),
    listDisplays: (): Promise<{ id: number; label: string; width: number; height: number; primary: boolean; current: boolean }[]> => ipcRenderer.invoke(IPC_CHANNELS.DISPLAYS_LIST),
    moveToDisplay: (id: number): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.DISPLAYS_MOVE, id),
    getMonitorWander: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.DISPLAYS_GET_WANDER),
    setMonitorWander: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.DISPLAYS_SET_WANDER, enabled),
    setClickThrough: (ignore: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_SET_CLICK_THROUGH, ignore),

    getUserProfile: (): Promise<{ name: string; hasName: boolean; onboardingDone: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_GET_USER_PROFILE),

    setUserName: (name: string): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.COMPANION_SET_USER_NAME, name),

    onUserNameChanged: (callback: (name: string) => void): (() => void) => {
      const sub = (_e: IpcRendererEvent, name: string): void => callback(name)
      ipcRenderer.on(IPC_CHANNELS.COMPANION_USER_NAME_CHANGED, sub)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.COMPANION_USER_NAME_CHANGED, sub)
    },

    getLanguageSettings: (): Promise<{ textLang: string; speechLang: string; micLang: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_GET_LANGUAGE_SETTINGS),

    setLanguageSettings: (next: { textLang?: string; speechLang?: string; micLang?: string }): Promise<{ textLang: string; speechLang: string; micLang: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_SET_LANGUAGE_SETTINGS, next),

    onToggleChat: (callback: () => void): (() => void) => {
      const sub = (): void => callback()
      ipcRenderer.on(IPC_CHANNELS.COMPANION_TOGGLE_CHAT, sub)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.COMPANION_TOGGLE_CHAT, sub)
    },

    onGamingModeChanged: (callback: (enabled: boolean) => void): (() => void) => {
      const subscription = (_event: IpcRendererEvent, enabled: boolean): void => callback(enabled)
      ipcRenderer.on(IPC_CHANNELS.COMPANION_GAMING_MODE_CHANGED, subscription)
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.COMPANION_GAMING_MODE_CHANGED, subscription)
      }
    },

    moveBy: (dx: number, dy: number): Promise<{ x: number; y: number } | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_MOVE_BY, { dx, dy }),

    getConsciousness: (): Promise<{
      shutdownCount: number
      bootCount: number
      lastShutdownTimestamp: number
      lastBootTimestamp: number
      totalConversations: number
      preferredLanguage?: string
      bootGreeting: string
    }> => ipcRenderer.invoke(IPC_CHANNELS.COMPANION_GET_CONSCIOUSNESS),

    getLanguage: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.COMPANION_GET_LANGUAGE),
    onLineLanguage: (callback: (lang: string) => void): (() => void) => {
      const sub = (_e: IpcRendererEvent, lang: string): void => callback(lang)
      ipcRenderer.on(IPC_CHANNELS.COMPANION_LINE_LANGUAGE, sub)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.COMPANION_LINE_LANGUAGE, sub)
    },

    setLanguage: (lang: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_SET_LANGUAGE, lang),

    speak: (text: string, durationMs?: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.COMPANION_SPEAK, { text, durationMs }),

    onStateChanged: (callback: (state: CompanionEmotionState) => void): (() => void) => {
      const subscription = (_event: IpcRendererEvent, state: CompanionEmotionState): void => callback(state)
      ipcRenderer.on(IPC_CHANNELS.COMPANION_STATE_CHANGED, subscription)
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.COMPANION_STATE_CHANGED, subscription)
      }
    },

    onSpeechChanged: (
      callback: (payload: { text: string; durationMs: number; speakVoice?: boolean }) => void
    ): (() => void) => {
      const subscription = (
        _event: IpcRendererEvent,
        payload: { text: string; durationMs: number; speakVoice?: boolean }
      ): void => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.COMPANION_SPEECH_CHANGED, subscription)
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.COMPANION_SPEECH_CHANGED, subscription)
      }
    },

    onLanguageChanged: (callback: (lang: string) => void): (() => void) => {
      const subscription = (_event: IpcRendererEvent, lang: string): void => callback(lang)
      ipcRenderer.on(IPC_CHANNELS.COMPANION_LANGUAGE_CHANGED, subscription)
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.COMPANION_LANGUAGE_CHANGED, subscription)
      }
    }
  },

  // Agent Controls & Real-time Events
  agent: {
    sendPrompt: (
      prompt: string,
      projectPath: string,
      mode?: AgentMode,
      source?: 'pet' | 'editor'
    ): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SEND_PROMPT, { prompt, projectPath, mode, source }),

    getConfig: (): Promise<AgentConfigPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_CONFIG),

    setConfig: (config: Partial<AgentConfigPayload>): Promise<AgentConfigPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SET_CONFIG, config),

    detectOllama: (): Promise<{ running: boolean; models: string[] }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_DETECT_OLLAMA),

    getLlmSettings: (): Promise<LlmPublicSettings> => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_SETTINGS),

    setLlmSettings: (update: LlmSettingsUpdate): Promise<{ success: boolean; error?: string; settings: LlmPublicSettings }> =>
      ipcRenderer.invoke(IPC_CHANNELS.LLM_SET_SETTINGS, update),

    listLlmModels: (baseUrl: string, apiKey?: string): Promise<{ ok: boolean; models: string[]; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.LLM_LIST_MODELS, baseUrl, apiKey),

    testLlm: (baseUrl: string, model: string, apiKey?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.LLM_TEST, baseUrl, model, apiKey),

    clearHistory: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_CLEAR_HISTORY),

    respondPermission: (requestId: string, approved: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, { requestId, approved }),

    cancel: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_CANCEL),

    getStatus: (): Promise<{ isRunning: boolean; mode: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_STATUS),

    onEvent: (callback: (event: AgentEventPayload) => void): (() => void) => {
      const subscription = (_event: IpcRendererEvent, event: AgentEventPayload): void => callback(event)
      ipcRenderer.on(IPC_CHANNELS.AGENT_EVENT, subscription)
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.AGENT_EVENT, subscription)
      }
    }
  },

  // Terminal Controls & Output
  terminal: {
    input: (command: string, cwd: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_INPUT, { command, cwd }),

    onData: (callback: (data: string) => void): (() => void) => {
      const subscription = (_event: IpcRendererEvent, data: string): void => callback(data)
      ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, subscription)
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_DATA, subscription)
      }
    }
  },

  // System Utilities & Project Files
  setup: {
    getStatus: (): Promise<any> => ipcRenderer.invoke(IPC_CHANNELS.SETUP_STATUS),
    run: (step: string): Promise<{ ok: boolean; status: any }> => ipcRenderer.invoke(IPC_CHANNELS.SETUP_RUN, step),
    onLog: (callback: (entry: { step: string; line: string }) => void): (() => void) => {
      const sub = (_e: IpcRendererEvent, entry: { step: string; line: string }): void => callback(entry)
      ipcRenderer.on(IPC_CHANNELS.SETUP_LOG, sub)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SETUP_LOG, sub)
    },
    finish: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.ONBOARDING_FINISH),
    open: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.ONBOARDING_OPEN),
    getStorage: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SETUP_GET_STORAGE),
    chooseStorage: (reset?: boolean): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SETUP_CHOOSE_STORAGE, reset)
  },

  system: {
    selectDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY),

    getCwd: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_CWD),

    listFiles: (rootDir: string): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_LIST_FILES, rootDir),

    listDir: (rootDir: string, relDir?: string): Promise<{ name: string; path: string; isDir: boolean }[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_LIST_DIR, { rootDir, relDir }),

    readFile: (rootDir: string, relPath: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_READ_FILE, { rootDir, relPath }),

    writeFile: (rootDir: string, relPath: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_WRITE_FILE, { rootDir, relPath, content })
  },

  // Voice Core (Speech-to-Text & Text-to-Speech)
  voice: {
    transcribe: (audioData: ArrayBuffer | Uint8Array, partial?: boolean): Promise<{ success: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRANSCRIBE, audioData, partial),
    sttState: (): Promise<'off' | 'loading' | 'ready' | 'failed'> => ipcRenderer.invoke(IPC_CHANNELS.VOICE_STT_STATE),
    getArrowKeys: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.ARROW_KEYS_GET),
    setArrowKeys: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.ARROW_KEYS_SET, enabled),

    synthesize: (text: string, langOverride?: string): Promise<{ success: boolean; audioDataUrl?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_SYNTHESIZE, text, langOverride),

    getConfig: (): Promise<any> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_CONFIG),

    setConfig: (config: any): Promise<{ success: boolean; config?: any; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_SET_CONFIG, config),

    onToggleAlwaysListening: (callback: () => void): (() => void) => {
      const sub = (): void => callback()
      ipcRenderer.on(IPC_CHANNELS.VOICE_TOGGLE_ALWAYS_LISTENING, sub)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_TOGGLE_ALWAYS_LISTENING, sub)
    },

    wakeCheck: (text: string): Promise<{ addressed: boolean; text: string; reason: 'wake_word' | 'macro' | 'none' }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_WAKE_CHECK, text),

    onToggleRecording: (callback: () => void): (() => void) => {
      const sub = (): void => callback()
      ipcRenderer.on(IPC_CHANNELS.VOICE_TOGGLE_RECORDING, sub)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_TOGGLE_RECORDING, sub)
    },

    setRecordingState: (active: boolean): void => ipcRenderer.send(IPC_CHANNELS.VOICE_RECORDING_STATE, active),

    onCancelRecording: (callback: () => void): (() => void) => {
      const sub = (): void => callback()
      ipcRenderer.on(IPC_CHANNELS.VOICE_CANCEL_RECORDING, sub)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_CANCEL_RECORDING, sub)
    }
  },

  // Media Controls (Spotify)
  media: {
    control: (action: 'play' | 'pause' | 'play_pause' | 'next' | 'prev'): Promise<{ success: boolean; output: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEDIA_CONTROL, action),

    getStatus: (): Promise<{ isPlaying: boolean; title: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEDIA_GET_STATUS)
  },

  // NVIDIA ShadowPlay Instant Replay Clipping
  triggerClip: (): Promise<{ success: boolean; message?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_TRIGGER_CLIP),

  // Autonomous Boredom
  boredom: {
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.BOREDOM_GET_ENABLED),
    setEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.BOREDOM_SET_ENABLED, enabled),
    trigger: (category?: 'spotify' | 'youtube' | 'web_search'): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOREDOM_TRIGGER, category)
  },

  // Neural Scanner Mode (Screen Region Vision)
  scanner: {
    open: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.SCANNER_OPEN),
    close: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.SCANNER_CLOSE),
    toggle: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.SCANNER_TOGGLE),
    getStatus: (): Promise<ScannerStatusPayload> => ipcRenderer.invoke(IPC_CHANNELS.SCANNER_GET_STATUS),
    setBounds: (bounds: Partial<ScannerBounds>): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SCANNER_SET_BOUNDS, bounds),
    scan: (query?: string): Promise<ScannerScanResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SCANNER_SCAN, query),
    setContinuous: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SCANNER_SET_CONTINUOUS, enabled),
    setIgnoreMouse: (ignore: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SCANNER_SET_IGNORE_MOUSE, ignore),
    onEvent: (callback: (event: ScannerEventPayload) => void): (() => void) => {
      const subscription = (_event: IpcRendererEvent, event: ScannerEventPayload): void => callback(event)
      ipcRenderer.on(IPC_CHANNELS.SCANNER_EVENT, subscription)
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.SCANNER_EVENT, subscription)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
