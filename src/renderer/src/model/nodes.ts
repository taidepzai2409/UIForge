import type { ContainerNode, NodeId, Page, SceneNode } from './types'
import { isContainer } from './types'

export interface NodeEntry {
  node: SceneNode
  parent: ContainerNode | null
  /** index inside parent's children (or page.children) */
  index: number
  depth: number
  /** absolute position (ignores rotation of ancestors) */
  absX: number
  absY: number
  path: string
}

export interface PageIndex {
  byId: Map<NodeId, NodeEntry>
  order: NodeId[] // depth-first, bottom-to-top render order
}

const indexCache = new WeakMap<Page, PageIndex>()

export function indexPage(page: Page): PageIndex {
  let idx = indexCache.get(page)
  if (idx) return idx
  const byId = new Map<NodeId, NodeEntry>()
  const order: NodeId[] = []
  const visit = (nodes: SceneNode[], parent: ContainerNode | null, depth: number, ox: number, oy: number, pathPrefix: string): void => {
    nodes.forEach((n, i) => {
      const absX = ox + n.x
      const absY = oy + n.y
      const path = pathPrefix ? `${pathPrefix}/${n.name}` : n.name
      byId.set(n.id, { node: n, parent, index: i, depth, absX, absY, path })
      order.push(n.id)
      if (isContainer(n)) visit(n.children, n, depth + 1, absX, absY, path)
    })
  }
  visit(page.children, null, 0, 0, 0, '')
  idx = { byId, order }
  indexCache.set(page, idx)
  return idx
}

export function getNode(page: Page, id: NodeId): SceneNode | undefined {
  return indexPage(page).byId.get(id)?.node
}

export function getEntry(page: Page, id: NodeId): NodeEntry | undefined {
  return indexPage(page).byId.get(id)
}

export function siblingsOf(page: Page, id: NodeId): SceneNode[] {
  const e = getEntry(page, id)
  if (!e) return []
  return e.parent ? e.parent.children : page.children
}

/** Walks ancestors from the node's parent up to the root. */
export function ancestorsOf(page: Page, id: NodeId): ContainerNode[] {
  const out: ContainerNode[] = []
  let e = getEntry(page, id)
  while (e && e.parent) {
    out.push(e.parent)
    e = getEntry(page, e.parent.id)
  }
  return out
}

export function topLevelFrameOf(page: Page, id: NodeId): SceneNode | undefined {
  const anc = ancestorsOf(page, id)
  const top = anc.length ? anc[anc.length - 1] : getNode(page, id)
  return top
}

export function isDescendant(page: Page, id: NodeId, maybeAncestorId: NodeId): boolean {
  return ancestorsOf(page, id).some((a) => a.id === maybeAncestorId)
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function absRect(page: Page, id: NodeId): Rect | undefined {
  const e = getEntry(page, id)
  if (!e) return undefined
  return { x: e.absX, y: e.absY, width: e.node.width, height: e.node.height }
}

export function unionRects(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width)
    y1 = Math.max(y1, r.y + r.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export function rectContains(r: Rect, px: number, py: number): boolean {
  return px >= r.x && py >= r.y && px <= r.x + r.width && py <= r.y + r.height
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Point-in-node test honoring rotation around pivot. Point is in absolute page space. */
export function hitNode(page: Page, n: SceneNode, px: number, py: number): boolean {
  const e = getEntry(page, n.id)
  if (!e) return false
  if (!n.rotation) return px >= e.absX && py >= e.absY && px <= e.absX + n.width && py <= e.absY + n.height
  // rotate point into node's local space
  const cx = e.absX + n.pivot.x * n.width
  const cy = e.absY + n.pivot.y * n.height
  const rad = (-n.rotation * Math.PI) / 180
  const dx = px - cx
  const dy = py - cy
  const lx = cx + dx * Math.cos(rad) - dy * Math.sin(rad)
  const ly = cy + dx * Math.sin(rad) + dy * Math.cos(rad)
  return lx >= e.absX && ly >= e.absY && lx <= e.absX + n.width && ly <= e.absY + n.height
}

/**
 * Returns the chain of nodes under a point, outermost first (e.g. [frame, group, image]).
 * Only visible nodes are considered. Locked nodes are still returned (callers filter).
 */
export function hitChain(page: Page, px: number, py: number): SceneNode[] {
  const chain: SceneNode[] = []
  const search = (nodes: SceneNode[]): void => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      if (!n.visible) continue
      if (isContainer(n)) {
        // groups/instances: test children (bounds are just the union of children)
        if (n.type === 'group' || n.type === 'instance') {
          const before = chain.length
          chain.push(n)
          search(n.children)
          if (chain.length === before + 1) chain.pop() // nothing hit inside
          else return
          continue
        }
        // frames: hit their own rect, then descend
        if (hitNode(page, n, px, py)) {
          chain.push(n)
          search(n.children)
          return
        }
        continue
      }
      if (hitNode(page, n, px, py)) {
        chain.push(n)
        return
      }
    }
  }
  search(page.children)
  return chain
}

/** All nodes (ids) whose absolute rect intersects the given rect, restricted to direct children of scope. */
export function nodesInRect(page: Page, scope: ContainerNode | null, r: Rect): NodeId[] {
  const list = scope ? scope.children : page.children
  const out: NodeId[] = []
  for (const n of list) {
    if (!n.visible || n.locked) continue
    const ar = absRect(page, n.id)
    if (ar && rectsIntersect(ar, r)) out.push(n.id)
  }
  return out
}

export function cloneNodeDeep<T extends SceneNode>(n: T, newId: () => string): T {
  const copy = JSON.parse(JSON.stringify(n)) as T
  const reid = (node: SceneNode): void => {
    node.id = newId()
    if (isContainer(node)) node.children.forEach(reid)
  }
  reid(copy)
  return copy
}

export function collectAssetIds(nodes: SceneNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.type === 'image' || n.type === 'nineslice') {
      out.add(n.assetId)
      if (n.sourceAssetId) out.add(n.sourceAssetId)
    }
    if (isContainer(n)) collectAssetIds(n.children, out)
  }
  return out
}

/** Recomputes a group's bounds from its children and shifts children so they stay in place. */
export function fitGroup(g: ContainerNode): void {
  if ((g.type !== 'group' && g.type !== 'instance') || g.children.length === 0) return
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  // groups with auto layout ignore hidden children (Unity's ContentSizeFitter ignores inactive objects)
  const layoutOnly = g.type === 'group' && !!g.layout && g.children.some((c) => c.visible)
  for (const c of g.children) {
    if (layoutOnly && !c.visible) continue
    x0 = Math.min(x0, c.x)
    y0 = Math.min(y0, c.y)
    x1 = Math.max(x1, c.x + c.width)
    y1 = Math.max(y1, c.y + c.height)
  }
  const dx = x0
  const dy = y0
  if (dx === 0 && dy === 0 && g.width === x1 - x0 && g.height === y1 - y0) return
  for (const c of g.children) {
    c.x -= dx
    c.y -= dy
  }
  g.x += dx
  g.y += dy
  g.width = x1 - x0
  g.height = y1 - y0
}

/** Re-fit every group from the leaves upward (call after mutating a draft). */
export function fitAllGroups(nodes: SceneNode[]): void {
  for (const n of nodes) {
    if (isContainer(n)) {
      fitAllGroups(n.children)
      fitGroup(n)
    }
  }
}
