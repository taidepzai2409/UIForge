// Photoshop-style "Snap to pixel": dragged / resized layers land on whole pixels of the page, so edges
// stay crisp and positions stay round numbers. On by default; View > Snap to pixel (Ctrl+Shift+') toggles it,
// holding Alt while dragging moves freely for that drag.
const KEY = 'uiforge.pixelSnap'
let on = (() => {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
})()

export function pixelSnapOn(): boolean {
  return on
}

export function togglePixelSnap(): boolean {
  on = !on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  return on
}
