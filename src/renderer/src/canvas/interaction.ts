import type { NodeId, Page, SceneNode } from '@/model/types'
import { isContainer } from '@/model/types'
import { absRect, getEntry, hitChain, type Rect } from '@/model/nodes'

/** Cuts the chain at the first locked node (a locked ancestor locks its subtree). */
export function unlockedChain(chain: SceneNode[]): SceneNode[] {
  const i = chain.findIndex((n) => n.locked)
  return i < 0 ? chain : chain.slice(0, i)
}

/**
 * Figma-style pick: top-level frames are pass-through, groups/nested frames are opaque
 * unless the user has entered them (scope).
 */
export function pickCandidate(chain: SceneNode[], scopeId: NodeId | null): SceneNode | null {
  if (!chain.length) return null
  if (scopeId) {
    const si = chain.findIndex((n) => n.id === scopeId)
    if (si >= 0) {
      const next = chain[si + 1]
      if (next) return next
      return chain[si].type === 'frame' ? chain[si] : null
    }
  }
  const first = chain[0]
  if (first.type === 'frame' && chain.length > 1) return chain[1]
  return first
}

export function pickAt(page: Page, wx: number, wy: number, scopeId: NodeId | null): SceneNode | null {
  return pickCandidate(unlockedChain(hitChain(page, wx, wy)), scopeId)
}

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const HANDLES: { id: HandleId; fx: number; fy: number; cursor: string }[] = [
  { id: 'nw', fx: 0, fy: 0, cursor: 'nwse-resize' },
  { id: 'n', fx: 0.5, fy: 0, cursor: 'ns-resize' },
  { id: 'ne', fx: 1, fy: 0, cursor: 'nesw-resize' },
  { id: 'e', fx: 1, fy: 0.5, cursor: 'ew-resize' },
  { id: 'se', fx: 1, fy: 1, cursor: 'nwse-resize' },
  { id: 's', fx: 0.5, fy: 1, cursor: 'ns-resize' },
  { id: 'sw', fx: 0, fy: 1, cursor: 'nesw-resize' },
  { id: 'w', fx: 0, fy: 0.5, cursor: 'ew-resize' }
]

export const HANDLE_SIZE = 8

/** Returns which handle (if any) is under a screen point, given a screen-space bbox. */
export function handleAt(bbox: Rect, sx: number, sy: number): (typeof HANDLES)[number] | null {
  const half = HANDLE_SIZE / 2 + 2
  for (const h of HANDLES) {
    const hx = bbox.x + h.fx * bbox.width
    const hy = bbox.y + h.fy * bbox.height
    if (Math.abs(sx - hx) <= half && Math.abs(sy - hy) <= half) return h
  }
  return null
}

/** Applies a handle drag to a rect. Returns new local rect. */
export function resizeRect(
  orig: Rect,
  handle: HandleId,
  dx: number,
  dy: number,
  keepAspect: boolean,
  fromCenter: boolean
): Rect {
  const left = handle.includes('w')
  const right = handle.includes('e')
  const top = handle.includes('n')
  const bottom = handle.includes('s')
  let x0 = orig.x
  let y0 = orig.y
  let x1 = orig.x + orig.width
  let y1 = orig.y + orig.height
  if (left) {
    x0 += dx
    if (fromCenter) x1 -= dx
  }
  if (right) {
    x1 += dx
    if (fromCenter) x0 -= dx
  }
  if (top) {
    y0 += dy
    if (fromCenter) y1 -= dy
  }
  if (bottom) {
    y1 += dy
    if (fromCenter) y0 -= dy
  }
  let width = Math.max(1, x1 - x0)
  let height = Math.max(1, y1 - y0)
  if (keepAspect && orig.width > 0 && orig.height > 0) {
    const ratio = orig.width / orig.height
    const cornerish = (left || right) && (top || bottom)
    if (cornerish) {
      const rw = Math.abs(width - orig.width) / orig.width
      const rh = Math.abs(height - orig.height) / orig.height
      if (rw >= rh) height = width / ratio
      else width = height * ratio
    } else if (left || right) height = width / ratio
    else width = height * ratio
  }
  // re-anchor
  let x: number
  let y: number
  if (fromCenter) {
    x = orig.x + (orig.width - width) / 2
    y = orig.y + (orig.height - height) / 2
  } else {
    if (left) x = orig.x + orig.width - width
    else if (right) x = orig.x
    else x = keepAspect ? orig.x + (orig.width - width) / 2 : orig.x
    if (top) y = orig.y + orig.height - height
    else if (bottom) y = orig.y
    else y = keepAspect ? orig.y + (orig.height - height) / 2 : orig.y
  }
  return { x, y, width, height }
}

