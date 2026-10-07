// Font epoch: bumped whenever a font becomes available after text was already drawn (project fonts
// loaded, a game's webfonts captured, document.fonts finishing a load).
//
// Text whose node is unchanged is never redrawn (scene sync compares node objects and text keys), so text
// drawn with a fallback kept it after the real font arrived. The epoch is part of every text key, and
// every font string the app hands to a canvas ends with a family naming the epoch (never installed, so
// it never matches): a new epoch means new keys, fresh font lookups and new Pixi text textures.
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
