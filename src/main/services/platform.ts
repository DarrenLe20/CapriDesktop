/**
 * Everything that depends on the operating system. Windows keeps using tasklist/taskkill and the
 * PowerShell scripts; on Linux the same answers come from /proc, xdotool, wmctrl, xdg-open and
 * playerctl. Window tools only see X11/XWayland windows: on a pure Wayland desktop those calls
 * answer "nothing" and the features that need them stay quiet instead of failing.
 */

import { exec, execFile, spawn } from './hidden-process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export const isWindows = process.platform === 'win32'
export const isLinux = process.platform === 'linux'

// Lookups

/** Full path of a command found in PATH, or null. Doesn't run anything */
export function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts = isWindows ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext)
      try {
        fs.accessSync(full, fs.constants.X_OK)
        if (fs.statSync(full).isFile()) return full
      } catch {
        // not here
      }
    }
  }
  return null
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Shell command that opens a URL, URI, file or registered app with the system's default handler */
export function startCommand(target: string): string {
  return isWindows ? `cmd.exe /c start "" "${target}"` : `xdg-open ${shellQuote(target)}`
}

function run(cmd: string, args: string[], timeout = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

// Processes

export interface LinuxProcess {
  pid: number
  /** Lowercase names without ".exe", from comm and from the command line */
  names: string[]
  /** First word of the command line: for Proton/Wine games, the Windows path of the .exe */
  argv0: string
  exe: string
  cwd: string
}

/** Last path segment, for / and for the \ of a Windows path under Wine */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || ''
}

/**
 * Names a process goes by. comm is cut at 15 characters ("Cyberpunk2077.e"), so the command line
 * has the real one. Electron apps rewrite it as a single string with their flags after the path.
 */
export function processNames(comm: string, cmdline: string): { names: string[]; argv0: string } {
  const parts = cmdline.split('\0').filter(Boolean)
  let argv0 = parts[0] || ''
  if (parts.length === 1) argv0 = argv0.replace(/\s+--.*$/, '')
  const clean = (n: string) => n.trim().toLowerCase().replace(/\.exe$/, '')
  const names = new Set([clean(comm), clean(baseName(argv0))].filter(Boolean))
  return { names: Array.from(names), argv0 }
}

export async function readLinuxProcesses(): Promise<LinuxProcess[]> {
  let entries: string[]
  try {
    entries = await fs.promises.readdir('/proc')
  } catch {
    return []
  }
  const found = await Promise.all(
    entries
      .filter((e) => /^\d+$/.test(e))
      .map(async (e): Promise<LinuxProcess | null> => {
        const dir = `/proc/${e}`
        try {
          const [comm, cmdline] = await Promise.all([
            fs.promises.readFile(`${dir}/comm`, 'utf-8'),
            fs.promises.readFile(`${dir}/cmdline`, 'utf-8')
          ])
          const link = (p: string) => fs.promises.readlink(p).catch(() => '')
          const [exe, cwd] = await Promise.all([link(`${dir}/exe`), link(`${dir}/cwd`)])
          return { pid: Number(e), exe, cwd, ...processNames(comm, cmdline) }
        } catch {
          return null // it exited while being read
        }
      })
  )
  return found.filter((p): p is LinuxProcess => !!p)
}

/**
 * Lowercase process names with ".exe" on every platform, so "discord.exe" means the same process
 * everywhere (a Proton game already has it). Null if the list couldn't be read.
 */
export async function listProcessNames(): Promise<Set<string> | null> {
  if (isWindows) {
    return new Promise((resolve) => {
      exec('tasklist /fo csv /nh', { timeout: 3000 }, (_err, stdout) => {
        if (!stdout) return resolve(null)
        const names = new Set<string>()
        for (const line of stdout.split(/\r?\n/)) {
          const match = line.match(/^"([^"]+)"/)
          if (match?.[1]) names.add(match[1].toLowerCase())
        }
        resolve(names)
      })
    })
  }
  const procs = await readLinuxProcesses()
  if (!procs.length) return null
  const names = new Set<string>()
  for (const p of procs) for (const n of p.names) names.add(`${n}.exe`)
  return names
}

