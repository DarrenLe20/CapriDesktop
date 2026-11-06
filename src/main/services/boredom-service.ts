import { shell } from 'electron'
import { localizeLine } from '../../shared/lines'
import { agentManager } from '../agents/agent-manager'
import { scannerService } from './scanner-service'
import { consciousnessService } from './consciousness-service'
import { ToolExecutor } from '../agents/tools/tool-executor'
import { windowManager } from '../windows/window-manager'
import { cyberpunkAdapter, lolLiveAdapter } from './game'
import { roamingManager } from '../roaming/roaming-manager'
import { presenceService } from './presence-service'

/** Before putting music or a video on by herself, she bets on it with a game of tag (at most every 45 minutes) */
const DEAL_GAP_MS = 45 * 60 * 1000
// English: lines are translated on their way out
const DEAL_MUSIC_LINES_EN = ['Bored! Wanna play tag? Click me to start. Catch me and you pick the music, lose and I pick.', 'Deal time! Click me and chase me across the screens. You win, you pick the song.']
const DEAL_VIDEO_LINES_EN = ['Bored! Wanna play tag? Click me to start. Catch me and you pick what we watch, lose and I pick.', 'Deal time! Click me and chase me across the screens. You win, you pick the video.']
const DEAL_IGNORED_LINES_EN = ['Details! Never mind.', 'Eh, whatever. Maybe later.']
const DEAL_USER_WON_LINES_EN = ['Okay, okay, you win! Your pick. Just tell me what you want.', 'Caught fair and square. Your call, choom.']
const DEAL_CAPRI_WON_LINES_EN = ['Too slow! My pick.', 'Game over! I pick.']

const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]

interface BoredomActionConfig {
  category: 'apple_music' | 'youtube' | 'web_search'
  target: string
  phrasesEs: string[]
  phrasesEn: string[]
}

// Real songs, artist and title: each one is looked up and played on Apple Music
const APPLE_MUSIC_SONGS = [
  'P.T. Adamczyk - The Rebel Path',
  'Rezodrone - Resist and Disorder',
  'Rosa Walton - I Really Want to Stay at Your House',
  'Hyper Spoiler',
  'Daft Punk - Harder Better Faster Stronger',
  'Gorillaz - Feel Good Inc',
  'Charly Garcia - Demoliendo Hoteles',
  'Duki - She Don\'t Give a FO',
  'Skrillex - Scary Monsters and Nice Sprites',
  'Kavinsky - Nightcall',
  'Carpenter Brut - Turbo Killer',
  'The Midnight - Los Angeles',
  'Kenshi Yonezu - KICK BACK',
  'Soda Stereo - De Musica Ligera'
]

const YOUTUBE_SEARCHES = [
  'Cyberpunk 2077 Edgerunners best scenes',
  'Cool robotics and cyberware tech',
  'Insane tech hacks that look like magic',
  'Crazy anime fight scenes 4k',
  'Synthwave visualizer neon animation',
  'Hilarious computer glitches speedruns',
  'Boston Dynamics robots parkour',
  'Night City ambiance 4k'
]

const WEB_SEARCHES = [
  'the strangest scientific discoveries in the world',
  'cyberpunk aesthetics wallpaper 4k',
  'quantum computing breakthroughs',
  'unsolved internet mysteries',
  'crazy programmer projects on github',
  'funniest technology conspiracy theories'
]

export class BoredomService {
  private static instance: BoredomService
  private timer: NodeJS.Timeout | null = null
  private isRunning = false
  private lastTriggeredTime = 0
  private lastDealAt = 0
  private minCooldownMs = 8 * 60 * 1000 // At least 8 minutes between autonomous boredom actions
  private gamingModeUnsub: (() => void) | null = null

  public static getInstance(): BoredomService {
    if (!BoredomService.instance) {
      BoredomService.instance = new BoredomService()
    }
    return BoredomService.instance
  }

  public start(): void {
    if (this.isRunning) return

    // Never start if already in Gaming Mode or in an active game
    if (windowManager.isGamingModeActive() || cyberpunkAdapter?.isCyberpunkActive() || lolLiveAdapter?.isRunning()) {
      console.log('[BoredomService] Game or Gaming Mode currently active -> Boredom engine remains frozen.')
      this.lastTriggeredTime = Date.now()
      return
    }

    this.isRunning = true
    this.lastTriggeredTime = Date.now()

    if (!this.gamingModeUnsub) {
      this.gamingModeUnsub = windowManager.onGamingModeChanged((isGaming) => {
        if (isGaming) {
          console.log('[BoredomService] Gaming Mode engaged -> Freezing boredom engine completely.')
          this.stop()
        } else {
          console.log('[BoredomService] Gaming Mode disengaged -> Restarting boredom cooldown.')
          this.lastTriggeredTime = Date.now()
          this.start()
        }
      })
    }

    // Initial wait of 4 to 8 minutes after app boot before first boredom check
    const initialDelay = (4 + Math.random() * 4) * 60 * 1000
    this.scheduleNextTick(initialDelay)
    console.log(`[BoredomService] Started. First boredom check in ${Math.round(initialDelay / 60000)} minutes.`)
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.isRunning = false
    this.lastTriggeredTime = Date.now() // Freeze boredom level so it never accumulates during pause!
  }

