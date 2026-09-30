// Prototype flows: Figma-style interactions (trigger → action → destination + animation).
// Pure module (no DOM/Pixi) so the MCP server and export can use it too.
import type { Connection, Direction, Easing, NodeId, OverlaySettings, Page, SceneNode, Transition, Trigger } from './types'
import { isContainer } from './types'

export type FlowAction = Connection['action']

export const TRIGGERS: { id: Trigger; label: string; hint: string }[] = [
  { id: 'click', label: 'On click', hint: 'Bấm / chạm' },
  { id: 'hover', label: 'While hovering', hint: 'Rê chuột vào; rời ra thì quay lại' },
  { id: 'press', label: 'While pressing', hint: 'Giữ chuột; thả ra thì quay lại' },
  { id: 'drag', label: 'On drag', hint: 'Kéo trên node' },
  { id: 'after-delay', label: 'After delay', hint: 'Tự chạy sau N ms (đặt trên frame hoặc node)' },
  { id: 'key', label: 'Key press', hint: 'Bấm phím' }
]

export const ACTIONS: { id: FlowAction; label: string; needsTarget: boolean }[] = [
  { id: 'navigate', label: 'Navigate to', needsTarget: true },
  { id: 'overlay', label: 'Open overlay', needsTarget: true },
  { id: 'swap', label: 'Swap overlay', needsTarget: true },
  { id: 'back', label: 'Back', needsTarget: false },
  { id: 'close', label: 'Close overlay', needsTarget: false }
]

export const TRANSITIONS: { id: Transition; label: string; directional: boolean; overlayOk: boolean }[] = [
  { id: 'instant', label: 'Instant', directional: false, overlayOk: true },
  { id: 'dissolve', label: 'Dissolve', directional: false, overlayOk: true },
  { id: 'smart', label: 'Smart animate', directional: false, overlayOk: false },
  { id: 'move-in', label: 'Move in', directional: true, overlayOk: true },
  { id: 'move-out', label: 'Move out', directional: true, overlayOk: false },
  { id: 'push', label: 'Push', directional: true, overlayOk: false },
  { id: 'slide-in', label: 'Slide in', directional: true, overlayOk: true },
  { id: 'slide-out', label: 'Slide out', directional: true, overlayOk: false },
  { id: 'scale-in', label: 'Scale in (pop)', directional: false, overlayOk: true },
  { id: 'scale-out', label: 'Scale out', directional: false, overlayOk: false }
]

export const DIRECTIONS: { id: Direction; label: string; arrow: string }[] = [
  { id: 'left', label: 'Sang trái', arrow: '←' },
  { id: 'right', label: 'Sang phải', arrow: '→' },
  { id: 'up', label: 'Lên', arrow: '↑' },
  { id: 'down', label: 'Xuống', arrow: '↓' }
]

export const EASINGS: { id: Easing; label: string }[] = [
  { id: 'ease-out', label: 'Ease out' },
  { id: 'ease-in', label: 'Ease in' },
  { id: 'ease-in-out', label: 'Ease in & out' },
  { id: 'linear', label: 'Linear' },
  { id: 'back-out', label: 'Back out (overshoot)' },
  { id: 'spring', label: 'Spring' }
]

export const OVERLAY_POSITIONS: { id: OverlaySettings['position']; label: string }[] = [
  { id: 'center', label: 'Giữa' },
  { id: 'top', label: 'Trên' },
  { id: 'bottom', label: 'Dưới' },
  { id: 'left', label: 'Trái' },
  { id: 'right', label: 'Phải' },
  { id: 'top-left', label: 'Trên trái' },
  { id: 'top-right', label: 'Trên phải' },
  { id: 'bottom-left', label: 'Dưới trái' },
  { id: 'bottom-right', label: 'Dưới phải' },
  { id: 'manual', label: 'Tự đặt (x,y)' }
]

export const DEFAULT_OVERLAY: OverlaySettings = { position: 'center', dim: true, dimColor: '#000000', dimOpacity: 0.5, closeOutside: true }

/** Default animation per action, so a freshly drawn flow already looks right. */
export function defaultsForAction(action: FlowAction): Pick<Connection, 'transition' | 'direction' | 'duration' | 'easing'> {
  switch (action) {
    case 'overlay':
    case 'swap':
      return { transition: 'scale-in', duration: 250, easing: 'back-out' }
    case 'close':
    case 'back':
      return { transition: 'dissolve', duration: 200, easing: 'ease-out' }
    default:
      return { transition: 'dissolve', duration: 300, easing: 'ease-out' }
  }
}

