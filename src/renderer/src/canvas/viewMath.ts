import type { ViewState } from '@/store/editor'
import type { Rect } from '@/model/nodes'

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 64

export function toWorld(v: ViewState, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom }
}

export function toScreen(v: ViewState, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * v.zoom + v.x, y: wy * v.zoom + v.y }
}

export function zoomAt(v: ViewState, sx: number, sy: number, factor: number): ViewState {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor))
  const k = zoom / v.zoom
  return { zoom, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k }
}

export function fitViewToRect(r: Rect, canvasW: number, canvasH: number, padding = 60): ViewState {
  if (r.width <= 0 || r.height <= 0) return { x: canvasW / 2, y: canvasH / 2, zoom: 1 }
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min((canvasW - padding * 2) / r.width, (canvasH - padding * 2) / r.height)))
  return {
    zoom,
    x: (canvasW - r.width * zoom) / 2 - r.x * zoom,
    y: (canvasH - r.height * zoom) / 2 - r.y * zoom
  }
}

export function zoomToLevel(v: ViewState, canvasW: number, canvasH: number, zoom: number): ViewState {
  return zoomAt(v, canvasW / 2, canvasH / 2, zoom / v.zoom)
}