  private scheduleNextTick(delayMs?: number): void {
    if (!this.isRunning) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    // Interval between 12 and 22 minutes (randomized)
    const nextInterval = delayMs ?? ((12 + Math.random() * 10) * 60 * 1000)
    this.timer = setTimeout(() => {
      this.tick()
    }, nextInterval)
  }

  private async tick(): Promise<void> {
    if (!this.isRunning) return

    // If gaming mode or active games are detected, DO not trigger and keep boredom AT zero
    if (windowManager.isGamingModeActive() || cyberpunkAdapter?.isCyberpunkActive() || lolLiveAdapter?.isRunning()) {
      this.lastTriggeredTime = Date.now()
      this.scheduleNextTick(15 * 60 * 1000)
      return
    }

    try {
      if (this.canTriggerAutonomous()) {
        await this.triggerBoredomAction()
      }
    } catch (err) {
      console.warn('[BoredomService] Tick warning:', err)
    } finally {
      this.scheduleNextTick()
    }
  }

  public canTriggerAutonomous(): boolean {
    if (!this.isRunning || !consciousnessService.isBoredomEnabled()) return false

    // Never interrupt active chat or executing tool tasks
    if (agentManager.getStatus().isRunning) {
      return false
    }

    // Never interrupt scanner mode
    if (scannerService.getStatus().isOpen) {
      return false
    }

    // Never interrupt sleep state
    if (agentManager.getCompanionState() === 'sleep') {
      return false
    }

    // Strictly forbidden in Gaming Mode (playing Cyberpunk or League or gaming mode active)
    if (windowManager.isGamingModeActive()) {
      return false
    }

    if (cyberpunkAdapter?.isCyberpunkActive() || lolLiveAdapter?.isRunning()) {
      return false
    }

    // Cooldown check
    const now = Date.now()
    if (now - this.lastTriggeredTime < this.minCooldownMs) {
      return false
    }

    return true
  }

  /**
   * Triggers an autonomous boredom action:
   * Capri complains that she is bored, announces what she is doing,
   * and opens a tab / plays a song / searches the web!
   */
  /**
   * Instead of just putting something on, she offers tag: click her to start the chase. Catch her and the user
   * picks, lose and she does what she meant to. Ignoring her costs nothing: she shrugs and does nothing.
   */
  private offerDeal(category: 'apple_music' | 'youtube'): boolean {
    if (Date.now() - this.lastDealAt < DEAL_GAP_MS || !presenceService.canActNow('speak')) return false
    const offered = roamingManager.offerTag((result) => {
      if (result === 'ignored') {
        agentManager.setCompanionSpeech(pick(DEAL_IGNORED_LINES_EN), 3000, false)
      } else if (result === 'caught') {
        agentManager.setCompanionSpeech(pick(DEAL_USER_WON_LINES_EN), 4500, true)
      } else {
        agentManager.setCompanionSpeech(pick(DEAL_CAPRI_WON_LINES_EN), 3000, true)
        setTimeout(() => void this.triggerBoredomAction(category), 3200)
      }
    })
    if (!offered) return false
    this.lastDealAt = Date.now()
    presenceService.noteLine()
    agentManager.setCompanionState('happy')
    agentManager.setCompanionSpeech(pick(category === 'apple_music' ? DEAL_MUSIC_LINES_EN : DEAL_VIDEO_LINES_EN), 6000, true)
    return true
  }

