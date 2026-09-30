// Rule-based anchoring: decides Unity anchors / pivot / safe-area for the top-level nodes of a frame
// from where they sit on the screen, so the layout survives other aspect ratios without manual work.
// Pure (used by the app, the bridge and the MCP server).
import type { Anchor, FrameNode, NodeId, SceneNode, Vec2 } from './types'
import { DEFAULT_ANCHOR, DEFAULT_PIVOT } from './types'

export interface AutoAnchorRules {
  /** node covering ≥ this fraction of the frame in BOTH axes → stretch all (default 0.95) */
  fullScreen: number
  /** 9-slice / rect spanning ≥ this fraction of the frame width (or height) → stretch on that axis (default 0.9); plain images/groups are centred instead so bitmaps never distort */
  span: number
  /** |centre − frame centre| ≤ this fraction of the frame size → Center / Middle (default 0.12) */
  centerBand: number
  /** (kept for API compatibility) fraction of the edge band; safe area now follows the anchored edge */
  edgeBand: number
  /** also change nodes whose anchor was already edited by hand (default false) */
  overwrite: boolean
  /** flag nodes anchored to an edge (Top/Bottom/Left/Right) as safeArea so they all shift together under the notch (default true) */
  safeArea: boolean
}

export const DEFAULT_ANCHOR_RULES: AutoAnchorRules = { fullScreen: 0.95, span: 0.9, centerBand: 0.12, edgeBand: 0.1, overwrite: false, safeArea: true }

export interface AnchorSuggestion {
  id: NodeId
  name: string
  anchor: Anchor
  pivot: Vec2
  safeArea: boolean
  /** short human label, e.g. "Bottom-Center" */
  label: string
  reason: string
  /** false when the node already had a hand-edited anchor and overwrite is off */
  apply: boolean
}

const isDefault = (a: Anchor, p: Vec2): boolean => a.minX === DEFAULT_ANCHOR.minX && a.minY === DEFAULT_ANCHOR.minY && a.maxX === DEFAULT_ANCHOR.maxX && a.maxY === DEFAULT_ANCHOR.maxY && p.x === DEFAULT_PIVOT.x && p.y === DEFAULT_PIVOT.y

/** Suggests anchors for the direct children of `frame` (children of groups follow their group). */
export function suggestAnchors(frame: FrameNode, rules: Partial<AutoAnchorRules> = {}): AnchorSuggestion[] {
  const R = { ...DEFAULT_ANCHOR_RULES, ...rules }
  const W = frame.width
  const H = frame.height
  const out: AnchorSuggestion[] = []
  for (const n of frame.children as SceneNode[]) {
    const fullW = n.width >= W * R.fullScreen
    const fullH = n.height >= H * R.fullScreen
    const stretchable = n.type === 'nineslice' || n.type === 'rect'
    const spanW = stretchable && n.width >= W * R.span
    const spanH = stretchable && n.height >= H * R.span
    const cx = n.x + n.width / 2
    const cy = n.y + n.height / 2

    let ax: 'left' | 'center' | 'right' | 'stretch'
    let ay: 'top' | 'middle' | 'bottom' | 'stretch'
    const reasons: string[] = []
    if (fullW && fullH) {
      ax = 'stretch'
      ay = 'stretch'
      reasons.push('phủ cả màn → stretch 4 phía')
    } else {
      if (spanW) {
        ax = 'stretch'
        reasons.push('rộng gần hết màn → giãn ngang')
      } else if (Math.abs(cx - W / 2) <= W * R.centerBand) {
        ax = 'center'
        reasons.push('ở giữa theo chiều ngang')
      } else ax = cx < W / 2 ? 'left' : 'right'
      if (spanH) {
        ay = 'stretch'
        reasons.push('cao gần hết màn → giãn dọc')
      } else if (Math.abs(cy - H / 2) <= H * R.centerBand) {
        ay = 'middle'
        reasons.push('ở giữa theo chiều dọc')
      } else ay = cy < H / 2 ? 'top' : 'bottom'
      if (ax === 'left' || ax === 'right') reasons.push(`nửa ${ax === 'left' ? 'trái' : 'phải'} → neo ${ax === 'left' ? 'Left' : 'Right'}`)
      if (ay === 'top' || ay === 'bottom') reasons.push(`nửa ${ay === 'top' ? 'trên' : 'dưới'} → neo ${ay === 'top' ? 'Top' : 'Bottom'}`)
    }
    const fx = ax === 'left' ? 0 : ax === 'right' ? 1 : 0.5
    const fy = ay === 'top' ? 0 : ay === 'bottom' ? 1 : 0.5
    const anchor: Anchor = { minX: ax === 'stretch' ? 0 : fx, maxX: ax === 'stretch' ? 1 : fx, minY: ay === 'stretch' ? 0 : fy, maxY: ay === 'stretch' ? 1 : fy }
    const pivot: Vec2 = { x: fx, y: fy }
    // everything anchored to an edge moves with the safe area, so a header and the panel under it keep their gap
    const safe = R.safeArea && !(fullW && fullH) && (ay === 'top' || ay === 'bottom' || ax === 'left' || ax === 'right')
    if (safe) reasons.push('neo theo mép → đi theo safe area (tai thỏ / home bar)')
    const label = `${ay === 'stretch' ? 'Stretch' : ay[0].toUpperCase() + ay.slice(1)}-${ax === 'stretch' ? 'Stretch' : ax[0].toUpperCase() + ax.slice(1)}`
    const untouched = isDefault(n.anchor, n.pivot) && !n.safeArea
    out.push({ id: n.id, name: n.name, anchor, pivot, safeArea: safe, label, reason: reasons.join('; '), apply: R.overwrite || untouched })
  }
  return out
}

/** Applies suggestions to a frame draft (immer) — keeps every node exactly where it is on the reference screen. */
export function applyAnchorSuggestions(frame: FrameNode, suggestions: AnchorSuggestion[]): number {
  let n = 0
  for (const s of suggestions) {
    if (!s.apply) continue
    const node = frame.children.find((c) => c.id === s.id)
    if (!node) continue
    node.anchor = { ...s.anchor }
    node.pivot = { ...s.pivot }
    if (s.safeArea) node.safeArea = true
    else delete node.safeArea
    n++
  }
  return n
}