/** What a Windows process is called on Linux, when it isn't just the same name */
const LINUX_PROCESS_ALIASES: Record<string, string[]> = {
  chrome: ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  msedge: ['msedge', 'microsoft-edge', 'microsoft-edge-stable'],
  brave: ['brave', 'brave-browser'],
  opera_gx: [],
  obs64: ['obs'],
  obs32: [],
  discordptb: ['discordptb'],
  calculatorapp: ['gnome-calculator', 'kcalc', 'galculator', 'qalculate-gtk', 'mate-calc', 'xcalc'],
  calc: ['gnome-calculator', 'kcalc', 'galculator', 'qalculate-gtk', 'mate-calc', 'xcalc'],
  notepad: ['gedit', 'gnome-text-editor', 'kate', 'kwrite', 'mousepad', 'xed', 'pluma', 'leafpad']
}

/** Pure part of killProcesses: the pids to stop. Never Capri herself or the process that started her */
export function pidsToKill(procs: Pick<LinuxProcess, 'pid' | 'names'>[], names: string[], ownPids: number[]): number[] {
  const wanted = new Set<string>()
  for (const raw of names) {
    const n = raw.trim().toLowerCase().replace(/\.exe$/, '')
    if (!n) continue
    for (const alias of LINUX_PROCESS_ALIASES[n] ?? [n]) wanted.add(alias)
  }
  return procs.filter((p) => !ownPids.includes(p.pid) && p.names.some((n) => wanted.has(n))).map((p) => p.pid)
}

/** Closes processes by name, with or without ".exe". Force-kills on Windows, asks them to quit on Linux */
export function killProcesses(names: string[]): void {
  if (isWindows) {
    const images = names.map((n) => `/IM "${n.replace(/\.exe$/i, '')}.exe"`).join(' ')
    exec(`taskkill ${images} /F`)
    return
  }
  void readLinuxProcesses().then((procs) => {
    for (const pid of pidsToKill(procs, names, [process.pid, process.ppid])) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already gone, or it belongs to another user (a system service)
      }
    }
  })
}

// Launching apps on Linux

export interface DesktopEntry {
  name: string
  path: string
  exec: string
}

/** Name and command of a .desktop file. Null for hidden entries and non-applications */
export function parseDesktopEntry(content: string, file: string): DesktopEntry | null {
  const section = content.split(/^\[(?!Desktop Entry\])/m)[0]
  const field = (key: string) => section.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() || ''
  if (field('Type') && field('Type') !== 'Application') return null
  if (/^true$/i.test(field('NoDisplay')) || /^true$/i.test(field('Hidden'))) return null
  const name = field('Name')
  // %u, %F and friends are slots for files the launcher would pass: nothing to pass here
  const command = field('Exec').replace(/\s*%[a-zA-Z]/g, '').trim()
  return name && command ? { name, path: file, exec: command } : null
}

function linuxApplicationDirs(): string[] {
  const home = os.homedir()
  const data = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [
    path.join(home, '.local/share/applications'),
    path.join(home, '.local/share/flatpak/exports/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
    ...data.map((d) => path.join(d, 'applications')),
    path.join(home, 'Desktop')
  ]
}

/** Installed applications (the Linux equivalent of the Start Menu and desktop shortcuts) */
export function listDesktopEntries(dirs: string[] = linuxApplicationDirs()): DesktopEntry[] {
  const entries: DesktopEntry[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    let files: string[]
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.desktop') || seen.has(f)) continue
      seen.add(f)
      const full = path.join(dir, f)
      try {
        const parsed = parseDesktopEntry(fs.readFileSync(full, 'utf-8'), full)
        if (parsed) entries.push(parsed)
      } catch {
        // unreadable: skip it
      }
    }
  }
  return entries
}

/** Best match for a spoken app name: exact, then whole words of the query, then a part of the name */
export function matchDesktopEntry(entries: DesktopEntry[], query: string): DesktopEntry | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const named = (e: DesktopEntry) => e.name.toLowerCase()
  return (
    entries.find((e) => named(e) === q) ||
    (q.length >= 3 ? entries.find((e) => named(e).includes(q)) : undefined) ||
    entries.find((e) => named(e).length >= 4 && q.includes(named(e))) ||
    null
  )
}

