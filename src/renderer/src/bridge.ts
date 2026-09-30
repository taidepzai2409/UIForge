// Renderer side of the local automation bridge. The main process runs a tiny HTTP
// server on 127.0.0.1 (see src/main/bridge.ts); requests are forwarded here over IPC.
// The MCP server (mcp/server.ts) uses these methods when the app is running.
import type { AutoLayout, Connection, DesignDocument, FrameNode, GroupNode, ImageEdits, InstanceOverride, NodeId, OverlaySettings, Page, SceneNode, Transition, Trigger } from '@/model/types'
import { DEFAULT_OVERLAY } from '@/model/flows'
import { createFrame, createGroup, createImage, createNineSlice, createRect, createText } from '@/model/create'
import { pngFromCanvas, putAssetBytes, sha256Hex } from '@/store/assets'
import { safeFileName } from '@/model/naming'
import { hexToRgba as hexToRgbaOrNull } from '@/model/color'
import type { RGBA } from '@/model/types'
const hexToRgba = (h: string): RGBA => hexToRgbaOrNull(h) ?? { r: 255, g: 255, b: 255, a: 1 }
import type { Asset } from '@/model/types'
import { isContainer } from '@/model/types'
import { findMaster } from '@/model/instances'
import { DEFAULT_PREVIEW_DEVICES, DEVICE_PRESETS, frameForSim, scalerOf, simulateFrame } from '@/model/simulate'
import type { CanvasScalerSettings } from '@/model/types'

function scalerArg(p: Record<string, unknown>): CanvasScalerSettings {
  if (p.scaler && typeof p.scaler === 'object') return { mode: ((p.scaler as CanvasScalerSettings).mode ?? 'expand') as CanvasScalerSettings['mode'], match: Number((p.scaler as CanvasScalerSettings).match ?? 0) }
  return scalerOf(useEditor.getState().doc, typeof p.match === 'number' ? p.match : undefined)
}
import { compareFrame } from '@/canvas/compare'
import { suggestAnchors, type AutoAnchorRules } from '@/model/autoAnchor'
import { indexPage } from '@/model/nodes'
import { getCurrentPage, locate, useEditor } from '@/store/editor'
import { exportLayout, importPsdFiles, openProject, saveProject } from '@/store/project'
import { buildFrameLayout, buildPageManifest } from '@/export/layout'
import { renderFramePng } from '@/canvas/render'
import { ackGame, ensureGameProject, pendingChanges, pushGameDesign, replaceFromFolder, replaceNodeArt, replaceSource, runGameAgent, syncGame } from '@/store/game'
import { buildChangesMarkdown, gameSources, type GameDesign } from '@/model/game'

type Params = Record<string, unknown>
type Handler = (p: Params) => Promise<unknown>

function doc(): DesignDocument {
  return useEditor.getState().doc
}

function findFrame(ref: string): { page: Page; frame: FrameNode } {
  const d = doc()
  const lower = String(ref).toLowerCase()
  for (const page of d.pages) {
    for (const c of page.children) {
      if (c.type === 'frame' && (c.id === ref || c.name.toLowerCase() === lower)) return { page, frame: c }
    }
  }
  throw new Error(`Không tìm thấy frame "${ref}"`)
}

function findNode(ref: string): { page: Page; node: SceneNode } {
  const d = doc()
  const lower = String(ref).toLowerCase()
  let byName: { page: Page; node: SceneNode } | null = null
  for (const page of d.pages) {
    const idx = indexPage(page)
    const e = idx.byId.get(ref)
    if (e) return { page, node: e.node }
    for (const en of idx.byId.values()) {
      if (en.path.toLowerCase() === lower || (en.path.toLowerCase().endsWith('/' + lower) && !byName)) return { page, node: en.node }
      if (!byName && en.node.name.toLowerCase() === lower) byName = { page, node: en.node }
    }
  }
  if (byName) return byName
  throw new Error(`Không tìm thấy node "${ref}"`)
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  return btoa(s)
}

