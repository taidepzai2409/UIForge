// Responsive preview: lays a frame out for another screen size exactly the way Unity's
// CanvasScaler (Scale With Screen Size) + RectTransform anchors would, honouring the
// device safe area for nodes flagged `safeArea`.
import type { CanvasScalerSettings, FrameNode, SceneNode } from './types'
import { DEFAULT_SCALER, isContainer } from './types'

export interface DevicePreset {
  id: string
  name: string
  width: number
  height: number
  /** safe area insets in device px, PORTRAIT terms (top = notch, bottom = home bar); rotated automatically */
  safe: { top: number; bottom: number; left: number; right: number }
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'ref', name: 'Thiết kế gốc', width: 0, height: 0, safe: { top: 0, bottom: 0, left: 0, right: 0 } },
  { id: 'iphone15', name: 'iPhone 15 Pro (19.5:9)', width: 2556, height: 1179, safe: { top: 59 * 3, bottom: 34 * 3, left: 0, right: 0 } },
  { id: 'iphoneSE', name: 'iPhone SE (16:9)', width: 1334, height: 750, safe: { top: 0, bottom: 0, left: 0, right: 0 } },
  { id: 'galaxyS', name: 'Galaxy S24 (20:9)', width: 2340, height: 1080, safe: { top: 120, bottom: 60, left: 0, right: 0 } },
  { id: 'pixel', name: 'Pixel 8 (20:9)', width: 2400, height: 1080, safe: { top: 130, bottom: 60, left: 0, right: 0 } },
  { id: 'ipad', name: 'iPad (4:3)', width: 2160, height: 1620, safe: { top: 24 * 2, bottom: 20 * 2, left: 0, right: 0 } },
  { id: 'tablet', name: 'Tablet 16:10', width: 2560, height: 1600, safe: { top: 0, bottom: 0, left: 0, right: 0 } },
  { id: 'fold', name: 'Fold mở (≈1:1)', width: 2176, height: 1812, safe: { top: 60, bottom: 40, left: 0, right: 0 } }
]

export const DEFAULT_PREVIEW_DEVICES = ['iphone15', 'galaxyS', 'ipad']

export interface SimRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SimNode {
  id: NodeId
  path: string
  rect: SimRect // in reference units, relative to the simulated canvas top-left
  visible: boolean
  safeArea: boolean
  /** problems detected for this node */
  issues: string[]
}
type NodeId = string

export interface SimResult {
  device: DevicePreset
  /** canvas size in reference units (frame units) after CanvasScaler */
  canvas: { width: number; height: number }
  /** safe rect in reference units */
  safe: SimRect
  scale: number
  nodes: SimNode[]
  issues: string[]
}

/** Unity CanvasScaler.ScaleWithScreenSize. `scaler` = mode expand/shrink or matchWidthOrHeight (0 = width, 1 = height). */
export function canvasScale(refW: number, refH: number, screenW: number, screenH: number, scaler: CanvasScalerSettings | number): number {
  const s: CanvasScalerSettings = typeof scaler === 'number' ? { mode: 'match', match: scaler } : scaler
  if (s.mode === 'expand') return Math.min(screenW / refW, screenH / refH)
  if (s.mode === 'shrink') return Math.max(screenW / refW, screenH / refH)
  const logW = Math.log2(screenW / refW)
  const logH = Math.log2(screenH / refH)
  return Math.pow(2, logW * (1 - s.match) + logH * s.match)
}

/** Default when the document has none: expand (safest for game UI). */
export function scalerOf(doc: { scaler?: CanvasScalerSettings } | undefined, override?: CanvasScalerSettings | number): CanvasScalerSettings {
  if (typeof override === 'number') return { mode: 'match', match: override }
  return override ?? doc?.scaler ?? DEFAULT_SCALER
}

/**
 * Simulates the frame at a device size with the given CanvasScaler settings
 * (number = legacy matchWidthOrHeight; default = expand, which never overlaps).
 */