export interface SnapResult {
  dx: number
  dy: number
  guidesX: number[]
  guidesY: number[]
}

/** Snaps a moving bbox (absolute) against parent bounds and sibling edges/centers. */
export function snapMove(page: Page, movingIds: NodeId[], bbox: Rect, threshold: number): SnapResult {
  const xs: number[] = []
  const ys: number[] = []
  for (const g of page.guides ?? []) (g.axis === 'x' ? xs : ys).push(g.pos)
  const moving = new Set(movingIds)
  const first = getEntry(page, movingIds[0])
  const parent = first?.parent ?? null
  const siblings = parent ? parent.children : page.children
  if (parent) {
    const pr = absRect(page, parent.id)
    if (pr) {
      xs.push(pr.x, pr.x + pr.width / 2, pr.x + pr.width)
      ys.push(pr.y, pr.y + pr.height / 2, pr.y + pr.height)
    }
  }
  for (const s of siblings) {
    if (moving.has(s.id) || !s.visible) continue
    const r = absRect(page, s.id)
    if (!r) continue
    xs.push(r.x, r.x + r.width / 2, r.x + r.width)
    ys.push(r.y, r.y + r.height / 2, r.y + r.height)
  }
  const mxs = [bbox.x, bbox.x + bbox.width / 2, bbox.x + bbox.width]
  const mys = [bbox.y, bbox.y + bbox.height / 2, bbox.y + bbox.height]
  let bestDx = 0,
    bestDy = 0,
    bestDistX = threshold,
    bestDistY = threshold
  const guidesX: number[] = []
  const guidesY: number[] = []
  for (const m of mxs)
    for (const c of xs) {
      const d = Math.abs(c - m)
      if (d < bestDistX) {
        bestDistX = d
        bestDx = c - m
      }
    }
  for (const m of mys)
    for (const c of ys) {
      const d = Math.abs(c - m)
      if (d < bestDistY) {
        bestDistY = d
        bestDy = c - m
      }
    }
  if (bestDistX < threshold) {
    for (const m of mxs) for (const c of xs) if (Math.abs(c - (m + bestDx)) < 0.01) guidesX.push(c)
  }
  if (bestDistY < threshold) {
    for (const m of mys) for (const c of ys) if (Math.abs(c - (m + bestDy)) < 0.01) guidesY.push(c)
  }
  return { dx: bestDistX < threshold ? bestDx : 0, dy: bestDistY < threshold ? bestDy : 0, guidesX, guidesY }
}

/** Cubic bezier points for a prototype connection (screen space). */
export function connectionCurve(x0: number, y0: number, x1: number, y1: number): { c1x: number; c1y: number; c2x: number; c2y: number } {
  const d = Math.max(40, Math.abs(x1 - x0) * 0.5)
  return { c1x: x0 + d, c1y: y0, c2x: x1 - d, c2y: y1 }
}

export function distToCurve(x0: number, y0: number, x1: number, y1: number, px: number, py: number): number {
  const { c1x, c1y, c2x, c2y } = connectionCurve(x0, y0, x1, y1)
  let best = Infinity
  for (let i = 0; i <= 24; i++) {
    const t = i / 24
    const mt = 1 - t
    const x = mt * mt * mt * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x1
    const y = mt * mt * mt * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y1
    best = Math.min(best, Math.hypot(px - x, py - y))
  }
  return best
}

/** Scales a container's children proportionally (used when resizing groups). */
export function scaleChildren(n: SceneNode, sx: number, sy: number): void {
  if (!isContainer(n) || n.type !== 'group') return
  for (const c of n.children) {
    c.x *= sx
    c.y *= sy
    c.width *= sx
    c.height *= sy
    if (c.type === 'text') c.fontSize *= (sx + sy) / 2
    scaleChildren(c, sx, sy)
  }
}

/** True when the point is in the rotation ring just outside a bbox corner (screen space). */
export function rotateZoneAt(bbox: Rect, sx: number, sy: number): boolean {
  const corners = [
    [bbox.x, bbox.y],
    [bbox.x + bbox.width, bbox.y],
    [bbox.x + bbox.width, bbox.y + bbox.height],
    [bbox.x, bbox.y + bbox.height]
  ]
  const inside = sx >= bbox.x - 2 && sx <= bbox.x + bbox.width + 2 && sy >= bbox.y - 2 && sy <= bbox.y + bbox.height + 2
  if (inside) return false
  return corners.some(([cx, cy]) => Math.hypot(sx - cx, sy - cy) <= 22)
}