const ALLOWED_DOC_PROPS = new Set(['scaler', 'previewDevices', 'globalLight'])
const ALLOWED_PROPS = new Set(['name', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked', 'anchor', 'pivot', 'insets', 'text', 'fontSize', 'fontFamily', 'fontWeight', 'color', 'align', 'fill', 'cornerRadius', 'clipsContent', 'meta', 'blendMode', 'effects', 'fillOpacity', 'safeArea', 'layout', 'edits', 'letterSpacing', 'lineHeight', 'italic', 'uppercase', 'stroke', 'shape', 'autoSize', 'component'])

function findComponent(ref: string): { page: Page; node: FrameNode | GroupNode; path: string } {
  const d = doc()
  const lower = String(ref).toLowerCase()
  for (const page of d.pages) {
    for (const e of indexPage(page).byId.values()) {
      const n = e.node
      if ((n.type === 'frame' || n.type === 'group') && n.component && (n.id === ref || n.component.name.toLowerCase() === lower || e.path.toLowerCase() === lower)) return { page, node: n, path: e.path }
    }
  }
  throw new Error(`Không tìm thấy component "${ref}"`)
}

function listComponents(): { id: NodeId; name: string; page: string; path: string; width: number; height: number; instances: number }[] {
  const d = doc()
  const out: { id: NodeId; name: string; page: string; path: string; width: number; height: number; instances: number }[] = []
  const count = new Map<NodeId, number>()
  const walk = (list: SceneNode[]): void => {
    for (const c of list) {
      if (c.type === 'instance') count.set(c.componentId, (count.get(c.componentId) ?? 0) + 1)
      if (isContainer(c) && c.type !== 'instance') walk(c.children)
    }
  }
  for (const page of d.pages) walk(page.children)
  for (const page of d.pages) {
    for (const e of indexPage(page).byId.values()) {
      const n = e.node
      if ((n.type === 'frame' || n.type === 'group') && n.component) out.push({ id: n.id, name: n.component.name, page: page.name, path: e.path, width: n.width, height: n.height, instances: count.get(n.id) ?? 0 })
    }
  }
  return out
}

export interface BridgeOp {
  op: 'setNodeProps' | 'addConnection' | 'removeConnection' | 'setStartFrame' | 'convertToNineSlice' | 'convertToImage' | 'select' | 'setPage' | 'deleteNode' | 'createComponent' | 'createInstance' | 'detachInstance' | 'setLayout' | 'setOverride' | 'setImageEdits' | 'autoAnchor' | 'addNode' | 'groupNodes' | 'addState'
  [k: string]: unknown
}

/** Registers a PNG (or a cropped region of it) as a project asset. */
async function assetFromFile(path: string, crop?: { x: number; y: number; width: number; height: number }, name?: string): Promise<Asset> {
  const bytes = await window.api.readFile(path)
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]))
  const c = document.createElement('canvas')
  const r = crop ? { x: Math.max(0, Math.round(crop.x)), y: Math.max(0, Math.round(crop.y)), width: Math.max(1, Math.round(crop.width)), height: Math.max(1, Math.round(crop.height)) } : { x: 0, y: 0, width: bmp.width, height: bmp.height }
  c.width = r.width
  c.height = r.height
  c.getContext('2d')!.drawImage(bmp, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height)
  bmp.close()
  const png = await pngFromCanvas(c)
  const id = (await sha256Hex(png)).slice(0, 16)
  const base = path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  const asset: Asset = { id, file: `${safeFileName(name ?? base)}_${id.slice(0, 8)}.png`, width: r.width, height: r.height, source: crop ? `file:${path} crop ${r.x},${r.y} ${r.width}x${r.height}` : `file:${path}` }
  useEditor.getState().update((d) => {
    if (!d.assets[id]) d.assets[id] = asset
  }, { history: false })
  putAssetBytes(id, png)
  return asset
}

function resolveParent(ref: unknown): { page: Page; id: NodeId | null } {
  if (!ref) return { page: getCurrentPage(), id: null }
  const { page, node } = findNode(String(ref))
  if (!isContainer(node)) throw new Error(`${node.name} không phải frame/group`)
  return { page, id: node.id }
}

