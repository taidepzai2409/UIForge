// Re-renders an image node's layer style from its raw pixels (sourceAssetId) whenever the
// user edits `node.effects` in the app. Produces a new derived asset and keeps the node's
// visual position/scale stable (the effect margin may grow or shrink).
import type { LayerEffectsInfo, PatternInfo } from 'ag-psd'
import type { Asset, GroupNode, ImageNode, NineSliceNode, NodeId, SceneNode } from '@/model/types'
import { isContainer } from '@/model/types'
import { rasterizeText } from '@/canvas/textRaster'
import { createImage } from '@/model/create'
import { getCurrentPage, locate, useEditor } from '@/store/editor'
import { getEntry } from '@/model/nodes'
import { getAssetBytes, pngFromCanvas, putAssetBytes, safeFileName, sha256Hex } from '@/store/assets'
import { applyLayerEffects, hasEnabledEffects } from './effects'
import { applyAdjustment, supportedAdjustment } from './adjustments'
import type { ImageEdits } from '@/model/types'

async function canvasFromAsset(asset: Asset): Promise<HTMLCanvasElement | null> {
  const bytes = await getAssetBytes(asset)
  if (!bytes) return null
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }))
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  return c
}

/** Loads the project's stored patterns as ag-psd-like PatternInfo (RGBA data) for the effects renderer. */
export async function loadPatternInfos(): Promise<PatternInfo[]> {
  const doc = useEditor.getState().doc
  const out: PatternInfo[] = []
  for (const [id, p] of Object.entries(doc.patterns ?? {})) {
    const asset = doc.assets[p.assetId]
    if (!asset) continue
    const c = await canvasFromAsset(asset)
    if (!c) continue
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    out.push({ id, name: p.name, x: 0, y: 0, bounds: { x: 0, y: 0, w: c.width, h: c.height }, data: new Uint8Array(data.buffer) })
  }
  return out
}

export function globalAngle(): number {
  return useEditor.getState().doc.globalLight?.angle ?? 120
}

let pending = new Map<NodeId, number>()

/** Debounced re-render (effects editing fires many changes per second). */
export function scheduleRestyle(nodeId: NodeId, delay = 120): void {
  const t = pending.get(nodeId)
  if (t) window.clearTimeout(t)
  pending.set(
    nodeId,
    window.setTimeout(() => {
      pending.delete(nodeId)
      void restyleNode(nodeId)
    }, delay)
  )
}

/** Draws a node subtree (rendered assets + text) into one canvas; returns canvas + its position relative to `origin`. */
async function compositeNodes(nodes: SceneNode[], ox: number, oy: number): Promise<{ canvas: HTMLCanvasElement; left: number; top: number } | null> {
  const doc = useEditor.getState().doc
  const items: { c: HTMLCanvasElement; x: number; y: number; w: number; h: number; alpha: number }[] = []
  const walk = async (list: SceneNode[], px: number, py: number): Promise<void> => {
    for (const n of list) {
      if (!n.visible) continue
      const ax = px + n.x
      const ay = py + n.y
      if (isContainer(n)) {
        await walk(n.children, ax, ay)
        continue
      }
      if (n.type === 'image' || n.type === 'nineslice') {
        const a = doc.assets[n.assetId]
        if (!a) continue
        const c = await canvasFromAsset(a)
        if (c) items.push({ c, x: ax, y: ay, w: n.width, h: n.height, alpha: n.opacity })
      } else if (n.type === 'text') {
        const r = rasterizeText(n, 1)
        items.push({ c: r.canvas, x: ax + r.left, y: ay + r.top, w: r.canvas.width, h: r.canvas.height, alpha: n.opacity })
      }
    }
  }
  await walk(nodes, ox, oy)
  if (!items.length) return null
  const x0 = Math.floor(Math.min(...items.map((i) => i.x)))
  const y0 = Math.floor(Math.min(...items.map((i) => i.y)))
  const x1 = Math.ceil(Math.max(...items.map((i) => i.x + i.w)))
  const y1 = Math.ceil(Math.max(...items.map((i) => i.y + i.h)))
  const c = document.createElement('canvas')
  c.width = Math.max(1, x1 - x0)
  c.height = Math.max(1, y1 - y0)
  const g = c.getContext('2d')!
  for (const it of items) {
    g.globalAlpha = it.alpha
    g.drawImage(it.c, it.x - x0, it.y - y0, it.w, it.h)
  }
  return { canvas: c, left: x0, top: y0 }
}

