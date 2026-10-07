import { useEffect, useRef } from 'react'
import { Application, Container, Graphics, Text } from 'pixi.js'
import type { Connection, NodeId, Page, SceneNode } from '@/model/types'
import { isContainer } from '@/model/types'
import { absRect, getEntry, hitChain, indexPage, nodesInRect, unionRects, type Rect } from '@/model/nodes'
import { createFrame, createRect, createText, newId } from '@/model/create'
import { getCurrentPage, locate, useEditor, type EditorState, type ViewState } from '@/store/editor'
import { createScene, destroyScene, setGlobalLightAngle, setPatternInfos, setTextResolution, syncScene, type SceneView } from './sync'
import { loadPatternInfos } from '@/psd/restyle'
import { useHover } from '@/store/hover'
import { actionLabel, ownerFrameId, transitionLabel, triggerLabel } from '@/model/flows'
import { canvasPalette, useTheme } from '@/store/theme'
import { toScreen, toWorld, zoomAt } from './viewMath'
import { onFontEpoch } from './fontEpoch'
import {
  HANDLES,
  HANDLE_SIZE,
  connectionCurve,
  distToCurve,
  handleAt,
  pickAt,
  pickCandidate,
  resizeRect,
  rotateZoneAt,
  scaleChildren,
  snapMove,
  unlockedChain,
  type HandleId
} from './interaction'

const BLUE = 0x4f9dff
const MAGENTA = 0xff4fd8
const RED = 0xff5555
const CYAN = 0x2ec7e6
const RULER = 20

type SliceEdge = 'left' | 'top' | 'right' | 'bottom'

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'move'; sx: number; sy: number; ids: NodeId[]; orig: Map<NodeId, { x: number; y: number }>; started: boolean; bboxOrig: Rect; clickedId: NodeId; shift: boolean }
  | { kind: 'marquee'; wx: number; wy: number; cx: number; cy: number; additive: boolean; base: NodeId[] }
  | { kind: 'resize'; sx: number; sy: number; id: NodeId; orig: Rect; handle: HandleId; origChildren: SceneNode[] | null; started: boolean }
  | { kind: 'create'; sx: number; sy: number; wx: number; wy: number; type: 'frame' | 'rect'; id: NodeId | null; parentId: NodeId | null; parentAbs: { x: number; y: number } }
  | { kind: 'connect'; fromId: NodeId; sx: number; sy: number; cx: number; cy: number; targetId: NodeId | null; alt: boolean }
  | { kind: 'slice'; id: NodeId; edge: SliceEdge; started: boolean }
  | { kind: 'rotate'; id: NodeId; cx: number; cy: number; startAngle: number; orig: number; started: boolean }
  | { kind: 'guide'; axis: 'x' | 'y'; id: string | null; started: boolean }
  | { kind: 'crop'; id: NodeId; handle: HandleId; orig: { x: number; y: number; width: number; height: number }; nodeOrig: Rect; started: boolean }

interface Endpoints {
  x0: number
  y0: number
  x1: number
  y1: number
}

class ViewportController {
  app = new Application()
  scene: SceneView = createScene()
  overlay = new Graphics()
  overlayTexts = new Map<string, Text>()
  usedTexts = new Set<string>()
  drag: Drag | null = null
  space = false
  guides: { xs: number[]; ys: number[] } = { xs: [], ys: [] }
  selectedGuide: string | null = null
  cropNodeId: NodeId | null = null
  unsub: (() => void) | null = null
  unsubHover: (() => void) | null = null
  unsubTheme: (() => void) | null = null
  unsubFonts: (() => void) | null = null
  ready = false
  raf = 0

  constructor(private host: HTMLDivElement) {}

  async init(): Promise<void> {
    await this.app.init({
      resizeTo: this.host,
      background: canvasPalette().bg,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      autoStart: false,
      sharedTicker: false
    })
    this.app.ticker.stop()
    const canvas = this.app.canvas
    canvas.style.display = 'block'
    canvas.style.touchAction = 'none'
    this.host.appendChild(canvas)
    this.app.stage.addChild(this.scene.root, this.overlay)
    this.scene.onTextMeasured = (id, w, h) => {
      queueMicrotask(() => useEditor.getState().setNodeProps(id, { width: w, height: h }, { history: false }))
    }
    this.scene.onTextureLoaded = () => this.requestRender()
    this.unsubHover = useHover.subscribe(() => this.requestRender())
    this.unsubTheme = useTheme.subscribe((t) => {
      this.app.renderer.background.color = canvasPalette(t.theme).bg
      this.requestRender()
    })
    useEditor.getState().setCanvasSize(this.app.screen.width, this.app.screen.height)
    this.app.renderer.on('resize', (w: number, h: number) => {
      useEditor.getState().setCanvasSize(w, h)
      this.requestRender()
    })
    this.unsub = useEditor.subscribe(() => this.requestRender())
    this.unsubFonts = onFontEpoch(() => this.requestRender())

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('dblclick', this.onDblClick)
    canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    this.ready = true
    ;(window as unknown as { __dmViewport: unknown }).__dmViewport = this
    window.addEventListener('dm:delete-guide', this.onDeleteGuide)
    window.addEventListener('dm:crop-mode', this.onCropMode)
    this.render()
  }

  onCropMode = (e: Event): void => {
    const id = (e as CustomEvent<NodeId>).detail
    this.cropNodeId = this.cropNodeId === id ? null : id
    useEditor.getState().setStatus(this.cropNodeId ? 'Crop: kéo các tay cầm hồng trên canvas. Esc để xong.' : '')
    this.requestRender()
  }

  onDeleteGuide = (): void => {
    const id = this.selectedGuide
    if (!id) return
    useEditor.getState().updatePage((pg) => {
      pg.guides = (pg.guides ?? []).filter((g) => g.id !== id)
    })
    this.selectedGuide = null
  }

  destroy(): void {
    window.removeEventListener('dm:delete-guide', this.onDeleteGuide)
    this.unsub?.()
    this.unsubFonts?.()
    this.unsubHover?.()
    this.unsubTheme?.()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    cancelAnimationFrame(this.raf)
    if (this.ready) {
      destroyScene(this.scene)
      // never `destroy(true)`: it releases Pixi's GLOBAL batch pool, which the main viewport still uses
      this.app.destroy({ removeView: true }, { children: true })
    }
  }