function detached(cmd: string, args: string[], shell = false): boolean {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Starts an app by name without a shell, so a spoken name can't become a command. False if it isn't installed */
export function launchLinuxApp(name: string): boolean {
  const exact = /^[\w.+-]+$/.test(name) ? findOnPath(name.toLowerCase()) || findOnPath(name) : null
  if (exact) return detached(exact, [])
  const entry = matchDesktopEntry(listDesktopEntries(), name)
  if (entry) return launchDesktopEntry(entry)
  return false
}

/** .desktop commands are shell syntax written by whoever installed the app */
export function launchDesktopEntry(entry: DesktopEntry): boolean {
  return detached(entry.exec, [], true)
}

/** Calculator or text editor: the first one installed */
export function launchFirstLinuxApp(names: string[]): boolean {
  return names.some((n) => {
    const bin = findOnPath(n)
    return bin ? detached(bin, []) : false
  })
}

export const LINUX_CALCULATORS = ['gnome-calculator', 'kcalc', 'qalculate-gtk', 'galculator', 'mate-calc', 'xcalc']
export const LINUX_EDITORS = ['gnome-text-editor', 'gedit', 'kate', 'kwrite', 'mousepad', 'xed', 'pluma', 'leafpad']

// Windows (X11 / XWayland)

export interface ForegroundWindow {
  title: string
  process: string
  path: string
  pid: number
}

/** The path that says where a program is installed. Under Proton /proc/pid/exe is Wine itself */
export function installPathOf(p: Pick<LinuxProcess, 'argv0' | 'exe' | 'cwd'>): string {
  const candidates = [p.argv0, p.exe, p.cwd].filter(Boolean)
  return candidates.find((c) => /[\\/]steamapps[\\/]common[\\/]/i.test(c)) || p.exe || p.argv0
}

export async function linuxForegroundWindow(): Promise<ForegroundWindow | null> {
  const id = (await run('xdotool', ['getactivewindow']))?.trim()
  if (!id) return null
  const [title, pidText] = await Promise.all([run('xdotool', ['getwindowname', id]), run('xdotool', ['getwindowpid', id])])
  const pid = Number(pidText?.trim()) || 0
  if (!pid) return { title: (title || '').trim(), process: '', path: '', pid: 0 }
  const proc = (await readLinuxProcesses()).find((p) => p.pid === pid)
  return {
    title: (title || '').trim(),
    process: proc?.names[proc.names.length - 1] || '',
    path: proc ? installPathOf(proc) : '',
    pid
  }
}

export interface LinuxWindow {
  id: string
  pid: number
  left: number
  top: number
  width: number
  height: number
  title: string
}

/** Parses `wmctrl -lpG`: id, desktop, pid, x, y, width, height, host, title */
export function parseWmctrl(output: string): LinuxWindow[] {
  const windows: LinuxWindow[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s*(.*)$/i)
    if (!m) continue
    // Desktop -1 means sticky: panels, docks and Capri herself
    if (m[2] === '-1') continue
    windows.push({
      id: m[1],
      pid: Number(m[3]),
      left: Number(m[4]),
      top: Number(m[5]),
      width: Number(m[6]),
      height: Number(m[7]),
      title: m[8].trim()
    })
  }
  return windows
}

export async function listLinuxWindows(): Promise<LinuxWindow[]> {
  const out = await run('wmctrl', ['-lpG'])
  return out ? parseWmctrl(out) : []
}

export interface WindowedApp {
  hwnd: string
  title: string
  left: number
  top: number
  width: number
  height: number
  isBrowser: boolean
}

const BROWSER = /opera|chrome|chromium|edge|brave|firefox/i

/** Same rules as get_windowed_apps.ps1: real, not maximized windows, browsers first */
export function pickWindowedApps(windows: LinuxWindow[], names: Map<number, string>, screenW: number, screenH: number): WindowedApp[] {
  const apps: WindowedApp[] = []
  for (const w of windows) {
    if (w.width < 320 || w.height < 220) continue
    if (w.left < -120 || w.top < -80) continue
    if (w.width >= screenW - 30 && w.height >= screenH - 85) continue
    const lower = w.title.toLowerCase()
    if (!lower || /overlay|capri|cyber companion|taskbar|desktop$/.test(lower)) continue
    apps.push({
      hwnd: w.id,
      title: w.title,
      left: w.left,
      top: w.top,
      width: w.width,
      height: w.height,
      isBrowser: BROWSER.test(lower) || BROWSER.test(names.get(w.pid) || '')
    })
  }
  return apps.sort((a, b) => Number(b.isBrowser) - Number(a.isBrowser))
}

