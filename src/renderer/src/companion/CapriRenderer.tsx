import { effectsVolume, glitchSoundOn } from '../utils/soundSettings'
import { localizeLine } from '../../../shared/lines'
import { getLineLanguage } from '../utils/lineLanguage'
import React, { useState, useEffect, useMemo, useRef } from 'react'
import { CompanionEmotionState, useCompanionStore } from '../stores/useCompanionStore'
import capri2TrimVideo from '../assets/Capri2_Trim.mp4'
import capriAsustadaVideo from '../assets/capri_asustada.mp4'
import ojos2Video from '../assets/ojos2.mp4'
import capriFrameImg from '../assets/capri_frame.png'
import capriFrameHorizontalImg from '../assets/capri_frame_horizontal.png'
import avatarChangeSound from '../assets/avatar_change.wav'
import capriFrontImg from '../assets/capri/idle_front/idle_front.png'
import capriFrontWebp from '../assets/capri/idle_front/idle_front.webp'

interface CapriRendererProps {
  state: CompanionEmotionState
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void
  className?: string
  overrideDirection?: 'left' | 'right'
  noShadow?: boolean
  isGamingMode?: boolean
}

// Avatar change audio effect
let activeAvatarAudio: HTMLAudioElement | null = null

const playAvatarChangeSound = () => {
  try {
    if (activeAvatarAudio) {
      try {
        activeAvatarAudio.pause()
        activeAvatarAudio.currentTime = 0
      } catch {}
    }
    if (!glitchSoundOn()) return
    const audio = new Audio(avatarChangeSound)
    audio.volume = 0.55 * effectsVolume()
    activeAvatarAudio = audio
    audio.play().catch(() => {
      playGlitchSound()
    })
  } catch {
    playGlitchSound()
  }
}

// Cyber glitch audio click (50ms) using Web Audio API
const playGlitchSound = () => {
  if (!glitchSoundOn()) return
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const now = ctx.currentTime

    const bufferSize = Math.floor(ctx.sampleRate * 0.05) // 50ms
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.35))
    }

    const noise = ctx.createBufferSource()
    noise.buffer = buffer

    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(1600, now)
    filter.frequency.exponentialRampToValueAtTime(400, now + 0.045)
    filter.Q.value = 2.5

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.08, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05)

    noise.connect(filter)
    filter.connect(gain)
    gain.connect(ctx.destination)

    noise.start(now)
    noise.stop(now + 0.05)
    setTimeout(() => ctx.close().catch(() => {}), 90)
  } catch {}
}

// Multi-burst glitch audio effect for cyber shock / scared state
export const playMultiGlitchSound = (count = 5, intervalMs = 180) => {
  if (!glitchSoundOn()) return
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      try {
        const audio = new Audio(avatarChangeSound)
        audio.volume = 0.65 * effectsVolume()
        audio.playbackRate = 0.90 + Math.random() * 0.25 // authentic cybernetic stutter
        audio.play().catch(() => {
          playGlitchSound()
        })
      } catch {
        playGlitchSound()
      }
    }, i * intervalMs)
  }
}

// Gentle cybernetic chirp / purr sound when petting Capri
export const playPetChirpSound = () => {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(540, now)
    osc.frequency.exponentialRampToValueAtTime(840, now + 0.12)

    gain.gain.setValueAtTime(0.06, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.15)
    setTimeout(() => ctx.close().catch(() => {}), 200)
  } catch {}
}

// Load all frames, gifs, and webps eagerly using Vite's glob import
const assetModules = import.meta.glob<{ default: string }>(
  '../assets/capri/*/*.{png,gif,webp}',
  { eager: true }
)

