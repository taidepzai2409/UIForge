// Figma-style link for the four 9-slice borders: linked, one value drives left/top/right/bottom (the
// properties field and the slice lines on the canvas); unlinked, each border is edited on its own.
// Remembered across sessions; the properties panel toggles it.
const KEY = 'uiforge.sliceLink'
let on = (() => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
})()

export function sliceLinkOn(): boolean {
  return on
}

export function setSliceLink(v: boolean): void {
  on = v
  try {
    localStorage.setItem(KEY, v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** Same border on all four sides, kept inside the image (at least 1 px of stretchable middle). */
export function uniformInsets(v: number, w: number, h: number): { left: number; top: number; right: number; bottom: number } {
  const b = Math.max(0, Math.min(Math.round(v), Math.floor((w - 1) / 2), Math.floor((h - 1) / 2)))
  return { left: b, top: b, right: b, bottom: b }
}
