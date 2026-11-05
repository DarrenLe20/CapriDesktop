import { assetPath } from '../services/app-paths'
import { BrowserWindow, screen, app } from 'electron'
import { join } from 'path'

export function createCompanionWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { workArea } = primaryDisplay

  const width = 420
  const height = 520
  const x = workArea.x + workArea.width - width - 20
  const y = workArea.y + workArea.height - height - 20

  const preloadPath = join(__dirname, '../preload/index.mjs')
  const iconPath = assetPath('icon.png')

  const companionWindow = new BrowserWindow({
    title: 'Capricorn // Capri Desktop',
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
    resizable: false,
    hasShadow: false,
    skipTaskbar: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Ensure window stays above DirectX games and handles fullscreen blur without dropping z-order
  companionWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  companionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Hash route for companion view
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    companionWindow.loadURL(`${devUrl}#/companion`)
  } else {
    companionWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: 'companion'
    })
  }

  companionWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[CompanionWindow] Failed to load:', errorCode, errorDescription)
  })
  companionWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[CompanionWindow] Render process gone:', details)
  })

  return companionWindow
}
