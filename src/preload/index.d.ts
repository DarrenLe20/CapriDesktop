import type { LlmPublicSettings, LlmSettingsUpdate } from '../main/services/llm-gateway'
import {
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

export interface SetupStatus {
  python: { systemPython: string | null; envReady: boolean }
  ffmpeg: boolean
  ollama: { installed: boolean; running: boolean; models: string[] }
  model: boolean
  persona: boolean
}

export interface IElectronAPI {
  deck: {
    toggle: () => Promise<boolean>
    show: () => Promise<void>
    hide: () => Promise<void>
    getStatus: () => Promise<boolean>
    onStatusChanged?: (callback: (isOpen: boolean) => void) => () => void
  }
  window: {
    minimize: () => Promise<void>
    close: () => Promise<void>
  }
  roaming: {
    toggle: () => Promise<boolean>
    setActive: (active: boolean) => Promise<RoamingStatusPayload>
    getStatus: () => Promise<RoamingStatusPayload>
    onStateChanged: (callback: (status: RoamingStatusPayload) => void) => () => void
  }
  game: {
    startCatchGame: () => Promise<boolean>
    catchSuccess: () => Promise<boolean>
    markCyberpunkPoi: (target?: string) => Promise<boolean>
    clearCyberpunkPoi: () => Promise<boolean>
    markCyberpunkGig: (gigId?: string) => Promise<boolean>
    openExternal: (url: string) => Promise<boolean>
  }
  companion: {
    setState: (state: CompanionEmotionState) => Promise<string>
    setTabMode: (enabled: boolean, keepPosition?: boolean) => Promise<boolean>
    setEyeMode: (enabled: boolean) => Promise<boolean>
    setGamingMode: (enabled: boolean, corner?: string) => Promise<boolean>
    getGamingMode: () => Promise<boolean>
    setHitThrough: (ignore: boolean) => Promise<boolean>
    listDisplays: () => Promise<{ id: number; label: string; width: number; height: number; primary: boolean; current: boolean }[]>
    moveToDisplay: (id: number) => Promise<boolean>
    getMonitorWander: () => Promise<boolean>
    setMonitorWander: (enabled: boolean) => Promise<boolean>
    setClickThrough: (ignore: boolean) => Promise<boolean>
    onScriptEvent: (
      callback: (
        event:
          | { kind: 'start' }
          | { kind: 'end' }
          | { kind: 'look'; look: 'ojos' | 'ojos2' | 'closed' | 'thinking' | 'asustada' | null }
          | { kind: 'line'; id: number; text: string; audioDataUrl?: string; look?: 'ojos' | 'ojos2' | 'closed' | 'thinking' | 'asustada' }
      ) => void
    ) => () => void
    scriptLineDone: (id: number) => void
    cancelScript: () => void
    onToggleChat: (callback: () => void) => () => void
    getUserProfile: () => Promise<{ name: string; hasName: boolean; onboardingDone: boolean }>
    setUserName: (name: string) => Promise<string>
    onUserNameChanged: (callback: (name: string) => void) => () => void
    getLanguageSettings: () => Promise<{ textLang: string; speechLang: string; micLang: string }>
    setLanguageSettings: (next: { textLang?: string; speechLang?: string; micLang?: string }) => Promise<{ textLang: string; speechLang: string; micLang: string }>
    onGamingModeChanged: (callback: (enabled: boolean) => void) => () => void
    moveBy: (dx: number, dy: number) => Promise<{ x: number; y: number } | null>
    getConsciousness: () => Promise<{
      shutdownCount: number
      bootCount: number
      lastShutdownTimestamp: number
      lastBootTimestamp: number
      totalConversations: number
      preferredLanguage?: string
      bootGreeting: string
    }>
    getLanguage: () => Promise<string>
    onLineLanguage: (callback: (lang: string) => void) => () => void
    setLanguage: (lang: string) => Promise<string>
    speak: (text: string, durationMs?: number) => Promise<boolean>
    onStateChanged: (callback: (state: CompanionEmotionState) => void) => () => void
    onSpeechChanged: (callback: (payload: { text: string; durationMs: number; speakVoice?: boolean }) => void) => () => void
    onLanguageChanged: (callback: (lang: string) => void) => () => void
  }
  agent: {
    sendPrompt: (
      prompt: string,
      projectPath: string,
      mode?: AgentMode,
      source?: 'pet' | 'editor'
    ) => Promise<boolean>
    getConfig: () => Promise<AgentConfigPayload>
    setConfig: (config: Partial<AgentConfigPayload>) => Promise<AgentConfigPayload>
    detectOllama: () => Promise<{ running: boolean; models: string[] }>
    getLlmSettings: () => Promise<LlmPublicSettings>
    setLlmSettings: (update: LlmSettingsUpdate) => Promise<{ success: boolean; error?: string; settings: LlmPublicSettings }>
    listLlmModels: (baseUrl: string, apiKey?: string) => Promise<{ ok: boolean; models: string[]; error?: string }>
    testLlm: (baseUrl: string, model: string, apiKey?: string) => Promise<{ ok: boolean; error?: string }>
    clearHistory: () => Promise<boolean>
    respondPermission: (requestId: string, approved: boolean) => Promise<boolean>
    cancel: () => Promise<boolean>
    getStatus: () => Promise<{ isRunning: boolean; mode: string }>
    onEvent: (callback: (event: AgentEventPayload) => void) => () => void
  }
  terminal: {
    input: (command: string, cwd: string) => Promise<boolean>
    onData: (callback: (data: string) => void) => () => void
  }
  setup: {
    getStatus: () => Promise<SetupStatus>
    run: (step: 'python' | 'ffmpeg' | 'ollama' | 'model' | 'persona') => Promise<{ ok: boolean; status: SetupStatus }>
    onLog: (callback: (entry: { step: string; line: string }) => void) => () => void
    finish: () => Promise<boolean>
    open: () => Promise<boolean>
    getStorage: () => Promise<string | null>
    chooseStorage: (reset?: boolean) => Promise<string | null>
  }
  system: {
    selectDirectory: () => Promise<string | null>
    getCwd: () => Promise<string>
    listFiles: (rootDir: string) => Promise<string[]>
    listDir: (rootDir: string, relDir?: string) => Promise<{ name: string; path: string; isDir: boolean }[]>
    readFile: (rootDir: string, relPath: string) => Promise<string | null>
    writeFile: (rootDir: string, relPath: string, content: string) => Promise<boolean>
  }
  voice: {
    transcribe: (audioData: ArrayBuffer | Uint8Array, partial?: boolean) => Promise<{ success: boolean; text?: string; error?: string }>
    sttState: () => Promise<'off' | 'loading' | 'ready' | 'failed'>
    getArrowKeys: () => Promise<boolean>
    setArrowKeys: (enabled: boolean) => Promise<boolean>
    synthesize: (text: string, langOverride?: string) => Promise<{ success: boolean; audioDataUrl?: string; error?: string }>
    getConfig: () => Promise<any>
    setConfig: (config: any) => Promise<{ success: boolean; config?: any; error?: string }>
    onToggleRecording: (callback: () => void) => () => void
    setRecordingState: (active: boolean) => void
    onCancelRecording: (callback: () => void) => () => void
    onToggleAlwaysListening: (callback: () => void) => () => void
    wakeCheck: (text: string) => Promise<{ addressed: boolean; text: string; reason: 'wake_word' | 'macro' | 'none' }>
  }
  media: {
    control: (action: 'play' | 'pause' | 'play_pause' | 'next' | 'prev') => Promise<{ success: boolean; output: string }>
    getStatus: () => Promise<{ isPlaying: boolean; title: string }>
  }
  boredom: {
    getEnabled: () => Promise<boolean>
    setEnabled: (enabled: boolean) => Promise<boolean>
    trigger: (category?: 'apple_music' | 'youtube' | 'web_search') => Promise<boolean>
  }
  triggerClip: () => Promise<{ success: boolean; message?: string }>
  scanner: {
    open: () => Promise<boolean>
    close: () => Promise<boolean>
    toggle: () => Promise<boolean>
    getStatus: () => Promise<ScannerStatusPayload>
    setBounds: (bounds: Partial<ScannerBounds>) => Promise<boolean>
    scan: (query?: string) => Promise<ScannerScanResult>
    setContinuous: (enabled: boolean) => Promise<boolean>
    setIgnoreMouse: (ignore: boolean) => Promise<boolean>
    onEvent: (callback: (event: ScannerEventPayload) => void) => () => void
  }
}

declare global {
  interface Window {
    api: IElectronAPI
  }
}
