export const IPC_CHANNELS = {
  // Window
  DECK_TOGGLE: 'deck:toggle',
  DECK_SHOW: 'deck:show',
  DECK_HIDE: 'deck:hide',
  DECK_STATUS: 'deck:status',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_CLOSE: 'window:close',

  // Companion
  COMPANION_SET_STATE: 'companion:setState',
  COMPANION_GET_STATE: 'companion:getState',
  COMPANION_STATE_CHANGED: 'companion:stateChanged',
  COMPANION_SPEAK: 'companion:speak',
  COMPANION_SPEECH_CHANGED: 'companion:speechChanged',
  COMPANION_SET_TAB_MODE: 'companion:setTabMode',
  COMPANION_SET_EYE_MODE: 'companion:setEyeMode',
  COMPANION_SET_GAMING_MODE: 'companion:setGamingMode',
  COMPANION_GET_GAMING_MODE: 'companion:getGamingMode',
  COMPANION_GAMING_MODE_CHANGED: 'companion:gamingModeChanged',
  COMPANION_SET_CLICK_THROUGH: 'companion:setClickThrough',
  COMPANION_SET_HIT_THROUGH: 'companion:setHitThrough',
  DISPLAYS_LIST: 'displays:list',
  DISPLAYS_MOVE: 'displays:move',
  DISPLAYS_GET_WANDER: 'displays:getWander',
  DISPLAYS_SET_WANDER: 'displays:setWander',
  BOREDOM_GET_ENABLED: 'boredom:getEnabled',
  BOREDOM_SET_ENABLED: 'boredom:setEnabled',
  SETUP_GET_STORAGE: 'setup:getStorage',
  SETUP_CHOOSE_STORAGE: 'setup:chooseStorage',
  COMPANION_SCRIPT_EVENT: 'companion:scriptEvent',
  COMPANION_SCRIPT_LINE_DONE: 'companion:scriptLineDone',
  COMPANION_SCRIPT_CANCEL: 'companion:scriptCancel',
  WINDOW_FORWARDED_MOUSE: 'window:forwardedMouse',
  COMPANION_TOGGLE_CHAT: 'companion:toggleChat',
  VOICE_TOGGLE_ALWAYS_LISTENING: 'voice:toggleAlwaysListening',
  VOICE_WAKE_CHECK: 'voice:wakeCheck',
  COMPANION_MOVE_BY: 'companion:moveBy',
  COMPANION_GET_CONSCIOUSNESS: 'companion:getConsciousness',
  COMPANION_GET_LANGUAGE: 'companion:getLanguage',
  COMPANION_LINE_LANGUAGE: 'companion:lineLanguage',
  COMPANION_SET_LANGUAGE: 'companion:setLanguage',
  COMPANION_LANGUAGE_CHANGED: 'companion:languageChanged',
  COMPANION_GET_LANGUAGE_SETTINGS: 'companion:getLanguageSettings',
  COMPANION_GET_USER_PROFILE: 'companion:getUserProfile',
  COMPANION_SET_USER_NAME: 'companion:setUserName',
  COMPANION_USER_NAME_CHANGED: 'companion:userNameChanged',
  SETUP_STATUS: 'setup:status',
  SETUP_RUN: 'setup:run',
  SETUP_LOG: 'setup:log',
  ONBOARDING_FINISH: 'onboarding:finish',
  ONBOARDING_OPEN: 'onboarding:open',
  COMPANION_SET_LANGUAGE_SETTINGS: 'companion:setLanguageSettings',

  // Desktop Roaming & Walking
  ROAMING_TOGGLE: 'roaming:toggle',
  ROAMING_SET_ACTIVE: 'roaming:setActive',
  ROAMING_GET_STATUS: 'roaming:getStatus',
  ROAMING_STATE_CHANGED: 'roaming:stateChanged',

  // Mini-Games & Playful actions
  GAME_CATCH_START: 'game:catchStart',
  GAME_CATCH_SUCCESS: 'game:catchSuccess',
  BOREDOM_TRIGGER: 'boredom:trigger',

  // Cyberpunk 2077 Integration
  CYBERPUNK_MARK_POI: 'cyberpunk:markPoi',
  CYBERPUNK_CLEAR_POI: 'cyberpunk:clearPoi',
  CYBERPUNK_MARK_GIG: 'cyberpunk:markGig',

  // Agent Core
  AGENT_SEND_PROMPT: 'agent:sendPrompt',
  AGENT_EVENT: 'agent:event',
  AGENT_PERMISSION_RESPONSE: 'agent:permissionResponse',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_GET_STATUS: 'agent:getStatus',
  AGENT_GET_CONFIG: 'agent:getConfig',
  AGENT_SET_CONFIG: 'agent:setConfig',
  AGENT_DETECT_OLLAMA: 'agent:detectOllama',
  AGENT_CLEAR_HISTORY: 'agent:clearHistory',
  LLM_GET_SETTINGS: 'llm:getSettings',
  LLM_SET_SETTINGS: 'llm:setSettings',
  LLM_LIST_MODELS: 'llm:listModels',
  LLM_TEST: 'llm:test',

  // Terminal & System
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_CLEAR: 'terminal:clear',
  DIALOG_SELECT_DIRECTORY: 'dialog:selectDirectory',
  SYSTEM_GET_CWD: 'system:getCwd',
  SYSTEM_OPEN_EXTERNAL: 'system:openExternal',
  FS_LIST_FILES: 'fs:listFiles',
  FS_LIST_DIR: 'fs:listDir',
  FS_READ_FILE: 'fs:readFile',
  FS_WRITE_FILE: 'fs:writeFile',

  // Voice Core (Speech-to-Text and Text-to-Speech)
  VOICE_TRANSCRIBE: 'voice:transcribe',
  VOICE_STT_STATE: 'voice:sttState',
  ARROW_KEYS_GET: 'shortcuts:getArrowKeys',
  ARROW_KEYS_SET: 'shortcuts:setArrowKeys',
  VOICE_SYNTHESIZE: 'voice:synthesize',
  VOICE_TOGGLE_RECORDING: 'voice:toggle-recording',
  /** Renderer -> main: push-to-talk recording started/stopped (enables the global Esc to cancel) */
  VOICE_RECORDING_STATE: 'voice:recording-state',
  /** Main -> renderer: discard the current recording without sending it */
  VOICE_CANCEL_RECORDING: 'voice:cancel-recording',
  VOICE_GET_CONFIG: 'voice:get-config',
  VOICE_SET_CONFIG: 'voice:set-config',

  // Media controls (Apple Music, or whatever player Windows reports)
  MEDIA_CONTROL: 'media:control',
  MEDIA_GET_STATUS: 'media:getStatus',

  // NVIDIA ShadowPlay Instant Replay Clipping
  SYSTEM_TRIGGER_CLIP: 'system:triggerClip',

  // Scanner Mode (Screen Region Vision Analysis)
  SCANNER_OPEN: 'scanner:open',
  SCANNER_CLOSE: 'scanner:close',
  SCANNER_TOGGLE: 'scanner:toggle',
  SCANNER_GET_STATUS: 'scanner:getStatus',
  SCANNER_SET_BOUNDS: 'scanner:setBounds',
  SCANNER_SCAN: 'scanner:scan',
  SCANNER_SET_CONTINUOUS: 'scanner:setContinuous',
  SCANNER_SET_IGNORE_MOUSE: 'scanner:setIgnoreMouse',
  SCANNER_EVENT: 'scanner:event'
} as const

