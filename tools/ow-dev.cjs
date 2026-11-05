// Runs Capri in development on Overwolf's Electron (@overwolf/ow-electron) instead of plain
// Electron, to test Overwolf's game events (GEP). Usage: npm run dev:ow
//
// GEP only works in Overwolf's Dev Mode, which needs your Overwolf Console credentials:
// OW_CLI_EMAIL + OW_CLI_API_KEY, or OW_DEV_KEY. Put them in .env.overwolf.local (git-ignored,
// see .env.overwolf.example) or set them in your shell. Without them Capri still starts, but
// GEP stays inactive.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const envFile = path.join(root, '.env.overwolf.local')

if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const key = line.slice(0, line.indexOf('=')).trim()
    const value = line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    // The shell wins over the file
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

const hasCredentials = !!(process.env.OW_DEV_KEY || (process.env.OW_CLI_EMAIL && process.env.OW_CLI_API_KEY))
if (!hasCredentials) {
  console.warn('[ow-dev] No Overwolf Dev Mode credentials found: Capri will start, but game events stay inactive.')
  console.warn('[ow-dev] Add them to .env.overwolf.local (see .env.overwolf.example).')
}

// electron-vite launches whatever ELECTRON_EXEC_PATH points to
process.env.ELECTRON_EXEC_PATH = require('@overwolf/ow-electron')
console.log(`[ow-dev] Electron binary: ${process.env.ELECTRON_EXEC_PATH}`)

// The package doesn't export its bin file, so it's found next to its package.json
const cli = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [cli, 'dev', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
})
child.on('exit', (code) => process.exit(code ?? 0))
