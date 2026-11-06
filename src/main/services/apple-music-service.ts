/**
 * Capri's music, on Apple Music. A song is looked up in the iTunes Search API, its album page opens
 * in the Apple Music app (a musics:// link) and scripts/apple_music.ps1 starts that exact song from
 * the page. Play, pause and skip go through the Windows media session, so they reach whatever is
 * playing. Without the app, and on Linux, the song opens on the Apple Music website instead and
 * playerctl handles the player that's running.
 */

import { app, shell } from 'electron'
import { exec, execFile } from './hidden-process'
import { scriptPath } from './app-paths'
import { isWindows, linuxMediaControl, linuxNowPlaying, listProcessNames, startCommand, type MediaAction, type NowPlaying } from './platform'

export type { MediaAction, NowPlaying }

export interface SongResult {
  /** playing: it started. opened: its page is open in the app but it didn't start. web: opened on the website */
  outcome: 'playing' | 'opened' | 'web' | 'not_found'
  /** The song as Apple Music calls it, or what was asked for when nothing was found */
  title: string
  artist: string
  query: string
}

interface CatalogSong {
  trackName: string
  artistName: string
  collectionName: string
  trackViewUrl: string
  trackCount?: number
}

/** What the music app goes by. Spotify is here so "play X on Spotify" plays X on Apple Music anyway */
const MUSIC_APP = String.raw`apple[\s_-]*music|itunes|spotify`

/** "apple music", "apple_music", "itunes"... */
export function isMusicApp(name: string): boolean {
  return new RegExp(`(?:${MUSIC_APP})`, 'i').test(name)
}

/** Words of a music request: only then does the app they named become Apple Music */
const MUSIC_CUE = /\b(?:play|pon|pone|reproduc|paus|skip|next|siguiente|abr|open|launch|cierra|cerr|close|listen|escuch|m[uú]sica|music|canci[oó]n|song|track|tema)/i

/** A music request with whatever music app they named said as "Apple Music". Anything else stays as said */
export function asAppleMusic(text: string): string {
  if (!MUSIC_CUE.test(text)) return text
  return text.replace(new RegExp(`\\b(?:${MUSIC_APP})\\b`, 'gi'), 'Apple Music')
}

/** A song request without the app in it: "bohemian rhapsody on apple music" -> "bohemian rhapsody" */
export function withoutMusicApp(text: string): string {
  return text
    .replace(new RegExp(`\\s*\\b(?:on|en|in)\\s+(?:${MUSIC_APP})\\b`, 'gi'), '')
    .replace(new RegExp(`^\\s*(?:(?:abre|abrir|open)\\s+)?(?:${MUSIC_APP})\\b\\s*`, 'i'), '')
    .trim()
}

/** The Apple Music store of the user's country, the one their app plays from */
function storeCountry(): string {
  const code = (app.getLocaleCountryCode() || '').toLowerCase()
  return /^[a-z]{2}$/.test(code) ? code : 'us'
}

/** Songs that match, best known first. Null when the search couldn't be reached */
async function searchSongs(query: string, country: string): Promise<CatalogSong[] | null> {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=8&country=${country}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const data = (await res.json()) as { results?: CatalogSong[] }
    return (data.results || []).filter((s) => s.trackName && s.trackViewUrl)
  } catch {
    return null
  }
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

const NOT_THE_ORIGINAL = /karaoke|tribute|made famous|in the style of|8[- ]bit|lullaby|cover version|string quartet|relaxing piano|instrumental/i

/**
 * The search ranks the most played first: that one wins unless another matches the words said
 * better. Each word said counts once, title words nobody said ("Live", "Remix") count against it
 * and a "(feat. X)" doesn't count at all
 */
function pickSong(songs: CatalogSong[], query: string): CatalogSong | null {
  const said = new Set(words(query))
  let best: CatalogSong | null = null
  let bestScore = -Infinity
  for (const [i, song] of songs.entries()) {
    const title = words(song.trackName.replace(/[([](?:feat|ft|with)\b[^)\]]*[)\]]/gi, ''))
    const found = new Set([...title, ...words(song.artistName)].filter((w) => said.has(w)))
    const unsaid = title.filter((w) => !said.has(w)).length
    let score = found.size * 2 - unsaid * 0.5 + (title.length && !unsaid ? 2 : 0) - i * 0.3
    if (NOT_THE_ORIGINAL.test(`${song.trackName} ${song.artistName} ${song.collectionName}`) && !NOT_THE_ORIGINAL.test(query)) score -= 5
    if (score > bestScore) {
      best = song
      bestScore = score
    }
  }
  return best
}

