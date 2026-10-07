// Font epoch: bumped whenever a font becomes available after text was already drawn (project fonts
// loaded, a game's webfonts captured, document.fonts finishing a load).
//
// Chrome's canvas keeps the face it resolved for a CSS font string, so text drawn with a fallback
// keeps the fallback even after the real font is added. Every font string the app hands to a canvas
// therefore ends with a family that names the epoch (it never exists, so it never matches): a new
// epoch means a new string, a fresh lookup, and new Pixi text textures.
import { CanvasTextMetrics } from 'pixi.js'

let epoch = 0
const listeners = new Set<() => void>()

/** Last family of every font list: unique per epoch, never installed. */
export function epochFamily(): string {
  return `uiforge-fonts-${epoch}`
}

export function fontEpoch(): number {
  return epoch
}

export function onFontEpoch(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function bumpFontEpoch(): void {
  epoch++
  CanvasTextMetrics.clearMetrics()
  for (const cb of listeners) cb()
}

let watching = false
/** Fonts that finish loading on their own (system fonts used for the first time) also redraw the text. */
export function watchDocumentFonts(): void {
  if (watching) return
  watching = true
  let t: ReturnType<typeof setTimeout> | null = null
  document.fonts.addEventListener('loadingdone', () => {
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      t = null
      bumpFontEpoch()
    }, 50)
  })
}
