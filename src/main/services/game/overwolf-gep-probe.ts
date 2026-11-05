/**
 * Test probe for Overwolf's Game Events Provider (GEP) with VALORANT.
 *
 * Only does something when Capri runs on Overwolf's Electron (npm run dev:ow): with plain
 * Electron `app.overwolf` doesn't exist and this is a no-op. It enables GEP for VALORANT, asks
 * for every feature and writes each event and info update, untouched, to
 * <userData>/valorant_gep_log.jsonl so a real match can be checked afterwards. Capri doesn't
 * react to any of it yet.
 *
 * Read-only: GEP only reports what the game shows, nothing is sent to the game.
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const VALORANT = 21640
const VALORANT_PBE = 22904
const FEATURES = ['gep_internal', 'me', 'game_info', 'match_info', 'kill', 'death']

/** The parts of app.overwolf this probe uses (the full types live in @overwolf/ow-electron-packages-types) */
interface GepPackage {
  on(eventName: string, listener: (...args: any[]) => void): void
  setRequiredFeatures(gameId: number, features: string[] | undefined): Promise<void>
  getFeatures(gameId: number): Promise<string[]>
  getInfo(gameId: number): Promise<any>
}

interface OverwolfApi {
  disableAnonymousAnalytics(): void
  packages: {
    on(eventName: string, listener: (...args: any[]) => void): void
    readonly gep?: GepPackage
    readonly logsFolderPath?: string
  }
}

let logPath: string | null = null
const counts: Record<string, number> = {}

function write(kind: string, data: unknown): void {
  counts[kind] = (counts[kind] || 0) + 1
  const line = JSON.stringify({ t: new Date().toISOString(), kind, data })
  console.log(`[GEP] ${line.length > 400 ? line.slice(0, 400) + '...' : line}`)
  if (!logPath) return
  try {
    fs.appendFileSync(logPath, line + '\n', 'utf-8')
  } catch {}
}

async function requireFeatures(gep: GepPackage, gameId: number): Promise<void> {
  // GEP can refuse the first calls while the game is still starting: keep trying for a minute
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await gep.setRequiredFeatures(gameId, FEATURES)
      write('features-set', { gameId, attempt, features: FEATURES })
      try {
        write('supported-features', { gameId, features: await gep.getFeatures(gameId) })
      } catch (err) {
        write('get-features-failed', { gameId, error: String(err) })
      }
      try {
        write('initial-info', { gameId, info: await gep.getInfo(gameId) })
      } catch (err) {
        write('get-info-failed', { gameId, error: String(err) })
      }
      return
    } catch (err) {
      write('features-retry', { gameId, attempt, error: String(err) })
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  write('features-gave-up', { gameId })
}

function attachGep(gep: GepPackage): void {
  gep.on('game-detected', (event: { enable: () => void }, gameId: number, name: string, ...args: any[]) => {
    write('game-detected', { gameId, name, extra: args })
    if (gameId !== VALORANT && gameId !== VALORANT_PBE) return
    event.enable()
    void requireFeatures(gep, gameId)
  })
  gep.on('game-exit', (_e: unknown, gameId: number, gameName: string, pid: number, processName: string) => {
    write('game-exit', { gameId, gameName, pid, processName, counts: { ...counts } })
  })
  gep.on('elevated-privileges-required', (_e: unknown, gameId: number, name: string, pid: number) => {
    write('elevated-privileges-required', { gameId, name, pid })
  })
  gep.on('new-info-update', (_e: unknown, gameId: number, data: unknown) => write('info', { gameId, data }))
  gep.on('new-game-event', (_e: unknown, gameId: number, data: unknown) => write('event', { gameId, data }))
  gep.on('error', (_e: unknown, gameId: number, error: string, ...args: any[]) => write('gep-error', { gameId, error, extra: args }))
}

/** Call before app.whenReady: analytics can only be turned off before the app is ready */
export function initOverwolfGepProbe(): void {
  const ow = (app as unknown as { overwolf?: OverwolfApi }).overwolf
  if (!ow) return

  // Overwolf's anonymous usage analytics are on by default: this test doesn't need them
  try {
    ow.disableAnonymousAnalytics()
  } catch {}

  app.whenReady().then(() => {
    logPath = path.join(app.getPath('userData'), 'valorant_gep_log.jsonl')
    write('probe-started', {
      logPath,
      owLogsFolder: ow.packages.logsFolderPath,
      // Only whether they're set, never their values
      devModeCredentials: !!(process.env.OW_DEV_KEY || (process.env.OW_CLI_EMAIL && process.env.OW_CLI_API_KEY))
    })
  })

  ow.packages.on('loading', (_e: unknown, name: string) => write('package-loading', { name }))
  ow.packages.on('failed-to-initialize', (_e: unknown, name: string) => write('package-failed', { name }))
  ow.packages.on('crashed', (_e: unknown, canRecover: boolean) => write('package-crashed', { canRecover }))
  ow.packages.on('ready', (_e: unknown, name: string, version: string) => {
    write('package-ready', { name, version })
    if (name === 'gep' && ow.packages.gep) attachGep(ow.packages.gep)
  })
}
