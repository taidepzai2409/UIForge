import { getCurrentPage, locate, useEditor } from '@/store/editor'
import { absRect, getEntry, cloneNodeDeep, type Rect } from '@/model/nodes'
import { newId } from '@/model/create'
import type { NodeId, SceneNode } from '@/model/types'
import { isContainer } from '@/model/types'

/** Image → 9-slice (and start editing slices); 9-slice → toggle slice editing. */
export function toggleNineSlice(): void {
  const s = useEditor.getState()
  if (s.selection.length !== 1) {
    s.setStatus('Chọn đúng một ảnh để làm 9-slice')
    return
  }
  const page = getCurrentPage()
  const n = getEntry(page, s.selection[0])?.node
  if (!n) return
  if (n.type === 'image') {
    s.convertToNineSlice(n.id)
    s.setEditSlices(true)
    s.setStatus('Đã chuyển thành 9-slice. Kéo 4 đường hồng trên canvas hoặc nhập L/T/R/B ở panel phải. Esc để xong.')
  } else if (n.type === 'nineslice') {
    s.setEditSlices(!s.editSlices)
  } else {
    s.setStatus('Node này không phải ảnh, không làm 9-slice được')
  }
}

export function resetImageSize(): void {
  const s = useEditor.getState()
  const page = getCurrentPage()
  for (const id of s.selection) {
    const n = getEntry(page, id)?.node
    if (!n || (n.type !== 'image' && n.type !== 'nineslice')) continue
    const a = s.doc.assets[n.assetId]
    if (a) s.setNodeProps(id, { width: a.width, height: a.height })
  }
}

// ------------------------------------------------------------------ align / distribute
export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'dist-h' | 'dist-v'

/**
 * Aligns the selection. One node → relative to its parent (frame/group) or the page bounds;
 * several nodes → relative to the selection bounding box. Distribute needs ≥ 3 nodes.
 */
export function alignSelection(kind: AlignKind): void {
  const s = useEditor.getState()
  const page = getCurrentPage()
  const ids = s.selection.filter((id) => {
    const n = getEntry(page, id)?.node
    return n && !n.locked
  })
  if (!ids.length) return
  const rects = new Map<NodeId, Rect>()
  for (const id of ids) {
    const r = absRect(page, id)
    if (r) rects.set(id, r)
  }
  let box: Rect
  if (ids.length === 1) {
    const e = getEntry(page, ids[0])!
    if (e.parent) box = absRect(page, e.parent.id)!
    else {
      // page-level node: align to the union of all top-level frames
      box = rects.get(ids[0])!
      return
    }
  } else {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity
    for (const r of rects.values()) {
      x0 = Math.min(x0, r.x)
      y0 = Math.min(y0, r.y)
      x1 = Math.max(x1, r.x + r.width)
      y1 = Math.max(y1, r.y + r.height)
    }
    box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }
  const moves = new Map<NodeId, { dx: number; dy: number }>()
  if (kind === 'dist-h' || kind === 'dist-v') {
    if (ids.length < 3) return
    const horiz = kind === 'dist-h'
    const sorted = ids.slice().sort((a, b) => (horiz ? rects.get(a)!.x - rects.get(b)!.x : rects.get(a)!.y - rects.get(b)!.y))
    const total = sorted.reduce((acc, id) => acc + (horiz ? rects.get(id)!.width : rects.get(id)!.height), 0)
    const span = horiz ? box.width : box.height
    const gap = (span - total) / (sorted.length - 1)
    let cur = horiz ? box.x : box.y
    for (const id of sorted) {
      const r = rects.get(id)!
      moves.set(id, horiz ? { dx: cur - r.x, dy: 0 } : { dx: 0, dy: cur - r.y })
      cur += (horiz ? r.width : r.height) + gap
    }
  } else {
    for (const id of ids) {
      const r = rects.get(id)!
      let dx = 0
      let dy = 0
      if (kind === 'left') dx = box.x - r.x
      if (kind === 'hcenter') dx = box.x + box.width / 2 - (r.x + r.width / 2)
      if (kind === 'right') dx = box.x + box.width - (r.x + r.width)
      if (kind === 'top') dy = box.y - r.y
      if (kind === 'vcenter') dy = box.y + box.height / 2 - (r.y + r.height / 2)
      if (kind === 'bottom') dy = box.y + box.height - (r.y + r.height)
      moves.set(id, { dx, dy })
    }
  }
  s.updatePage((pg) => {
    for (const [id, m] of moves) {
      const l = locate(pg, id)
      if (!l) continue
      l.node.x = Math.round((l.node.x + m.dx) * 100) / 100
      l.node.y = Math.round((l.node.y + m.dy) * 100) / 100
    }
  })
}