/** Runs apple_music.ps1 and reads the JSON line it prints last. Null if it failed */
function runScript(args: string[], timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('apple_music.ps1'), ...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (_err, stdout) => {
        const line = String(stdout || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .pop()
        try {
          resolve(line ? (JSON.parse(line) as Record<string, unknown>) : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const NOTHING: NowPlaying = { app: '', source: '', status: 'None', artist: '', album: '', title: '' }

class AppleMusicService {
  private appInfo: { installed: boolean; appId: string } | null = null
  private appInfoAt = 0
  private queue: Promise<unknown> = Promise.resolve()
  private recent: { at: number; value: NowPlaying } | null = null
  private reading: Promise<NowPlaying> | null = null

  /** Whether the Windows app is installed, and the id that opens it. "Not installed" is asked again every 10 minutes */
  public async appleMusicApp(): Promise<{ installed: boolean; appId: string }> {
    if (!isWindows) return { installed: false, appId: '' }
    if (this.appInfo && (this.appInfo.installed || Date.now() - this.appInfoAt < 10 * 60 * 1000)) return this.appInfo
    const res = await runScript(['-Action', 'installed'], 15000)
    this.appInfo = { installed: !!res?.installed, appId: String(res?.appId || '') }
    this.appInfoAt = Date.now()
    return this.appInfo
  }

  public async isRunning(): Promise<boolean> {
    return !!(await listProcessNames())?.has('applemusic.exe')
  }

  /** Finds the song and plays it. One at a time: two songs opening at once would fight over the window */
  public playSong(query: string): Promise<SongResult> {
    const next = this.queue.then(() => this.play(query))
    this.queue = next.catch(() => undefined)
    return next
  }

  private async play(query: string): Promise<SongResult> {
    const country = storeCountry()
    const songs = await searchSongs(query, country)
    const song = songs ? pickSong(songs, query) : null
    const found = { title: song?.trackName || query, artist: song?.artistName || '', query }

    if (!(await this.appleMusicApp()).installed) {
      await this.openWebSearch(query, country)
      return { outcome: 'web', ...found }
    }
    if (!song) return { outcome: 'not_found', ...found }

    const wasRunning = await this.isRunning()
    try {
      // Opens the song's album page in the app. It doesn't start playing by itself
      await shell.openExternal(song.trackViewUrl.replace(/^https?:/, 'musics:'))
    } catch {
      await this.openWebSearch(query, country)
      return { outcome: 'web', ...found }
    }

    // The page loads in a few seconds, much longer when the app has to start
    const waitSec = wasRunning ? 12 : 30
    const res = await runScript(
      [
        '-Action',
        'play_track',
        '-TitleB64',
        Buffer.from(song.trackName, 'utf8').toString('base64'),
        '-TimeoutSec',
        String(waitSec),
        ...(song.trackCount === 1 ? ['-Single'] : [])
      ],
      (waitSec + 25) * 1000
    )
    this.recent = null
    if (res?.ok) return { outcome: 'playing', title: String(res.title || song.trackName), artist: String(res.artist || song.artistName), query }
    console.warn(`[AppleMusic] "${song.trackName}" didn't start: ${res?.reason || 'the script gave no answer'}`)
    return { outcome: 'opened', ...found }
  }

  /** Play, pause, next or previous on whatever is playing, Apple Music first */
  public async control(action: MediaAction): Promise<{ ok: boolean; app: string }> {
    this.recent = null
    if (!isWindows) return { ok: await linuxMediaControl(action), app: '' }

    const command = action === 'play_pause' ? 'toggle' : action
    // Nothing anywhere to resume: opens Apple Music, its own play button picks up where it left off
    const opened = (command === 'play' || command === 'toggle') && (await this.nowPlaying()).status === 'None' && (await this.openApp())
    return this.runControl(command, opened ? 25 : 0)
  }

  /** "Open Apple Music": opens it if it's closed and resumes it, even while a video has the media session */
  public async resume(): Promise<{ ok: boolean; app: string }> {
    if (!isWindows || !(await this.appleMusicApp()).installed) return this.control('play')
    const opened = await this.openApp()
    return this.runControl('play', opened ? 25 : 0, true)
  }

  /** Starts the app when it's installed and closed. True if it had to */
  private async openApp(): Promise<boolean> {
    const apple = await this.appleMusicApp()
    if (!apple.installed || !apple.appId || (await this.isRunning())) return false
    exec(`explorer.exe "shell:AppsFolder\\${apple.appId}"`)
    await sleep(1500)
    return true
  }

  /** waitSec: how long its window may take to show up after opening it */
  private async runControl(command: string, waitSec: number, appleOnly = false): Promise<{ ok: boolean; app: string }> {
    const res = await runScript(
      ['-Action', 'control', '-Command', command, '-TimeoutSec', String(waitSec), ...(appleOnly ? ['-AppleOnly'] : [])],
      (waitSec + 15) * 1000
    )
    this.recent = null
    return { ok: !!res?.ok, app: String(res?.app || '') }
  }

  /** What's playing. maxAgeMs lets a caller that asks often reuse an answer that recent */
  public nowPlaying(maxAgeMs = 3000): Promise<NowPlaying> {
    if (this.recent && Date.now() - this.recent.at <= maxAgeMs) return Promise.resolve(this.recent.value)
    if (!this.reading) {
      this.reading = (isWindows ? this.readSession() : linuxNowPlaying())
        .catch(() => NOTHING)
        .then((value) => {
          this.recent = { at: Date.now(), value }
          return value
        })
        .finally(() => (this.reading = null))
    }
    return this.reading
  }

  private async readSession(): Promise<NowPlaying> {
    const res = await runScript(['-Action', 'status'], 10000)
    if (!res) return NOTHING
    const status = String(res.status)
    return {
      app: String(res.app || ''),
      source: String(res.source || ''),
      status: status === 'Playing' || status === 'Paused' || status === 'Stopped' ? status : 'None',
      artist: String(res.artist || ''),
      album: String(res.album || ''),
      title: String(res.title || '')
    }
  }

  private async openWebSearch(query: string, country = storeCountry()): Promise<void> {
    const url = `https://music.apple.com/${country}/search?term=${encodeURIComponent(query)}`
    await shell.openExternal(url).catch(() => exec(startCommand(url)))
  }
}

export const appleMusic = new AppleMusicService()