  // ------------------------------------------------------------ rendering
  requestRender(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.render()
    })
  }

  renderErrors = 0

  lastPatterns: unknown = null

  render(): void {
    if (!this.ready) return
    const s = useEditor.getState()
    const page = getCurrentPage()
    setGlobalLightAngle(s.doc.globalLight?.angle ?? 120)
    if (s.doc.patterns !== this.lastPatterns) {
      this.lastPatterns = s.doc.patterns
      void loadPatternInfos().then((list) => {
        setPatternInfos(list)
        this.requestRender()
      })
    }
    try {
      syncScene(this.scene, page, s.doc.assets)
      const v = s.view
      this.scene.root.position.set(v.x, v.y)
      this.scene.root.scale.set(v.zoom)
      const dpr = window.devicePixelRatio || 1
      setTextResolution(this.scene, Math.min(4, Math.max(1, Math.ceil(v.zoom * dpr))))
      this.drawOverlay(s, page)
      this.app.render()
      this.renderErrors = 0
    } catch (e) {
      console.error('render failed', e)
      if (this.renderErrors++ === 0) {
        s.setNotice({ kind: 'error', title: 'Lỗi render canvas (đã ghi console F12)', lines: [String((e as Error)?.stack ?? e)] })
        // rebuild the scene from scratch on next render
        destroyScene(this.scene)
        this.scene = createScene()
        this.scene.onTextMeasured = (id, w, h) => queueMicrotask(() => useEditor.getState().setNodeProps(id, { width: w, height: h }, { history: false }))
        this.app.stage.addChildAt(this.scene.root, 0)
      }
    }
  }

  // ------------------------------------------------------------ helpers
  pos(e: MouseEvent): { sx: number; sy: number } {
    const r = this.app.canvas.getBoundingClientRect()
    return { sx: e.clientX - r.left, sy: e.clientY - r.top }
  }

  screenRect(page: Page, id: NodeId, v: ViewState): Rect | null {
    const r = absRect(page, id)
    if (!r) return null
    const p = toScreen(v, r.x, r.y)
    return { x: p.x, y: p.y, width: r.width * v.zoom, height: r.height * v.zoom }
  }

  cornersScreen(page: Page, n: SceneNode, v: ViewState): { x: number; y: number }[] {
    const e = getEntry(page, n.id)
    if (!e) return []
    const cx = e.absX + n.pivot.x * n.width
    const cy = e.absY + n.pivot.y * n.height
    const rad = (n.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const pts = [
      [e.absX, e.absY],
      [e.absX + n.width, e.absY],
      [e.absX + n.width, e.absY + n.height],
      [e.absX, e.absY + n.height]
    ]
    return pts.map(([x, y]) => {
      const dx = x - cx
      const dy = y - cy
      return toScreen(v, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)
    })
  }

  selectionBBox(page: Page, sel: NodeId[], v: ViewState): Rect | null {
    const rects = sel.map((id) => this.screenRect(page, id, v)).filter((r): r is Rect => !!r)
    return unionRects(rects) ?? null
  }

  topFrameAt(page: Page, wx: number, wy: number): SceneNode | null {
    const chain = hitChain(page, wx, wy)
    return chain[0]?.type === 'frame' ? chain[0] : null
  }

  labelHit(page: Page, v: ViewState, sx: number, sy: number): NodeId | null {
    for (const n of page.children) {
      if (n.type !== 'frame' || !n.visible) continue
      const p = toScreen(v, n.x, n.y)
      const t = this.overlayTexts.get(`label:${n.id}`)
      const w = t ? t.width : 60
      if (sx >= p.x && sx <= p.x + w + 4 && sy >= p.y - 18 && sy <= p.y - 2) return n.id
    }
    return null
  }

  /** Node whose "+" connect handle is shown: the selected node, else the hovered one (Figma shows it on hover). */
  hotspotNode(page: Page, sel: NodeId[]): NodeId | null {
    if (sel.length === 1) return sel[0]
    if (sel.length) return null
    const h = useHover.getState().hoverId
    return h && getEntry(page, h) ? h : null
  }

  hotspotHandle(page: Page, sel: NodeId[], v: ViewState): { x: number; y: number; id: NodeId } | null {
    const id = this.hotspotNode(page, sel)
    if (!id) return null
    const r = this.screenRect(page, id, v)
    if (!r) return null
    return { x: r.x + r.width, y: r.y + r.height / 2, id }
  }

  connectionEndpoints(page: Page, c: Connection, v: ViewState): Endpoints | null {
    const a = this.screenRect(page, c.from, v)
    if (!a) return null
    if (!c.to || c.action === 'back' || c.action === 'close') {
      // no destination: short stub to the right of the hotspot
      return { x0: a.x + a.width, y0: a.y + a.height / 2, x1: a.x + a.width + 48 * Math.max(0.5, Math.min(1, v.zoom * 2)), y1: a.y + a.height / 2 }
    }
    const b = this.screenRect(page, c.to, v)
    if (!b) return null
    const aCenter = a.x + a.width / 2
    const bCenter = b.x + b.width / 2
    if (bCenter >= aCenter) return { x0: a.x + a.width, y0: a.y + a.height / 2, x1: b.x, y1: b.y + b.height / 2 }
    return { x0: a.x, y0: a.y + a.height / 2, x1: b.x + b.width, y1: b.y + b.height / 2 }
  }

  connectionAt(page: Page, v: ViewState, sx: number, sy: number): Connection | null {
    for (const c of page.connections) {
      const ep = this.connectionEndpoints(page, c, v)
      if (!ep) continue
      if (distToCurve(ep.x0, ep.y0, ep.x1, ep.y1, sx, sy) < 6) return c
    }
    return null
  }

  sliceLines(page: Page, n: SceneNode, v: ViewState, assets: EditorState['doc']['assets']): Record<SliceEdge, number> | null {
    if (n.type !== 'nineslice') return null
    const r = this.screenRect(page, n.id, v)
    const a = assets[n.assetId]
    if (!r || !a) return null
    const kx = r.width / a.width
    const ky = r.height / a.height
    return {
      left: r.x + n.insets.left * kx,
      right: r.x + r.width - n.insets.right * kx,
      top: r.y + n.insets.top * ky,
      bottom: r.y + r.height - n.insets.bottom * ky
    }
  }

  sliceEdgeAt(page: Page, n: SceneNode, v: ViewState, assets: EditorState['doc']['assets'], sx: number, sy: number): SliceEdge | null {
    const lines = this.sliceLines(page, n, v, assets)
    const r = this.screenRect(page, n.id, v)
    if (!lines || !r) return null
    const inX = sx >= r.x - 8 && sx <= r.x + r.width + 8
    const inY = sy >= r.y - 8 && sy <= r.y + r.height + 8
    if (inY && Math.abs(sx - lines.left) < 6) return 'left'
    if (inY && Math.abs(sx - lines.right) < 6) return 'right'
    if (inX && Math.abs(sy - lines.top) < 6) return 'top'
    if (inX && Math.abs(sy - lines.bottom) < 6) return 'bottom'
    return null
  }

  guideAt(page: Page, v: ViewState, sx: number, sy: number): { id: string; axis: 'x' | 'y' } | null {
    for (const g of page.guides ?? []) {
      if (g.axis === 'x' && Math.abs(toScreen(v, g.pos, 0).x - sx) <= 4) return { id: g.id, axis: 'x' }
      if (g.axis === 'y' && Math.abs(toScreen(v, 0, g.pos).y - sy) <= 4) return { id: g.id, axis: 'y' }
    }
    return null
  }

  pivotScreen(page: Page, n: SceneNode, v: ViewState): { x: number; y: number } {
    const e = getEntry(page, n.id)!
    return toScreen(v, e.absX + n.pivot.x * n.width, e.absY + n.pivot.y * n.height)
  }

  setCursor(c: string): void {
    this.app.canvas.style.cursor = c
  }

  // ------------------------------------------------------------ events
  onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'Escape' && this.cropNodeId) {
      this.cropNodeId = null
      this.requestRender()
    }
    if (e.code === 'Space' && !this.space) {
      this.space = true
      if (!this.drag) this.setCursor('grab')
      e.preventDefault()
    }
  }

  onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') {
      this.space = false
      if (!this.drag) this.setCursor('default')
    }
  }

  dragStartSx = 0
  dragStartSy = 0

  onPointerDown = (e: PointerEvent): void => {
    const canvas = this.app.canvas
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic events have no active pointer */
    }
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const s = useEditor.getState()
    const page = getCurrentPage()
    const { sx, sy } = this.pos(e)
    this.dragStartSx = sx
    this.dragStartSy = sy
    const { x: wx, y: wy } = toWorld(s.view, sx, sy)
    const v = s.view
    const sel = s.selection

    if (e.button === 1 || this.space || s.tool === 'hand') {
      this.drag = { kind: 'pan', sx, sy, vx: v.x, vy: v.y }
      this.setCursor('grabbing')
      return
    }
    if (e.button !== 0) return

    // rulers: drag out a new guide
    if (s.showRulers && (sx < RULER || sy < RULER)) {
      const axis: 'x' | 'y' = sy < RULER && sx >= RULER ? 'y' : sx < RULER && sy >= RULER ? 'x' : sx < sy ? 'x' : 'y'
      const id = newId()
      s.snapshot()
      s.updatePage((pg) => {
        pg.guides = [...(pg.guides ?? []), { id, axis, pos: Math.round(axis === 'x' ? wx : wy) }]
      }, { history: false })
      this.selectedGuide = id
      this.drag = { kind: 'guide', axis, id, started: true }
      return
    }
    // existing guide
    if (s.showRulers && s.mode === 'design') {
      const g = this.guideAt(page, v, sx, sy)
      if (g) {
        this.selectedGuide = g.id
        s.select([])
        this.drag = { kind: 'guide', axis: g.axis, id: g.id, started: false }
        return
      }
    }
    this.selectedGuide = null

    // rotation ring around single selection
    if (sel.length === 1 && s.mode === 'design' && !s.editSlices) {
      const bbox = this.selectionBBox(page, sel, v)
      const n = getEntry(page, sel[0])?.node
      if (bbox && n && !n.locked && rotateZoneAt(bbox, sx, sy)) {
        const pv = this.pivotScreen(page, n, v)
        this.drag = { kind: 'rotate', id: n.id, cx: pv.x, cy: pv.y, startAngle: Math.atan2(sy - pv.y, sx - pv.x), orig: n.rotation, started: false }
        return
      }
    }

    // frame label click → select frame
    const lbl = this.labelHit(page, v, sx, sy)
    if (lbl) {
      if (e.shiftKey) s.select([lbl], { toggle: true })
      else if (!sel.includes(lbl)) s.select([lbl])
      s.setScope(null)
      this.beginMove(page, useEditor.getState().selection, sx, sy, lbl, e.shiftKey)
      return
    }

    if (s.mode === 'prototype') {
      const hp = this.hotspotHandle(page, sel, v)
      if (hp && Math.hypot(sx - hp.x, sy - hp.y) <= 10) {
        if (!sel.includes(hp.id)) s.select([hp.id])
        this.drag = { kind: 'connect', fromId: hp.id, sx, sy, cx: sx, cy: sy, targetId: null, alt: e.altKey }
        return
      }
      const c = this.connectionAt(page, v, sx, sy)
      if (c) {
        s.setSelectedConnection(c.id)
        return
      }
    }

    if (s.editSlices && sel.length === 1) {
      const n = getEntry(page, sel[0])?.node
      if (n && n.type === 'nineslice') {
        const edge = this.sliceEdgeAt(page, n, v, s.doc.assets, sx, sy)
        if (edge) {
          this.drag = { kind: 'slice', id: n.id, edge, started: false }
          return
        }
      }
    }

    if (s.tool === 'text') {
      const parent = this.topFrameAt(page, wx, wy)
      const pa = parent ? absRect(page, parent.id)! : { x: 0, y: 0 }
      const t = createText('Text', Math.round(wx - pa.x), Math.round(wy - pa.y))
      s.addNode(t, parent?.id ?? null)
      s.setTool('select')
      window.dispatchEvent(new CustomEvent('dm:edit-text', { detail: t.id }))
      return
    }
    if (s.tool === 'frame' || s.tool === 'rect') {
      const parent = this.topFrameAt(page, wx, wy)
      const pa = parent ? absRect(page, parent.id)! : { x: 0, y: 0 }
      this.drag = { kind: 'create', sx, sy, wx, wy, type: s.tool, id: null, parentId: parent?.id ?? null, parentAbs: { x: pa.x, y: pa.y } }
      return
    }

    // crop handles (image edit crop mode)
    if (this.cropNodeId && sel.length === 1 && sel[0] === this.cropNodeId) {
      const n = getEntry(page, sel[0])?.node
      const bbox = this.selectionBBox(page, sel, v)
      if (n && (n.type === 'image' || n.type === 'nineslice') && bbox) {
        const h = handleAt(bbox, sx, sy)
        if (h) {
          const doc = s.doc
          const src = doc.assets[n.originalAssetId ?? n.sourceAssetId ?? n.assetId]
          const crop = n.edits?.crop ?? { x: 0, y: 0, width: src?.width ?? n.width, height: src?.height ?? n.height }
          this.drag = { kind: 'crop', id: n.id, handle: h.id, orig: { ...crop }, nodeOrig: { x: n.x, y: n.y, width: n.width, height: n.height }, started: false }
          return
        }
      }
    }

    // resize handles
    if (sel.length === 1 && s.mode === 'design') {
      const bbox = this.selectionBBox(page, sel, v)
      const n = getEntry(page, sel[0])?.node
      if (bbox && n && !n.locked) {
        const h = handleAt(bbox, sx, sy)
        if (h) {
          const origChildren = n.type === 'group' ? (JSON.parse(JSON.stringify(n.children)) as SceneNode[]) : null
          this.drag = { kind: 'resize', sx, sy, id: n.id, orig: { x: n.x, y: n.y, width: n.width, height: n.height }, handle: h.id, origChildren, started: false }
          return
        }
      }
    }

    const chain = unlockedChain(hitChain(page, wx, wy))
    let scopeId = s.scopeId
    if (scopeId && !chain.some((n) => n.id === scopeId)) {
      scopeId = null
      s.setScope(null)
    }
    const cand = pickCandidate(chain, scopeId)
    if (!cand) {
      if (!e.shiftKey) s.select([])
      this.drag = { kind: 'marquee', wx, wy, cx: wx, cy: wy, additive: e.shiftKey, base: e.shiftKey ? sel : [] }
      return
    }
    if (e.shiftKey) {
      s.select([cand.id], { toggle: true })
      if (!useEditor.getState().selection.includes(cand.id)) return
    } else if (!sel.includes(cand.id)) {
      s.select([cand.id])
    }
    this.beginMove(page, useEditor.getState().selection, sx, sy, cand.id, e.shiftKey)
  }

  beginMove(page: Page, ids: NodeId[], sx: number, sy: number, clickedId: NodeId, shift: boolean): void {
    const orig = new Map<NodeId, { x: number; y: number }>()
    const rects: Rect[] = []
    for (const id of ids) {
      const n = getEntry(page, id)?.node
      if (!n) continue
      orig.set(id, { x: n.x, y: n.y })
      const r = absRect(page, id)
      if (r) rects.push(r)
    }
    const bboxOrig = unionRects(rects) ?? { x: 0, y: 0, width: 0, height: 0 }
    this.drag = { kind: 'move', sx, sy, ids, orig, started: false, bboxOrig, clickedId, shift }
  }

  onPointerMove = (e: PointerEvent): void => {
    const s = useEditor.getState()
    const page = getCurrentPage()
    const { sx, sy } = this.pos(e)
    const v = s.view
    const { x: wx, y: wy } = toWorld(v, sx, sy)
    const d = this.drag
    if (!d) {
      this.updateHover(s, page, sx, sy, wx, wy)
      return
    }
    switch (d.kind) {
      case 'pan':
        s.setView({ x: d.vx + (sx - d.sx), y: d.vy + (sy - d.sy), zoom: v.zoom })
        return
      case 'move': {
        if (!d.started) {
          if (Math.hypot(sx - d.sx, sy - d.sy) < 3) return
          d.started = true
          s.snapshot()
        }
        let dx = (sx - d.sx) / v.zoom
        let dy = (sy - d.sy) / v.zoom
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        this.guides = { xs: [], ys: [] }
        if (!e.altKey) {
          const moved = { x: d.bboxOrig.x + dx, y: d.bboxOrig.y + dy, width: d.bboxOrig.width, height: d.bboxOrig.height }
          const snap = snapMove(page, d.ids, moved, 6 / v.zoom)
          dx += snap.dx
          dy += snap.dy
          this.guides = { xs: snap.guidesX, ys: snap.guidesY }
        }
        s.updatePage(
          (pg) => {
            for (const id of d.ids) {
              const l = locate(pg, id)
              const o = d.orig.get(id)
              if (l && o && !l.node.locked) {
                l.node.x = Math.round((o.x + dx) * 100) / 100
                l.node.y = Math.round((o.y + dy) * 100) / 100
              }
            }
          },
          { history: false }
        )
        return
      }
      case 'marquee': {
        d.cx = wx
        d.cy = wy
        const r = normRect(d.wx, d.wy, d.cx, d.cy)
        const scope = s.scopeId ? (getEntry(page, s.scopeId)?.node ?? null) : null
        const ids = nodesInRect(page, scope && isContainer(scope) ? scope : null, r)
        const next = d.additive ? Array.from(new Set([...d.base, ...ids])) : ids
        const cur = s.selection
        if (next.length !== cur.length || next.some((id, i) => id !== cur[i])) s.select(next)
        this.requestRender()
        return
      }
      case 'resize': {
        if (!d.started) {
          d.started = true
          s.snapshot()
        }
        const dx = (sx - d.sx) / v.zoom
        const dy = (sy - d.sy) / v.zoom
        const nr = resizeRect(d.orig, d.handle, dx, dy, e.shiftKey, e.altKey)
        s.updatePage(
          (pg) => {
            const l = locate(pg, d.id)
            if (!l) return
            const n = l.node
            n.x = Math.round(nr.x * 100) / 100
            n.y = Math.round(nr.y * 100) / 100
            n.width = Math.round(nr.width * 100) / 100
            n.height = Math.round(nr.height * 100) / 100
            if (n.type === 'group' && d.origChildren) {
              n.children = JSON.parse(JSON.stringify(d.origChildren))
              scaleChildren(n, nr.width / d.orig.width, nr.height / d.orig.height)
            }
            if (n.type === 'text') n.autoSize = false
          },
          { history: false }
        )
        return
      }
      case 'create': {
        const r = normRect(d.wx, d.wy, wx, wy)
        if (!d.id) {
          if (Math.hypot(sx - d.sx, sy - d.sy) < 3) return
          const node =
            d.type === 'frame'
              ? createFrame('Frame', r.x - d.parentAbs.x, r.y - d.parentAbs.y, r.width, r.height)
              : createRect('Rectangle', r.x - d.parentAbs.x, r.y - d.parentAbs.y, r.width, r.height)
          s.addNode(node, d.parentId)
          d.id = node.id
          return
        }
        s.setNodeProps(d.id, { x: Math.round(r.x - d.parentAbs.x), y: Math.round(r.y - d.parentAbs.y), width: Math.round(r.width), height: Math.round(r.height) }, { history: false })
        return
      }
      case 'connect': {
        d.cx = sx
        d.cy = sy
        d.alt = e.altKey
        const f = this.topFrameAt(page, wx, wy)
        // cannot connect a node to its own frame (Figma disallows it too)
        const own = ownerFrameId(page, d.fromId)
        d.targetId = f && f.id !== own ? f.id : null
        this.requestRender()
        return
      }
      case 'crop': {
        if (!d.started) {
          d.started = true
          s.snapshot()
        }
        const n = getEntry(page, d.id)?.node
        if (!n || (n.type !== 'image' && n.type !== 'nineslice')) return
        // node px → source px (crop is in original pixels; ignore rotation edits)
        const kx = d.orig.width / d.nodeOrig.width
        const ky = d.orig.height / d.nodeOrig.height
        const dx = ((sx - this.dragStartSx) / v.zoom) * kx
        const dy = ((sy - this.dragStartSy) / v.zoom) * ky
        const nr = resizeRect(d.orig, d.handle, dx, dy, e.shiftKey, false)
        const src = s.doc.assets[n.originalAssetId ?? n.sourceAssetId ?? n.assetId]
        const maxW = src?.width ?? d.orig.x + d.orig.width
        const maxH = src?.height ?? d.orig.y + d.orig.height
        const crop = {
          x: Math.max(0, Math.min(maxW - 1, Math.round(nr.x))),
          y: Math.max(0, Math.min(maxH - 1, Math.round(nr.y))),
          width: Math.max(1, Math.round(nr.width)),
          height: Math.max(1, Math.round(nr.height))
        }
        crop.width = Math.min(crop.width, maxW - crop.x)
        crop.height = Math.min(crop.height, maxH - crop.y)
        // keep the on-screen scale: node size follows crop size
        const nx = d.nodeOrig.x + (crop.x - d.orig.x) / kx
        const ny = d.nodeOrig.y + (crop.y - d.orig.y) / ky
        s.setNodeProps(d.id, { x: Math.round(nx * 100) / 100, y: Math.round(ny * 100) / 100, width: Math.round((crop.width / kx) * 100) / 100, height: Math.round((crop.height / ky) * 100) / 100 } as Partial<SceneNode>, { history: false })
        s.setImageEdits(d.id, { ...(n.edits ?? {}), crop })
        return
      }
      case 'rotate': {
        if (!d.started) {
          d.started = true
          s.snapshot()
        }
        const a = Math.atan2(sy - d.cy, sx - d.cx)
        let deg = d.orig + ((a - d.startAngle) * 180) / Math.PI
        if (e.shiftKey) deg = Math.round(deg / 15) * 15
        deg = Math.round(deg * 10) / 10
        if (deg > 180) deg -= 360
        if (deg <= -180) deg += 360
        s.setNodeProps(d.id, { rotation: deg }, { history: false })
        return
      }
      case 'guide': {
        if (!d.started) {
          if (Math.hypot(sx - 0, sy - 0) < 0) return
          d.started = true
          s.snapshot()
        }
        const pos = Math.round(d.axis === 'x' ? wx : wy)
        s.updatePage((pg) => {
          const g = (pg.guides ?? []).find((x) => x.id === d.id)
          if (g) g.pos = pos
        }, { history: false })
        return
      }
      case 'slice': {
        if (!d.started) {
          d.started = true
          s.snapshot()
        }
        const n = getEntry(page, d.id)?.node
        const r = absRect(page, d.id)
        if (!n || n.type !== 'nineslice' || !r) return
        const a = s.doc.assets[n.assetId]
        if (!a) return
        const kx = a.width / r.width
        const ky = a.height / r.height
        const ins = { ...n.insets }
        const clamp = (val: number, max: number): number => Math.max(0, Math.min(max, Math.round(val)))
        if (d.edge === 'left') ins.left = clamp((wx - r.x) * kx, a.width - ins.right - 1)
        if (d.edge === 'right') ins.right = clamp((r.x + r.width - wx) * kx, a.width - ins.left - 1)
        if (d.edge === 'top') ins.top = clamp((wy - r.y) * ky, a.height - ins.bottom - 1)
        if (d.edge === 'bottom') ins.bottom = clamp((r.y + r.height - wy) * ky, a.height - ins.top - 1)
        s.setNodeProps(d.id, { insets: ins } as Partial<SceneNode>, { history: false })
        return
      }
    }
  }

  updateHover(s: EditorState, page: Page, sx: number, sy: number, wx: number, wy: number): void {
    if (this.space || s.tool === 'hand') {
      this.setCursor('grab')
      return
    }
    if (s.tool !== 'select') {
      this.setCursor(s.tool === 'text' ? 'text' : 'crosshair')
      useHover.getState().setHover(null)
      return
    }
    const v = s.view
    const sel = s.selection
    if (s.mode === 'prototype') {
      const hp = this.hotspotHandle(page, sel, v)
      if (hp && Math.hypot(sx - hp.x, sy - hp.y) <= 10) {
        this.setCursor('crosshair')
        return
      }
      if (this.connectionAt(page, v, sx, sy)) {
        this.setCursor('pointer')
        return
      }
    }
    if (s.editSlices && sel.length === 1) {
      const n = getEntry(page, sel[0])?.node
      if (n && n.type === 'nineslice') {
        const edge = this.sliceEdgeAt(page, n, v, s.doc.assets, sx, sy)
        if (edge) {
          this.setCursor(edge === 'left' || edge === 'right' ? 'ew-resize' : 'ns-resize')
          return
        }
      }
    }
    if (s.showRulers && (sx < RULER || sy < RULER)) {
      this.setCursor(sx < RULER && sy >= RULER ? 'col-resize' : 'row-resize')
      useHover.getState().setHover(null)
      return
    }
    if (s.showRulers && s.mode === 'design') {
      const g = this.guideAt(page, v, sx, sy)
      if (g) {
        this.setCursor(g.axis === 'x' ? 'col-resize' : 'row-resize')
        useHover.getState().setHover(null)
        return
      }
    }
    if (sel.length === 1 && s.mode === 'design') {
      const bbox = this.selectionBBox(page, sel, v)
      const h = bbox ? handleAt(bbox, sx, sy) : null
      if (h) {
        this.setCursor(h.cursor)
        return
      }
      const n = getEntry(page, sel[0])?.node
      if (bbox && n && !n.locked && !s.editSlices && rotateZoneAt(bbox, sx, sy)) {
        this.setCursor('alias')
        return
      }
    }
    if (this.labelHit(page, v, sx, sy)) {
      this.setCursor('default')
      useHover.getState().setHover(null)
      return
    }
    const cand = pickAt(page, wx, wy, s.scopeId)
    useHover.getState().setHover(cand?.id ?? null)
    this.setCursor(cand ? 'default' : 'default')
  }

  onPointerUp = (e: PointerEvent): void => {
    const s = useEditor.getState()
    const d = this.drag
    if (!d) return
    const { sx, sy } = this.pos(e)
    switch (d.kind) {
      case 'move':
        if (!d.started && !d.shift && s.selection.length > 1) s.select([d.clickedId])
        break
      case 'create':
        if (d.id) {
          s.select([d.id])
        } else {
          // simple click: create default-sized node
          const w = d.type === 'frame' ? 1080 : 100
          const h = d.type === 'frame' ? 1920 : 100
          const node =
            d.type === 'frame'
              ? createFrame('Frame', Math.round(d.wx - d.parentAbs.x), Math.round(d.wy - d.parentAbs.y), w, h)
              : createRect('Rectangle', Math.round(d.wx - d.parentAbs.x), Math.round(d.wy - d.parentAbs.y), w, h)
          s.addNode(node, d.parentId)
        }
        s.setTool('select')
        break
      case 'connect':
        if (d.targetId && Math.hypot(sx - d.sx, sy - d.sy) > 8) s.addConnection(d.fromId, d.targetId, d.alt ? { action: 'overlay' } : undefined)
        else if (Math.hypot(sx - d.sx, sy - d.sy) <= 8) s.setStatus('Kéo nút + tới một frame khác để tạo flow (giữ Alt = mở overlay)')
        break
      case 'crop':
        if (d.started) void import('@/psd/restyle').then((m) => m.restyleNode(d.id))
        break
      case 'guide':
        if (sx < RULER || sy < RULER) {
          s.updatePage((pg) => {
            pg.guides = (pg.guides ?? []).filter((g) => g.id !== d.id)
          }, { history: false })
          this.selectedGuide = null
        }
        break
      default:
        break
    }
    this.drag = null
    this.guides = { xs: [], ys: [] }
    this.setCursor(this.space ? 'grab' : 'default')
    this.requestRender()
  }

  onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    const s = useEditor.getState()
    const page = getCurrentPage()
    const { sx, sy } = this.pos(e)
    const { x: wx, y: wy } = toWorld(s.view, sx, sy)
    const cand = pickAt(page, wx, wy, s.scopeId)
    if (cand && !s.selection.includes(cand.id)) s.select([cand.id])
    else if (!cand) s.select([])
    window.dispatchEvent(new CustomEvent('dm:contextmenu', { detail: { x: e.clientX, y: e.clientY } }))
  }

  onDblClick = (e: MouseEvent): void => {
    const s = useEditor.getState()
    const page = getCurrentPage()
    const { sx, sy } = this.pos(e)
    const { x: wx, y: wy } = toWorld(s.view, sx, sy)
    const chain = unlockedChain(hitChain(page, wx, wy))
    const cand = pickCandidate(chain, s.scopeId)
    if (!cand) return
    if (isContainer(cand)) {
      const idx = chain.indexOf(cand)
      const deeper = chain[idx + 1]
      if (deeper) {
        s.setScope(cand.id)
        s.select([deeper.id])
      }
      return
    }
    if (cand.type === 'text') window.dispatchEvent(new CustomEvent('dm:edit-text', { detail: cand.id }))
    if (cand.type === 'nineslice') s.setEditSlices(true)
  }

  onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const s = useEditor.getState()
    const { sx, sy } = this.pos(e)
    const k = e.deltaMode === 1 ? 16 : 1
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.pow(1.1, (-e.deltaY * k) / 100)
      s.setView(zoomAt(s.view, sx, sy, factor))
    } else {
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * k
      const dy = (e.shiftKey ? 0 : e.deltaY) * k
      s.setView({ x: s.view.x - dx, y: s.view.y - dy, zoom: s.view.zoom })
    }
  }

  // ------------------------------------------------------------ overlay
  text(key: string, str: string, x: number, y: number, color: number, size = 11): Text {
    let t = this.overlayTexts.get(key)
    if (!t) {
      t = new Text({ text: str, style: { fontFamily: 'Segoe UI, Arial', fontSize: size, fill: color }, resolution: 2 })
      this.overlayTexts.set(key, t)
      this.app.stage.addChild(t)
    } else {
      if (t.text !== str) t.text = str
      if (t.style.fill !== color) t.style.fill = color
    }
    t.position.set(Math.round(x), Math.round(y))
    t.rotation = 0
    t.visible = true
    this.usedTexts.add(key)
    return t
  }

  drawOverlay(s: EditorState, page: Page): void {
    const g = this.overlay
    const v = s.view
    const pal = canvasPalette()
    g.clear()
    this.usedTexts.clear()
    const idx = indexPage(page)
    const sel = s.selection

    // frame labels
    for (const n of page.children) {
      if (n.type !== 'frame' || !n.visible) continue
      const p = toScreen(v, n.x, n.y)
      const isSel = sel.includes(n.id)
      const isStart = page.startFrameId === n.id && s.mode === 'prototype'
      const label = (isStart ? '▶ ' : '') + n.name
      this.text(`label:${n.id}`, label, p.x, p.y - 17, isSel ? BLUE : isStart ? 0x7fd0ff : pal.label)
    }

    // subtle frame outline (frames are white on a light canvas)
    for (const n of page.children) {
      if (n.type !== 'frame' || !n.visible) continue
      const r = this.screenRect(page, n.id, v)
      if (r) g.rect(r.x - 0.5, r.y - 0.5, r.width + 1, r.height + 1).stroke({ color: pal.frameShadow, width: 1, alpha: 0.12 })
    }

    // hover
    const hoverId = useHover.getState().hoverId
    if (hoverId && !sel.includes(hoverId) && !this.drag) {
      const n = idx.byId.get(hoverId)?.node
      if (n) {
        g.poly(this.cornersScreen(page, n, v).flatMap((p) => [p.x, p.y])).stroke({ color: BLUE, width: 1.5 })
      }
    }

    // selection outlines
    for (const id of sel) {
      const n = idx.byId.get(id)?.node
      if (!n) continue
      g.poly(this.cornersScreen(page, n, v).flatMap((p) => [p.x, p.y])).stroke({ color: BLUE, width: 1.5 })
    }
    // bbox + handles
    if (sel.length) {
      const bbox = this.selectionBBox(page, sel, v)
      if (bbox) {
        if (sel.length > 1) g.rect(bbox.x, bbox.y, bbox.width, bbox.height).stroke({ color: BLUE, width: 1 })
        const single = sel.length === 1 ? idx.byId.get(sel[0])?.node : undefined
        const cropping = !!this.cropNodeId && single?.id === this.cropNodeId
        if (s.mode === 'design' && single && !single.locked) {
          for (const h of HANDLES) {
            const hx = bbox.x + h.fx * bbox.width
            const hy = bbox.y + h.fy * bbox.height
            g.rect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
              .fill(cropping ? MAGENTA : 0xffffff)
              .stroke({ color: cropping ? 0xffffff : BLUE, width: 1 })
          }
          if (cropping) this.text('cropHint', 'CROP · kéo tay cầm · Esc xong', bbox.x, bbox.y - 34, MAGENTA, 10)
        }
        // dimension label
        const w = sel.length === 1 && single ? single.width : bbox.width / v.zoom
        const h = sel.length === 1 && single ? single.height : bbox.height / v.zoom
        const label = `${fmt(w)} × ${fmt(h)}`
        const t = this.text('dim', label, 0, 0, 0xffffff, 10)
        const tw = t.width + 8
        const tx = bbox.x + bbox.width / 2 - tw / 2
        const ty = bbox.y + bbox.height + 8
        g.roundRect(tx, ty, tw, 16, 3).fill(BLUE)
        t.position.set(Math.round(tx + 4), Math.round(ty + 1))
      }
    }

    // scope outline (entered container)
    if (s.scopeId) {
      const n = idx.byId.get(s.scopeId)?.node
      if (n && !sel.includes(n.id)) {
        const r = this.screenRect(page, n.id, v)
        if (r) g.rect(r.x, r.y, r.width, r.height).stroke({ color: BLUE, width: 1, alpha: 0.4 })
      }
    }

    // marquee
    if (this.drag?.kind === 'marquee') {
      const d = this.drag
      const r = normRect(d.wx, d.wy, d.cx, d.cy)
      const p = toScreen(v, r.x, r.y)
      g.rect(p.x, p.y, r.width * v.zoom, r.height * v.zoom).fill({ color: BLUE, alpha: 0.1 }).stroke({ color: BLUE, width: 1 })
    }

    // snap guides
    const H = this.app.screen.height
    const W = this.app.screen.width
    for (const x of this.guides.xs) {
      const p = toScreen(v, x, 0)
      g.moveTo(p.x, 0).lineTo(p.x, H).stroke({ color: RED, width: 1 })
    }
    for (const y of this.guides.ys) {
      const p = toScreen(v, 0, y)
      g.moveTo(0, p.y).lineTo(W, p.y).stroke({ color: RED, width: 1 })
    }

    // nine-slice guides
    if (s.editSlices && sel.length === 1) {
      const n = idx.byId.get(sel[0])?.node
      if (n && n.type === 'nineslice') {
        const lines = this.sliceLines(page, n, v, s.doc.assets)
        const r = this.screenRect(page, n.id, v)
        if (lines && r) {
          g.moveTo(lines.left, r.y - 10).lineTo(lines.left, r.y + r.height + 10).stroke({ color: MAGENTA, width: 1 })
          g.moveTo(lines.right, r.y - 10).lineTo(lines.right, r.y + r.height + 10).stroke({ color: MAGENTA, width: 1 })
          g.moveTo(r.x - 10, lines.top).lineTo(r.x + r.width + 10, lines.top).stroke({ color: MAGENTA, width: 1 })
          g.moveTo(r.x - 10, lines.bottom).lineTo(r.x + r.width + 10, lines.bottom).stroke({ color: MAGENTA, width: 1 })
          const knob = (x: number, y: number): void => {
            g.circle(x, y, 4).fill(0xffffff).stroke({ color: MAGENTA, width: 1.5 })
          }
          knob(lines.left, r.y - 10)
          knob(lines.right, r.y - 10)
          knob(r.x - 10, lines.top)
          knob(r.x - 10, lines.bottom)
          this.text('sl', `L ${n.insets.left}  T ${n.insets.top}  R ${n.insets.right}  B ${n.insets.bottom}`, r.x, r.y + r.height + 28, MAGENTA, 10)
        }
      }
    }

    // prototype connections
    if (s.mode === 'prototype') {
      const frameName = (id?: NodeId): string | undefined => (id ? (page.children.find((c) => c.id === id)?.name ?? undefined) : undefined)
      // hotspots: outline every node that has an interaction
      const hot = new Set(page.connections.map((c) => c.from))
      for (const id of hot) {
        const r = this.screenRect(page, id, v)
        if (r) g.rect(r.x, r.y, r.width, r.height).stroke({ color: BLUE, width: 1, alpha: 0.5 })
      }
      for (const c of page.connections) {
        const ep = this.connectionEndpoints(page, c, v)
        if (!ep) continue
        const selected = s.selectedConnectionId === c.id
        const ovl = c.action === 'overlay' || c.action === 'swap'
        this.drawArrow(g, ep, selected ? 0xffffff : ovl ? MAGENTA : BLUE, selected ? 2.5 : 1.5, c.action === 'back' || c.action === 'close')
        // label pill at the curve midpoint: "click → Shop · Dissolve 300ms"
        const { c1x, c1y, c2x, c2y } = connectionCurve(ep.x0, ep.y0, ep.x1, ep.y1)
        const mx = 0.125 * ep.x0 + 0.375 * c1x + 0.375 * c2x + 0.125 * ep.x1
        const my = 0.125 * ep.y0 + 0.375 * c1y + 0.375 * c2y + 0.125 * ep.y1
        const label = `${triggerLabel(c)} ${actionLabel(c, frameName(c.to))}${selected && c.transition !== 'instant' ? ` · ${transitionLabel(c)}` : ''}`
        const t = this.text(`conn:${c.id}`, label, mx - 4, my - 8, 0xffffff, selected ? 11 : 10)
        g.roundRect(t.x - 5, t.y - 2, t.width + 10, t.height + 4, 6)
          .fill({ color: selected ? 0x1f1f1f : ovl ? MAGENTA : BLUE, alpha: 0.94 })
          .stroke({ color: selected ? 0xffffff : 0x000000, width: selected ? 1.5 : 0, alpha: selected ? 1 : 0 })
      }
      const hp = this.hotspotHandle(page, sel, v)
      if (hp) {
        g.circle(hp.x, hp.y, 7).fill(0xffffff).stroke({ color: BLUE, width: 2 })
        g.moveTo(hp.x - 3.5, hp.y).lineTo(hp.x + 3.5, hp.y).moveTo(hp.x, hp.y - 3.5).lineTo(hp.x, hp.y + 3.5).stroke({ color: BLUE, width: 1.5 })
      }
      if (this.drag?.kind === 'connect') {
        const d = this.drag
        this.drawArrow(g, { x0: d.sx, y0: d.sy, x1: d.cx, y1: d.cy }, d.alt ? MAGENTA : BLUE, 1.5)
        if (d.targetId) {
          const r = this.screenRect(page, d.targetId, v)
          if (r) g.rect(r.x, r.y, r.width, r.height).stroke({ color: d.alt ? MAGENTA : BLUE, width: 3 })
        }
        this.text('connHint', d.targetId ? (d.alt ? 'Thả: mở overlay' : 'Thả: navigate (giữ Alt = overlay)') : 'Kéo tới một frame khác', d.cx + 14, d.cy + 10, 0xffffff, 10)
      }
      // start frame badge
      if (page.startFrameId) {
        const r = this.screenRect(page, page.startFrameId, v)
        if (r) {
          const t = this.text('flowStart', '▶ Flow start', r.x, r.y - 34, 0xffffff, 10)
          g.roundRect(t.x - 5, t.y - 2, t.width + 10, t.height + 4, 6).fill({ color: 0x2ea043, alpha: 0.95 })
        }
      }
    }

    // guides
    if (s.showRulers) {
      for (const gd of page.guides ?? []) {
        const selG = this.selectedGuide === gd.id
        if (gd.axis === 'x') {
          const p = toScreen(v, gd.pos, 0)
          g.moveTo(p.x, 0).lineTo(p.x, H).stroke({ color: CYAN, width: selG ? 2 : 1, alpha: selG ? 1 : 0.8 })
          this.text(`gx:${gd.id}`, String(gd.pos), p.x + 3, RULER + 2, CYAN, 10)
        } else {
          const p = toScreen(v, 0, gd.pos)
          g.moveTo(0, p.y).lineTo(W, p.y).stroke({ color: CYAN, width: selG ? 2 : 1, alpha: selG ? 1 : 0.8 })
          this.text(`gy:${gd.id}`, String(gd.pos), RULER + 2, p.y + 2, CYAN, 10)
        }
      }
      // rulers
      g.rect(0, 0, W, RULER).fill({ color: pal.ruler, alpha: 0.96 })
      g.rect(0, 0, RULER, H).fill({ color: pal.ruler, alpha: 0.96 })
      g.moveTo(0, RULER).lineTo(W, RULER).stroke({ color: pal.rulerLine, width: 1 })
      g.moveTo(RULER, 0).lineTo(RULER, H).stroke({ color: pal.rulerLine, width: 1 })
      const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
      const step = steps.find((st) => st * v.zoom >= 60) ?? 5000
      const minor = step / 5
      const x0 = Math.floor(toWorld(v, RULER, 0).x / minor) * minor
      const x1 = toWorld(v, W, 0).x
      for (let wxv = x0; wxv <= x1; wxv += minor) {
        const p = toScreen(v, wxv, 0)
        const major = Math.abs(wxv / step - Math.round(wxv / step)) < 1e-6
        g.moveTo(p.x, major ? RULER - 10 : RULER - 4).lineTo(p.x, RULER).stroke({ color: pal.rulerText, width: 1 })
        if (major) this.text(`rx:${wxv}`, String(Math.round(wxv)), p.x + 2, 1, pal.rulerText, 9)
      }
      const y0 = Math.floor(toWorld(v, 0, RULER).y / minor) * minor
      const y1 = toWorld(v, 0, H).y
      for (let wyv = y0; wyv <= y1; wyv += minor) {
        const p = toScreen(v, 0, wyv)
        const major = Math.abs(wyv / step - Math.round(wyv / step)) < 1e-6
        g.moveTo(major ? RULER - 10 : RULER - 4, p.y).lineTo(RULER, p.y).stroke({ color: pal.rulerText, width: 1 })
        if (major) {
          const t = this.text(`ry:${wyv}`, String(Math.round(wyv)), 0, 0, pal.rulerText, 9)
          t.rotation = -Math.PI / 2
          t.position.set(2, Math.round(p.y - 2))
        }
      }
      g.rect(0, 0, RULER, RULER).fill(pal.ruler)
      // selection extent on rulers
      if (sel.length) {
        const bb = this.selectionBBox(page, sel, v)
        if (bb) {
          g.rect(bb.x, 0, bb.width, RULER).fill({ color: BLUE, alpha: 0.25 })
          g.rect(0, bb.y, RULER, bb.height).fill({ color: BLUE, alpha: 0.25 })
        }
      }
    }

    // cleanup unused texts
    for (const [k, t] of this.overlayTexts) {
      if (!this.usedTexts.has(k)) t.visible = false
    }
  }

  drawArrow(g: Graphics, ep: Endpoints, color: number, width: number, stub = false): void {
    const { c1x, c1y, c2x, c2y } = connectionCurve(ep.x0, ep.y0, ep.x1, ep.y1)
    g.moveTo(ep.x0, ep.y0).bezierCurveTo(c1x, c1y, c2x, c2y, ep.x1, ep.y1).stroke({ color, width })
    g.circle(ep.x0, ep.y0, 3).fill(color)
    if (stub) {
      // back / close: end in a small loop instead of an arrow head
      g.circle(ep.x1, ep.y1, 5).stroke({ color, width })
      return
    }
    const dir = ep.x1 >= c2x ? 1 : -1
    g.poly([ep.x1, ep.y1, ep.x1 - dir * 10, ep.y1 - 5, ep.x1 - dir * 10, ep.y1 + 5]).fill(color)
  }
}

function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

export function Viewport(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ctl = new ViewportController(host)
    let disposed = false
    ctl.init().then(() => {
      if (disposed) ctl.destroy()
    })
    return () => {
      disposed = true
      if (ctl.ready) ctl.destroy()
    }
  }, [])
  return <div ref={hostRef} className="viewport" />
}