export function simulateFrame(frame: FrameNode, device: DevicePreset, scaler?: CanvasScalerSettings | number): SimResult {
  const landscape = frame.width >= frame.height
  let dw = device.width
  let dh = device.height
  let safe = { ...device.safe }
  if (device.id === 'ref' || dw === 0) {
    dw = frame.width
    dh = frame.height
    safe = { top: 0, bottom: 0, left: 0, right: 0 }
  } else {
    // presets list width/height in landscape and safe insets in portrait terms (top = notch, bottom = home bar);
    // rotate to the frame's orientation: in landscape the notch/home bar sit on the left/right edges
    const big = Math.max(dw, dh)
    const small = Math.min(dw, dh)
    if (landscape) {
      dw = big
      dh = small
      safe = { top: device.safe.left, bottom: device.safe.right, left: device.safe.top, right: device.safe.bottom }
    } else {
      dw = small
      dh = big
      safe = { ...device.safe }
    }
  }
  const sc: CanvasScalerSettings = typeof scaler === 'number' ? { mode: 'match', match: scaler } : (scaler ?? DEFAULT_SCALER)
  const scale = canvasScale(frame.width, frame.height, dw, dh, sc)
  const cw = dw / scale
  const ch = dh / scale
  const safeRect: SimRect = { x: safe.left / scale, y: safe.top / scale, width: cw - (safe.left + safe.right) / scale, height: ch - (safe.top + safe.bottom) / scale }

  const nodes: SimNode[] = []
  const issues: string[] = []

  // a child's rect inside a parent whose rect changed from (pw0,ph0) → (pw1,ph1)
  const place = (n: SceneNode, parent0: SimRect, parent1: SimRect, parentPath: string, depth: number): void => {
    const path = parentPath ? `${parentPath}/${n.name}` : n.name
    const a = n.anchor
    const p = n.pivot
    // anchor rects in both parents (local coords)
    const a0 = { x: a.minX * parent0.width, y: a.minY * parent0.height, w: (a.maxX - a.minX) * parent0.width, h: (a.maxY - a.minY) * parent0.height }
    const a1 = { x: a.minX * parent1.width, y: a.minY * parent1.height, w: (a.maxX - a.minX) * parent1.width, h: (a.maxY - a.minY) * parent1.height }
    // Unity keeps anchoredPosition (pivot offset from anchor ref) and sizeDelta constant
    const w = n.width + (a1.w - a0.w)
    const h = n.height + (a1.h - a0.h)
    const refX0 = a0.x + p.x * a0.w
    const refY0 = a0.y + p.y * a0.h
    const pivX0 = n.x + p.x * n.width
    const pivY0 = n.y + p.y * n.height
    const refX1 = a1.x + p.x * a1.w
    const refY1 = a1.y + p.y * a1.h
    const pivX1 = refX1 + (pivX0 - refX0)
    const pivY1 = refY1 + (pivY0 - refY0)
    const local: SimRect = { x: pivX1 - p.x * w, y: pivY1 - p.y * h, width: w, height: h }
    const abs: SimRect = { x: parent1.x + local.x, y: parent1.y + local.y, width: w, height: h }
    const node: SimNode = { id: n.id, path, rect: abs, visible: n.visible, safeArea: !!n.safeArea, issues: [] }
    if (n.visible) {
      if (abs.x < -0.5 || abs.y < -0.5 || abs.x + abs.width > cw + 0.5 || abs.y + abs.height > ch + 0.5) node.issues.push('tràn ra ngoài màn hình')
      const inSafe = abs.x >= safeRect.x - 0.5 && abs.y >= safeRect.y - 0.5 && abs.x + abs.width <= safeRect.x + safeRect.width + 0.5 && abs.y + abs.height <= safeRect.y + safeRect.height + 0.5
      const isLeaf = !isContainer(n) || n.type === 'instance'
      if (!inSafe && isLeaf && depth <= 2 && !(n.width >= frame.width * 0.9 && n.height >= frame.height * 0.9)) node.issues.push('lấn vùng không an toàn (tai thỏ / home bar)')
      if (w < 1 || h < 1) node.issues.push('bị co về 0')
      // full-screen background that no longer covers the simulated canvas → needs stretch anchors
      const wasFull = n.width >= frame.width * 0.98 && n.height >= frame.height * 0.98 && depth === 0
      const coversNow = abs.x <= 0.5 && abs.y <= 0.5 && abs.x + abs.width >= cw - 0.5 && abs.y + abs.height >= ch - 0.5
      if (wasFull && !coversNow && (n.type === 'image' || n.type === 'nineslice' || n.type === 'rect')) node.issues.push('nền không phủ hết màn hình → đặt Anchor "All" (stretch) để giãn theo máy')
    }
    nodes.push(node)
    if (node.issues.length && n.visible) issues.push(`${path}: ${node.issues.join(', ')}`)
    if (isContainer(n)) {
      // children need the parent's ABSOLUTE rect in the simulated canvas (parent0 only supplies sizes)
      const abs0: SimRect = { x: parent0.x + n.x, y: parent0.y + n.y, width: n.width, height: n.height }
      for (const c of n.children) place(c, abs0, abs, path, depth + 1)
    }
  }

  const root0: SimRect = { x: 0, y: 0, width: frame.width, height: frame.height }
  for (const c of frame.children) {
    // top-level nodes flagged safeArea are anchored to the safe rect instead of the full canvas
    const root1: SimRect = c.safeArea ? safeRect : { x: 0, y: 0, width: cw, height: ch }
    place(c, root0, root1, '', 0)
  }
  // overlap: siblings (depth ≤ 1) that were apart on the reference screen but intersect now
  const ref = new Map<string, SimRect>()
  const collect = (list: SceneNode[], ox: number, oy: number, prefix: string, depth: number): void => {
    for (const n of list) {
      const p = prefix ? `${prefix}/${n.name}` : n.name
      ref.set(p, { x: ox + n.x, y: oy + n.y, width: n.width, height: n.height })
      if (isContainer(n) && depth < 1) collect(n.children, ox + n.x, oy + n.y, p, depth + 1)
    }
  }
  collect(frame.children, 0, 0, '', 0)
  const byPath = new Map(nodes.map((n) => [n.path, n]))
  const inter = (a: SimRect, b: SimRect, tol: number): boolean => a.x + a.width > b.x + tol && b.x + b.width > a.x + tol && a.y + a.height > b.y + tol && b.y + b.height > a.y + tol
  const isBg = (n: SceneNode): boolean => n.width >= frame.width * 0.9 && n.height >= frame.height * 0.9
  const siblingsOf = (list: SceneNode[], prefix: string): void => {
    const vis = list.filter((n) => n.visible && !isBg(n) && n.width > 0 && n.height > 0)
    for (let i = 0; i < vis.length; i++)
      for (let j = i + 1; j < vis.length; j++) {
        const pa = prefix ? `${prefix}/${vis[i].name}` : vis[i].name
        const pb = prefix ? `${prefix}/${vis[j].name}` : vis[j].name
        const a0 = ref.get(pa)
        const b0 = ref.get(pb)
        const a1 = byPath.get(pa)
        const b1 = byPath.get(pb)
        if (!a0 || !b0 || !a1 || !b1) continue
        if (!inter(a0, b0, 0.5) && inter(a1.rect, b1.rect, 2)) {
          a1.issues.push(`đè lên ${vis[j].name}`)
          issues.push(`${pa} ↔ ${pb}: đè lên nhau (thiết kế gốc không đè) → đổi scaler sang Expand hoặc neo lại`)
        }
      }
  }
  siblingsOf(frame.children, '')
  for (const n of frame.children) if (isContainer(n) && n.type !== 'instance') siblingsOf(n.children, n.name)
  return { device, canvas: { width: cw, height: ch }, safe: safeRect, scale, nodes, issues }
}

/** Builds a copy of the frame with the simulated geometry so it can be rendered with the normal renderer. */
export function frameForSim(frame: FrameNode, sim: SimResult): FrameNode {
  const byId = new Map(sim.nodes.map((n) => [n.id, n]))
  const copy = JSON.parse(JSON.stringify(frame)) as FrameNode
  copy.x = 0
  copy.y = 0
  copy.width = sim.canvas.width
  copy.height = sim.canvas.height
  const apply = (n: SceneNode, parentAbs: { x: number; y: number }): void => {
    const s = byId.get(n.id)
    if (s) {
      n.x = s.rect.x - parentAbs.x
      n.y = s.rect.y - parentAbs.y
      n.width = s.rect.width
      n.height = s.rect.height
      if (isContainer(n)) for (const c of n.children) apply(c, { x: s.rect.x, y: s.rect.y })
    }
  }
  for (const c of copy.children) apply(c, { x: 0, y: 0 })
  return copy
}
