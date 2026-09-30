import type { ContainerNode, SceneNode } from './types'
import { isContainer } from './types'

/**
 * Applies auto layout (row/column, gap, padding, alignment) to every container that has one.
 * Children keep their array order (bottom-to-top = first-to-last along the main axis).
 * Runs inside the store's post-mutation pass, so positions are always consistent.
 */
export function applyAutoLayouts(nodes: SceneNode[]): void {
  for (const n of nodes) {
    if (!isContainer(n)) continue
    applyAutoLayouts(n.children)
    if (n.type === 'instance') continue // instances copy the master's already laid-out children
    if (n.layout) layoutContainer(n)
  }
}

export function layoutContainer(c: ContainerNode): void {
  if (c.type === 'instance' || !c.layout) return
  const L = c.layout
  const kids = c.children.filter((k) => k.visible)
  if (!kids.length) return
  const horiz = L.direction === 'horizontal'
  const pad = L.padding
  // hidden children are skipped by Unity's layout groups (inactive) → park them at the content origin
  for (const k of c.children) {
    if (k.visible) continue
    k.x = c.type === 'group' ? 0 : pad.left
    k.y = c.type === 'group' ? 0 : pad.top
  }
  // content size
  const mainSum = kids.reduce((acc, k) => acc + (horiz ? k.width : k.height), 0) + L.gap * (kids.length - 1)
  const crossMax = Math.max(...kids.map((k) => (horiz ? k.height : k.width)))
  const hug = c.type === 'group' ? true : L.hug
  const innerMain = hug ? mainSum : (horiz ? c.width : c.height) - (horiz ? pad.left + pad.right : pad.top + pad.bottom)
  const innerCross = hug ? crossMax : (horiz ? c.height : c.width) - (horiz ? pad.top + pad.bottom : pad.left + pad.right)
  let cursor = horiz ? pad.left : pad.top
  for (const k of kids) {
    const kMain = horiz ? k.width : k.height
    const kCross = horiz ? k.height : k.width
    let cross = horiz ? pad.top : pad.left
    if (L.align === 'center') cross += (innerCross - kCross) / 2
    else if (L.align === 'end') cross += innerCross - kCross
    if (horiz) {
      k.x = Math.round(cursor * 100) / 100
      k.y = Math.round(cross * 100) / 100
    } else {
      k.y = Math.round(cursor * 100) / 100
      k.x = Math.round(cross * 100) / 100
    }
    cursor += kMain + L.gap
  }
  if (hug && c.type === 'frame') {
    c.width = Math.round((horiz ? innerMain + pad.left + pad.right : innerCross + pad.left + pad.right) * 100) / 100
    c.height = Math.round((horiz ? innerCross + pad.top + pad.bottom : innerMain + pad.top + pad.bottom) * 100) / 100
  }
  // groups: fitGroup() (run after this pass) will re-fit the bounds to the children
}