function isBlank(c: HTMLCanvasElement): boolean {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
  for (let i = 3; i < d.length; i += 4) if (d[i] > 2) return false
  return true
}

/** Re-renders a group's "(style below)" / "(style above)" images from its (non-style) children. */
export async function restyleGroup(groupId: NodeId): Promise<void> {
  const s = useEditor.getState()
  const page = getCurrentPage()
  const g = getEntry(page, groupId)?.node as GroupNode | undefined
  if (!g || g.type !== 'group') return
  const isStyle = (n: SceneNode): boolean => !!(n.meta && (n.meta as { psdGroupStyle?: string }).psdGroupStyle)
  const content = g.children.filter((n) => !isStyle(n))
  const fx = g.effects as LayerEffectsInfo | undefined
  const comp = fx && hasEnabledEffects(fx) ? await compositeNodes(content, 0, 0) : null
  const parts: { kind: 'below' | 'above'; r: { canvas: HTMLCanvasElement; left: number; top: number } }[] = []
  if (comp && fx) {
    const patterns = await loadPatternInfos()
    const below = applyLayerEffects(comp, fx, globalAngle(), () => {}, patterns, { part: 'below' })
    const above = applyLayerEffects(comp, fx, globalAngle(), () => {}, patterns, { part: 'above' })
    if (!isBlank(below.canvas)) parts.push({ kind: 'below', r: below })
    if (!isBlank(above.canvas)) parts.push({ kind: 'above', r: above })
  }
  const newAssets: Asset[] = []
  const nodesByKind: Record<string, ImageNode> = {}
  for (const p of parts) {
    const png = await pngFromCanvas(p.r.canvas)
    const id = (await sha256Hex(png)).slice(0, 16)
    putAssetBytes(id, png)
    if (!s.doc.assets[id]) newAssets.push({ id, file: `${safeFileName(g.name)}_style_${p.kind}_${id.slice(0, 8)}.png`, width: p.r.canvas.width, height: p.r.canvas.height, source: `group style ${p.kind}` })
    const img = createImage(`${g.name} (style ${p.kind})`, p.r.left, p.r.top, p.r.canvas.width, p.r.canvas.height, id)
    img.meta = { psdGroupStyle: p.kind }
    img.locked = true
    nodesByKind[p.kind] = img
  }
  s.update((doc) => {
    for (const a of newAssets) doc.assets[a.id] = a
    const pg = doc.pages.find((p) => p.id === s.pageId) ?? doc.pages[0]
    const l = locate(pg, groupId)
    if (!l || l.node.type !== 'group') return
    const kept = l.node.children.filter((n) => !isStyle(n))
    // positions are relative to the group; compositeNodes used the same local space (ox=oy=0)
    l.node.children = [...(nodesByKind.below ? [nodesByKind.below] : []), ...kept, ...(nodesByKind.above ? [nodesByKind.above] : [])]
  }, { history: false })
}