export async function findLinuxWindowedApp(screenW: number, screenH: number): Promise<WindowedApp | null> {
  const [windows, procs] = await Promise.all([listLinuxWindows(), readLinuxProcesses()])
  const names = new Map(procs.map((p) => [p.pid, p.names.join(' ')]))
  return pickWindowedApps(windows, names, screenW, screenH)[0] || null
}

/** Position of a window, or null when it was closed or minimized */
export async function linuxWindowGeometry(id: string): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const out = await run('xdotool', ['getwindowgeometry', '--shell', id], 1000)
  if (!out) return null
  const value = (key: string) => Number(out.match(new RegExp(`^${key}=(-?\\d+)`, 'm'))?.[1])
  const geometry = { left: value('X'), top: value('Y'), width: value('WIDTH'), height: value('HEIGHT') }
  return Object.values(geometry).every((n) => Number.isFinite(n)) ? geometry : null
}

/** Window titles of browsers, as the media detection reads them. Music comes from the media session */
export async function linuxMediaWindows(): Promise<{ proc: string; title: string }[]> {
  const [windows, procs] = await Promise.all([listLinuxWindows(), readLinuxProcesses()])
  const byPid = new Map(procs.map((p) => [p.pid, p.names]))
  const titles: { proc: string; title: string }[] = []
  for (const w of windows) {
    const names = byPid.get(w.pid) || []
    const name = names.find((n) => /opera|chrome|chromium|msedge|edge|brave|firefox/.test(n))
    // The media detection knows browsers by their Windows process names
    const proc = name?.includes('edge') ? 'msedge' : name?.includes('chromium') ? 'chrome' : name
    if (proc && w.title) titles.push({ proc: `${proc}.exe`, title: w.title })
  }
  return titles
}

/** Browser window titles for the media detection. Null if they couldn't be read */
export async function mediaWindowTitles(): Promise<{ proc: string; title: string }[] | null> {
  if (!isWindows) return linuxMediaWindows()
  const cmd =
    'tasklist /v /fo csv /fi "IMAGENAME eq opera.exe" & tasklist /v /fo csv /fi "IMAGENAME eq opera_gx.exe" & tasklist /v /fo csv /fi "IMAGENAME eq chrome.exe" & tasklist /v /fo csv /fi "IMAGENAME eq msedge.exe" & tasklist /v /fo csv /fi "IMAGENAME eq brave.exe" & tasklist /v /fo csv /fi "IMAGENAME eq firefox.exe"'
  return new Promise((resolve) => {
    exec(cmd, { timeout: 3500 }, (_err, stdout) => {
      if (!stdout) return resolve(null)
      const rows: { proc: string; title: string }[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const cols = line.split('","')
        if (cols.length >= 9) rows.push({ proc: cols[0].replace(/^"/, '').toLowerCase(), title: cols[8].replace(/"$/, '').trim() })
      }
      resolve(rows)
    })
  })
}

/** Where the mouse is, asked directly to the X server */
export async function linuxCursorPosition(): Promise<{ x: number; y: number } | null> {
  const out = await run('xdotool', ['getmouselocation', '--shell'], 1000)
  const m = out?.match(/^X=(\d+)\s+Y=(\d+)/m)
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

export function pressKey(key: string): Promise<boolean> {
  return run('xdotool', ['key', key]).then((out) => out !== null)
}

// Media (MPRIS): whichever player is running, Apple Music's website in a browser included

export type MediaAction = 'next' | 'prev' | 'play' | 'pause' | 'play_pause'

/** What a player is on. app is the player's name ("Apple Music" on Windows), status None without one */
export interface NowPlaying {
  app: string
  /** The media session's own id: tells a browser apart from a music app */
  source: string
  status: 'Playing' | 'Paused' | 'Stopped' | 'None'
  artist: string
  album: string
  title: string
}

const PLAYERCTL_ACTION: Record<MediaAction, string> = {
  next: 'next',
  prev: 'previous',
  play: 'play',
  pause: 'pause',
  play_pause: 'play-pause'
}

const MPRIS_METHOD: Record<MediaAction, string> = {
  next: 'Next',
  prev: 'Previous',
  play: 'Play',
  pause: 'Pause',
  play_pause: 'PlayPause'
}

/** The first player on the session bus, for when playerctl isn't installed */
async function firstMprisPlayer(): Promise<string | null> {
  const out = await run('dbus-send', ['--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames'])
  return out?.match(/"(org\.mpris\.MediaPlayer2\.[^"]+)"/)?.[1] ?? null
}