/** Ops that need async work (image decoding) run here before the sync ones. */
async function applyAsyncOp(op: BridgeOp, log: string[]): Promise<boolean> {
  const st = useEditor.getState()
  if (op.op !== 'addNode') return false
  const type = String(op.type ?? 'rect')
  const name = String(op.name ?? type)
  const x = Number(op.x ?? 0)
  const y = Number(op.y ?? 0)
  const w = Number(op.width ?? 100)
  const h = Number(op.height ?? 100)
  const { page, id: parentId } = resolveParent(op.parent)
  if (st.pageId !== page.id) st.setPage(page.id)
  let node: SceneNode
  switch (type) {
    case 'frame': {
      const f = createFrame(name, x, y, w, h)
      if (op.fill) f.fill = { color: hexToRgba(String(op.fill)), visible: true }
      else if (op.fill === null) f.fill.visible = false
      node = f
      break
    }
    case 'group':
      node = createGroup(name, x, y, w, h)
      break
    case 'text': {
      const t = createText(name, x, y, String(op.text ?? name))
      if (op.fontSize) t.fontSize = Number(op.fontSize)
      if (op.fontFamily) t.fontFamily = String(op.fontFamily)
      if (op.fontWeight) t.fontWeight = Number(op.fontWeight)
      if (op.color) t.color = hexToRgba(String(op.color))
      if (op.align) t.align = op.align as 'left' | 'center' | 'right'
      if (op.width) {
        t.width = w
        t.autoSize = false
        if (op.height) t.height = h
      }
      node = t
      break
    }
    case 'image':
    case 'nineslice': {
      if (!op.file) throw new Error('image cần file (đường dẫn PNG/JPG)')
      const asset = await assetFromFile(String(op.file), op.crop as { x: number; y: number; width: number; height: number } | undefined, name)
      const iw = op.width ? w : asset.width
      const ih = op.height ? h : asset.height
      node = type === 'image' ? createImage(name, x, y, iw, ih, asset.id) : createNineSlice(name, x, y, iw, ih, asset.id, (op.insets as { left: number; top: number; right: number; bottom: number } | undefined) ?? { left: 10, top: 10, right: 10, bottom: 10 })
      break
    }
    default: {
      const r = createRect(name, x, y, w, h)
      if (op.fill) r.fill = { color: hexToRgba(String(op.fill)), visible: true }
      else if (op.fill === null) r.fill.visible = false
      if (typeof op.cornerRadius === 'number') r.cornerRadius = op.cornerRadius
      if (op.stroke) r.stroke = { color: hexToRgba(String(op.stroke)), width: Number(op.strokeWidth ?? 2), visible: true }
      if (op.shape === 'ellipse') r.shape = 'ellipse'
      node = r
    }
  }
  if (typeof op.opacity === 'number') node.opacity = op.opacity
  if (op.visible === false) node.visible = false
  st.addNode(node, parentId, typeof op.index === 'number' ? op.index : undefined)
  if (op.props && typeof op.props === 'object') st.setNodeProps(node.id, op.props as Partial<SceneNode>)
  log.push(`addNode ${type} ${node.name} (${node.id})${parentId ? ' in ' + parentId : ''}`)
  return true
}

