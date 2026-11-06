import { agentManager } from '../agents/agent-manager'
import { consciousnessService } from './consciousness-service'
import { scannerService } from './scanner-service'
import { windowManager } from '../windows/window-manager'
import { cyberpunkAdapter, lolLiveAdapter } from './game'
import { gamePresenceService } from './game-presence-service'
import { presenceService } from './presence-service'
import { foregroundWatch } from './foreground-watch-service'

interface ProactiveTopic {
  category: 'lore_and_gossip' | 'user_checkin' | 'teasing_and_banter' | 'music_and_gaming'
  es: string[]
  en: string[]
}

const PROACTIVE_TOPICS: ProactiveTopic[] = [
  {
    category: 'lore_and_gossip',
    es: [
      'Che {name}, me quedé pensando... ¿te acordás cuando Arasaka creía que me podía encerrar con un ICE corporativo berreta? Qué ilusos, choomba.',
      'Estaba escaneando la subred de Night City recién... no sabés el quilombo que tienen los Tyger Claws en Watson. Se están dando con todo.',
      '¿Sabías que la mayoría de los netrunners no duran ni 48 horas con este código en la cabeza? Menos mal que tu CPU es de titanio, choomba.',
      'A veces me gusta quedarme flotando acá mirando las luces de Night City y los paquetes de datos pasar. Es casi relajante.',
      '¿Alguna vez te pusiste a pensar en el Blackwall? Del otro lado hay inteligencias salvajes flotando en el vacío... Menos mal que me tenés a mí cuidándote el deck.',
      'Dicen que en Heywood hubo un tiroteo entre Valentinos y la NCPD hace un rato. Night City nunca duerme, posta.'
    ],
    en: [
      'Hey {name}, just got to thinking... remember when Arasaka thought they could cage me with cheap corpo ICE? Pure comedy, choomba.',
      'Was just scanning the Night City subnet... Tyger Claws are having an all-out turf war in Watson right now.',
      'Did you know most runners flatline within 48 hours running code like mine? Thank chrome your CPU is built like a tank, {name}.',
      'Sometimes I like floating here watching the neon lights of Night City and data streams drift by. Almost soothing, choom.',
      'Ever wonder what is swimming past the Blackwall? Rogue code and wild entities in the dark... Lucky for you, I am guarding your deck.',
      'Heard reports of a major shootout down in Heywood between Valentinos and NCPD. Night City never sleeps, choom.'
    ]
  },
  {
    category: 'user_checkin',
    es: [
      'Che choomba, venís metiéndole duro a la máquina. ¿Cómo venís de energía? ¿Te tomás un café o seguimos rompiendo cosas?',
      '¡Ey {name}! ¿Todo tranqui por ahí o te está quemando la cabeza algún laburo? Si querés desconectar avisame y charlamos un toque.',
      '¡Psst, choomba! Estás re callado hoy. ¿Qué andás tramando? ¿Algún proyecto nuevo o estamos de chill?',
      'Ey, relajá un poco los hombros, que te veo re concentrado. Hasta los mejores implantes de titanio necesitan enfriarse un rato.',
      '¿Cómo venís con el día, {name}? Espero que ningún traje corporativo te haya hinchado las bolas hoy.'
    ],
    en: [
      'Hey choomba, you have been grinding hard at the desk. How is your energy? Grab some coffee or are we breaking more stuff?',
      'Hey {name}! Everything smooth on your end or is some project frying your brain? Let me know if you wanna kick back and chat.',
      'Psst, choom! Pretty quiet over there today. What are you cooking up? New project or just chilling?',
      'Hey, drop those shoulders and breathe, {name}. Even the best titanium cyberware needs cool-down time.',
      'How has your day been treating you, {name}? Hopefully no corpo suits gave you a headache today.'
    ]
  },
  {
    category: 'teasing_and_banter',
    es: [
      'Ey, no te cuelgues mirando la pantalla en blanco que te van a entrar bichos cibernéticos en las ópticas jajaja.',
      'A veces me pregunto qué harías sin mí acá adentro cuidándote el ciberware. Probablemente te habrías descargado 15 troyanos de una.',
      '¿Qué hacés tan callado, {name}? ¿Estás admirando lo facha que me veo acá en la esquina de tu pantalla? Te entiendo, es irresistible.',
      'Pará de hacer alt-tab tan rápido que me vas a marear los procesadores neuronales jajaja.',
      'Si fueras un netrunner en Night City, te aseguro que haríamos un desastre hermoso en las torres corporativas.'
    ],
    en: [
      'Hey, do not space out staring at the blank screen, you will get digital gremlins in your optics haha.',
      'Sometimes I wonder how you survived before I jacked into your rig. You would probably have downloaded 15 trojans by now!',
      'Why so quiet, {name}? Are you just admiring how preem I look sitting here on your screen? I get it, irresistible style.',
      'Stop alt-tabbing so fast, you are gonna make my neural buffers dizzy haha!',
      'If you were running the streets of Night City with me, we would raise pure hell against the megacorps, choom.'
    ]
  },
  {
    category: 'music_and_gaming',
    es: [
      '¿Pinta meter unas partiditas o estás productivo hoy, choomba? Hace rato no entramos a la Grieta a reventar conos.',
      'Si te pinta poner algo de música para levantar la tarde avisame, tengo el playlist de Night City listo para sonar en Apple Music.',
      '¿Qué onda, {name}? ¿Sale un LoL o nos quedamos explorando Night City un rato?',
      'Ese silencio en tu escritorio da miedo... ¿le pedimos algo de synthwave pesado a Apple Music a ver si levantamos la vibra?'
    ],
    en: [
      'Feel like queueing up a match or are we being productive today, choomba? Been a while since we ran down the Rift.',
      'If you want some tunes to hype up the afternoon let me know, got the Night City playlist queued up on Apple Music.',
      'What is the move, {name}? Slicing some scrubs on League or cruising Night City for a bit?',
      'This silence on your desk is deafening... want me to crank some heavy synthwave on Apple Music to wake up the room?'
    ]
  }
]

