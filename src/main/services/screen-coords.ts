import { screen } from 'electron'

export type WindowRect = { left: number; top: number; width: number; height: number }

/**
 * The window scripts report real pixels on every monitor; Electron places her in its own units, which differ on
 * a monitor with another scale (a 150% laptop next to a 100% monitor, say)
 */
export function toDipRect(rect: WindowRect): WindowRect {
  if (process.platform !== 'win32') return rect
  try {
    const dip = screen.screenToDipRect(null, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    return { left: Math.round(dip.x), top: Math.round(dip.y), width: Math.round(dip.width), height: Math.round(dip.height) }
  } catch {
    return rect
  }
}

/** The monitor most of a window is on */
export function displayOfRect(rect: WindowRect): Electron.Display {
  return screen.getDisplayMatching({
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  })
}

export function displayById(id: number | null | undefined): Electron.Display | null {
  if (id == null) return null
  return screen.getAllDisplays().find((d) => d.id === id) ?? null
}