export type CompanionEmotionState =
  | 'idle'
  | 'idle_front'
  | 'thinking'
  | 'working'
  | 'happy'
  | 'talking'
  | 'sleep'
  | 'curious'
  | 'standing'
  | 'walking'
  | 'ojos'
  | 'ojos2'
  | 'capri2'
  | 'closed'
  | 'asustada'

export interface RoamingStatusPayload {
  isRoaming: boolean
  isPaused: boolean
  direction: 'left' | 'right'
  speed: number
  isCatchGameActive: boolean
  gameTimeRemaining?: number
  isTabMode?: boolean
  currentBehavior?: 'walking' | 'still' | 'tab'
  /** Hopping to another monitor: 'out' while she's glitched away, 'in' as she re-forms */
  hop?: 'out' | 'in'
  /** Goes up by one on every glitch, so the renderer replays the effect */
  hopId?: number
  /** She offered a game of tag: a click on her starts the chase */
  offeringTag?: boolean
}

/** Capri's own local agent is the only engine */
export type AgentMode = 'capri-local'

export interface AgentConfigPayload {
  mode: AgentMode
  endpoint: string
  model: string
  apiKey: string
}

export interface AgentEventPayload {
  type:
    | 'session.started'
    | 'assistant.delta'
    | 'tool.started'
    | 'tool.finished'
    | 'permission.requested'
    | 'session.finished'
    | 'session.error'
  text?: string
  /** The script player is already saying this text, part by part */
  spokenByScript?: boolean
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  requestId?: string
  permissionDescription?: string
  success?: boolean
  error?: string
  timestamp?: number
  source?: 'pet' | 'editor'
}

export interface ScannerBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ScannerStatusPayload {
  isOpen: boolean
  isScanning: boolean
  isContinuous: boolean
  bounds: ScannerBounds
}

export interface ScannerScanResult {
  success: boolean
  summary?: string
  tags?: string[]
  response?: string
  error?: string
}

export interface ScannerEventPayload {
  type: 'scanning' | 'result' | 'error' | 'status'
  isScanning?: boolean
  isContinuous?: boolean
  result?: ScannerScanResult
  tags?: string[]
  error?: string
}

/** A hand-written script playing part by part (see services/script) */
export type ScriptEventPayload =
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'look'; look: 'ojos' | 'ojos2' | 'closed' | 'thinking' | 'asustada' | null }
  | { kind: 'line'; id: number; text: string; audioDataUrl?: string; look?: 'ojos' | 'ojos2' | 'closed' | 'thinking' | 'asustada' }