export const CapriRenderer: React.FC<CapriRendererProps> = ({
  state,
  onClick,
  className = '',
  overrideDirection,
  noShadow = false,
  isGamingMode = false
}) => {
  const { renderMode, direction: storeDirection, isCatchGameActive, hop, hopId } = useCompanionStore()
  const direction = overrideDirection || storeDirection
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const asustadaVideoRef = useRef<HTMLVideoElement | null>(null)
  const ojosVideoRef = useRef<HTMLVideoElement | null>(null)

  // Ensure videos auto-play smoothly whenever entering talking or asustada state
  useEffect(() => {
    if ((state === 'talking' || state === 'capri2') && videoRef.current) {
      videoRef.current.currentTime = 0
      videoRef.current.play().catch(() => {})
    }
    if (state === 'asustada' && asustadaVideoRef.current) {
      asustadaVideoRef.current.currentTime = 0
      asustadaVideoRef.current.muted = true
      asustadaVideoRef.current.volume = 0
      asustadaVideoRef.current.play().catch(() => {})
    }
    if ((state === 'ojos' || state === 'ojos2') && ojosVideoRef.current) {
      ojosVideoRef.current.play().catch(() => {})
    }
  }, [state])

  // Organize assets by state
  const { framesByState, gifsByState, webpsByState } = useMemo(() => {
    const framesMap: Record<string, string[]> = {
      idle: [],
      idle_front: [],
      standing: [],
      walking: [],
      thinking: [],
      working: [],
      happy: [],
      talking: [],
      sleep: [],
      curious: [],
      ojos: [],
      capri2: [],
      closed: [],
      asustada: []
    }

    const gifsMap: Record<string, string> = {}
    const webpsMap: Record<string, string> = {}

    const indexed: Record<string, { index: number; url: string }[]> = {
      idle: [],
      idle_front: [],
      standing: [],
      walking: [],
      thinking: [],
      working: [],
      happy: [],
      talking: [],
      sleep: [],
      curious: [],
      ojos: [],
      capri2: [],
      closed: [],
      asustada: []
    }

    for (const [path, mod] of Object.entries(assetModules)) {
      const modValue = (mod as { default: string }).default

      // Check for frame PNG: ../assets/capri/{state}/frame_{i}.png
      const frameMatch = path.match(/\/capri\/([^/]+)\/frame_(\d+)\.png$/)
      if (frameMatch) {
        const [, st, idxStr] = frameMatch
        if (indexed[st]) {
          indexed[st].push({
            index: parseInt(idxStr, 10),
            url: modValue
          })
        }
        continue
      }

      // Check for standalone PNG: ../assets/capri/{state}/{name}.png
      const singlePngMatch = path.match(/\/capri\/([^/]+)\/([^/]+)\.png$/)
      if (singlePngMatch) {
        const [, st] = singlePngMatch
        if (indexed[st]) {
          indexed[st].push({
            index: 0,
            url: modValue
          })
        }
        continue
      }

      // Check for GIF: ../assets/capri/{state}/{state}.gif
      const gifMatch = path.match(/\/capri\/([^/]+)\/([^/]+)\.gif$/)
      if (gifMatch) {
        const [, st] = gifMatch
        gifsMap[st] = modValue
        continue
      }

      // Check for WebP: ../assets/capri/{state}/{state}.webp
      const webpMatch = path.match(/\/capri\/([^/]+)\/([^/]+)\.webp$/)
      if (webpMatch) {
        const [, st] = webpMatch
        webpsMap[st] = modValue
        continue
      }
    }

    // Sort frames by index
    for (const [st, list] of Object.entries(indexed)) {
      list.sort((a, b) => a.index - b.index)
      framesMap[st] = list.map((item) => item.url)
    }

    return {
      framesByState: framesMap,
      gifsByState: gifsMap,
      webpsByState: webpsMap
    }
  }, [])

  // If thinking or working is requested, map to curious (full-body avatar) so the eye is never shown on desktop
  const effectiveState = (state === 'thinking' || state === 'working') ? 'curious' : state
  const currentFrames = framesByState[effectiveState] || framesByState['idle'] || []
  const currentGif = gifsByState[effectiveState] || gifsByState['idle']
  const currentWebp = webpsByState[effectiveState] || webpsByState['idle']

  // Dynamic FPS based on current state (for frame sequence mode)
  const fps = useMemo(() => {
    switch (effectiveState) {
      case 'walking':
        return isCatchGameActive ? 14 : 9
      case 'talking':
        return 7
      case 'happy':
        return 8
      case 'sleep':
        return 5
      case 'curious':
        return 6
      case 'standing':
        return 8
      case 'ojos':
      case 'ojos2':
        return 7
      case 'capri2':
        return 12
      case 'closed':
        return 8
      case 'asustada':
        return 12
      case 'idle':
      case 'idle_front':
      default:
        return 8
    }
  }, [state, isCatchGameActive])

  // Animation frame loop for frame sequence mode
  useEffect(() => {
    if (renderMode !== 'frames' || currentFrames.length <= 1) return

    const intervalMs = Math.round(1000 / fps)
    const timer = setInterval(() => {
      setCurrentFrameIndex((prev) => (prev + 1) % currentFrames.length)
    }, intervalMs)

    return () => clearInterval(timer)
  }, [currentFrames.length, fps, state, renderMode])

  // Reset frame index on state switch
  useEffect(() => {
    setCurrentFrameIndex(0)
  }, [state, renderMode])

  // Determine active image source
  const currentSrc = useMemo(() => {
    if (effectiveState === 'idle_front') {
      return (renderMode === 'webp' && (currentWebp || capriFrontWebp))
        ? (currentWebp || capriFrontWebp)
        : (capriFrontImg || currentWebp || capriFrontWebp)
    }
    if (renderMode === 'gif' && currentGif) {
      return currentGif
    }
    if (renderMode === 'webp' && currentWebp) {
      return currentWebp
    }
    return currentFrames[currentFrameIndex] || currentFrames[0] || currentGif
  }, [renderMode, currentGif, currentWebp, currentFrames, currentFrameIndex, effectiveState])

  // Glitch transition state & timer for Cyberpunk Edgerunners effect
  const [isGlitching, setIsGlitching] = useState(false)
  const [glitchKey, setGlitchKey] = useState(0)
  const lastStateRef = useRef<CompanionEmotionState>(state)
  const isInitialMount = useRef(true)
  const glitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Trigger horizontal red-green cyber glitch and sound whenever Capri changes avatar
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false
      lastStateRef.current = state
      setIsGlitching(true)
      playAvatarChangeSound()
      glitchTimerRef.current = setTimeout(() => {
        setIsGlitching(false)
      }, 380)
      return
    }

    if (lastStateRef.current !== state) {
      lastStateRef.current = state
      setIsGlitching(true)
      setGlitchKey((prev) => prev + 1)

      // When scared: play glitch sound several times in rapid succession
      if (state === 'asustada') {
        playMultiGlitchSound(5, 180)
      } else {
        // Play avatar change audio & glitch click on every avatar change
        playAvatarChangeSound()
      }

      if (glitchTimerRef.current) clearTimeout(glitchTimerRef.current)
      glitchTimerRef.current = setTimeout(() => {
        setIsGlitching(false)
      }, state === 'asustada' ? 950 : 380)
    }

    return () => {
      if (glitchTimerRef.current) clearTimeout(glitchTimerRef.current)
    }
  }, [state])

  // Hopping between monitors replays the same glitch as she goes and as she re-forms
  const lastHopIdRef = useRef(hopId)
  useEffect(() => {
    if (hopId === lastHopIdRef.current) return
    lastHopIdRef.current = hopId
    setIsGlitching(true)
    setGlitchKey((prev) => prev + 1)
    playAvatarChangeSound()
    if (glitchTimerRef.current) clearTimeout(glitchTimerRef.current)
    glitchTimerRef.current = setTimeout(() => setIsGlitching(false), 380)
  }, [hopId])

  // CSS Animation and styling according to the companion states
  const stateStyle = useMemo(() => {
    if (noShadow) {
      switch (state) {
        case 'walking':
          return {
            filter: 'none',
            transition: 'transform 0.15s ease'
          }
        case 'idle':
        case 'idle_front':
          return {
            animation: 'levitate 3.5s ease-in-out infinite',
            filter: 'none'
          }
        case 'standing':
          return {
            animation: 'levitate 3.0s ease-in-out infinite',
            filter: 'none'
          }
        case 'thinking':
          return {
            animation: 'glitch-pulse 2s infinite',
            filter: 'none'
          }
        case 'working':
          return {
            animation: 'levitate 1.5s ease-in-out infinite',
            filter: 'none'
          }
        case 'happy':
          return {
            animation: 'levitate 2.2s ease-in-out infinite',
            filter: 'none'
          }
        case 'talking':
        case 'capri2':
          return {
            filter: 'none'
          }
        case 'sleep':
          return {
            filter: 'none'
          }
        case 'curious':
          return {
            transform: 'rotate(2.5deg)',
            filter: 'none'
          }
        case 'ojos':
        case 'ojos2':
          return {
            animation: 'glitch-pulse 2.2s infinite',
            filter: 'drop-shadow(0 0 16px rgba(0, 229, 255, 0.85))'
          }
        case 'closed':
          return {
            transform: 'scale(1.06)',
            animation: 'glitch-pulse 0.7s infinite',
            filter: 'none'
          }
        case 'asustada':
          return {
            filter: 'none'
          }
        default:
          return {
            filter: 'none'
          }
      }
    }

    switch (state) {
      case 'walking':
        return {
          filter: isCatchGameActive
            ? 'drop-shadow(0 0 5px rgba(255, 0, 127, 0.95)) drop-shadow(0 0 10px rgba(255, 0, 127, 0.7))'
            : 'drop-shadow(0 0 3px rgba(0, 255, 159, 0.95)) drop-shadow(0 0 7px rgba(0, 255, 159, 0.55))',
          transition: 'transform 0.15s ease'
        }
      case 'idle':
      case 'idle_front':
        return {
          animation: 'levitate 3.5s ease-in-out infinite',
          filter: 'drop-shadow(0 0 3px rgba(0, 255, 159, 0.95)) drop-shadow(0 0 7px rgba(0, 255, 159, 0.55))'
        }
      case 'standing':
        return {
          animation: 'levitate 3.0s ease-in-out infinite',
          filter: 'drop-shadow(0 0 3px rgba(0, 255, 159, 0.95)) drop-shadow(0 0 7px rgba(0, 255, 159, 0.55))'
        }
      case 'thinking':
        return {
          animation: 'glitch-pulse 2s infinite',
          filter: 'drop-shadow(0 0 3px rgba(0, 229, 255, 0.95)) drop-shadow(0 0 8px rgba(0, 229, 255, 0.6))'
        }
      case 'working':
        return {
          animation: 'levitate 1.5s ease-in-out infinite',
          filter: 'drop-shadow(0 0 3px rgba(255, 0, 127, 0.95)) drop-shadow(0 0 8px rgba(255, 0, 127, 0.6))'
        }
      case 'happy':
        return {
          animation: 'levitate 2.2s ease-in-out infinite',
          filter: 'drop-shadow(0 0 3px rgba(255, 190, 11, 0.95)) drop-shadow(0 0 8px rgba(255, 190, 11, 0.6))'
        }
      case 'talking':
      case 'capri2':
        return {
          filter: 'drop-shadow(0 0 3px rgba(0, 240, 255, 0.95)) drop-shadow(0 0 8px rgba(255, 0, 127, 0.75))'
        }
      case 'sleep':
        return {
          filter: 'drop-shadow(0 0 3px rgba(157, 78, 221, 0.95)) drop-shadow(0 0 7px rgba(157, 78, 221, 0.55)) opacity(0.92)'
        }
      case 'curious':
        return {
          transform: 'rotate(2.5deg)',
          filter: 'drop-shadow(0 0 3px rgba(0, 229, 255, 0.95)) drop-shadow(0 0 7px rgba(0, 229, 255, 0.55))'
        }
      case 'ojos':
      case 'ojos2':
        return {
          animation: 'glitch-pulse 2.5s infinite',
          filter: 'drop-shadow(0 0 4px rgba(0, 229, 255, 0.95)) drop-shadow(0 0 10px rgba(0, 229, 255, 0.75))'
        }
      case 'closed':
        return {
          transform: 'scale(1.06)',
          animation: 'glitch-pulse 0.7s infinite',
          filter: 'drop-shadow(0 0 4px rgba(255, 0, 80, 0.95)) drop-shadow(0 0 10px rgba(255, 0, 127, 0.75))'
        }
      case 'asustada':
        return {
          filter: 'drop-shadow(0 0 4px rgba(255, 0, 80, 0.95)) drop-shadow(0 0 10px rgba(255, 0, 127, 0.75))',
          animation: 'glitch-pulse 0.4s infinite'
        }
      default:
        return {}
    }
  }, [state, isCatchGameActive, noShadow])

  return (
    <div
      onClick={onClick}
      data-capri-art
      className={`relative inline-flex items-center justify-center cursor-pointer select-none ${className}`}
      style={{
        width: '100%',
        height: '100%',
        WebkitAppRegion: 'no-drag',
        // Hopping to another monitor: she dissolves, then re-forms on the other side
        opacity: hop === 'out' ? 0 : 1,
        transition: 'opacity 0.22s ease'
      } as React.CSSProperties}
      title={isCatchGameActive ? localizeLine('CLICK TO CATCH CAPRICORN!', getLineLanguage()) : 'Capricorn // Shift+Drag to move | Click for Dev Deck | Ctrl+Click to chat'}
    >
      {/* Background Cyber Glow Rings only during Catch Game (never on hover) */}
      {!noShadow && isCatchGameActive && (
        <div
          className="absolute inset-4 rounded-full pointer-events-none transition-all duration-300 animate-ping"
          style={{
            background: 'radial-gradient(circle, rgba(255, 0, 127, 0.4) 0%, rgba(255, 190, 11, 0.3) 60%, transparent 75%)',
            boxShadow: '0 0 35px rgba(255, 0, 127, 0.8)',
            filter: 'blur(4px)'
          }}
        />
      )}

      {/* Character Video (Capri2 - Trim.mp4) whenever in talking or capri2 state */}
      {state === 'talking' || state === 'capri2' ? (
        <div
          className={`relative w-full h-full flex items-center justify-center overflow-visible ${isGamingMode ? 'aspect-video' : ''}`}
          style={{
            // User requirement: "que el modo de hablar y el ojo no se espejen cuando aparecen"
            transform: 'scaleX(1)',
            transition: 'transform 0.15s ease'
          }}
        >
          <video
            ref={videoRef}
            key="capri2-trim-video"
            src={capri2TrimVideo}
            autoPlay
            loop
            muted
            playsInline
            className={`w-full h-full ${isGamingMode ? 'object-cover rounded-xl' : 'object-contain rounded-2xl max-h-[88%] max-w-[88%]'} pointer-events-none select-none ${isGlitching ? 'capri-silhouette-slice-a' : ''}`}
            style={{
              ...stateStyle,
              animation: isGlitching ? undefined : stateStyle.animation,
              filter: noShadow ? 'none' : 'drop-shadow(0 0 3px rgba(0, 240, 255, 0.95)) drop-shadow(0 0 8px rgba(255, 0, 127, 0.75))'
            }}
          />

          {/* Cyberpunk HUD Frame overlay (Horizontal in Gaming Mode, Portrait on Desktop) */}
          <img
            src={isGamingMode ? capriFrameHorizontalImg : capriFrameImg}
            alt="cyber-frame"
            draggable={false}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none z-20"
            style={{
              filter: 'drop-shadow(0 0 4px rgba(0, 255, 159, 0.85)) drop-shadow(0 0 10px rgba(0, 240, 255, 0.45))'
            }}
          />
        </div>
      ) : state === 'asustada' ? (
        <div
          className="relative w-full h-full flex items-center justify-center overflow-visible"
          style={{
            // Asustada animation with capri asustada.mp4 (without HUD frame)
            transform: 'scaleX(1)',
            transition: 'transform 0.15s ease'
          }}
        >
          <video
            ref={asustadaVideoRef}
            key="capri-asustada-video"
            src={capriAsustadaVideo}
            autoPlay
            loop
            muted
            playsInline
            className={`w-full h-full object-cover pointer-events-none select-none rounded-2xl max-h-[92%] max-w-[92%] ${isGlitching ? 'capri-silhouette-slice-a' : ''}`}
            style={{
              ...stateStyle,
              animation: isGlitching ? undefined : stateStyle.animation,
              filter: noShadow ? 'none' : 'drop-shadow(0 0 3px rgba(255, 0, 80, 0.95)) drop-shadow(0 0 8px rgba(255, 0, 127, 0.75))'
            }}
          />
        </div>
      ) : state === 'ojos2' || (state === 'ojos' && isGamingMode) ? (
        <div
          className="relative w-full h-full flex items-center justify-center overflow-visible aspect-video"
          style={{
            transform: 'scaleX(1)',
            transition: 'transform 0.15s ease'
          }}
        >
          <video
            ref={ojosVideoRef}
            key="capri-ojos2-video"
            src={ojos2Video}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            className={`w-full h-full object-contain pointer-events-none select-none rounded-xl ${isGlitching ? 'capri-silhouette-slice-a' : ''}`}
            style={{
              ...stateStyle,
              animation: isGlitching ? undefined : stateStyle.animation,
              filter: noShadow ? 'none' : 'drop-shadow(0 0 4px rgba(0, 229, 255, 0.95)) drop-shadow(0 0 10px rgba(0, 229, 255, 0.75))'
            }}
          />

          {/* Cyberpunk HUD Horizontal Frame overlay matching exact size of eyes clip (16:9) */}
          <img
            src={capriFrameHorizontalImg}
            alt="cyber-frame"
            draggable={false}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none z-20"
            style={{
              filter: 'drop-shadow(0 0 4px rgba(0, 255, 159, 0.85)) drop-shadow(0 0 10px rgba(0, 240, 255, 0.45))'
            }}
          />
        </div>
      ) : currentSrc ? (
        <div
          className="relative w-full h-full flex items-center justify-center overflow-visible"
          style={{
            // User requirement: "que el modo de hablar y el ojo no se espejen cuando aparecen"
            // idle_front, closed (red eye) and ojos (single black eye) must not flip horizontally
            transform: (state !== 'idle_front' && state !== 'closed' && state !== 'ojos' && direction === 'right') ? 'scaleX(-1)' : 'scaleX(1)',
            transition: 'transform 0.15s ease'
          }}
        >
          {/* Red Silhouette Razor Ghost: Projecting left with sharp slices */}
          {isGlitching && (
            <img
              key={`glitch-red-${glitchKey}`}
              src={currentSrc}
              alt="glitch-red"
              draggable={false}
              className="capri-silhouette-layer capri-silhouette-red"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain'
              }}
            />
          )}

          {/* Green Silhouette Razor Ghost: Projecting right with sharp slices */}
          {isGlitching && (
            <img
              key={`glitch-green-${glitchKey}`}
              src={currentSrc}
              alt="glitch-green"
              draggable={false}
              className="capri-silhouette-layer capri-silhouette-green"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain'
              }}
            />
          )}

          {/* Counter-slice B: PNG deformed and severed with knife cuts shifting right */}
          {isGlitching && (
            <img
              key={`glitch-slice-b-${glitchKey}`}
              src={currentSrc}
              alt="glitch-slice-b"
              draggable={false}
              className="capri-silhouette-slice-b"
              style={{
                ...stateStyle,
                animation: undefined,
                width: '100%',
                height: '100%',
                objectFit: 'contain'
              }}
            />
          )}

          {/* Base Character Image: Clean full-body sprite in pet mode */}
          <img
            key={`${state}-${renderMode}-${glitchKey}`}
            src={currentSrc}
            alt={`Capri (${state})`}
            draggable={false}
            className={isGlitching ? 'capri-silhouette-slice-a' : ''}
            style={{
              ...stateStyle,
              animation: isGlitching ? undefined : stateStyle.animation,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              pointerEvents: 'none',
              userSelect: 'none'
            }}
          />
        </div>
      ) : (
        <div className="text-xs text-pink-400 font-mono p-4 text-center">
          [Loading Capri...]
        </div>
      )}
    </div>
  )
}