function applyOps(ops: BridgeOp[]): string[] {
  const st = useEditor.getState()
  const log: string[] = []
  for (const op of ops) {
    switch (op.op) {
      case 'addState': {
        const { page, node } = findComponent(String(op.component))
        if (st.pageId !== page.id) st.setPage(page.id)
        useEditor.getState().addState(node.id, String(op.state))
        if (op.show) useEditor.getState().showState(node.id, String(op.state))
        log.push(`addState ${node.component?.name ?? node.name}/${op.state}`)
        break
      }
      case 'groupNodes': {
        const ids = ((op.nodes as string[]) ?? []).map((r) => findNode(r).node.id)
        if (!ids.length) throw new Error('groupNodes cần nodes[]')
        useEditor.getState().select(ids)
        useEditor.getState().groupSelection()
        const gid = useEditor.getState().selection[0]
        if (op.name && gid) useEditor.getState().setNodeProps(gid, { name: String(op.name) })
        log.push(`groupNodes ${ids.length} → ${gid}`)
        break
      }
      case 'setNodeProps': {
        const { page, node } = findNode(String(op.node))
        if (st.pageId !== page.id) st.setPage(page.id)
        const props: Record<string, unknown> = {}
        for (const [k, v] of Object.entries((op.props as Record<string, unknown>) ?? {})) {
          if (!ALLOWED_PROPS.has(k)) throw new Error(`Prop không cho phép: ${k}`)
          props[k] = v
        }
        useEditor.getState().setNodeProps(node.id, props as Partial<SceneNode>)
        log.push(`setNodeProps ${node.name} ${Object.keys(props).join(',')}`)
        break
      }
      case 'addConnection': {
        const { page, node } = findNode(String(op.from))
        const action = (op.action as Connection['action']) ?? (op.overlay === true ? 'overlay' : 'navigate')
        const needsTarget = action === 'navigate' || action === 'overlay' || action === 'swap'
        const frame = needsTarget ? findFrame(String(op.to)).frame : null
        if (st.pageId !== page.id) st.setPage(page.id)
        const init: Partial<Connection> = { action }
        if (op.trigger) init.trigger = op.trigger as Trigger
        if (op.transition) init.transition = op.transition as Transition
        if (op.direction) init.direction = op.direction as Connection['direction']
        if (op.easing) init.easing = op.easing as Connection['easing']
        if (typeof op.duration === 'number') init.duration = op.duration
        if (typeof op.delay === 'number') init.delay = op.delay
        if (typeof op.key === 'string') init.key = op.key
        if (op.overlay && typeof op.overlay === 'object') init.overlay = { ...DEFAULT_OVERLAY, ...(op.overlay as Partial<OverlaySettings>) }
        useEditor.getState().addConnection(node.id, frame?.id, init)
        const c = useEditor.getState().selectedConnectionId
        log.push(`addConnection ${c}: ${node.name} ${action}${frame ? ` → ${frame.name}` : ''}`)
        break
      }
      case 'removeConnection': {
        const id = String(op.id)
        for (const page of doc().pages) {
          if (page.connections.some((c) => c.id === id)) {
            if (st.pageId !== page.id) st.setPage(page.id)
            useEditor.getState().removeConnection(id)
            log.push(`removeConnection ${id}`)
          }
        }
        break
      }
      case 'setStartFrame': {
        const { page, frame } = findFrame(String(op.frame))
        if (st.pageId !== page.id) st.setPage(page.id)
        useEditor.getState().setStartFrame(frame.id)
        log.push(`setStartFrame ${frame.name}`)
        break
      }
      case 'convertToNineSlice':
      case 'convertToImage': {
        const { page, node } = findNode(String(op.node))
        if (st.pageId !== page.id) st.setPage(page.id)
        if (op.op === 'convertToNineSlice') useEditor.getState().convertToNineSlice(node.id)
        else useEditor.getState().convertToImage(node.id)
        if (op.insets) useEditor.getState().setNodeProps(node.id, { insets: op.insets } as Partial<SceneNode>)
        log.push(`${op.op} ${node.name}`)
        break
      }
      case 'deleteNode': {
        const { page, node } = findNode(String(op.node))
        if (st.pageId !== page.id) st.setPage(page.id)
        useEditor.getState().select([node.id])
        useEditor.getState().deleteSelection()
        log.push(`deleteNode ${node.name}`)
        break
      }
      case 'select': {
        const ids = ((op.nodes as string[]) ?? []).map((r) => findNode(r).node.id)
        useEditor.getState().select(ids)
        log.push(`select ${ids.length}`)
        break
      }
      case 'createComponent': {
        const { page, node } = findNode(String(op.node))
        if (st.pageId !== page.id) st.setPage(page.id)
        useEditor.getState().select([node.id])
        useEditor.getState().createComponent()
        const id = useEditor.getState().selection[0]
        if (op.name) {
          useEditor.getState().update((d) => {
            const pg = d.pages.find((x) => x.id === page.id)!
            const l = locate(pg, id)
            if (l && (l.node.type === 'frame' || l.node.type === 'group')) l.node.component = { name: String(op.name) }
            if (d.components?.[id]) d.components[id].name = String(op.name)
          })
        }
        log.push(`createComponent ${id}`)
        break
      }
      case 'createInstance': {
        const { node: master } = findComponent(String(op.component))
        let parentId: NodeId | null = null
        let page: Page | null = null
        if (op.parent) {
          const r = findNode(String(op.parent))
          parentId = r.node.id
          page = r.page
        }
        if (page && st.pageId !== page.id) st.setPage(page.id)
        useEditor.getState().createInstanceOf(master.id, parentId, Number(op.x ?? 0), Number(op.y ?? 0))
        const id = useEditor.getState().selection[0]
        if (op.name) useEditor.getState().setNodeProps(id, { name: String(op.name) })
        log.push(`createInstance ${id} of ${master.component?.name ?? master.name}`)
        break
      }
      case 'detachInstance': {
        const { page, node } = findNode(String(op.node))
        if (st.pageId !== page.id) st.setPage(page.id)
        useEditor.getState().detachInstance(node.id)
        log.push(`detachInstance ${node.name}`)
        break
      }
      case 'setLayout': {
        const { page, node } = findNode(String(op.node))
        if (st.pageId !== page.id) st.setPage(page.id)
        useEditor.getState().setLayout(node.id, (op.layout as AutoLayout | null) ?? undefined)
        log.push(`setLayout ${node.name} ${op.layout ? (op.layout as AutoLayout).direction : 'off'}`)
        break
      }
      case 'setOverride': {
        const { page, node } = findNode(String(op.instance))
        if (node.type !== 'instance') throw new Error(`${node.name} không phải instance`)
        if (st.pageId !== page.id) st.setPage(page.id)
        const m = findMaster(doc(), node.componentId)
        if (!m) throw new Error('mất master')
        const ref = String(op.child).toLowerCase()
        let childId: NodeId | null = null
        const walk = (list: SceneNode[], p: string): void => {
          for (const c of list) {
            const cp = p ? `${p}/${c.name}` : c.name
            if (!childId && (c.id === op.child || cp.toLowerCase() === ref || c.name.toLowerCase() === ref)) childId = c.id
            if (isContainer(c) && c.type !== 'instance') walk(c.children, cp)
          }
        }
        walk(m.node.children, '')
        if (!childId) throw new Error(`Không thấy child "${op.child}" trong master`)
        useEditor.getState().setOverride(node.id, childId, (op.patch as InstanceOverride) ?? {})
        log.push(`setOverride ${node.name}/${op.child}`)
        break
      }
      case 'setImageEdits': {
        const { page, node } = findNode(String(op.node))
        if (node.type !== 'image' && node.type !== 'nineslice') throw new Error(`${node.name} không phải ảnh`)
        if (st.pageId !== page.id) st.setPage(page.id)
        if (!node.originalAssetId) useEditor.getState().setNodeProps(node.id, { originalAssetId: node.sourceAssetId ?? node.assetId, sourceAssetId: node.sourceAssetId ?? node.assetId } as Partial<SceneNode>, { history: false })
        useEditor.getState().setImageEdits(node.id, (op.edits as ImageEdits | null) ?? undefined)
        void import('@/psd/restyle').then((m) => m.restyleNode(node.id))
        log.push(`setImageEdits ${node.name}`)
        break
      }
      case 'autoAnchor': {
        const { page, frame } = findFrame(String(op.frame))
        if (st.pageId !== page.id) st.setPage(page.id)
        const n = useEditor.getState().autoAnchor([frame.id], (op.rules as Partial<AutoAnchorRules>) ?? {})
        log.push(`autoAnchor ${frame.name}: ${n} node`)
        break
      }
      case 'setPage': {
        const p = doc().pages.find((x) => x.id === op.page || x.name === op.page)
        if (!p) throw new Error(`Không tìm thấy page ${op.page}`)
        useEditor.getState().setPage(p.id)
        log.push(`setPage ${p.name}`)
        break
      }
      default:
        throw new Error(`Op không hỗ trợ: ${(op as BridgeOp).op}`)
    }
  }
  return log
}