// ------------------------------------------------------------------ clipboard
interface ClipPayload {
  app: 'uiforge-design'
  nodes: SceneNode[]
  /** absolute positions of the copied roots (for pasting in another container) */
  abs: { x: number; y: number }[]
  parentId: NodeId | null
  assets: Record<string, { id: string; file: string; width: number; height: number; source?: string }>
}

let memoryClip: ClipPayload | null = null

export function copySelection(): boolean {
  const s = useEditor.getState()
  const page = getCurrentPage()
  if (!s.selection.length) return false
  // only copy roots (skip nodes whose ancestor is also selected)
  const sel = new Set(s.selection)
  const roots = s.selection.filter((id) => {
    let e = getEntry(page, id)
    while (e?.parent) {
      if (sel.has(e.parent.id)) return false
      e = getEntry(page, e.parent.id)
    }
    return true
  })
  const nodes: SceneNode[] = []
  const abs: { x: number; y: number }[] = []
  const assets: ClipPayload['assets'] = {}
  const collectAssets = (n: SceneNode): void => {
    if ((n.type === 'image' || n.type === 'nineslice') && s.doc.assets[n.assetId]) assets[n.assetId] = s.doc.assets[n.assetId]
    if (isContainer(n)) n.children.forEach(collectAssets)
  }
  // keep z-order of the source list
  roots.sort((a, b) => {
    const ea = getEntry(page, a)!
    const eb = getEntry(page, b)!
    return ea.depth === eb.depth && ea.parent === eb.parent ? ea.index - eb.index : 0
  })
  for (const id of roots) {
    const e = getEntry(page, id)
    if (!e) continue
    nodes.push(JSON.parse(JSON.stringify(e.node)) as SceneNode)
    abs.push({ x: e.absX, y: e.absY })
    collectAssets(e.node)
  }
  const first = getEntry(page, roots[0])
  memoryClip = { app: 'uiforge-design', nodes, abs, parentId: first?.parent?.id ?? null, assets }
  void window.api.copyText(JSON.stringify(memoryClip)).catch(() => {})
  s.setStatus(`Đã copy ${nodes.length} node`)
  return true
}

export function cutSelection(): void {
  if (copySelection()) useEditor.getState().deleteSelection()
}

async function readClip(): Promise<ClipPayload | null> {
  try {
    const t = await window.api.readClipboardText()
    if (t && t.startsWith('{')) {
      const p = JSON.parse(t) as ClipPayload
      if (p.app === 'uiforge-design' && Array.isArray(p.nodes)) return p
    }
  } catch {
    /* clipboard blocked */
  }
  return memoryClip
}

/**
 * Pastes into the current scope / the parent of the selection / the frame under the selection,
 * keeping the copied nodes' local positions (offset by 10px when pasting next to the source).
 */
export async function pasteClipboard(): Promise<void> {
  const clip = await readClip()
  if (!clip || !clip.nodes.length) return
  const s = useEditor.getState()
  const page = getCurrentPage()
  // target container
  let targetId: NodeId | null = null
  if (s.scopeId && getEntry(page, s.scopeId)) targetId = s.scopeId
  else if (s.selection.length) {
    const e = getEntry(page, s.selection[0])
    const n = e?.node
    if (n && n.type === 'frame') targetId = n.id
    else targetId = e?.parent?.id ?? null
  }
  const sameParent = targetId === clip.parentId
  const newIds: NodeId[] = []
  s.update((doc) => {
    for (const [id, a] of Object.entries(clip.assets)) if (!doc.assets[id]) doc.assets[id] = a
    const pg = doc.pages.find((p) => p.id === s.pageId) ?? doc.pages[0]
    const list = targetId ? (locate(pg, targetId)?.node as { children?: SceneNode[] } | undefined)?.children : pg.children
    if (!list) return
    for (const n of clip.nodes) {
      const copy = cloneNodeDeep(n, newId)
      if (sameParent) {
        copy.x += 10
        copy.y += 10
      }
      list.push(copy)
      newIds.push(copy.id)
    }
  })
  s.select(newIds)
  s.setStatus(`Đã paste ${newIds.length} node`)
}

/** Ensures an image node has raw pixels to re-render from (plain imports use their own asset). */
export function ensureSource(id: NodeId): void {
  const s = useEditor.getState()
  const page = getCurrentPage()
  const n = getEntry(page, id)?.node
  if (!n || (n.type !== 'image' && n.type !== 'nineslice')) return
  if (!n.sourceAssetId) s.setNodeProps(id, { sourceAssetId: n.assetId, contentOffset: { x: 0, y: 0 } } as Partial<SceneNode>, { history: false })
}

export function requestRename(): void {
  const s = useEditor.getState()
  if (s.selection.length === 1) window.dispatchEvent(new CustomEvent('dm:rename', { detail: s.selection[0] }))
}
