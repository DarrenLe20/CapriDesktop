import { localizeLine } from '../../../shared/lines'
import { getLineLanguage } from '../utils/lineLanguage'
import { personalize } from '../utils/userName'
import { create } from 'zustand'

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

export type CompanionRenderMode = 'frames' | 'gif' | 'webp'

interface CompanionState {
  emotion: CompanionEmotionState
  speech: string | null
  speechTimeout: ReturnType<typeof setTimeout> | null
  renderMode: CompanionRenderMode
  direction: 'left' | 'right'
  isRoaming: boolean
  isCatchGameActive: boolean
  catchGameTimeRemaining: number
  isTabMode: boolean
  /** Hopping to another monitor: 'out' while she's glitched away */
  hop?: 'out' | 'in'
  /** Changes on every hop glitch */
  hopId: number
  /** She offered a game of tag: a click on her starts it */
  offeringTag: boolean
  setEmotion: (emotion: CompanionEmotionState) => void
  setSpeech: (text: string | null, durationMs?: number) => void
  setRenderMode: (mode: CompanionRenderMode) => void
  setDirection: (direction: 'left' | 'right') => void
  setTabMode: (enabled: boolean) => void
  setRoamingStatus: (status: {
    isRoaming: boolean
    direction: 'left' | 'right'
    isCatchGameActive?: boolean
    gameTimeRemaining?: number
    isTabMode?: boolean
    currentBehavior?: 'walking' | 'still' | 'tab'
    hop?: 'out' | 'in'
    hopId?: number
    offeringTag?: boolean
  }) => void
}

export const useCompanionStore = create<CompanionState>((set, get) => ({
  emotion: 'idle',
  speech: null,
  speechTimeout: null,
  renderMode: 'frames',
  direction: 'right',
  isRoaming: false,
  isCatchGameActive: false,
  catchGameTimeRemaining: 15,
  isTabMode: false,
  hop: undefined,
  hopId: 0,
  offeringTag: false,

  setEmotion: (emotion) => set({ emotion }),

  setTabMode: (enabled) => set({ isTabMode: enabled }),

  setSpeech: (rawText, durationMs = 4500) => {
    const text = personalize(rawText && localizeLine(rawText, getLineLanguage()))
    const prev = get().speechTimeout
    if (prev) clearTimeout(prev)

    if (!text) {
      set({ speech: null, speechTimeout: null })
      return
    }

    if (durationMs <= 0 || durationMs === Infinity) {
      set({ speech: text, speechTimeout: null })
      return
    }

    const timeout = setTimeout(() => {
      set({ speech: null, speechTimeout: null })
    }, durationMs)

    set({ speech: text, speechTimeout: timeout })
  },

  setRenderMode: (renderMode) => set({ renderMode }),

  setDirection: (direction) => set({ direction }),

  setRoamingStatus: (status) =>
    set({
      isRoaming: status.isRoaming,
      direction: status.direction,
      isCatchGameActive: !!status.isCatchGameActive,
      catchGameTimeRemaining: status.gameTimeRemaining ?? 15,
      hop: status.hop,
      offeringTag: !!status.offeringTag,
      ...(typeof status.hopId === 'number' ? { hopId: status.hopId } : {}),
      ...(typeof status.isTabMode === 'boolean' ? { isTabMode: status.isTabMode } : {})
    })
}))