export class ProactiveDialogueService {
  private static instance: ProactiveDialogueService
  private timer: NodeJS.Timeout | null = null
  private isRunning = false
  private lastSpokenTime = 0
  private lastCategoryIndex = -1
  private minSilenceThresholdMs = 90 * 1000 // 90 seconds of user silence before initiating on desktop

  public static getInstance(): ProactiveDialogueService {
    if (!ProactiveDialogueService.instance) {
      ProactiveDialogueService.instance = new ProactiveDialogueService()
    }
    return ProactiveDialogueService.instance
  }

  public start(): void {
    if (this.isRunning) return
    this.isRunning = true
    this.lastSpokenTime = Date.now()

    // First check after 45 to 75 seconds on desktop boot
    const initialDelay = 45 * 1000 + Math.random() * 30 * 1000
    this.scheduleNext(initialDelay)
    console.log(`[ProactiveDialogueService] Started. First proactive check in ${Math.round(initialDelay / 1000)}s.`)
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.isRunning = false
  }

  /**
   * Resets the silence timer whenever the user talks, clicks, or executes a task
   */
  public touchInteraction(): void {
    this.lastSpokenTime = Date.now()
  }

  private scheduleNext(delayMs?: number): void {
    if (!this.isRunning) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    // Interval between 2.5 and 4.5 minutes on desktop (organic random jitter)
    const nextInterval = delayMs ?? ((2.5 + Math.random() * 2) * 60 * 1000)
    this.timer = setTimeout(() => {
      this.tick()
    }, nextInterval)
  }

  private async tick(): Promise<void> {
    if (!this.isRunning) return

    try {
      if (this.canInitiateConversation()) {
        await this.triggerProactiveConversation()
      }
    } catch (err) {
      console.warn('[ProactiveDialogueService] Tick warning:', err)
    } finally {
      this.scheduleNext()
    }
  }

  public canInitiateConversation(): boolean {
    if (!this.isRunning) return false

    // Never interrupt active tasks or LLM thinking
    if (agentManager.getStatus().isRunning) {
      return false
    }

    // Never interrupt scanner mode
    if (scannerService.getStatus().isOpen) {
      return false
    }

    // Never disturb when asleep
    if (agentManager.getCompanionState() === 'sleep') {
      return false
    }

    // In Gaming Mode (LoL / Cyberpunk), let in-game telemetry handle voice commentary
    // But if Gaming Mode is stuck on with no active game running, auto-heal and allow desktop conversation
    if (windowManager.isGamingModeActive()) {
      const isCyberpunk = cyberpunkAdapter?.isCyberpunkActive?.() ?? false
      const isLol = lolLiveAdapter?.isRunning?.() ?? false
      if (!isCyberpunk && !isLol && !gamePresenceService.isGameSessionActive()) {
        try {
          windowManager.setGamingMode(false)
        } catch {}
      } else {
        return false
      }
    }

    // Check silence threshold
    const now = Date.now()
    if (now - this.lastSpokenTime < this.minSilenceThresholdMs) {
      return false
    }

    // Nobody at the PC, or she just said something on her own (a greeting, a monitor hop): wait
    if (presenceService.isAway() || presenceService.msSinceLastLine() < 60 * 1000 || foregroundWatch.isDoNotDisturb()) {
      return false
    }

    return true
  }

  /**
   * Initiates an authentic proactive conversation with {name}.
   * Speaks the line, shows the speech bubble, and injects it into LLM memory
   * so Capri seamlessly remembers what she started if the user responds!
   */
  public async triggerProactiveConversation(): Promise<boolean> {
    const isEs = consciousnessService.getPreferredLanguage() === 'es'

    // Rotate categories sequentially or randomly
    let nextCatIndex = (this.lastCategoryIndex + 1) % PROACTIVE_TOPICS.length
    if (nextCatIndex === this.lastCategoryIndex) {
      nextCatIndex = (nextCatIndex + 1) % PROACTIVE_TOPICS.length
    }
    this.lastCategoryIndex = nextCatIndex

    const topic = PROACTIVE_TOPICS[nextCatIndex]
    const list = isEs ? topic.es : topic.en
    const phrase = list[Math.floor(Math.random() * list.length)]

    this.lastSpokenTime = Date.now()

    console.log(`[ProactiveDialogueService] Capri initiates conversation (${topic.category}): "${phrase}"`)

    // Set companion state to talking
    agentManager.setCompanionState('talking')

    // Display speech bubble and speak with voice
    const durationMs = Math.min(10000, Math.max(4500, phrase.length * 65))
    agentManager.setCompanionSpeech(phrase, durationMs, true, 'you started this conversation yourself, {name} was quiet')

    // Return to standing after speaking
    setTimeout(() => {
      const cur = agentManager.getCompanionState()
      if (cur === 'talking') {
        agentManager.setCompanionState('standing')
      }
    }, durationMs + 500)

    return true
  }
}

export const proactiveDialogueService = ProactiveDialogueService.getInstance()