const handlers: Record<string, Handler> = {
  ping: async () => {
    const s = useEditor.getState()
    return { app: 'uiforge-design', projectDir: s.projectDir, docName: s.doc.name, dirty: s.dirty, pages: s.doc.pages.map((p) => ({ id: p.id, name: p.name })) }
  },
  getDoc: async () => ({ projectDir: useEditor.getState().projectDir, doc: doc() }),
  getFrameLayout: async (p) => {
    const { page, frame } = findFrame(String(p.frame))
    return buildFrameLayout(doc(), page, frame)
  },
  getManifest: async (p) => {
    const d = doc()
    const page = p.page ? d.pages.find((x) => x.id === p.page || x.name === p.page) : getCurrentPage()
    if (!page) throw new Error('page not found')
    return buildPageManifest(d, page)
  },
  renderFrame: async (p) => {
    const { page, frame } = findFrame(String(p.frame))
    const scale = typeof p.scale === 'number' ? Math.max(0.05, Math.min(2, p.scale)) : 1
    const png = await renderFramePng(page, frame, doc().assets, scale)
    return { frame: frame.name, width: Math.round(frame.width * scale), height: Math.round(frame.height * scale), pngBase64: toBase64(png) }
  },
  importPsd: async (p) => {
    const paths = (p.paths as string[]) ?? []
    const frames = await importPsdFiles(paths, {
      mode: p.split ? 'split' : 'single',
      groupIndexes: Array.isArray(p.groupIndexes) ? (p.groupIndexes as number[]) : undefined,
      includeLooseLayers: p.includeLooseLayers !== false,
      textMode: (p.textMode as 'live' | 'raster' | 'both' | undefined) ?? 'both',
      autoAnchor: p.autoAnchor !== false
    })
    return { frames: frames.map((c) => ({ id: c.id, name: c.name, width: c.width, height: c.height, nodes: c.children.length })), status: useEditor.getState().status }
  },
  save: async (p) => {
    const ok = await saveProject(false, p.dir ? String(p.dir) : undefined)
    return { ok, projectDir: useEditor.getState().projectDir }
  },
  export: async () => ({ outDir: await exportLayout() }),
  openProject: async (p) => {
    await openProject(String(p.dir))
    return { projectDir: useEditor.getState().projectDir, docName: doc().name }
  },
  apply: async (p) => {
    const ops = (p.ops as BridgeOp[]) ?? []
    const applied: string[] = []
    let batch: BridgeOp[] = []
    const flush = (): void => {
      if (batch.length) applied.push(...applyOps(batch))
      batch = []
    }
    for (const op of ops) {
      if (op.op === 'addNode') {
        flush()
        await applyAsyncOp(op, applied)
      } else batch.push(op)
    }
    flush()
    // keep project.json in sync so file-based readers (other agents) see the change
    let saved = false
    if (useEditor.getState().projectDir) saved = await saveProject()
    return { applied, saved, selection: useEditor.getState().selection }
  },
  setDocProps: async (p) => {
    const props = (p.props as Record<string, unknown>) ?? {}
    for (const k of Object.keys(props)) if (!ALLOWED_DOC_PROPS.has(k)) throw new Error(`Doc prop không cho phép: ${k}`)
    useEditor.getState().update((d) => Object.assign(d, props))
    if (useEditor.getState().projectDir) await saveProject()
    return { ok: true, scaler: scalerOf(useEditor.getState().doc) }
  },
  listComponents: async () => listComponents(),
  suggestAnchors: async (p) => {
    const { frame } = findFrame(String(p.frame))
    return suggestAnchors(frame, (p.rules as Partial<AutoAnchorRules>) ?? {})
  },
  simulateFrame: async (p) => {
    const { frame } = findFrame(String(p.frame))
    const ids = Array.isArray(p.devices) && p.devices.length ? (p.devices as string[]) : (doc().previewDevices ?? DEFAULT_PREVIEW_DEVICES)
    const sc = scalerArg(p)
    return ids
      .map((id) => DEVICE_PRESETS.find((d) => d.id === id))
      .filter((d): d is (typeof DEVICE_PRESETS)[number] => !!d)
      .map((d) => {
        const sim = simulateFrame(frame, d, sc)
        return { device: { id: d.id, name: d.name, width: d.width, height: d.height }, scaler: sc, canvas: sim.canvas, safe: sim.safe, scale: sim.scale, issues: sim.issues, nodes: sim.nodes.filter((n) => n.issues.length || p.allNodes).map((n) => ({ id: n.id, path: n.path, rect: n.rect, issues: n.issues })) }
      })
  },
  renderDevice: async (p) => {
    const { page, frame } = findFrame(String(p.frame))
    const d = DEVICE_PRESETS.find((x) => x.id === p.device)
    if (!d) throw new Error(`device không hợp lệ: ${p.device}. Có: ${DEVICE_PRESETS.map((x) => x.id).join(', ')}`)
    const sim = simulateFrame(frame, d, scalerArg(p))
    const scale = typeof p.scale === 'number' ? Math.max(0.05, Math.min(2, p.scale)) : 0.5
    const png = await renderFramePng(page, frameForSim(frame, sim), doc().assets, scale)
    return { frame: frame.name, device: d.id, width: Math.round(sim.canvas.width * scale), height: Math.round(sim.canvas.height * scale), issues: sim.issues, pngBase64: toBase64(png) }
  },
  compareFrame: async (p) => {
    const { page, frame } = findFrame(String(p.frame))
    let bytes: Uint8Array
    if (p.capturePath) bytes = await window.api.readFile(String(p.capturePath))
    else if (p.pngBase64) bytes = Uint8Array.from(atob(String(p.pngBase64)), (c) => c.charCodeAt(0))
    else throw new Error('cần capturePath hoặc pngBase64')
    const { report, diffPng } = await compareFrame(doc(), page, frame, bytes, { threshold: typeof p.threshold === 'number' ? p.threshold : undefined, maxShift: typeof p.maxShift === 'number' ? p.maxShift : undefined, diffPng: !!p.diffPath || !!p.returnDiff })
    if (p.diffPath && diffPng) await window.api.writeFile(String(p.diffPath), diffPng)
    return { ...report, diffPath: p.diffPath ?? null, diffPngBase64: p.returnDiff && diffPng ? toBase64(diffPng) : undefined }
  },
  // ---- game link (model/game.ts, store/game.ts)
  pushGameDesign: async (p) => pushGameDesign(p.design as GameDesign),
  openGame: async (p) => {
    const dir = await ensureGameProject(String(p.root), String(p.name ?? 'Game'))
    const g = doc().game
    if (!g) throw new Error(`${dir} chưa có dữ liệu game (chưa push lần nào — dùng capture_game hoặc push_game_design).`)
    return { projectDir: dir, game: { name: g.name, root: g.root, engine: g.engine, devUrl: g.devUrl, revision: g.revision, pushedAt: g.pushedAt, syncedAt: g.syncedAt ?? null }, screens: Object.entries(g.screens).map(([id, s]) => ({ id, name: s.name, width: s.width, height: s.height, elements: Object.keys(s.elements).length })), sources: gameSources(doc()).map((s) => ({ source: s.source, width: s.width, height: s.height, usedBy: s.usedBy.length, replaced: s.replaced })) }
  },
  gameChanges: async () => {
    const c = pendingChanges()
    if (!c) throw new Error('Project đang mở chưa liên kết với game nào.')
    return { changes: c, markdown: buildChangesMarkdown(c) }
  },
  syncGame: async (p) => {
    const r = await syncGame({ resample: p.resample !== false })
    if (!p.runAgent) return { ...r, markdown: buildChangesMarkdown(r.changes) }
    const log: string[] = []
    const agent = await runGameAgent((line) => log.push(line))
    return { ...r, markdown: buildChangesMarkdown(r.changes), agent: { ...agent, log: log.slice(-60) } }
  },
  ackGame: async () => ackGame(),
  replaceGameArt: async (p) => {
    if (p.folder) return replaceFromFolder(String(p.folder))
    if (!p.file) throw new Error('cần file (đường dẫn ảnh) hoặc folder')
    const bytes = await window.api.readFile(String(p.file))
    if (p.source) return { replaced: await replaceSource(String(p.source), bytes, String(p.file)) }
    if (p.node) return { replaced: await replaceNodeArt(findNode(String(p.node)).node.id, bytes, String(p.file)) }
    throw new Error('cần source (file ảnh của game) hoặc node')
  },
  findNodes: async (p) => {
    const q = String(p.query ?? '').toLowerCase()
    const type = p.type ? String(p.type) : null
    const out: { id: NodeId; path: string; type: string; frame: string; page: string }[] = []
    for (const page of doc().pages) {
      const idx = indexPage(page)
      for (const e of idx.byId.values()) {
        if (type && e.node.type !== type) continue
        if (q && !e.path.toLowerCase().includes(q)) continue
        const top = e.path.split('/')[0]
        out.push({ id: e.node.id, path: e.path, type: e.node.type, frame: top, page: page.name })
        if (out.length >= 200) return out
      }
    }
    return out
  }
}

export { handlers as bridgeHandlers }

export function installBridge(): void {
  window.api.onBridgeRequest(async ({ id, method, params }) => {
    try {
      const h = handlers[method]
      if (!h) throw new Error(`unknown method ${method}`)
      const result = await h(params ?? {})
      window.api.sendBridgeResponse({ id, result })
    } catch (e) {
      window.api.sendBridgeResponse({ id, error: String((e as Error)?.message ?? e) })
    }
  })
}