async function mprisCall(method: string): Promise<boolean> {
  const player = await firstMprisPlayer()
  if (!player) return false
  return run('dbus-send', ['--print-reply', `--dest=${player}`, '/org/mpris/MediaPlayer2', `org.mpris.MediaPlayer2.Player.${method}`]).then(
    (out) => out !== null
  )
}

/** Sends a play/pause/next command to the player that's running. dbus-send is there even without playerctl */
export async function linuxMediaControl(action: MediaAction): Promise<boolean> {
  if ((await run('playerctl', [PLAYERCTL_ACTION[action]])) !== null) return true
  return mprisCall(MPRIS_METHOD[action])
}

/** What the running player is on, from playerctl */
export async function linuxNowPlaying(): Promise<NowPlaying> {
  const out = await run('playerctl', ['metadata', '--format', '{{playerName}}\t{{status}}\t{{artist}}\t{{album}}\t{{title}}'])
  if (!out?.trim()) return { app: '', source: '', status: 'None', artist: '', album: '', title: '' }
  const [player = '', status = '', artist = '', album = '', title = ''] = out.trim().split('\t')
  return {
    app: player,
    source: player,
    status: status === 'Playing' || status === 'Paused' ? status : 'Stopped',
    artist,
    album,
    title
  }
}

// Game libraries

/** Steam's "steamapps" folders on Windows: the usual installs and any extra library they list */
export function windowsSteamAppsDirs(): string[] {
  const roots = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']
  for (const letter of ['C', 'D', 'E', 'F', 'G']) roots.push(`${letter}:\\Steam`, `${letter}:\\SteamLibrary`)
  const dirs = new Set<string>()
  for (const root of roots) {
    const apps = path.join(root, 'steamapps')
    if (!fs.existsSync(apps)) continue
    dirs.add(apps)
    try {
      const vdf = fs.readFileSync(path.join(apps, 'libraryfolders.vdf'), 'utf-8')
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
        const extra = path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps')
        if (fs.existsSync(extra)) dirs.add(extra)
      }
    } catch {
      // no extra libraries
    }
  }
  return Array.from(dirs)
}

/** Steam's "steamapps" folders: the default installs (native and Flatpak) and any extra library */
export function linuxSteamAppsDirs(home: string = os.homedir()): string[] {
  const roots = [
    path.join(home, '.local/share/Steam'),
    path.join(home, '.steam/steam'),
    path.join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam')
  ]
  const dirs = new Set<string>()
  for (const root of roots) {
    const apps = path.join(root, 'steamapps')
    if (!fs.existsSync(apps)) continue
    dirs.add(apps)
    try {
      const vdf = fs.readFileSync(path.join(apps, 'libraryfolders.vdf'), 'utf-8')
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
        const extra = path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps')
        if (fs.existsSync(extra)) dirs.add(extra)
      }
    } catch {
      // no extra libraries
    }
  }
  try {
    return Array.from(new Set(Array.from(dirs).map((d) => fs.realpathSync(d))))
  } catch {
    return Array.from(dirs)
  }
}

// First-run setup

export type LinuxPackageManager = 'apt-get' | 'dnf' | 'pacman' | 'zypper'

export function linuxPackageManager(): LinuxPackageManager | null {
  for (const pm of ['apt-get', 'dnf', 'pacman', 'zypper'] as const) if (findOnPath(pm)) return pm
  return null
}

/** Command and arguments that install system packages, with the desktop's password prompt */
export function linuxInstallCommand(pm: LinuxPackageManager, what: 'python' | 'ffmpeg'): string[] {
  const packages: Record<LinuxPackageManager, Record<typeof what, string[]>> = {
    'apt-get': { python: ['python3', 'python3-venv'], ffmpeg: ['ffmpeg'] },
    dnf: { python: ['python3'], ffmpeg: ['ffmpeg'] },
    pacman: { python: ['python'], ffmpeg: ['ffmpeg'] },
    zypper: { python: ['python3'], ffmpeg: ['ffmpeg'] }
  }
  const flags: Record<LinuxPackageManager, string[]> = {
    'apt-get': ['install', '-y'],
    dnf: ['install', '-y'],
    pacman: ['-S', '--noconfirm', '--needed'],
    zypper: ['--non-interactive', 'install']
  }
  return ['pkexec', pm, ...flags[pm], ...packages[pm][what]]
}
