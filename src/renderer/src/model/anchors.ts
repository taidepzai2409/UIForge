import type { Anchor, Vec2 } from './types'

export interface AnchorPreset {
  key: string
  label: string
  anchor: Anchor
  pivot: Vec2
}

const a = (minX: number, minY: number, maxX: number, maxY: number): Anchor => ({ minX, minY, maxX, maxY })
const p = (x: number, y: number): Vec2 => ({ x, y })

/** Presets in editor convention (Y down). 3x3 grid + stretch variants. */
export const ANCHOR_PRESETS: AnchorPreset[] = [
  { key: 'top-left', label: 'Top Left', anchor: a(0, 0, 0, 0), pivot: p(0, 0) },
  { key: 'top', label: 'Top', anchor: a(0.5, 0, 0.5, 0), pivot: p(0.5, 0) },
  { key: 'top-right', label: 'Top Right', anchor: a(1, 0, 1, 0), pivot: p(1, 0) },
  { key: 'left', label: 'Left', anchor: a(0, 0.5, 0, 0.5), pivot: p(0, 0.5) },
  { key: 'center', label: 'Center', anchor: a(0.5, 0.5, 0.5, 0.5), pivot: p(0.5, 0.5) },
  { key: 'right', label: 'Right', anchor: a(1, 0.5, 1, 0.5), pivot: p(1, 0.5) },
  { key: 'bottom-left', label: 'Bottom Left', anchor: a(0, 1, 0, 1), pivot: p(0, 1) },
  { key: 'bottom', label: 'Bottom', anchor: a(0.5, 1, 0.5, 1), pivot: p(0.5, 1) },
  { key: 'bottom-right', label: 'Bottom Right', anchor: a(1, 1, 1, 1), pivot: p(1, 1) },
  { key: 'stretch-top', label: 'Stretch Top', anchor: a(0, 0, 1, 0), pivot: p(0.5, 0) },
  { key: 'stretch-middle', label: 'Stretch Middle', anchor: a(0, 0.5, 1, 0.5), pivot: p(0.5, 0.5) },
  { key: 'stretch-bottom', label: 'Stretch Bottom', anchor: a(0, 1, 1, 1), pivot: p(0.5, 1) },
  { key: 'stretch-left', label: 'Stretch Left', anchor: a(0, 0, 0, 1), pivot: p(0, 0.5) },
  { key: 'stretch-center', label: 'Stretch Center', anchor: a(0.5, 0, 0.5, 1), pivot: p(0.5, 0.5) },
  { key: 'stretch-right', label: 'Stretch Right', anchor: a(1, 0, 1, 1), pivot: p(1, 0.5) },
  { key: 'stretch-all', label: 'Stretch All', anchor: a(0, 0, 1, 1), pivot: p(0.5, 0.5) }
]

export function presetKeyFor(anchor: Anchor, pivot: Vec2): string | null {
  const eq = (x: number, y: number): boolean => Math.abs(x - y) < 1e-6
  for (const pr of ANCHOR_PRESETS) {
    if (
      eq(pr.anchor.minX, anchor.minX) &&
      eq(pr.anchor.minY, anchor.minY) &&
      eq(pr.anchor.maxX, anchor.maxX) &&
      eq(pr.anchor.maxY, anchor.maxY) &&
      eq(pr.pivot.x, pivot.x) &&
      eq(pr.pivot.y, pivot.y)
    )
      return pr.key
  }
  return null
}

export interface UnityRect {
  anchorMin: [number, number]
  anchorMax: [number, number]
  pivot: [number, number]
  anchoredPosition: [number, number]
  sizeDelta: [number, number]
  offsetMin: [number, number]
  offsetMax: [number, number]
  rotationZ: number
}

/**
 * Converts an editor rect (x,y,w,h relative to parent top-left, Y down) plus anchor/pivot
 * into Unity RectTransform values (Y up). parentW/H are the parent's size.
 */
export function toUnityRect(
  x: number,
  y: number,
  w: number,
  h: number,
  anchor: Anchor,
  pivot: Vec2,
  rotation: number,
  parentW: number,
  parentH: number
): UnityRect {
  // anchor rect in parent editor space
  const ax0 = anchor.minX * parentW
  const ay0 = anchor.minY * parentH
  const ax1 = anchor.maxX * parentW
  const ay1 = anchor.maxY * parentH
  const aw = ax1 - ax0
  const ah = ay1 - ay0
  // pivot point of child in parent editor space
  const px = x + pivot.x * w
  const py = y + pivot.y * h
  // anchor reference point (pivot applied to the anchor rect)
  const rx = ax0 + pivot.x * aw
  const ry = ay0 + pivot.y * ah
  const dx = px - rx
  const dy = -(py - ry) // flip Y
  // offsets: child rect edges relative to anchor rect edges (Unity space, Y up)
  const offsetMinX = x - ax0
  const offsetMaxX = x + w - ax1
  const offsetMinY = -(y + h - ay1) // bottom edge
  const offsetMaxY = -(y - ay0) // top edge
  const r = (v: number): number => Math.round(v * 1000) / 1000
  return {
    anchorMin: [r(anchor.minX), r(1 - anchor.maxY)],
    anchorMax: [r(anchor.maxX), r(1 - anchor.minY)],
    pivot: [r(pivot.x), r(1 - pivot.y)],
    anchoredPosition: [r(dx), r(dy)],
    sizeDelta: [r(w - aw), r(h - ah)],
    offsetMin: [r(offsetMinX), r(offsetMinY)],
    offsetMax: [r(offsetMaxX), r(offsetMaxY)],
    rotationZ: r(-rotation)
  }
}
