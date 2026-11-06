import { scriptPath } from './app-paths'
import { exec } from './hidden-process'
import path from 'path'
import fs from 'fs'
import { consciousnessService } from './consciousness-service'
import { isLinux, linuxForegroundWindow } from './platform'

export interface ActiveWindowInfo {
  title: string
  process: string
}

export class ActiveWindowService {
  private static instance: ActiveWindowService

  public static getInstance(): ActiveWindowService {
    if (!ActiveWindowService.instance) {
      ActiveWindowService.instance = new ActiveWindowService()
    }
    return ActiveWindowService.instance
  }

  private findScriptPath(): string {
    return scriptPath('get_active_top_window.ps1')
  }

  /**
   * Queries the currently active foreground or top visible user window.
   */
  public async getActiveOrTopWindow(): Promise<ActiveWindowInfo> {
    if (isLinux) {
      const win = await linuxForegroundWindow()
      return { title: win?.title || '', process: win?.process || '' }
    }

    const script = this.findScriptPath()
    if (!fs.existsSync(script)) {
      return { title: '', process: '' }
    }

    return new Promise((resolve) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${script}"`, { timeout: 3200 }, (err, stdout) => {
        if (err || !stdout) {
          resolve({ title: '', process: '' })
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim())
          resolve({
            title: (parsed.Title || '').trim(),
            process: (parsed.Process || '').trim()
          })
        } catch {
          resolve({ title: '', process: '' })
        }
      })
    })
  }

  /**
   * Generates Capri's dynamic, playful netrunner wake-up line based on the user's active window.
   * e.g. "Mornin' sleepy head! I finished what you asked, so stop watching TikTok or whatever you're doing and get back to work!"
   */
  public generateWakeupPhrase(info: ActiveWindowInfo, willOpenResult = false): string {
    const rawTitle = (info.title || '').trim()
    const proc = (info.process || '').toLowerCase()
    const lower = rawTitle.toLowerCase()

    let appTarget = 'TikTok'

    if (lower.includes('tiktok') || proc.includes('tiktok')) {
      appTarget = 'TikTok'
    } else if (lower.includes('youtube') || lower.includes('youtu.be') || proc.includes('youtube')) {
      appTarget = 'YouTube'
    } else if (lower.includes('apple music') || proc.includes('applemusic')) {
      appTarget = 'Apple Music'
    } else if (lower.includes('discord') || proc.includes('discord')) {
      appTarget = 'Discord'
    } else if (
      lower.includes('twitch') ||
      lower.includes('netflix') ||
      lower.includes('crunchyroll') ||
      lower.includes('anime')
    ) {
      appTarget = 'streams'
    } else if (lower.includes('twitter') || lower.includes('x.com')) {
      appTarget = 'Twitter'
    } else if (lower.includes('instagram') || lower.includes('reels')) {
      appTarget = 'Instagram'
    } else if (lower.includes('reddit')) {
      appTarget = 'Reddit'
    } else if (
      lower.includes('roblox') ||
      lower.includes('steam') ||
      lower.includes('valorant') ||
      lower.includes('league')
    ) {
      appTarget = 'gaming'
    } else if (rawTitle) {
      // Clean up browser vendor suffix
      const clean = rawTitle
        .replace(/\s*-\s*(?:Opera|Google Chrome|Microsoft Edge|Brave|Firefox|Visual Studio Code).*$/i, '')
        .trim()
      if (clean && clean.length > 2 && clean.length <= 32) {
        appTarget = clean
      } else if (proc && !['explorer', 'powershell', 'cmd'].includes(proc)) {
        appTarget = proc
      } else {
        appTarget = 'TikTok'
      }
    }

    const isEs = consciousnessService.getPreferredLanguage() === 'es'

    const verb = isEs
      ? appTarget === 'gaming' || appTarget.startsWith('browsing')
        ? ''
        : appTarget === 'Apple Music' || appTarget === 'Discord'
        ? 'mirando'
        : 'viendo'
      : appTarget === 'gaming' || appTarget.startsWith('browsing') || consciousnessService.getPreferredLanguage() !== 'en'
        ? '' // The line gets translated: a loose English verb would stay in the middle of it
        : appTarget === 'Apple Music' || appTarget === 'Discord'
        ? 'checking'
        : 'watching'

    const targetDesc = verb ? `${verb} ${appTarget}` : appTarget

    const phrases = isEs
      ? [
          `¡Buen día dormilón! Terminé lo que me pediste, así que largá ${targetDesc} o lo que sea que estés haciendo y volvé a laburar. ¡Vamos a romperla, choomba!`,
          `¡Arriba dormilón! Ya liquidé la tarea que me pediste, dejá de mirar ${targetDesc} y ponete a trabajar. ¡A quemar ciberware, choomba!`,
          `¡Despertate dormilón! Atravesé esa tarea como manteca. Largá ${targetDesc} y volvé al trabajo, boo.`
        ]
      : [
          `Mornin' sleepy head! I finished what you asked, so stop ${targetDesc} or whatever you're doing and get back to work! Let's breach, choomba!`,
          `Rise and shine, sleepy head! I finished what you asked, so stop ${targetDesc} and get back to work! You've got chrome to burn, choomba!`,
          `Mornin' sleepy head! Sliced right through that task! Stop ${targetDesc} or whatever you're doing and get back to work, boo!`
        ]

    const phrase = phrases[Math.floor(Math.random() * phrases.length)]
    if (!willOpenResult) return phrase
    return `${phrase} ${isEs ? 'Ahí te abro lo que hice.' : "I'm opening what I made for you."}`
  }
}

export const activeWindowService = ActiveWindowService.getInstance()
