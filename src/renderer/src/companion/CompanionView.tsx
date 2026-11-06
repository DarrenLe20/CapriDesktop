import { personalize } from '../utils/userName'
import { AlwaysListener } from '../utils/alwaysListening'
import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { CapriRenderer, playMultiGlitchSound, playPetChirpSound } from './CapriRenderer'
import { SpeechBubble } from './SpeechBubble'
import { useT } from '../utils/useUiLang'
import { localizeLine } from '../../../shared/lines'
import { getLineLanguage, setLineLanguage } from '../utils/lineLanguage'
import { micErrorKind, micErrorLine, openMicrophone } from '../utils/microphone'
import { voiceVolume } from '../utils/soundSettings'
import { useCompanionStore, CompanionEmotionState } from '../stores/useCompanionStore'
import { useAgentStore } from '../stores/useAgentStore'
import dialogueBlipAudio from '../assets/dialogue_blip.wav'
import patPatGif from '../assets/capri/pat-pat-pet-pet.gif'
import { VoiceSettingsModal } from './VoiceSettingsModal'
import {
  X,
  Mic,
  Ear,
  MicOff,
  Volume2,
  VolumeX,
  Loader2,
  Sliders,
  Code2
} from 'lucide-react'

export interface DesktopChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  toolCalls?: {
    toolName: string
    status: 'running' | 'completed' | 'failed'
    output?: string
  }[]
}

const STORAGE_KEY = 'capri_desktop_chat_history'
/** Loudest level in a recording below which the microphone isn't really sending anything */
const MIN_MIC_LEVEL = 3

// The view can mount twice (React's StrictMode, a reload of the window); she only says hello once
let greeted = false
function greetedThisSession(): boolean {
  if (greeted) return true
  greeted = true
  try {
    if (sessionStorage.getItem('capri_greeted')) return true
    sessionStorage.setItem('capri_greeted', '1')
  } catch {}
  return false
}