/** Applies non-destructive image edits (crop → flip → rotate → adjustments) to a source canvas. */
export function applyImageEdits(src: HTMLCanvasElement, edits: ImageEdits | undefined): HTMLCanvasElement {
  if (!edits) return src
  let c = src
  if (edits.crop) {
    const cr = edits.crop
    const x = Math.max(0, Math.min(src.width - 1, Math.round(cr.x)))
    const y = Math.max(0, Math.min(src.height - 1, Math.round(cr.y)))
    const w = Math.max(1, Math.min(src.width - x, Math.round(cr.width)))
    const h = Math.max(1, Math.min(src.height - y, Math.round(cr.height)))
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    out.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, w, h)
    c = out
  }
  const rot = edits.rotate ?? 0
  if (edits.flipH || edits.flipV || rot) {
    const swap = rot === 90 || rot === 270
    const out = document.createElement('canvas')
    out.width = swap ? c.height : c.width
    out.height = swap ? c.width : c.height
    const g = out.getContext('2d')!
    g.translate(out.width / 2, out.height / 2)
    g.rotate((rot * Math.PI) / 180)
    g.scale(edits.flipH ? -1 : 1, edits.flipV ? -1 : 1)
    g.drawImage(c, -c.width / 2, -c.height / 2)
    c = out
  }
  for (const adj of edits.adjustments ?? []) if (supportedAdjustment(adj)) c = applyAdjustment(c, adj, null)
  return c
}

export async function restyleNode(nodeId: NodeId): Promise<void> {
  const s = useEditor.getState()
  const page = getCurrentPage()
  const e = getEntry(page, nodeId)
  const n = e?.node
  if (n && n.type === 'group') return restyleGroup(nodeId)
  if (!n || (n.type !== 'image' && n.type !== 'nineslice')) return
  const node = n as ImageNode | NineSliceNode
  if (!node.sourceAssetId) return
  const src = s.doc.assets[node.originalAssetId ?? node.sourceAssetId]
  const cur = s.doc.assets[node.assetId]
  if (!src) return
  const raw0 = await canvasFromAsset(src)
  if (!raw0) return
  const raw = applyImageEdits(raw0, node.edits)
  const off = node.contentOffset ?? { x: 0, y: 0 }
  // visual scale the user applied to the node (rendered asset px → node px)
  const sx = cur ? node.width / cur.width : 1
  const sy = cur ? node.height / cur.height : 1
  const fx = node.effects as LayerEffectsInfo | undefined
  let rendered = { canvas: raw, left: 0, top: 0 }
  if (fx && hasEnabledEffects(fx)) {
    const patterns = await loadPatternInfos()
    rendered = applyLayerEffects({ canvas: raw, left: 0, top: 0 }, fx, globalAngle(), (m) => s.setStatus(`Layer style: ${m}`), patterns, { fillOpacity: node.fillOpacity ?? 1 })
  } else if ((node.fillOpacity ?? 1) < 1) {
    const c = document.createElement('canvas')
    c.width = raw.width
    c.height = raw.height
    const g = c.getContext('2d')!
    g.globalAlpha = node.fillOpacity ?? 1
    g.drawImage(raw, 0, 0)
    rendered = { canvas: c, left: 0, top: 0 }
  }
  const png = await pngFromCanvas(rendered.canvas)
  const id = (await sha256Hex(png)).slice(0, 16)
  const newOffset = { x: -rendered.left, y: -rendered.top } // raw content position inside the rendered canvas
  putAssetBytes(id, png)
  const asset: Asset = s.doc.assets[id] ?? { id, file: `${safeFileName(node.name)}_${id.slice(0, 8)}.png`, width: rendered.canvas.width, height: rendered.canvas.height, source: src.source ? `${src.source} (styled)` : undefined }
  // keep the raw content where it was on screen: node.x + off.x*sx == newX + newOffset.x*sx
  const newX = node.x + off.x * sx - newOffset.x * sx
  const newY = node.y + off.y * sy - newOffset.y * sy
  s.update(
    (doc) => {
      if (!doc.assets[id]) doc.assets[id] = asset
    },
    { history: false }
  )
  s.setNodeProps(
    nodeId,
    {
      assetId: id,
      contentOffset: newOffset,
      x: Math.round(newX * 100) / 100,
      y: Math.round(newY * 100) / 100,
      width: Math.round(rendered.canvas.width * sx * 100) / 100,
      height: Math.round(rendered.canvas.height * sy * 100) / 100
    } as Partial<ImageNode>,
    { history: false }
  )
}
