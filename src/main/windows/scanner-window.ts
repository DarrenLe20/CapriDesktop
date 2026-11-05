import { assetPath } from '../services/app-paths'
import { BrowserWindow, screen, app } from 'electron'
import { join } from 'path'
import { consciousnessService } from '../services/consciousness-service'

export function createScannerWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { workArea } = primaryDisplay

  const savedBounds = consciousnessService.getScannerBounds()
  const width = Math.max(220, Math.min(workArea.width, savedBounds.width || 520))
  const height = Math.max(200, Math.min(workArea.height, savedBounds.height || 420))

  let x = savedBounds.x
  let y = savedBounds.y

  if (x < 0 || y < 0 || x > workArea.x + workArea.width - 100 || y > workArea.y + workArea.height - 100) {
    x = Math.round(workArea.x + (workArea.width - width) / 2)
    y = Math.round(workArea.y + (workArea.height - height) / 2)
  }

  const preloadPath = join(__dirname, '../preload/index.mjs')
  const iconPath = assetPath('icon.png')

  const scannerWindow = new BrowserWindow({
    title: 'Capri // Neural Scanner Frame',
    icon: iconPath,
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    // Electron 43+ rounds frameless windows on Linux, which would clip a transparent one
    roundedCorners: process.platform !== 'linux',
    alwaysOnTop: true,
    resizable: false, // Window resizing is handled smoothly via our custom handles
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Set topmost z-order level 'screen-saver' so it stays above standard windows like Paint, browsers, etc.
  scannerWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  scannerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Hash route for scanner view
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    scannerWindow.loadURL(`${devUrl}#/scanner`)
  } else {
    scannerWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: 'scanner'
    })
  }

  scannerWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[ScannerWindow] Failed to load:', errorCode, errorDescription)
  })

  return scannerWindow
}