export const CompanionView: React.FC = () => {
  const {
    emotion,
    speech,
    isRoaming,
    isTabMode,
    setEmotion,
    setSpeech,
    setTabMode,
    setRoamingStatus
  } = useCompanionStore()

  const { projectPath } = useAgentStore()

  // Interactive Desktop Chat Mode (only active when user does Ctrl + Click)
  const [isDesktopChatOpen, setIsDesktopChatOpen] = useState(false)
  const [isEyeMode, setIsEyeMode] = useState(false)
  // A hand-written script is playing (see services/script): nothing else talks or moves her
  const [isScriptPlaying, setIsScriptPlaying] = useState(false)
  const isScriptPlayingRef = useRef(false)
  const [scriptLook, setScriptLook] = useState<'ojos' | 'ojos2' | 'closed' | 'thinking' | 'asustada' | null>(null)
  const [inputText, setInputText] = useState('')
  const [isExecuting, setIsExecuting] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isSynthesizingVoice, setIsSynthesizingVoice] = useState(false)
  const isSynthesizingVoiceRef = useRef(false)
  useEffect(() => {
    isSynthesizingVoiceRef.current = isSynthesizingVoice
  }, [isSynthesizingVoice])

  // Track whether Dev Deck is open (Editor Mode vs Pet Mode)
  const [isDeckOpen, setIsDeckOpen] = useState(false)
  const isDeckOpenRef = useRef(false)
  useEffect(() => {
    isDeckOpenRef.current = isDeckOpen
  }, [isDeckOpen])

  useEffect(() => {
    if (!window.api?.deck) return

    window.api.deck.getStatus().then((open) => {
      const isOpen = !!open
      setIsDeckOpen(isOpen)
      isDeckOpenRef.current = isOpen
    })

    if (window.api.deck.onStatusChanged) {
      const unsub = window.api.deck.onStatusChanged((open) => {
        setIsDeckOpen(open)
        isDeckOpenRef.current = open
        if (open && activeAudioRef.current) {
          activeAudioRef.current.pause()
          activeAudioRef.current = null
          setIsSpeaking(false)
        }
      })
      return unsub
    }
    return
  }, [])

  // Fresh chat session on every launch: do not load past sessions from localStorage
  const [chatMessages, setChatMessages] = useState<DesktopChatMessage[]>([])
  const [activeUserPrompt, setActiveUserPrompt] = useState<string | null>(null)
  const [activeSpeechText, setRawActiveSpeechText] = useState<string | null>(null)
  const setActiveSpeechText = useCallback((text: string | null) => {
    setRawActiveSpeechText(text ? localizeLine(text, getLineLanguage()) : text)
  }, [])
  const [isWindowHovered, setIsWindowHovered] = useState(false)
  const [isGamingMode, setIsGamingMode] = useState<boolean>(false)

  // Her window is much wider than she is: only her body takes clicks, the rest goes to what's behind.
  // Mouse moves keep arriving while it lets clicks through. On Linux they don't, so it stays as it was.
  useEffect(() => {
    if (isGamingMode || navigator.userAgent.includes('Linux') || !window.api?.companion?.setHitThrough) return
    let ignoring = false
    const set = (next: boolean) => {
      if (next === ignoring) return
      ignoring = next
      window.api.companion.setHitThrough(next).catch(() => {})
    }
    const onMove = (e: MouseEvent) => {
      const art = document.querySelector('[data-capri-art]')
      const over = document.elementFromPoint(e.clientX, e.clientY)
      if (e.buttons || !art || document.querySelector('.fixed.inset-0') || over?.closest('input,textarea,button,select,a,[data-capri-ui]')) {
        set(false)
        return
      }
      const box = art.getBoundingClientRect()
      const half = (Math.min(box.width, box.height) * 0.72) / 2
      const inside = Math.abs(e.clientX - (box.left + box.width / 2)) <= half && e.clientY >= box.top && e.clientY <= box.bottom
      set(!inside)
    }
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      set(false)
    }
  }, [isGamingMode])

  // Gaming Mode: Capri is click-through so she never steals clicks from the game.
  // Hold Ctrl over her to interact / drag her (mouse moves are forwarded even while click-through).
  useEffect(() => {
    if (!isGamingMode || !window.api?.companion?.setClickThrough) return
    let ignoring = true
    window.api.companion.setClickThrough(true).catch(() => {})
    const update = (ctrl: boolean) => {
      const want = !ctrl
      if (want === ignoring) return
      ignoring = want
      window.api.companion.setClickThrough(want).catch(() => {})
    }
    const onMove = (e: MouseEvent) => update(e.ctrlKey)
    const onKey = (e: KeyboardEvent) => update(e.ctrlKey)
    const onLeave = () => update(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [isGamingMode])
  const [isVoiceSettingsOpen, setIsVoiceSettingsOpen] = useState<boolean>(false)
  const [isContextMenuOpen, setIsContextMenuOpen] = useState<boolean>(false)
  const tr = useT()

  // Language state synchronized with consciousnessService (default 'en')
  const [currentLang, setCurrentLang] = useState<string>('en')
  const currentLangRef = useRef<string>('en')

  useEffect(() => {
    if (window.api?.companion?.getConsciousness) {
      window.api.companion.getConsciousness().then((res: any) => {
        const effective = res?.preferredLanguage === 'es' ? 'es' : (res?.preferredLanguage || 'en')
        setCurrentLang(effective)
        currentLangRef.current = effective
        setLineLanguage(effective)
      }).catch(() => {})
    }
    if (window.api?.companion?.getGamingMode) {
      window.api.companion.getGamingMode().then((g: boolean) => {
        setIsGamingMode(!!g)
      }).catch(() => {})
    }
    let unsubGaming: (() => void) | undefined
    if (window.api?.companion?.onGamingModeChanged) {
      unsubGaming = window.api.companion.onGamingModeChanged((g: boolean) => {
        setIsGamingMode(!!g)
      })
    }
    if (window.api?.companion?.onLineLanguage) {
      // Her lines follow the language she's spoken to. Changing the settings also comes through here.
      const unsub = window.api.companion.onLineLanguage((lang: string) => {
        const effective = lang || 'en'
        setCurrentLang(effective)
        currentLangRef.current = effective
        setLineLanguage(effective)
      })
      return () => {
        unsub()
        if (unsubGaming) unsubGaming()
      }
    }
    return () => {
      if (unsubGaming) unsubGaming()
    }
  }, [])

  const isSpeakingRef = useRef(false)
  const isExecutingRef = useRef(false)
  const isDesktopChatOpenRef = useRef(false)
  const bubbleHideTimerRef = useRef<NodeJS.Timeout | null>(null)
  const currentSpokenTextRef = useRef<string>('')

  useEffect(() => {
    isSpeakingRef.current = isSpeaking
  }, [isSpeaking])
  useEffect(() => {
    isExecutingRef.current = isExecuting
  }, [isExecuting])
  useEffect(() => {
    isDesktopChatOpenRef.current = isDesktopChatOpen
  }, [isDesktopChatOpen])

  const promptInputRef = useRef<HTMLInputElement>(null)
  const pendingCloseDeleteRef = useRef(false)
  const isClosedActiveRef = useRef(false)
  const closedTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isScaredActiveRef = useRef(false)
  const scaredTimerRef = useRef<NodeJS.Timeout | null>(null)
  const [isPetting, setIsPetting] = useState(false)
  const isPettingRef = useRef(false)
  const pettingTimerRef = useRef<NodeJS.Timeout | null>(null)
  const scareTriggeredRef = useRef<boolean>(false)
  const dragStartRef = useRef<{ startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null>(null)

  // With a voice the bubble comes up when she starts talking: showing it before too reads as saying it twice
  const sayGreeting = (text: string, durationMs: number) => {
    if (greetedThisSession()) return
    if (isVoiceMutedRef.current || isDeckOpenRef.current) setSpeech(text, durationMs)
    else setTimeout(() => speakWithCapriVoice(text), 600)
  }

  // Welcome back greeting on application mount (aware of reboots and past shutdowns)
  useEffect(() => {
    // Fresh chat session: clear past stored messages and backend LLM history
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {}

    if (window.api?.agent?.clearHistory) {
      window.api.agent.clearHistory().catch(() => {})
    }

    if (window.api?.companion?.getConsciousness) {
      window.api.companion.getConsciousness().then((res) => {
        const isEs = currentLangRef.current === 'es'
        const welcome = res?.bootGreeting || (isEs
          ? "¡Bienvenido de vuelta, {name}! Conectada a tu ciberware y lista para la acción. ¿Qué hackeamos hoy, choomba?"
          : "Welcome back, {name}! Jacked into your cyberware and ready for action. What are we hacking today, choomba?")
        setChatMessages([
          {
            id: `init-${Date.now()}`,
            role: 'assistant',
            content: welcome,
            timestamp: Date.now()
          }
        ])
        sayGreeting(welcome, 6000)
      }).catch(() => {
        const isEs = currentLangRef.current === 'es'
        const fallback = isEs
          ? "¡Bienvenido de vuelta, {name}! Conectada a tu ciberware y lista para la acción. ¿Qué hackeamos hoy, choomba?"
          : "Welcome back, {name}! Jacked into your cyberware and ready for action. What are we hacking today, choomba?"
        setChatMessages([
          {
            id: `init-${Date.now()}`,
            role: 'assistant',
            content: fallback,
            timestamp: Date.now()
          }
        ])
        sayGreeting(fallback, 5000)
      })
    } else {
      const isEs = currentLangRef.current === 'es'
      const welcome = isEs
        ? "¡Bienvenido de vuelta, {name}! Conectada a tu ciberware y lista para la acción. ¿Qué hackeamos hoy, choomba?"
        : "Welcome back, {name}! Jacked into your cyberware and ready for action. What are we hacking today, choomba?"
      setChatMessages([
        {
          id: `init-${Date.now()}`,
          role: 'assistant',
          content: welcome,
          timestamp: Date.now()
        }
      ])
      sayGreeting(welcome, 5000)
    }
  }, [])

  // Voice State (STT & TTS with Capri original voice)
  const [isVoiceMuted, setIsVoiceMuted] = useState(() => {
    try {
      return localStorage.getItem('capri_voice_muted') === 'true'
    } catch {
      return false
    }
  })
  const isVoiceMutedRef = useRef(isVoiceMuted)
  useEffect(() => {
    isVoiceMutedRef.current = isVoiceMuted
  }, [isVoiceMuted])

  // Voice Type Selection: 'blip' (dialogue_blip.wav) vs 'tts' (real voice; Edge-TTS until another
  // engine is chosen). A fresh install talks with the real voice; blip only if the user picks it.
  const [voiceType, setVoiceType] = useState<'blip' | 'tts'>(() => {
    try {
      return (localStorage.getItem('capri_voice_type') as 'blip' | 'tts') || 'tts'
    } catch {
      return 'tts'
    }
  })
  const voiceTypeRef = useRef(voiceType)
  useEffect(() => {
    voiceTypeRef.current = voiceType
  }, [voiceType])

  const [isRecordingVoice, setIsRecordingVoice] = useState(false)
  const [isProcessingVoice, setIsProcessingVoice] = useState(false)
  const [liveRecognizedText, setLiveRecognizedText] = useState<string | null>(null)
  const [audioLevel, setAudioLevel] = useState<number>(0)
  const isRecordingVoiceRef = useRef(false)
  const isTranscribingChunkRef = useRef(false)
  const audioContextRef = useRef<AudioContext | null>(null)
  const volumeRafRef = useRef<number | null>(null)
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const lastAudioActivityRef = useRef<number>(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const activeAudioRef = useRef<HTMLAudioElement | null>(null)
  const currentAudioIdRef = useRef<number>(0)
  const lastSpokenTextRef = useRef<string>('')
  const lastSpokenTimeRef = useRef<number>(0)
  const lastAssistantContentRef = useRef<string>('')

  const [isAlwaysListening, setIsAlwaysListening] = useState(false)
  const alwaysListenerRef = useRef<AlwaysListener | null>(null)
  const followUpUntilRef = useRef(0)
  const awaitingFollowUpRef = useRef(false)
  const isProcessingVoiceRef = useRef(false)
  const toggleAlwaysListeningRef = useRef<() => void>(() => {})
  const toggleDesktopChatRef = useRef<() => void>(() => {})
  const handleAlwaysUtteranceRef = useRef<(wav: ArrayBuffer) => void>(() => {})
  const handleSendMessageRef = useRef<(text: string) => void>(() => {})

  const startVoiceRecordingRef = useRef<() => void>(() => {})
  const stopVoiceRecordingRef = useRef<() => void>(() => {})
  const cancelVoiceRecordingRef = useRef<() => void>(() => {})
  const voiceCancelledRef = useRef(false)
  const lastToggleTimeRef = useRef<number>(0)

  const toggleVoiceRecordingSafe = () => {
    const now = Date.now()
    if (now - lastToggleTimeRef.current < 350) return
    lastToggleTimeRef.current = now

    if (isRecordingVoiceRef.current) {
      stopVoiceRecordingRef.current()
    } else {
      startVoiceRecordingRef.current()
    }
  }

  useEffect(() => {
    isRecordingVoiceRef.current = isRecordingVoice
    // Main registers a global Esc only while recording, so it can cancel from any app
    window.api?.voice?.setRecordingState?.(isRecordingVoice)
  }, [isRecordingVoice])

  // Esc (global while recording, or in-app) discards the recording
  useEffect(() => {
    const unsub = window.api?.voice?.onCancelRecording?.(() => cancelVoiceRecordingRef.current())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isRecordingVoiceRef.current) {
        e.preventDefault()
        cancelVoiceRecordingRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      unsub?.()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Global Shortcut Listener (Down / Ctrl + Alt + V) to toggle voice recording
  useEffect(() => {
    if (window.api?.voice?.onToggleRecording) {
      const unsub = window.api.voice.onToggleRecording(() => {
        // With the Dev Deck open its own mic takes the hotkey (so the message shows in its chat);
        // a recording already running here can still be stopped
        if (isDeckOpenRef.current && !isRecordingVoiceRef.current) return
        const activeEl = document.activeElement as HTMLElement | null
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
          return
        }
        toggleVoiceRecordingSafe()
      })
      return () => unsub()
    }
    return undefined
  }, [])

  // In-app window keydown listener for ArrowDown (Flecha abajo)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      e.preventDefault()
      if (e.key === 'ArrowDown') toggleVoiceRecordingSafe()
      else if (e.key === 'ArrowLeft') toggleDesktopChatRef.current()
      else toggleAlwaysListeningRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const toggleVoiceMute = () => {
    setIsVoiceMuted((prev) => {
      const next = !prev
      try {
        localStorage.setItem('capri_voice_muted', String(next))
      } catch {}
      if (next && activeAudioRef.current) {
        activeAudioRef.current.pause()
        activeAudioRef.current = null
        setIsSpeaking(false)
      }
      const isEs = currentLangRef.current === 'es'
      setSpeech(next ? (isEs ? 'Audio silenciado.' : 'Audio muted.') : (isEs ? '¡Audio activado!' : 'Voice active!'), 2000)
      return next
    })
  }

  // Speech queue: lines play one after another instead of cutting each other off or being
  // dropped; anything the user says or sends interrupts and clears it (interruptSpeech).
  const speechQueueRef = useRef<string[]>([])
  const speechPumpingRef = useRef(false)

  const speakWithCapriVoice = (rawText: string) => {
    const text = localizeLine(rawText, getLineLanguage())
    if (!text || !text.trim() || isScriptPlayingRef.current) return
    const q = speechQueueRef.current
    if (q[q.length - 1] === text) return
    if (q.length >= 4) q.shift() // keep it short: stale chatter goes first
    q.push(text)
    void pumpSpeechQueue()
  }

  const pumpSpeechQueue = async () => {
    if (speechPumpingRef.current) return
    speechPumpingRef.current = true
    try {
      while (speechQueueRef.current.length) {
        const next = speechQueueRef.current.shift() as string
        await playSpeechNow(next)
        // playSpeechNow returns once playback starts; wait until she finished talking
        const until = Date.now() + 90000
        while ((isSpeakingRef.current || isSynthesizingVoiceRef.current) && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 150))
        }
      }
    } finally {
      speechPumpingRef.current = false
    }
  }

  /** The user is talking or sent something: stop Capri mid-sentence and forget queued lines */
  const interruptSpeech = () => {
    speechQueueRef.current = []
    currentAudioIdRef.current++ // discards a line still being synthesized
    if (activeAudioRef.current) {
      try {
        activeAudioRef.current.pause()
        activeAudioRef.current.currentTime = 0
      } catch {}
      activeAudioRef.current = null
    }
    setIsSpeaking(false)
    isSpeakingRef.current = false
    setIsSynthesizingVoice(false)
    isSynthesizingVoiceRef.current = false
  }

  // One line of a script: its audio already comes prepared, and the script waits for it to end
  const playScriptLine = (line: { id: number; text: string; audioDataUrl?: string }) => {
    if (bubbleHideTimerRef.current) {
      clearTimeout(bubbleHideTimerRef.current)
      bubbleHideTimerRef.current = null
    }
    const text = personalize(line.text)
    currentSpokenTextRef.current = text
    setActiveUserPrompt(null)
    setActiveSpeechText(text)
    setSpeech(text, 0)
    setIsSynthesizingVoice(false)
    isSynthesizingVoiceRef.current = false
    setIsSpeaking(true)
    isSpeakingRef.current = true

    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      setIsSpeaking(false)
      isSpeakingRef.current = false
      window.api.companion.scriptLineDone(line.id)
    }

    // Muted, or the voice failed: the text stays up for as long as it takes to read it
    if (!line.audioDataUrl || isVoiceMutedRef.current) {
      setTimeout(finish, Math.max(1500, text.length * 60))
      return
    }
    const audio = new Audio(line.audioDataUrl)
    audio.volume = voiceVolume()
    audio.playbackRate = 1.05
    activeAudioRef.current = audio
    audio.onended = finish
    audio.onerror = finish
    audio.play().catch(finish)
  }

  // Synthesize and play one line with Capri's voice (supports dialogue_blip.wav or Original TTS)
  const playSpeechNow = async (text: string) => {
    // In Editor Mode, DO not speak. Only speak in Pet Mode
    if (isDeckOpenRef.current || isVoiceMutedRef.current) return

    // Strip all emojis and unicode pictographs before synthesizing so TTS never pronounces emoji names
    const clean = personalize(text)
      .replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu, '')
      .replace(/[🐾✨👀⚡🎉🦾🛑💬🎵🔥💥💡⚔️📹🎮💤✓✕⚠️🤖🐱🐶👍👎❤️]/g, '')
      .replace(/[*#_~>|`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!clean) return

    const bubbleText = clean.replace(/\[[a-zA-Z0-9_\s\-]+\]/g, '').replace(/\s+/g, ' ').trim() || clean
    const emotions = clean.match(/\[[a-zA-Z0-9_\s\-]+\]/g) || []
    console.log('[Capri Dialogue] Text to synthesize:', clean)
    console.log('[Capri Dialogue] Emotions/Tags detected:', emotions)
    console.log('[Capri Dialogue] Visual bubble text:', bubbleText)

    // Debounce duplicate calls with the exact same text within 4 seconds
    const now = Date.now()
    if (clean === lastSpokenTextRef.current && now - lastSpokenTimeRef.current < 4000) {
      return
    }
    lastSpokenTextRef.current = clean
    lastSpokenTimeRef.current = now

    // Instantly kill any currently playing audio so voices never overlap or duplicate
    if (activeAudioRef.current) {
      try {
        activeAudioRef.current.pause()
        activeAudioRef.current.currentTime = 0
      } catch {}
      activeAudioRef.current = null
      setIsSpeaking(false)
      isSpeakingRef.current = false
    }

    if (bubbleHideTimerRef.current) {
      clearTimeout(bubbleHideTimerRef.current)
      bubbleHideTimerRef.current = null
    }

    // Mark speaking active immediately to prevent interruptions during synthesis
    isSpeakingRef.current = true
    const currentId = ++currentAudioIdRef.current

    try {
      // New Dialogue Blip Voice Mode (@dialogue_blip.wav)
      if (voiceTypeRef.current === 'blip') {
        const audio = new Audio(dialogueBlipAudio)
        audio.volume = 0.65 * voiceVolume()
        activeAudioRef.current = audio

        currentSpokenTextRef.current = clean
        setActiveSpeechText(bubbleText)
        setSpeech(bubbleText, 0)
        setIsSpeaking(true)

        // Determine talking animation duration based on text reading length:
        const durationLimitMs = Math.min(5000, Math.max(2200, clean.length * 55))

        const stopBlip = () => {
          setIsSpeaking(false)
          isSpeakingRef.current = false
          if (activeAudioRef.current === audio) {
            activeAudioRef.current = null
          }
          if (bubbleHideTimerRef.current) clearTimeout(bubbleHideTimerRef.current)
          bubbleHideTimerRef.current = setTimeout(() => {
            if (!isSpeakingRef.current && !isExecutingRef.current && !isDesktopChatOpenRef.current) {
              setSpeech(null)
              setActiveSpeechText(null)
              setActiveUserPrompt(null)
              if (!isEyeMode && !isExecutingRef.current && !isDesktopChatOpenRef.current && !isGamingMode) {
                const curEmotion = useCompanionStore.getState().emotion
                setEmotion(isTabMode ? (curEmotion === 'idle_front' ? 'idle_front' : 'idle') : 'standing')
              }
            }
          }, isGamingMode ? 2000 : 4000)
        }

        setTimeout(stopBlip, durationLimitMs)
        audio.play().catch(() => {})
        return
      }

      // Synthesized Neural Voice Mode (Edge-TTS / Fish Audio / ElevenLabs)
      if (!window.api?.voice) {
        setIsSynthesizingVoice(false)
        isSynthesizingVoiceRef.current = false
        isSpeakingRef.current = false
        return
      }

      // Freeze roaming while synthesizing without showing premature text or mouth movement
      setIsSynthesizingVoice(true)
      isSynthesizingVoiceRef.current = true

      const res = await window.api.voice.synthesize(clean)
      // Discard stale in-flight responses if a newer request came in
      if (currentId !== currentAudioIdRef.current) {
        setIsSynthesizingVoice(false)
        isSynthesizingVoiceRef.current = false
        return
      }

      if (res.success && res.audioDataUrl) {
        const audio = new Audio(res.audioDataUrl)
        audio.volume = voiceVolume()
        audio.playbackRate = 1.05
        activeAudioRef.current = audio

        let started = false
        const startPlayback = () => {
          if (started) return
          started = true
          setIsSynthesizingVoice(false)
          isSynthesizingVoiceRef.current = false
          setIsSpeaking(true)
          isSpeakingRef.current = true
          currentSpokenTextRef.current = clean
          setActiveSpeechText(bubbleText)
          setSpeech(bubbleText, 0)
        }

        const stopTts = () => {
          setIsSynthesizingVoice(false)
          isSynthesizingVoiceRef.current = false
          setIsSpeaking(false)
          isSpeakingRef.current = false
          if (activeAudioRef.current === audio) {
            activeAudioRef.current = null
          }
          if (bubbleHideTimerRef.current) clearTimeout(bubbleHideTimerRef.current)
          bubbleHideTimerRef.current = setTimeout(() => {
            if (!isSpeakingRef.current && !isExecutingRef.current && !isDesktopChatOpenRef.current) {
              setSpeech(null)
              setActiveSpeechText(null)
              setActiveUserPrompt(null)
              if (!isEyeMode && !isExecutingRef.current && !isDesktopChatOpenRef.current && !isGamingMode) {
                const curEmotion = useCompanionStore.getState().emotion
                setEmotion(isTabMode ? (curEmotion === 'idle_front' ? 'idle_front' : 'idle') : 'standing')
              }
            }
          }, isGamingMode ? 2000 : 4000)
        }

        audio.onplay = startPlayback
        audio.onended = stopTts
        audio.onerror = stopTts

        await audio.play().then(startPlayback).catch(() => {
          stopTts()
        })
      } else {
        // Fallback: If TTS synthesis fails, display text and show talking mouth for reading duration
        setIsSynthesizingVoice(false)
        isSynthesizingVoiceRef.current = false
        currentSpokenTextRef.current = clean
        setActiveSpeechText(bubbleText)
        setSpeech(bubbleText, 0)
        setIsSpeaking(true)
        isSpeakingRef.current = true
        const durationLimitMs = Math.min(5000, Math.max(2200, clean.length * 55))
        setTimeout(() => {
          setIsSpeaking(false)
          isSpeakingRef.current = false
          setSpeech(null)
          setActiveSpeechText(null)
          setActiveUserPrompt(null)
        }, durationLimitMs)
      }
    } catch (err) {
      setIsSynthesizingVoice(false)
      isSynthesizingVoiceRef.current = false
      setIsSpeaking(false)
      isSpeakingRef.current = false
      console.warn('[CompanionView] Voice synthesis playback failed:', err)
    }
  }

  // Voice recording & Real-time Speech-to-Text streaming with local Whisper on GPU

  const micOpeningRef = useRef(false)
  const micPeakRef = useRef(-1)

  const startVoiceRecording = async () => {
    if (isRecordingVoice || isProcessingVoice || micOpeningRef.current) return
    if (isExecuting) {
      setSpeech("Hold on, I'm still thinking, choomba.", 2500)
      return
    }
    // The user started talking: Capri stops so the mic doesn't pick her up
    if (isScriptPlayingRef.current) window.api.companion.cancelScript()
    interruptSpeech()

    try {
      micOpeningRef.current = true
      let stream: MediaStream
      try {
        stream = await openMicrophone()
      } finally {
        micOpeningRef.current = false
      }
      micPeakRef.current = -1
      audioChunksRef.current = []
      setLiveRecognizedText(null)
      setAudioLevel(0)
      lastAudioActivityRef.current = Date.now()

      // Audio Visualizer & Level Meter via Web Audio API
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
        const ctx = new AudioCtx()
        audioContextRef.current = ctx
        void ctx.resume().catch(() => {})
        micPeakRef.current = 0
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 128
        source.connect(analyser)

        const pcmData = new Uint8Array(analyser.frequencyBinCount)
        const updateAudioMeter = () => {
          if (!isRecordingVoiceRef.current) return
          analyser.getByteFrequencyData(pcmData)
          let sum = 0
          for (let i = 0; i < pcmData.length; i++) {
            sum += pcmData[i]
          }
          const avg = sum / pcmData.length
          const level = Math.min(100, Math.round((avg / 120) * 100))
          setAudioLevel(level)
          micPeakRef.current = Math.max(micPeakRef.current, level)

          if (level > 15) {
            lastAudioActivityRef.current = Date.now()
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current)
              silenceTimerRef.current = null
            }
          }

          volumeRafRef.current = requestAnimationFrame(updateAudioMeter)
        }
        volumeRafRef.current = requestAnimationFrame(updateAudioMeter)
      } catch (e) {
        console.warn('[VoiceRecord] AudioContext visualizer init note:', e)
      }

      // MediaRecorder with 700ms chunk slices for real-time word streaming
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = async (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data)

          // Incremental transcription so words stream in real-time as the user speaks
          if (audioChunksRef.current.length >= 2 && !isTranscribingChunkRef.current) {
            isTranscribingChunkRef.current = true
            const currentBlob = new Blob(audioChunksRef.current, { type: mimeType })
            try {
              const arrayBuffer = await currentBlob.arrayBuffer()
              const partial = await window.api.voice.transcribe(arrayBuffer, true)
              if (partial.success && partial.text && partial.text.trim()) {
                setLiveRecognizedText(partial.text.trim())
              }
            } catch {
              // ignore partial error
            } finally {
              isTranscribingChunkRef.current = false
            }
          }
        }
      }

      recorder.onstop = async () => {
        // Clean up audio tracks & visualizer
        stream.getTracks().forEach((t) => t.stop())
        if (volumeRafRef.current) {
          cancelAnimationFrame(volumeRafRef.current)
          volumeRafRef.current = null
        }
        if (audioContextRef.current) {
          try {
            audioContextRef.current.close()
          } catch {}
          audioContextRef.current = null
        }
        setAudioLevel(0)

        // Cancelled (Esc / [CANCELAR]): drop the audio, nothing gets sent
        if (voiceCancelledRef.current) {
          voiceCancelledRef.current = false
          audioChunksRef.current = []
          setIsRecordingVoice(false)
          isRecordingVoiceRef.current = false
          setIsProcessingVoice(false)
          setLiveRecognizedText(null)
          return
        }

        const blob = new Blob(audioChunksRef.current, { type: mimeType })
        if (blob.size < 500) {
          setIsRecordingVoice(false)
          isRecordingVoiceRef.current = false
          setIsProcessingVoice(false)
          setLiveRecognizedText(null)
          return
        }

        setIsProcessingVoice(true)
        try {
          const arrayBuffer = await blob.arrayBuffer()
          // The first time Whisper is still downloading, and silence would look like a broken mic
          if ((await window.api.voice.sttState()) === 'loading') {
            setSpeech("I'm still loading my hearing, choomba. The first time can take a few minutes, hold on.", 0)
          }
          const res = await window.api.voice.transcribe(arrayBuffer)
          setSpeech(null)
          const isEs = currentLangRef.current === 'es'
          const finalText = res.success && res.text ? res.text.trim() : liveRecognizedText
          if (finalText) {
            setInputText('')
            setActiveUserPrompt(finalText)
            handleSendMessage(finalText)
          } else if ((await window.api.voice.sttState()) === 'failed') {
            setSpeech("My hearing isn't installed properly, choomba. Run the setup again from the model settings.", 6000)
          } else if (micPeakRef.current >= 0 && micPeakRef.current < MIN_MIC_LEVEL) {
            setSpeech("Your microphone isn't sending any sound, choomba. Check the one selected in my voice settings.", 6000)
          } else if (res.error && !/no speech/i.test(res.error)) {
            console.warn('[VoiceRecord] Transcription failed:', res.error)
            setSpeech(`Something failed in my hearing, choomba: ${res.error.slice(0, 140)}`, 8000)
          } else {
            setSpeech(
              isEs
                ? "No te llegué a escuchar con todo este ruido de la red, choomba. ¿Me repetís?"
                : "Didn't catch that over the cyber ICE, choomba. Mind repeating that?",
              3500
            )
          }
        } catch (err: any) {
          console.error('[VoiceRecord] Final transcription failed:', err)
          const isEs = currentLangRef.current === 'es'
          setSpeech(isEs ? "¡Glitcheo en el micrófono! Probá de nuevo, choomba." : "Microphone glitch! Try again, choomba.", 3000)
        } finally {
          setIsRecordingVoice(false)
          isRecordingVoiceRef.current = false
          setIsProcessingVoice(false)
          setLiveRecognizedText(null)
        }
      }

      // Unplugged or taken by another app in the middle: finish instead of staying stuck recording
      recorder.onerror = (e) => {
        console.warn('[VoiceRecord] Recorder error:', e)
        if (recorder.state !== 'inactive') recorder.stop()
      }
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (recorder.state !== 'inactive') recorder.stop()
        }
      })

      recorder.start(700)
      setIsRecordingVoice(true)
      isRecordingVoiceRef.current = true
    } catch (err: any) {
      console.error('[VoiceRecord] getUserMedia error:', err)
      setSpeech(micErrorLine(micErrorKind(err)), 6000)
    }
  }

  const stopVoiceRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
  }

  /** Stops the recording and throws the audio away instead of sending it */
  const cancelVoiceRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      voiceCancelledRef.current = true
      mediaRecorderRef.current.stop()
    }
  }
  startVoiceRecordingRef.current = startVoiceRecording
  stopVoiceRecordingRef.current = stopVoiceRecording
  cancelVoiceRecordingRef.current = cancelVoiceRecording

  // always listening (Right arrow): mic stays open, Capri only answers when she
  // hears her name (or a saved macro phrase). After she answers you get a few
  // seconds to keep talking without repeating "Capri".
  const toggleAlwaysListening = async () => {
    const isEs = currentLangRef.current === 'es'
    if (alwaysListenerRef.current?.active) {
      alwaysListenerRef.current.stop()
      alwaysListenerRef.current = null
      setIsAlwaysListening(false)
      followUpUntilRef.current = 0
      try { localStorage.setItem('capri.alwaysListening', '0') } catch {}
      setSpeech(isEs ? 'Listo, dejo de escucharte. Flecha derecha para volver a activarme.' : 'Okay, I stopped listening. Right arrow to turn me back on.', 3000)
      return
    }

    const listener = new AlwaysListener({
      isPaused: () =>
        // The Dev Deck has its own mic: hearing "Capri" from it here sent a second prompt
        // that cut the deck's recording and hid the user's message
        isDeckOpenRef.current ||
        isSpeakingRef.current ||
        isSynthesizingVoiceRef.current ||
        isRecordingVoiceRef.current ||
        isProcessingVoiceRef.current ||
        isExecutingRef.current,
      onUtterance: (wav) => {
        handleAlwaysUtteranceRef.current(wav)
      }
    })
    try {
      await listener.start()
      alwaysListenerRef.current = listener
      setIsAlwaysListening(true)
      try { localStorage.setItem('capri.alwaysListening', '1') } catch {}
      setSpeech(
        isEs ? 'Te escucho todo el tiempo, choomba. Decí "Capri" cuando me hables a mí.' : 'Always listening, choomba. Say "Capri" when you are talking to me.',
        3500
      )
    } catch (err) {
      console.error('[AlwaysListening] Could not open the microphone:', err)
      setSpeech(micErrorLine(micErrorKind(err)), 6000)
    }
  }
  toggleAlwaysListeningRef.current = toggleAlwaysListening

  handleAlwaysUtteranceRef.current = async (wav: ArrayBuffer) => {
    if (!window.api?.voice) return
    try {
      const res = await window.api.voice.transcribe(wav)
      const heard = res.success && res.text ? res.text.trim() : ''
      if (!heard) return

      const inFollowUp = Date.now() < followUpUntilRef.current
      const check = await window.api.voice.wakeCheck(heard)
      let prompt: string | null = null
      if (check.addressed) prompt = check.text
      else if (inFollowUp && heard.split(/\s+/).length >= 2) prompt = heard

      console.log(`[AlwaysListening] heard "${heard}" -> ${prompt ? `respond (${check.addressed ? check.reason : 'follow-up'})` : 'ignored'}`)
      if (!prompt || isExecutingRef.current) return

      followUpUntilRef.current = 0
      awaitingFollowUpRef.current = true
      setActiveUserPrompt(prompt)
      handleSendMessageRef.current(prompt)
    } catch (err) {
      console.warn('[AlwaysListening] utterance failed:', err)
    }
  }

  // Open the follow-up window once Capri has finished answering
  useEffect(() => {
    if (!isSpeaking && !isExecuting && awaitingFollowUpRef.current && alwaysListenerRef.current?.active) {
      awaitingFollowUpRef.current = false
      followUpUntilRef.current = Date.now() + 8000
    }
  }, [isSpeaking, isExecuting])

  useEffect(() => {
    isProcessingVoiceRef.current = isProcessingVoice
  }, [isProcessingVoice])

  // Global hotkeys: Right arrow = always listening on/off, Left arrow = chat (like Ctrl + Click)
  useEffect(() => {
    const unsubs: Array<() => void> = []
    if (window.api?.voice?.onToggleAlwaysListening) {
      unsubs.push(window.api.voice.onToggleAlwaysListening(() => toggleAlwaysListeningRef.current()))
    }
    if (window.api?.companion?.onToggleChat) {
      unsubs.push(window.api.companion.onToggleChat(() => toggleDesktopChatRef.current()))
    }
    // Restore the mode from the last session
    try {
      if (localStorage.getItem('capri.alwaysListening') === '1') {
        setTimeout(() => {
          if (!alwaysListenerRef.current) toggleAlwaysListeningRef.current()
        }, 2500)
      }
    } catch {}
    return () => {
      unsubs.forEach((u) => u())
      alwaysListenerRef.current?.stop()
    }
  }, [])

  // Clear active user prompt whenever speech expires and Capri is silent
  useEffect(() => {
    if (!speech && !isExecuting && !isSpeaking) {
      setActiveUserPrompt(null)
    }
  }, [speech, isExecuting, isSpeaking])

  // Listen to IPC broadcasts for emotion, speech, roaming status, and agent streaming events
  useEffect(() => {
    if (!window.api) return

    const unsubState = window.api.companion.onStateChanged((newState) => {
      if (isClosedActiveRef.current || isScaredActiveRef.current || isScriptPlayingRef.current) {
        return
      }
      setEmotion(newState as CompanionEmotionState)
    })

    const unsubScript = window.api.companion.onScriptEvent((event) => {
      if (event.kind === 'start') {
        speechQueueRef.current = [] // Anything still waiting to be said would talk over her
        isScriptPlayingRef.current = true
        setIsScriptPlaying(true)
        setScriptLook('thinking')
        if (activeAudioRef.current) {
          activeAudioRef.current.pause()
          activeAudioRef.current = null
        }
      } else if (event.kind === 'look') {
        setScriptLook(event.look)
      } else if (event.kind === 'line') {
        setScriptLook(event.look ?? null)
        playScriptLine(event)
      } else {
        isScriptPlayingRef.current = false
        setIsScriptPlaying(false)
        setScriptLook(null)
        setIsSpeaking(false)
        isSpeakingRef.current = false
        setSpeech(null)
        setActiveSpeechText(null)
        setEmotion(isTabMode ? 'idle' : 'standing')
      }
    })

    const unsubSpeech = window.api.companion.onSpeechChanged(({ text, durationMs, speakVoice }: any) => {
      if (isScriptPlayingRef.current) return
      // While she's working on the user's request, background chatter would be stale
      if (isExecutingRef.current) {
        console.log('[CompanionView] Ignoring background comment while executing:', text)
        return
      }

      if (speakVoice && !isDeckOpenRef.current && !isVoiceMutedRef.current) {
        // Queued: said after the current line instead of cutting it or being dropped
        speakWithCapriVoice(text)
      } else {
        // Text-only line: never cover what she's saying right now
        if (isSpeakingRef.current) return
        setActiveUserPrompt(null)
        currentSpokenTextRef.current = text
        setActiveSpeechText(text)
        setSpeech(text, durationMs || 5000)

        if (bubbleHideTimerRef.current) {
          clearTimeout(bubbleHideTimerRef.current)
          bubbleHideTimerRef.current = null
        }

        bubbleHideTimerRef.current = setTimeout(() => {
          if (!isSpeakingRef.current && !isExecutingRef.current && !isDesktopChatOpenRef.current) {
            setSpeech(null)
            setActiveSpeechText(null)
            setActiveUserPrompt(null)
          }
        }, durationMs || 5000)
      }
    })

    const unsubRoaming = window.api.roaming.onStateChanged((status) => {
      setRoamingStatus(status)
      if (typeof status.isTabMode === 'boolean') {
        setTabMode(status.isTabMode)
      }
    })

    // Listen to agent events (chat streaming and tool execution)
    const unsubAgent = window.api.agent.onEvent((event) => {
      switch (event.type) {
        case 'session.started':
          // In Editor Mode, Capri remains quiet and does not hijack the pet HUD
          if (event.source === 'editor' || isDeckOpenRef.current) break
          setIsExecuting(true)
          lastAssistantContentRef.current = ''
          if (!isEyeMode) {
            setEmotion('curious')
          }
          break

        case 'assistant.delta':
          if (event.source === 'editor' || isDeckOpenRef.current) break
          if (event.text) {
            const delta = event.text
            // A reply that changes her look is already being said part by part: saying it again at
            // the end of the session would repeat it
            if (!event.spokenByScript) lastAssistantContentRef.current = (lastAssistantContentRef.current || '') + delta
            setChatMessages((prev) => {
              if (prev.length === 0) return prev
              const last = prev[prev.length - 1]
              if (last && last.role === 'assistant') {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + delta }
                ]
              }
              return [
                ...prev,
                {
                  id: `asst-${Date.now()}`,
                  role: 'assistant',
                  content: delta,
                  timestamp: Date.now()
                }
              ]
            })
          }
          break

        case 'tool.started':
          if (event.source === 'editor' || isDeckOpenRef.current) break
          setEmotion('curious')
          if (event.toolName) {
            const toolName = event.toolName
            setChatMessages((prev) => {
              if (prev.length === 0) return prev
              const last = prev[prev.length - 1]
              if (last && last.role === 'assistant') {
                const tools = last.toolCalls || []
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    toolCalls: [
                      ...tools,
                      { toolName, status: 'running' }
                    ]
                  }
                ]
              }
              return prev
            })
          }
          break

        case 'tool.finished':
          if (event.source === 'editor' || isDeckOpenRef.current) break
          if (event.toolName) {
            const toolName = event.toolName
            const output = event.toolOutput

            // If close or delete action finished, show closed avatar (red cyber eye) for 3.5 seconds
            if (toolName === 'close_application' || toolName === 'delete_path') {
              isClosedActiveRef.current = true
              setEmotion('closed')
              if (window.api?.companion) window.api.companion.setState('closed')
              setSpeech("Target terminated, choomba! Cyberspace dusted!", 3500)
              if (closedTimerRef.current) clearTimeout(closedTimerRef.current)
              closedTimerRef.current = setTimeout(() => {
                isClosedActiveRef.current = false
                const returnSt = isDesktopChatOpen ? 'ojos' : 'standing'
                setEmotion(returnSt)
                if (window.api?.companion) window.api.companion.setState(returnSt)
              }, 3500)
            }

            // If shutdown Capri & Ollama triggered, change emotion to sleep
            if (toolName === 'shutdown_capri_and_ollama') {
              setEmotion('sleep')
              if (window.api?.companion) window.api.companion.setState('sleep')
              setSpeech("Jacking out of cyberspace... Catch you on the other side, {name}!", 4000)
            }

            setChatMessages((prev) => {
              if (prev.length === 0) return prev
              const last = prev[prev.length - 1]
              if (last && last.role === 'assistant' && last.toolCalls) {
                const updatedTools = last.toolCalls.map((t) =>
                  t.toolName === toolName
                    ? { ...t, status: (event.success ? 'completed' : 'failed') as 'completed' | 'failed', output }
                    : t
                )
                return [
                  ...prev.slice(0, -1),
                  { ...last, toolCalls: updatedTools }
                ]
              }
              return prev
            })
          }
          break

        case 'session.finished':
          setIsExecuting(false)
          isExecutingRef.current = false
          // In Editor Mode, Capri never speaks. Only in Pet Mode
          if (event.source !== 'editor' && !isDeckOpenRef.current) {
            const rawText = lastAssistantContentRef.current.trim()
            const textToSpeak = rawText
              .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu, '')
              .replace(/[🐾✨👀⚡🎉🦾🛑💬🎵🔥💥💡⚔️📹🎮💤✓✕⚠️🤖🐱🐶👍👎❤️🎶]/g, '')
              .trim()
            if (textToSpeak) {
              if (isScriptPlayingRef.current) {
                // She's in the middle of a reply: two voices at once would be worse than one line less
              } else if (isVoiceMutedRef.current) {
                const bubbleText = textToSpeak.replace(/\[[a-zA-Z0-9_\s\-]+\]/g, '').replace(/\s+/g, ' ').trim() || textToSpeak
                setActiveSpeechText(bubbleText)
                setSpeech(bubbleText, 6000)
              } else {
                setIsSynthesizingVoice(true)
                isSynthesizingVoiceRef.current = true
                speakWithCapriVoice(textToSpeak)
              }
            } else {
              setActiveUserPrompt(null)
            }
          } else {
            setActiveUserPrompt(null)
          }
          if (isClosedActiveRef.current || pendingCloseDeleteRef.current) {
            pendingCloseDeleteRef.current = false
            // Keep 'closed' red eye active, let closedTimer handle transition
            break
          }
          if (emotion === 'closed') {
            break
          }
          if (isDesktopChatOpen) {
            // Only switch to ojos if not actively waiting for or speaking audio
            if (!isSynthesizingVoiceRef.current && !isSpeakingRef.current) {
              setEmotion('ojos')
              if (window.api?.companion) window.api.companion.setState('ojos')
            }
          } else if (isTabMode) {
            setEmotion('idle')
            if (window.api?.companion) window.api.companion.setState('idle')
          }
          break

        case 'session.error':
          setIsExecuting(false)
          setEmotion('sleep')
          if (event.error) {
            setChatMessages((prev) => [
              ...prev,
              {
                id: `err-${Date.now()}`,
                role: 'assistant',
                content: `Glitch in the Net: ${event.error}`,
                timestamp: Date.now()
              }
            ])
          }
          break
      }
    })

    // Initial status fetch
    window.api.roaming.getStatus().then((status) => {
      if (status) {
        setRoamingStatus(status)
        if (typeof status.isTabMode === 'boolean') {
          setTabMode(status.isTabMode)
        }
      }
    })

    return () => {
      unsubState()
      unsubScript()
      unsubSpeech()
      unsubRoaming()
      unsubAgent()
    }
  }, [setEmotion, setSpeech, setRoamingStatus, setTabMode, isEyeMode, isDesktopChatOpen])

  // Desktop companion state: normal walking/standing/idle roaming behavior by default
  const desktopCompanionState = useMemo<CompanionEmotionState>(() => {
    // A script decides her look word by word, above everything else. Between its lines she stays
    // in the talking animation instead of flashing another pose.
    if (scriptLook) return scriptLook
    if (isScriptPlaying) return 'talking'

    // Red Cyber Eye (Target Terminated / App Closed)
    if (emotion === 'closed' || isClosedActiveRef.current) return 'closed'

    // 0.1 Scared Grab (Shift + Right Click or active scared state)
    // must always override talking. When scared, capri asustada.mp4 must play, never Capri2 talking
    if (emotion === 'asustada' || isScaredActiveRef.current) return 'asustada'

    // Audio Voice Active OR Active Dialogue in speech bubble (when muted):
    // Stays consistently in 'talking' (Capri2 - Trim.mp4 video) while actively speaking
    const hasActiveSpeech = isSpeaking || (!!speech && speech.trim().length > 0 && !isExecuting && !isSynthesizingVoice && isVoiceMutedRef.current)
    if (hasActiveSpeech) {
      return 'talking'
    }

    // Explicit Eye Mode animation override (e.g. Loading / RAM download script act)
    if (emotion === 'ojos') return 'ojos'

    // Gaming Mode: When in gaming mode, stays locked in 'ojos' unless speaking
    // (In CapriRenderer, 'ojos' with isGamingMode renders the ojos2.mp4 multi-eye video clip with the cyber frame)
    if (isGamingMode) {
      return 'ojos'
    }

    // Desktop Chat Open or Explicit Eye Mode on Desktop:
    // Shows the single black cyber eye ('ojos' animated sprite sequence from capri_generados/sprites/ojos)
    if (isDesktopChatOpen || isEyeMode) {
      return 'ojos'
    }

    // User actively recording voice to speak to Capri -> Curious listening avatar
    if (isRecordingVoice) {
      return 'curious'
    }

    // Tab Mode: Capri is perched sitting on window tab or sitting front in center -> 'idle_front' or 'idle'
    if (isTabMode) return emotion === 'idle_front' ? 'idle_front' : 'idle'

    // Closed or sleep
    if (emotion === 'sleep') return 'sleep'

    // If executing/thinking or synthesizing voice in desktop avatar mode -> avatar thinking, never walking or floating eye
    if (isExecuting || isSynthesizingVoice) return 'thinking'

    // Autonomous desktop roaming behaviors (avatar only, never ojos)
    if (isRoaming) return 'walking'
    if (emotion === 'walking') return 'walking'
    if (emotion === 'idle') return 'idle'
    if (emotion === 'idle_front') return 'idle_front'
    if (emotion === 'curious') return 'curious'
    if (emotion === 'happy') return 'happy'

    // Default desktop state: standing full-body avatar (never ojos!)
    return 'standing'
  }, [scriptLook, isScriptPlaying, isSpeaking, speech, isTabMode, isDesktopChatOpen, isEyeMode, emotion, isExecuting, isSynthesizingVoice, isRoaming, isRecordingVoice, isGamingMode])

  // Dynamic user-facing label representing Capri's current active state
  const companionStatusLabel = useMemo(() => {
    if (isGamingMode) return tr('st_gaming')
    if (isExecuting) return tr('st_thinking')
    if (isSpeaking) return tr('st_talking')
    if (isDesktopChatOpen) return tr('st_listening')
    switch (desktopCompanionState) {
      case 'walking': return tr('st_walking')
      case 'idle': return tr('st_sitting')
      case 'idle_front': return tr('st_sittingCenter')
      case 'standing': return tr('st_standing')
      case 'talking': return tr('st_talking')
      case 'curious': return tr('st_curious')
      case 'happy': return tr('st_happy')
      case 'ojos':
      case 'ojos2':
        return tr('st_eyes')
      case 'sleep': return tr('st_sleeping')
      case 'asustada': return tr('st_scared')
      case 'closed': return tr('st_closed')
      default: return tr('st_idle')
    }
  }, [desktopCompanionState, isExecuting, isSpeaking, isDesktopChatOpen, isGamingMode, tr])

  // Enable/pause roaming: Roaming is active freely unless chat panel, eye mode, speaking, thinking execution, or tab mode is active
  useEffect(() => {
    const shouldFreeze = isScriptPlaying || isGamingMode || isEyeMode || isDesktopChatOpen || isExecuting || isSpeaking || isSynthesizingVoice || isTabMode
    if (window.api?.companion?.setEyeMode) {
      window.api.companion.setEyeMode(isEyeMode || isDesktopChatOpen)
    }
    if (window.api?.roaming) {
      if (shouldFreeze) {
        window.api.roaming.setActive(false)
      } else {
        window.api.roaming.setActive(true)
      }
    }
  }, [isScriptPlaying, isEyeMode, isDesktopChatOpen, isExecuting, isSpeaking, isSynthesizingVoice, isTabMode])

  // Trigger scared animation & glitch effects
  const triggerScaredReaction = () => {
    isScaredActiveRef.current = true
    if (scaredTimerRef.current) clearTimeout(scaredTimerRef.current)

    // Stuttering multi-burst cyber glitch audio immediately upon grab/overpet
    playMultiGlitchSound(5, 180)

    setTabMode(false)
    if (window.api?.companion?.setTabMode) {
      window.api.companion.setTabMode(false, true)
    }
    if (window.api?.roaming) {
      window.api.roaming.setActive(false)
    }
    setEmotion('asustada')
    if (window.api?.companion?.setState) {
      window.api.companion.setState('asustada')
    }

    const isEs = currentLangRef.current === 'es'
    const scaredPhrases = isEs
      ? [
          "¡¡KYAAA!! ¡Te dije que pares! ¡Vas a sobrecargar mis sensores neuronales!!",
          "¡KYAAA! ¡{name}, sacá las manos de encima!",
          "¡Aaaah! ¡Cuidado con el ciberware! ¡Casi desconectás mi biochip!"
        ]
      : [
          "KYAAA!! I told you to stop! You're overloading my neural sensors!!",
          "KYAAA! {name}, hands off!!",
          "Aaaah! Watch the cyberware! You almost dislodged my biochip!"
        ]
    const scream = scaredPhrases[Math.floor(Math.random() * scaredPhrases.length)]
    setActiveUserPrompt(null)
    setActiveSpeechText(scream)
    setSpeech(scream, 4500)
    interruptSpeech() // she reacts to what the user just did
    speakWithCapriVoice(scream)

    scaredTimerRef.current = setTimeout(() => {
      isScaredActiveRef.current = false
      setEmotion('standing')
      if (window.api?.companion?.setState) {
        window.api.companion.setState('standing')
      }
      if (window.api?.roaming) {
        window.api.roaming.setActive(true)
      }
    }, 4500)
  }

  // Drag & Click handlers: Left Click = friendly drag / click; Ctrl + Click = Interactive Chat; Shift + Right Click = Petting / Headpat; Right Click = Grab
  const handleCapriMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Shift + Right Click: Headpat / Petting Interaction
    if (e.shiftKey && e.button === 2) {
      e.preventDefault()
      e.stopPropagation()
      setIsPetting(true)
      isPettingRef.current = true
      scareTriggeredRef.current = false
      playPetChirpSound()

      const isEs = currentLangRef.current === 'es'
      const flusteredPhrases = isEs
        ? [
            "¡¿Qué estás haciendo?! ¡Pará de hacer eso!",
            "¡¿Pero qué hacés?! ¡Pará de acariciarme la cabeza!",
            "¡O-oye! ¡¿Qué hacés?! ¡No me toques el pelo!",
            "What are you doing!!!!! stop doing dat!"
          ]
        : [
            "What are you doing?!! Stop doing that!",
            "What are you doing!!!!! stop doing dat!",
            "Hey! What are you doing?! Hands off my hair!"
          ]
      const flusteredText = flusteredPhrases[Math.floor(Math.random() * flusteredPhrases.length)]
      setActiveUserPrompt(null)
      setActiveSpeechText(flusteredText)
      setSpeech(flusteredText, 3000)
      interruptSpeech() // she reacts to what the user just did
      speakWithCapriVoice(flusteredText)

      if (pettingTimerRef.current) clearTimeout(pettingTimerRef.current)
      // If user holds for >= 2.5 seconds, trigger the scare gif/video
      pettingTimerRef.current = setTimeout(() => {
        scareTriggeredRef.current = true
        setIsPetting(false)
        isPettingRef.current = false
        triggerScaredReaction()
      }, 2500)

      const onMouseUp = () => {
        window.removeEventListener('mouseup', onMouseUp)
        if (pettingTimerRef.current) {
          clearTimeout(pettingTimerRef.current)
          pettingTimerRef.current = null
        }
        setIsPetting(false)
        isPettingRef.current = false
        if (!scareTriggeredRef.current) {
          const isEs = currentLangRef.current === 'es'
          const poutText = isEs ? "¡No me despeines los circuitos!" : "Don't mess up my cyberware, choomba!"
          setSpeech(poutText, 2500)
        }
      }
      window.addEventListener('mouseup', onMouseUp)
      return
    }

    // Ctrl + Left Click: Ignore drag so handleCapriClick handles the toggle cleanly on click
    if ((e.ctrlKey || e.metaKey) && e.button === 0) {
      e.stopPropagation()
      return
    }

    const isRightClick = e.button === 2
    const isLeftClick = e.button === 0
    // Plain right click triggers Scared Grab
    const isScaredGrab = isRightClick

    if (!isLeftClick && !isRightClick) return

    // Do not call e.preventDefault() on plain left click mousedown so onClick fires reliably
    if (isRightClick) {
      e.preventDefault()
      e.stopPropagation()
    }

    dragStartRef.current = {
      startX: e.screenX,
      startY: e.screenY,
      lastX: e.screenX,
      lastY: e.screenY,
      moved: false
    }

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!dragStartRef.current) return
      const dx = moveEvent.screenX - dragStartRef.current.lastX
      const dy = moveEvent.screenY - dragStartRef.current.lastY

      const totalDist = Math.hypot(
        moveEvent.screenX - dragStartRef.current.startX,
        moveEvent.screenY - dragStartRef.current.startY
      )
      if (totalDist > 10) {
        if (!dragStartRef.current.moved && isScaredGrab) {
          triggerScaredReaction()
        }
        dragStartRef.current.moved = true
        if (isTabMode) {
          setTabMode(false)
          if (window.api?.companion?.setTabMode) {
            window.api.companion.setTabMode(false, true)
          }
        }
      }

      if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
        dragStartRef.current.lastX = moveEvent.screenX
        dragStartRef.current.lastY = moveEvent.screenY
        if (window.api?.companion?.moveBy) {
          window.api.companion.moveBy(dx, dy)
        }
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (dragStartRef.current?.moved || isScaredGrab) {
        if (isGamingMode) {
          // Requirement: "tambien en el gaming mode debes poder ser capaz de moverla pero ella siempre se debe quedar en donde la dejaste"
          // Keep strictly in 'ojos', no roaming, no switching to happy/standing, stays right where the user dropped her
          setTimeout(() => {
            dragStartRef.current = null
          }, 50)
          return
        }

        // Requirement: "cuando la arrastro que deje de estar en modo sentada"
        setTabMode(false)
        if (window.api?.companion?.setTabMode) {
          window.api.companion.setTabMode(false, true)
        }

        if (isScaredGrab) {
          isScaredActiveRef.current = true
          const isReleaseEs = currentLangRef.current === 'es'
          const scaredReleasePhrases = isReleaseEs
            ? [
                "Uff... ¡No me vuelvas a agarrar así, choomba!",
                "¡Gah! ¡Avisame antes de moverme como una valija, {name}!",
                "Mis circuitos del Soulkiller todavía están vibrando... ¡Qué susto!",
                "Menos mal... De vuelta en estática firme. ¡Mantené las manos quietas la próxima!"
              ]
            : [
                "Phew... Never grab me like that again, choomba!",
                "Gah! Warn me before you move me like luggage, {name}!",
                "My soulkiller circuits are still vibrating from that... Geez!",
                "Whew... Back on solid static. Keep your hands to yourself next time!"
              ]
          const relPhrase = scaredReleasePhrases[Math.floor(Math.random() * scaredReleasePhrases.length)]
          setActiveSpeechText(relPhrase)
          setSpeech(relPhrase, 4500)
          interruptSpeech() // she reacts to what the user just did
          speakWithCapriVoice(relPhrase)

          if (scaredTimerRef.current) clearTimeout(scaredTimerRef.current)
          scaredTimerRef.current = setTimeout(() => {
            isScaredActiveRef.current = false
            setEmotion('standing')
            if (window.api?.companion?.setState) {
              window.api.companion.setState('standing')
            }
            if (window.api?.roaming && !isTabMode) {
              window.api.roaming.setActive(true)
            }
          }, 4800)
        } else {
          const isDragEs = currentLangRef.current === 'es'
          const dragPhrases = isDragEs
            ? [
                "¡Yuuujuuu! ¡Recalibrando coordenadas físicas!",
                "¡Ey, cuidado con el ciberware, choomba! Pero me gusta este lugar.",
                "¡Nuevas coordenadas fijadas! Me copa este punto de vista, {name}.",
                "¡Moviéndome por la estática! ¿Qué hackeamos desde acá, choomba?",
                "¡Paseando por el espacio físico! Lindo panorama desde acá arriba."
              ]
            : [
                "Wheee! Repositioning my physical coordinates!",
                "Hey, hands off the cyberware, choomba! But I like this spot.",
                "New coordinates locked! Digging the new vantage point, {name}.",
                "Moved through the static! What are we hacking from here, choomba?",
                "Carried across meatspace! Nice view from up here."
              ]
          const phrase = dragPhrases[Math.floor(Math.random() * dragPhrases.length)]
          setActiveUserPrompt(null)
          setEmotion('happy')
          setActiveSpeechText(phrase)
          setSpeech(phrase)
          interruptSpeech() // she reacts to what the user just did
          speakWithCapriVoice(phrase)
          setTimeout(() => {
            setEmotion('standing')
          }, 4500)
        }
      }

      setTimeout(() => {
        dragStartRef.current = null
      }, 50)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const handleCapriContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (dragStartRef.current?.moved || isScaredActiveRef.current) return
    setIsContextMenuOpen((prev) => !prev)
  }

  // Opens/closes Capri's chat input (Ctrl + Click on her, or the Left arrow hotkey)
  const toggleDesktopChat = () => {
    const next = !isDesktopChatOpenRef.current
    setIsDesktopChatOpen(next)
    if (next) {
      window.api?.companion?.setEyeMode?.(true)
      window.api?.roaming?.setActive(false)
      const isEs = currentLangRef.current === 'es'
      setSpeech(isEs ? "¿En qué estás pensando, {name}? ¡Hablame o decime qué hackeamos!" : "What's on your mind, {name}? Talk to me or tell me what to hack!", 3500)
      setTimeout(() => promptInputRef.current?.focus(), 100)
    } else {
      window.api?.companion?.setEyeMode?.(false)
      window.api?.roaming?.setActive(true)
    }
  }
  toggleDesktopChatRef.current = toggleDesktopChat

  // Click on Capri: Normal click toggles Dev Deck; Ctrl + Click toggles Interactive HUD Input; Shift + Click moves window
  const handleCapriClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (isContextMenuOpen) {
      setIsContextMenuOpen(false)
      return
    }
    if (e.shiftKey || dragStartRef.current?.moved || isScaredActiveRef.current) {
      e.preventDefault()
      e.stopPropagation()
      return
    }

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      toggleDesktopChat()
      return
    }

    // During the catch game (or her offer of tag) a click catches her instead of opening the deck
    const { isCatchGameActive, offeringTag } = useCompanionStore.getState()
    if (isCatchGameActive || offeringTag) {
      e.preventDefault()
      e.stopPropagation()
      void window.api.game.catchSuccess()
      return
    }

    // Normal click: open Dev Deck
    if (window.api) {
      await window.api.deck.show()
    }
  }

  // Handle submitting message to Capri
  handleSendMessageRef.current = (t: string) => {
    handleSendMessage(t)
  }
  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputText).trim()
    if (!text || isExecuting) return

    // A new prompt from the user interrupts whatever Capri was saying (and what was queued)
    interruptSpeech()

    setInputText('')
    setIsDesktopChatOpen(false) // Close desktop input bar immediately upon sending
    if (window.api?.companion?.setEyeMode) {
      window.api.companion.setEyeMode(false)
    }
    if (window.api?.roaming && !isTabMode) {
      window.api.roaming.setActive(true)
    }
    setIsExecuting(true)
    isExecutingRef.current = true
    setActiveUserPrompt(text) // Associate speech bubble with the active user prompt
    lastAssistantContentRef.current = ''
    setActiveSpeechText(null)
    setSpeech(null) // Instantly clear previous speech so bubble shows thinking...
    if (bubbleHideTimerRef.current) {
      clearTimeout(bubbleHideTimerRef.current)
      bubbleHideTimerRef.current = null
    }

    const isCloseOrDelete =
      /^(?:cierra|cerrar|close|kill|termina|terminar|apaga|apagar|shut\s*down|shutdown|power\s*off|borra|borrar|elimina|eliminar|delete|remove|rm)\s*/i.test(text) ||
      /(?:cierra|cerrar|close|kill|borra|borrar|elimina|eliminar|delete)\s+(?:chrome|steam|apple\s*music|itunes|discord|youtube|calc|calculadora|notepad|bloc|obs|lol|league|valorant|cyberpunk|palworld|roblox|juego|game|archivo|file|carpeta|folder)/i.test(text)
    pendingCloseDeleteRef.current = isCloseOrDelete

    const isVoiceSettingsCmd =
      /^(?:voz|cambiar\s+voz|cambiar\s+la\s+voz|configurar\s+voz|ajustes\s+de\s+voz|voice|voice\s+settings|tts|elevenlabs|fish\s*audio)$/i.test(text.trim()) ||
      /(?:configurar\s+voz|cambiar\s+la\s+voz|cambiar\s+voz|ajustes\s+de\s+voz|voice\s+settings|tts\s+settings)/i.test(text)

    if (isVoiceSettingsCmd) {
      setIsExecuting(false)
      isExecutingRef.current = false
      setIsVoiceSettingsOpen(true)

      const userMsg: DesktopChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: Date.now()
      }
      const asstMsg: DesktopChatMessage = {
        id: `asst-${Date.now() + 1}`,
        role: 'assistant',
        content: '¡Abriendo panel de configuración de voz TTS! Podés configurar Edge-TTS, ElevenLabs o Fish Audio.',
        timestamp: Date.now() + 1
      }
      setChatMessages((prev) => [...prev, userMsg, asstMsg])
      setSpeech('¡Abriendo panel de voz TTS!', 3000)
      return
    }

    // Append user message
    const userMsg: DesktopChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    }

    // Append blank assistant message to stream into
    const asstMsg: DesktopChatMessage = {
      id: `asst-${Date.now() + 1}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now() + 1
    }

    setChatMessages((prev) => [...prev, userMsg, asstMsg])
    if (!isEyeMode) {
      setEmotion('thinking')
    }

    try {
      if (window.api) {
        await window.api.agent.sendPrompt(text, projectPath, undefined, 'pet')
      }
    } catch (err: any) {
      setIsExecuting(false)
      setChatMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: localizeLine(`Failed to reach cyberware core: ${err?.message || err}`, getLineLanguage()),
          timestamp: Date.now()
        }
      ])
    }
  }

  const handleClearChat = () => {
    const isEs = currentLangRef.current === 'es'
    const resetMsg = isEs
      ? "¡Bancos de memoria reiniciados, {name}! ¿Cuál es nuestra próxima jugada, choomba?"
      : "Memory banks refreshed, {name}! What's our next move, choomba?"
    const resetList: DesktopChatMessage[] = [
      {
        id: `init-${Date.now()}`,
        role: 'assistant',
        content: resetMsg,
        timestamp: Date.now()
      }
    ]
    setChatMessages(resetList)
    setActiveUserPrompt(null)
    setSpeech(resetMsg, 4000)
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {}
    if (window.api?.agent?.clearHistory) {
      window.api.agent.clearHistory().catch(() => {})
    }
  }

  const isBubbleVisible = Boolean(
    isDesktopChatOpen ||
    isExecuting ||
    isSynthesizingVoice ||
    speech ||
    activeSpeechText ||
    isSpeaking ||
    isRecordingVoice ||
    isProcessingVoice
  )
  const bubbleText = (isExecuting || isSynthesizingVoice)
    ? null
    : (activeSpeechText || speech || null)

  if (isGamingMode) {
    return (
      <div
        onMouseEnter={() => setIsWindowHovered(true)}
        onMouseLeave={() => setIsWindowHovered(false)}
        className={`relative w-full h-full flex flex-col items-center justify-start pt-1 select-none overflow-visible font-terminal ${
          isDeckOpen ? 'invisible opacity-0 pointer-events-none' : ''
        }`}
        style={{
          WebkitAppRegion: 'drag',
          background: 'transparent'
        } as React.CSSProperties}
      >
        {/* Capri Cyber Frame (Ojos or Talking) strictly anchored at the top-left */}
        <div
          onMouseDown={handleCapriMouseDown}
          onContextMenu={handleCapriContextMenu}
          className="w-full aspect-video flex items-center justify-center relative z-10 cursor-pointer overflow-visible select-none flex-shrink-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="w-full h-full flex items-center justify-center overflow-visible">
            <CapriRenderer
              state={desktopCompanionState}
              noShadow={false}
              isGamingMode={isGamingMode}
              onClick={handleCapriClick}
            />
          </div>
        </div>

        {/* Downward Speech Bubble strictly below Capri */}
        {isBubbleVisible && (
          <div
            className="w-full flex flex-col items-center z-40 select-none mt-1 px-3 animate-fade-in"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className="w-full flex flex-col items-center max-w-[350px]">
              <SpeechBubble
                text={bubbleText}
                userPrompt={activeUserPrompt}
                state={desktopCompanionState}
                isExecuting={isExecuting || isSynthesizingVoice}
                compact={false}
                isRecordingVoice={isRecordingVoice}
                isProcessingVoice={isProcessingVoice}
                liveVoiceText={liveRecognizedText}
                audioLevel={audioLevel}
                tailPosition="top"
                onStopVoice={stopVoiceRecording}
                onCancelVoice={cancelVoiceRecording}
                onClose={() => {
                  setSpeech(null)
                  setActiveSpeechText(null)
                  setActiveUserPrompt(null)
                  if (bubbleHideTimerRef.current) {
                    clearTimeout(bubbleHideTimerRef.current)
                    bubbleHideTimerRef.current = null
                  }
                }}
              >
                {/* Minimal Input Bar: Only opens on Ctrl + Click */}
                {isDesktopChatOpen && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      handleSendMessage()
                    }}
                    className="mt-2 pt-2 border-t border-[#00f0ff]/30 flex items-center gap-1.5 font-terminal animate-fade-in"
                  >
                    <span className="text-xs font-bold text-[#fcee0a] select-none font-terminal">&gt;</span>

                    <input
                      ref={promptInputRef}
                      type="text"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder={
                        isRecordingVoice
                          ? localizeLine('Listening... speak to Capri...', currentLang)
                          : isProcessingVoice
                          ? localizeLine('Decoding voice...', currentLang)
                          : localizeLine('type command...', currentLang)
                      }
                      disabled={isExecuting || isRecordingVoice || isProcessingVoice}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setIsDesktopChatOpen(false)
                        }
                      }}
                      className="flex-1 bg-black/90 border border-zinc-700 focus:border-[#00f0ff] text-[#f8fafc] text-xs px-2.5 py-1 rounded outline-none select-text shadow-inner transition-colors font-terminal placeholder:text-zinc-600"
                    />

                    <button
                      type="button"
                      onClick={() => setIsVoiceSettingsOpen(true)}
                      className="p-1.5 rounded text-xs font-bold transition-all cursor-pointer bg-black/80 hover:bg-cyan-950/60 text-cyan-400 border border-cyan-500/40 hover:border-cyan-400"
                      title="Configurar Voz TTS (Fish Audio / Edge-TTS / ElevenLabs)"
                    >
                      <Sliders size={13} className="text-cyan-400" />
                    </button>

                    <button
                      type="button"
                      disabled={isExecuting || isProcessingVoice}
                      onClick={toggleVoiceRecordingSafe}
                      className={`p-1.5 rounded text-xs font-bold transition-all cursor-pointer ${
                        isRecordingVoice
                          ? 'bg-[#ff003c] text-white animate-pulse'
                          : 'bg-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-700'
                      }`}
                      title={isRecordingVoice ? 'Stop recording' : 'Record voice (Down arrow)'}
                    >
                      {isProcessingVoice ? (
                        <div className="w-3.5 h-3.5 border-2 border-[#00f0ff] border-t-transparent rounded-full animate-spin" />
                      ) : isRecordingVoice ? (
                        <MicOff size={13} />
                      ) : (
                        <Mic size={13} />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsDesktopChatOpen(false)}
                      className="p-1 rounded text-zinc-500 hover:text-white transition-colors cursor-pointer"
                      title="Close input (Esc)"
                    >
                      <X size={13} />
                    </button>
                  </form>
                )}
              </SpeechBubble>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      onMouseEnter={() => setIsWindowHovered(true)}
      onMouseLeave={() => setIsWindowHovered(false)}
      onClick={() => {
        if (isContextMenuOpen) setIsContextMenuOpen(false)
      }}
      className={`relative w-full h-full flex flex-col items-center justify-end p-0 select-none overflow-visible font-terminal ${
        isDeckOpen ? 'invisible opacity-0 pointer-events-none' : ''
      }`}
      style={{
        WebkitAppRegion: 'drag',
        background: 'transparent'
      } as React.CSSProperties}
    >
      {/* =========================================================================
          GROUPED PET + BUBBLE STACK: Anchored to the bottom
          Speech bubble sits directly on top of Capri's head without an empty void.
          Ample headroom so Ctrl + Click input is never clipped at the top!
          ========================================================================= */}
      <div className="w-full flex flex-col items-center justify-end flex-shrink-0 pb-1">
        {isBubbleVisible && (
          <div
            className="w-full flex flex-col items-center z-40 select-none mb-1 px-3"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className={`w-full flex flex-col items-center animate-fade-in ${isTabMode ? 'max-w-[320px]' : 'max-w-[380px]'}`}>
              <SpeechBubble
                text={bubbleText}
                userPrompt={activeUserPrompt}
                state={desktopCompanionState}
                isExecuting={isExecuting || isSynthesizingVoice}
                compact={isTabMode}
                isRecordingVoice={isRecordingVoice}
                isProcessingVoice={isProcessingVoice}
                liveVoiceText={liveRecognizedText}
                audioLevel={audioLevel}
                onStopVoice={stopVoiceRecording}
                onCancelVoice={cancelVoiceRecording}
                onClose={() => {
                  setSpeech(null)
                  setActiveSpeechText(null)
                  setActiveUserPrompt(null)
                  if (bubbleHideTimerRef.current) {
                    clearTimeout(bubbleHideTimerRef.current)
                    bubbleHideTimerRef.current = null
                  }
                }}
              >
                {/* Minimal Input Bar: Only opens on Ctrl + Click */}
                {isDesktopChatOpen && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      handleSendMessage()
                    }}
                    className="mt-2 pt-2 border-t border-[#00f0ff]/30 flex items-center gap-1.5 font-terminal animate-fade-in"
                  >
                    <span className="text-xs font-bold text-[#fcee0a] select-none font-terminal">&gt;</span>

                    <input
                      ref={promptInputRef}
                      type="text"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder={
                        isRecordingVoice
                          ? localizeLine('Listening... speak to Capri...', currentLang)
                          : isProcessingVoice
                          ? localizeLine('Decoding voice...', currentLang)
                          : localizeLine('type command...', currentLang)
                      }
                      disabled={isExecuting || isRecordingVoice || isProcessingVoice}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setIsDesktopChatOpen(false)
                        }
                      }}
                      className="flex-1 bg-black/90 border border-zinc-700 focus:border-[#00f0ff] text-[#f8fafc] text-xs px-2.5 py-1 rounded outline-none select-text shadow-inner transition-colors font-terminal placeholder:text-zinc-600"
                    />

                    <button
                      type="button"
                      onClick={() => setIsVoiceSettingsOpen(true)}
                      className="p-1.5 rounded text-xs font-bold transition-all cursor-pointer bg-black/80 hover:bg-cyan-950/60 text-cyan-400 border border-cyan-500/40 hover:border-cyan-400"
                      title="Configurar Voz TTS (Fish Audio / Edge-TTS / ElevenLabs)"
                    >
                      <Sliders size={13} className="text-cyan-400" />
                    </button>

                    <button
                      type="button"
                      disabled={isExecuting || isProcessingVoice}
                      onClick={toggleVoiceRecordingSafe}
                      className={`p-1.5 rounded text-xs font-bold transition-all cursor-pointer ${
                        isRecordingVoice
                          ? 'bg-[#ff003c] text-white animate-pulse shadow-[0_0_12px_#ff003c]'
                          : isProcessingVoice
                          ? 'bg-zinc-800 text-zinc-400'
                          : 'bg-[#00f0ff]/10 hover:bg-[#00f0ff]/20 text-[#00f0ff] border border-[#00f0ff]/50'
                      }`}
                      title={isRecordingVoice ? 'Click para enviar (o Flecha abajo ↓)' : 'Hablar con Capri (Flecha abajo ↓ o clic)'}
                    >
                      {isProcessingVoice ? (
                        <Loader2 size={13} className="animate-spin text-[#00f0ff]" />
                      ) : isRecordingVoice ? (
                        <MicOff size={13} />
                      ) : (
                        <Mic size={13} />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsDesktopChatOpen(false)}
                      className="p-1 rounded text-zinc-500 hover:text-white transition-colors cursor-pointer"
                      title="Close input (Esc)"
                    >
                      <X size={13} />
                    </button>
                  </form>
                )}
              </SpeechBubble>

              {/* Discreet floating status & voice pill below bubble */}
              {!isTabMode && (
                <div
                  className="mt-1 flex items-center gap-1.5"
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                >
                  <button
                    type="button"
                    onClick={() => {
                      const next = !isDesktopChatOpen
                      setIsDesktopChatOpen(next)
                      if (next) {
                        if (window.api?.companion?.setEyeMode) {
                          window.api.companion.setEyeMode(true)
                        }
                        if (window.api?.roaming) {
                          window.api.roaming.setActive(false)
                        }
                        const isEs = currentLangRef.current === 'es'
                        setSpeech(isEs ? "¿En qué estás pensando, {name}?" : "What's on your mind, {name}?", 3500)
                        setTimeout(() => promptInputRef.current?.focus(), 100)
                      } else {
                        if (window.api?.companion?.setEyeMode) {
                          window.api.companion.setEyeMode(false)
                        }
                        if (window.api?.roaming) {
                          window.api.roaming.setActive(true)
                        }
                      }
                    }}
                    className="cp-cut cp-font uppercase tracking-wider px-2.5 py-0.5 bg-black/80 hover:bg-black border border-[#5ef6ff]/40 hover:border-[#5ef6ff] rounded-none text-[10px] font-bold flex items-center gap-1.5 transition-all cursor-pointer"
                    title={tr('cp_statusTitle')}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00ff66] animate-pulse shadow-[0_0_6px_#00ff66]" />
                    <span className="font-hud tracking-wide text-white">Capri</span>
                    <span className="text-zinc-500 font-normal">|</span>
                    <span className="text-[#00f0ff] font-semibold">{companionStatusLabel}</span>
                    <span className="text-[9px] text-zinc-400 font-normal opacity-70 ml-0.5">(Ctrl + {localizeLine('Click', currentLang)})</span>
                  </button>

                  <button
                    type="button"
                    onClick={toggleVoiceMute}
                    className={`cp-cut cp-font uppercase tracking-wider px-2 py-0.5 rounded-none text-[10px] font-bold flex items-center gap-1 border transition-all cursor-pointer ${
                      isVoiceMuted
                        ? 'bg-stone-950/90 border-stone-700 text-stone-500 hover:text-stone-300'
                        : 'bg-black/80 border-[#ff5f57]/70 text-[#ff5f57] hover:text-cp-100'
                    }`}
                    title={isVoiceMuted ? tr('cp_voiceMutedTitle') : tr('cp_voiceOnTitle')}
                  >
                    {isVoiceMuted ? (
                      <>
                        <VolumeX size={11} className="text-zinc-500" />
                        <span>{tr('cp_muted')}</span>
                      </>
                    ) : (
                      <>
                        <Volume2 size={11} className="text-[#ff003c] animate-pulse" />
                        <span>{tr('cp_on')}</span>
                      </>
                    )}
                  </button>

                  {/* Voice Type Selector: blip / TTS */}
                  <button
                    type="button"
                    onClick={() => {
                      setVoiceType((prev) => {
                        const next = prev === 'blip' ? 'tts' : 'blip'
                        try {
                          localStorage.setItem('capri_voice_type', next)
                        } catch {}
                        setSpeech(next === 'blip' ? 'Voice: Dialogue Blip' : 'Voice: Original TTS', 2000)
                        return next
                      })
                    }}
                    className="cp-cut cp-font uppercase tracking-wider px-2 py-0.5 rounded-none text-[10px] font-bold flex items-center gap-1 border border-[#5ef6ff]/50 bg-black/80 text-[#5ef6ff] hover:bg-[#5ef6ff]/20 transition-all cursor-pointer "
                    title="Toggle Voice: Dialogue Blip (@dialogue_blip.wav) vs Original Edge TTS"
                  >
                    <span className="text-zinc-400 font-normal">{localizeLine('Voice', currentLang).toUpperCase()}:</span>
                    <span className="text-[#fcee0a] uppercase font-bold">{voiceType}</span>
                  </button>

                </div>
              )}
            </div>
          </div>
        )}

        {/* Floating Status & Voice Controls on Hover when Bubble is Hidden */}
        {!isBubbleVisible && !isTabMode && !isGamingMode && (isWindowHovered || isRecordingVoice) && (
          <div
            className="mb-2 z-40 animate-fade-in flex items-center gap-1.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              type="button"
              onClick={() => {
                const next = !isDesktopChatOpen
                setIsDesktopChatOpen(next)
                if (next) {
                  if (window.api?.companion?.setEyeMode) {
                    window.api.companion.setEyeMode(true)
                  }
                  if (window.api?.roaming) {
                    window.api.roaming.setActive(false)
                  }
                  const isEs = currentLangRef.current === 'es'
                  setSpeech(isEs ? "¿En qué estás pensando, {name}?" : "What's on your mind, {name}?", 3500)
                  setTimeout(() => promptInputRef.current?.focus(), 100)
                } else {
                  if (window.api?.companion?.setEyeMode) {
                    window.api.companion.setEyeMode(false)
                  }
                  if (window.api?.roaming) {
                    window.api.roaming.setActive(true)
                  }
                }
              }}
              className="cp-cut cp-font uppercase tracking-wider px-2.5 py-0.5 bg-black/80 hover:bg-black border border-[#5ef6ff]/40 hover:border-[#5ef6ff] rounded-none text-[10px] font-bold flex items-center gap-1.5 transition-all cursor-pointer"
              title={tr('cp_statusTitle')}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#00ff66] animate-pulse shadow-[0_0_6px_#00ff66]" />
              <span className="font-hud tracking-wide text-white">Capri</span>
              <span className="text-zinc-500 font-normal">|</span>
              <span className="text-[#00f0ff] font-semibold">{companionStatusLabel}</span>
              <span className="text-[9px] text-zinc-400 font-normal opacity-70 ml-0.5">(Ctrl + {localizeLine('Click', currentLang)})</span>
            </button>

            <button
              type="button"
              onClick={toggleVoiceMute}
              className={`cp-cut cp-font uppercase tracking-wider px-2 py-0.5 rounded-none text-[10px] font-bold flex items-center gap-1 border transition-all cursor-pointer ${
                isVoiceMuted
                  ? 'bg-stone-950/90 border-stone-700 text-stone-500 hover:text-stone-300'
                  : 'bg-black/80 border-[#ff5f57]/70 text-[#ff5f57] hover:text-cp-100'
              }`}
              title={isVoiceMuted ? tr('cp_voiceMutedTitle') : tr('cp_voiceOnTitle')}
            >
              {isVoiceMuted ? (
                <>
                  <VolumeX size={11} className="text-zinc-500" />
                  <span>{tr('cp_muted')}</span>
                </>
              ) : (
                <>
                  <Volume2 size={11} className="text-[#ff003c] animate-pulse" />
                  <span>{tr('cp_on')}</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setVoiceType((prev) => {
                  const next = prev === 'blip' ? 'tts' : 'blip'
                  try {
                    localStorage.setItem('capri_voice_type', next)
                  } catch {}
                  setSpeech(next === 'blip' ? 'Voice: Dialogue Blip' : 'Voice: Original TTS', 2000)
                  return next
                })
              }}
              className="cp-cut cp-font uppercase tracking-wider px-2 py-0.5 rounded-none text-[10px] font-bold flex items-center gap-1 border border-[#5ef6ff]/50 bg-black/80 text-[#5ef6ff] hover:bg-[#5ef6ff]/20 transition-all cursor-pointer "
              title="Toggle Voice: Dialogue Blip (@dialogue_blip.wav) vs Original Edge TTS"
            >
              <span className="text-zinc-400 font-normal">{localizeLine('Voice', currentLang).toUpperCase()}:</span>
              <span className="text-[#fcee0a] uppercase font-bold">{voiceType}</span>
            </button>

          </div>
        )}

        {/* Capri Roaming Freely Anchored directly below the speech bubble */}
        <div
          onMouseDown={handleCapriMouseDown}
          onContextMenu={handleCapriContextMenu}
          className={`w-full ${isTabMode ? 'h-[190px]' : 'h-[235px]'} flex items-end justify-center relative z-10 cursor-pointer overflow-visible select-none`}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* Always-listening indicator: visible the whole time she's listening (Right arrow toggles) */}
          {isAlwaysListening && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                toggleAlwaysListeningRef.current()
              }}
              className="cp-cut cp-font uppercase tracking-wider absolute top-1 right-3 z-30 flex items-center gap-1 px-2 py-0.5 bg-black/85 border border-cyan-300/70 text-cyan-300 text-[11px] font-bold cursor-pointer hover:bg-[#1a0d0e]"
              title={tr('cp_listeningTitle')}
            >
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inline-flex w-full h-full bg-cyan-300 opacity-75 animate-ping" />
                <span className="relative inline-flex w-1.5 h-1.5 bg-cyan-300" />
              </span>
              <Ear size={11} className="text-cyan-300" />
              <span>{tr('cp_listening')}</span>
            </button>
          )}

          {isPetting && (
            <>
              {/* Synchronized hand patting overlay */}
              <div className="absolute -top-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none select-none flex flex-col items-center animate-hand-pet">
                <img
                  src={patPatGif}
                  alt="pat-pat"
                  className="w-28 h-28 object-contain filter drop-shadow(0 0 16px rgba(0,240,255,0.9)) pointer-events-none"
                />
              </div>

              {/* Floating cute digital hearts and cyber sparks */}
              <div className="absolute top-2 left-6 z-40 pointer-events-none select-none text-pink-400 font-mono text-sm animate-pulse drop-shadow-[0_0_8px_#ff007f]">
                ♥
              </div>
              <div className="absolute top-4 right-6 z-40 pointer-events-none select-none text-cyan-400 font-mono text-xs animate-ping drop-shadow-[0_0_8px_#00f0ff]">
                ✦
              </div>
            </>
          )}

          {/* Capri Avatar with rhythmic headpat squish & wobble when petted */}
          <div
            className={`w-full h-full flex items-end justify-center overflow-visible ${
              isPetting ? 'animate-capri-pet' : ''
            }`}
            style={{ transformOrigin: 'bottom center' }}
          >
            <CapriRenderer
              state={desktopCompanionState}
              noShadow={false}
              onClick={handleCapriClick}
            />
          </div>
        </div>
      </div>

      {/* Cyberpunk Quick Actions Menu on Right Click */}
      {isContextMenuOpen && !isDeckOpen && (
        <div
          className="cp-vars cp-frame absolute z-50 p-1.5 flex flex-col gap-1 min-w-[230px] animate-fade-in"
          style={{ bottom: isTabMode ? '140px' : '200px', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-2 py-1 border-b border-stone-800 text-[12px] text-stone-400 font-bold uppercase tracking-wider">
            <span className="text-cp-500 flex items-center gap-1">
              <Sliders size={11} /> {tr('cp_menu')}
            </span>
            <button
              onClick={() => setIsContextMenuOpen(false)}
              className="text-stone-500 hover:text-white cursor-pointer"
            >
              <X size={12} />
            </button>
          </div>

          <button
            onClick={() => {
              setIsContextMenuOpen(false)
              setIsVoiceSettingsOpen(true)
            }}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-none hover:bg-[#2a1213] text-cp-500 hover:text-white transition-colors text-left cursor-pointer"
          >
            <Sliders size={13} className="text-cp-500 shrink-0" />
            <div className="flex flex-col">
              <span className="font-bold text-[13px]">{tr('cp_voiceSettings')}</span>
              <span className="text-[11px] text-stone-500">Fish Audio / Edge-TTS / ElevenLabs</span>
            </div>
          </button>

          <button
            onClick={async () => {
              setIsContextMenuOpen(false)
              if (window.api?.deck) await window.api.deck.show()
            }}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-none hover:bg-[#2a1213] text-cp-500 hover:text-white transition-colors text-left cursor-pointer"
          >
            <Code2 size={13} className="text-cp-500 shrink-0" />
            <div className="flex flex-col">
              <span className="font-bold text-[13px]">{tr('cp_devMode')}</span>
              <span className="text-[11px] text-stone-500">{tr('cp_devModeSub')}</span>
            </div>
          </button>

          <button
            onClick={() => {
              setIsContextMenuOpen(false)
              toggleVoiceMute()
            }}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-none hover:bg-[#2a1213] text-cp-500 hover:text-white transition-colors text-left cursor-pointer"
          >
            {isVoiceMuted ? (
              <>
                <Volume2 size={13} className="text-cp-500 shrink-0" />
                <span className="font-bold text-[13px]">{tr('cp_unmute')}</span>
              </>
            ) : (
              <>
                <VolumeX size={13} className="text-stone-500 shrink-0" />
                <span className="font-bold text-[13px]">{tr('cp_mute')}</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* Voice TTS Settings Modal */}
      <VoiceSettingsModal
        isOpen={isVoiceSettingsOpen}
        onClose={() => setIsVoiceSettingsOpen(false)}
      />
    </div>
  )
}