/** Upgrades connections written by older versions (boolean overlay, slide-* transitions, no action). */
export function normalizeConnection(raw: Connection): Connection {
  const c = { ...raw } as Connection & { overlay?: boolean | OverlaySettings }
  const legacy = c.transition as string
  if (legacy === 'slide-left' || legacy === 'slide-right' || legacy === 'slide-up' || legacy === 'slide-down') {
    c.transition = 'move-in'
    c.direction = legacy.slice(6) as Direction
  }
  if (legacy === 'push' && !c.direction) c.direction = 'left'
  if (!c.action) c.action = (c.overlay as unknown) === true ? 'overlay' : 'navigate'
  if (typeof c.overlay === 'boolean') c.overlay = c.overlay ? { ...DEFAULT_OVERLAY } : undefined
  if ((c.action === 'overlay' || c.action === 'swap') && !c.overlay) c.overlay = { ...DEFAULT_OVERLAY }
  if (!c.easing) c.easing = 'ease-out'
  if (!Number.isFinite(c.duration)) c.duration = 300
  if (c.trigger === 'after-delay' && c.delay === undefined) c.delay = 1000
  return c as Connection
}

export function normalizePage(page: Page): void {
  page.connections = (page.connections ?? []).map(normalizeConnection)
}

/** Owning top-level frame id of a node on a page. */
export function ownerFrameId(page: Page, nodeId: NodeId): NodeId | null {
  for (const c of page.children) {
    if (c.type !== 'frame') continue
    if (c.id === nodeId || contains(c, nodeId)) return c.id
  }
  return null
}

function contains(n: SceneNode, id: NodeId): boolean {
  if (!isContainer(n)) return false
  for (const c of n.children) if (c.id === id || contains(c, id)) return true
  return false
}

export function triggerLabel(c: Connection): string {
  switch (c.trigger) {
    case 'after-delay':
      return `after ${c.delay ?? 1000}ms`
    case 'key':
      return `key ${c.key ?? '?'}`
    default:
      return TRIGGERS.find((t) => t.id === c.trigger)?.label.replace(/^(On|While) /, '').toLowerCase() ?? c.trigger
  }
}

export function actionLabel(c: Connection, targetName?: string): string {
  switch (c.action) {
    case 'back':
      return '↩ back'
    case 'close':
      return '✕ close overlay'
    case 'overlay':
      return `⧉ overlay ${targetName ?? ''}`.trim()
    case 'swap':
      return `⇄ swap ${targetName ?? ''}`.trim()
    default:
      return `→ ${targetName ?? ''}`.trim()
  }
}

export function transitionLabel(c: Connection): string {
  const t = TRANSITIONS.find((x) => x.id === c.transition)
  if (!t) return c.transition
  const d = t.directional ? ` ${DIRECTIONS.find((x) => x.id === (c.direction ?? 'left'))?.arrow ?? ''}` : ''
  return `${t.label}${d}${c.transition !== 'instant' ? ` ${c.duration}ms` : ''}`
}

// ------------------------------------------------------------------ easing
export function ease(k: number, e: Easing = 'ease-out'): number {
  const t = Math.max(0, Math.min(1, k))
  switch (e) {
    case 'linear':
      return t
    case 'ease-in':
      return t * t * t
    case 'ease-in-out':
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    case 'back-out': {
      const c1 = 1.70158
      const c3 = c1 + 1
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
    }
    case 'spring': {
      if (t === 0 || t === 1) return t
      return Math.pow(2, -10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1
    }
    default:
      return 1 - Math.pow(1 - t, 3)
  }
}

/** The transition that undoes `c` (used by Back / Close overlay / hover-leave / press-release). */
export function reverseTransition(c: Connection): Pick<Connection, 'transition' | 'direction' | 'duration' | 'easing'> {
  const flip: Record<Direction, Direction> = { left: 'right', right: 'left', up: 'down', down: 'up' }
  const dir = c.direction ? flip[c.direction] : undefined
  const map: Partial<Record<Transition, Transition>> = { 'move-in': 'move-out', 'move-out': 'move-in', 'slide-in': 'slide-out', 'slide-out': 'slide-in', 'scale-in': 'scale-out', 'scale-out': 'scale-in' }
  return { transition: map[c.transition] ?? c.transition, direction: dir, duration: c.duration, easing: c.easing === 'back-out' ? 'ease-in' : c.easing }
}

/** Where an overlay frame sits inside the base frame (frame units). */
export function overlayPosition(base: { width: number; height: number }, ov: { width: number; height: number }, s: OverlaySettings): { x: number; y: number } {
  const cx = (base.width - ov.width) / 2
  const cy = (base.height - ov.height) / 2
  const right = base.width - ov.width
  const bottom = base.height - ov.height
  switch (s.position) {
    case 'top':
      return { x: cx, y: 0 }
    case 'bottom':
      return { x: cx, y: bottom }
    case 'left':
      return { x: 0, y: cy }
    case 'right':
      return { x: right, y: cy }
    case 'top-left':
      return { x: 0, y: 0 }
    case 'top-right':
      return { x: right, y: 0 }
    case 'bottom-left':
      return { x: 0, y: bottom }
    case 'bottom-right':
      return { x: right, y: bottom }
    case 'manual':
      return { x: s.x ?? cx, y: s.y ?? cy }
    default:
      return { x: cx, y: cy }
  }
}