  public async triggerBoredomAction(forcedCategory?: 'apple_music' | 'youtube' | 'web_search'): Promise<boolean> {
    if (windowManager.isGamingModeActive()) {
      return false
    }

    if (cyberpunkAdapter?.isCyberpunkActive() || lolLiveAdapter?.isRunning()) {
      return false
    }

    const isEs = consciousnessService.getPreferredLanguage() === 'es'

    // Pick category: 35% Apple Music, 35% YouTube, 30% Web Search
    const category: 'apple_music' | 'youtube' | 'web_search' = forcedCategory ?? (() => {
      const r = Math.random()
      if (r < 0.35) return 'apple_music'
      if (r < 0.70) return 'youtube'
      return 'web_search'
    })()

    this.lastTriggeredTime = Date.now()

    // Music and videos start with a bet (a category picked from the deck is just done)
    if (!forcedCategory && category !== 'web_search' && this.offerDeal(category)) return true

    if (category === 'apple_music') {
      const song = APPLE_MUSIC_SONGS[Math.floor(Math.random() * APPLE_MUSIC_SONGS.length)]
      const phrasesEs = [
        `¡Uff, qué embole, {name}! Estoy re aburrida de estar acá quieta... Pará que pongo "${song}" en Apple Music para levantar la onda.`,
        `Me aburrí de este silencio mortal, choomba... Hackeando Apple Music ya mismo, te pongo "${song}" bien arriba.`,
        `¡Qué embole mal! No me aguanto las ganas de escuchar música, mandando "${song}" a Apple Music ahora mismo.`
      ]
      const phrasesEn = [
        `Uff, so bored, {name}! I'm completely bored just standing around... Hold up, throwing "${song}" on Apple Music to hype up the vibe!`,
        `Silence is killing me, choomba... Jacking into Apple Music right now, putting on "${song}"!`
      ]
      const speech = isEs ? phrasesEs[Math.floor(Math.random() * phrasesEs.length)] : phrasesEn[Math.floor(Math.random() * phrasesEn.length)]

      agentManager.setCompanionState('talking')
      agentManager.setCompanionSpeech(speech, 5000, true, `{name} was quiet and you got bored, so you put "${song}" on Apple Music. Nobody asked: you picked it yourself because you like it`)

      setTimeout(async () => {
        try {
          await ToolExecutor.execute(
            'open_application',
            { appOrUrl: 'apple_music', query: song, isChange: true },
            ''
          )
        } catch (e) {
          console.warn('[BoredomService] Apple Music error:', e)
        }
        agentManager.setCompanionState('happy')
      }, 1800)

      return true
    }

    if (category === 'youtube') {
      const query = YOUTUBE_SEARCHES[Math.floor(Math.random() * YOUTUBE_SEARCHES.length)]
      const phrasesEs = [
        `¡Che, {name}, me pudrí del aburrimiento! Voy a abrir YouTube a buscar "${query}" para mirar un toque.`,
        `Estoy recontra aburrida... A ver qué hay de copado en YouTube, abriendo una pestaña ya mismo, mirá esto.`,
        `Uff, qué embole... Dejame que te busque un video piola en la Red sobre "${query}", ¡no te quedes dormido, choomba!`
      ]
      const phrasesEn = [
        `Hey {name}, I'm dying of boredom! Opening up YouTube to look up "${query}" for a sec!`,
        `So bored just waiting around... Let's see what's on YouTube, opening up a tab for "${query}" right now!`
      ]
      const speech = isEs ? phrasesEs[Math.floor(Math.random() * phrasesEs.length)] : phrasesEn[Math.floor(Math.random() * phrasesEn.length)]

      agentManager.setCompanionState('talking')
      agentManager.setCompanionSpeech(speech, 5000, true, `{name} was quiet and you got bored, so you opened YouTube and searched "${query}". Nobody asked: it caught your curiosity`)

      setTimeout(async () => {
        try {
          const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
          await shell.openExternal(url)
        } catch (e) {
          console.warn('[BoredomService] YouTube open error:', e)
        }
        agentManager.setCompanionState('curious')
      }, 1800)

      return true
    }

    // Web Search
    const webQuery = localizeLine(WEB_SEARCHES[Math.floor(Math.random() * WEB_SEARCHES.length)], consciousnessService.getPreferredLanguage())
    const phrasesEs = [
      `¡Uff, qué embole! Me puse a escanear la Red de puro aburrimiento y encontré algo que tenés que ver, abriendo pestaña...`,
      `Estoy re aburrida, {name}... Mirá lo que me puse a googlear en la Red, no me juzgues que una netrunner siempre tiene curiosidad.`,
      `Me aburrí de mirar las paredes del escritorio... Hackeando el navegador para buscar "${webQuery}", ¡mirá esto!`
    ]
    const phrasesEn = [
      `Uff, total boredom! I started scanning the Net out of sheer boredom and found something curious, opening a tab...`,
      `I'm super bored, {name}... Look at what I just searched on the Net, don't judge a curious netrunner!`
    ]
    const speech = isEs ? phrasesEs[Math.floor(Math.random() * phrasesEs.length)] : phrasesEn[Math.floor(Math.random() * phrasesEn.length)]

    agentManager.setCompanionState('talking')
    agentManager.setCompanionSpeech(speech, 5000, true, `{name} was quiet and you got bored, so you searched "${webQuery}" on the Net. Nobody asked: it caught your curiosity`)

    setTimeout(async () => {
      try {
        const url = `https://www.google.com/search?q=${encodeURIComponent(webQuery)}`
        await shell.openExternal(url)
      } catch (e) {
        console.warn('[BoredomService] Web search error:', e)
      }
      agentManager.setCompanionState('working')
    }, 1800)

    return true
  }
}

export const boredomService = BoredomService.getInstance()
