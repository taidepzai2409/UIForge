// Prototype player (F5). Figma-style: base screen + overlay stack, history for Back,
// triggers click / hover / press / drag / after-delay / key, transitions incl. smart animate.
import { useEffect, useRef, useState } from 'react'
import { Application, Container, Graphics } from 'pixi.js'
import type { Connection, Easing, FrameNode, NodeId, Page, SceneNode, Transition } from '@/model/types'
import { isContainer } from '@/model/types'
import { hitChain, indexPage, absRect } from '@/model/nodes'
import { ease, normalizeConnection, overlayPosition, reverseTransition } from '@/model/flows'
import { getCurrentPage, useEditor } from '@/store/editor'
import { createScene, destroyScene, syncScene, type SceneView } from '@/canvas/sync'

/** Builds a page containing only the given frame placed at (0,0). Cached per frame object. */
const presentPageCache = new WeakMap<FrameNode, Page>()
function framePage(page: Page, frame: FrameNode): Page {
  let p = presentPageCache.get(frame)
  if (!p) {
    p = { ...page, children: [{ ...frame, x: 0, y: 0 }] }
    presentPageCache.set(frame, p)
  }
  return p
}

type Anim = Pick<Connection, 'transition' | 'direction' | 'duration' | 'easing'>

interface Tween {
  t0: number
  dur: number
  easing: Easing
  apply: (k: number) => void
  done: () => void
}

/** One rendered screen: the base frame or an overlay. */
class Layer {
  root = new Container()
  scene: SceneView = createScene()
  dim: Graphics | null = null
  /** position of the frame inside the base (0,0 for base) */
  pos = { x: 0, y: 0 }
  constructor(
    public frame: FrameNode,
    public via: Connection | null,
    public isOverlay: boolean
  ) {
    this.root.addChild(this.scene.root)
  }
  destroy(): void {
    destroyScene(this.scene)
    this.root.destroy({ children: true })
  }
}

export type PresentScale = 'fit' | '100'

export class Presenter {
  app = new Application()
  /** everything in frame units, scaled/centred by `world` */
  world = new Container()
  layersRoot = new Container()
  ghostRoot = new Container()
  overlayG = new Graphics()
  ready = false
  base: Layer | null = null
  overlays: Layer[] = []
  history: FrameNode[] = []
  tweens: Tween[] = []
  scale = 1
  scaleMode: PresentScale = 'fit'
  offset = { x: 0, y: 0 }
  flashUntil = 0
  showHotspots = false
  delayTimers: number[] = []
  hoverState: { nodeId: NodeId; c: Connection; reverted: boolean } | null = null
  pressState: { nodeId: NodeId; c: Connection } | null = null
  onChange: () => void = () => {}
  startFrameId: NodeId | null = null

  constructor(private host: HTMLDivElement) {}

  async init(startId: NodeId): Promise<void> {
    await this.app.init({ resizeTo: this.host, background: 0x000000, antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true })
    this.host.appendChild(this.app.canvas)
    this.world.addChild(this.ghostRoot, this.layersRoot)
    this.app.stage.addChild(this.world, this.overlayG)
    const c = this.app.canvas
    c.addEventListener('pointerdown', this.onPointerDown)
    c.addEventListener('pointerup', this.onPointerUp)
    c.addEventListener('pointermove', this.onPointerMove)
    c.addEventListener('pointerleave', this.onPointerLeave)
    this.app.renderer.on('resize', () => this.layout())
    this.app.ticker.add(() => this.tick())
    // the editor viewport stops the shared ticker (on-demand rendering); the player needs it running
    this.app.ticker.start()
    this.ready = true
    this.startFrameId = startId
    this.restart()
  }

  destroy(): void {
    this.clearTimers()
    if (this.ready) {
      this.base?.destroy()
      for (const o of this.overlays) o.destroy()
      // never `destroy(true)`: it releases Pixi's GLOBAL batch pool, which the main viewport still uses
      this.app.destroy({ removeView: true }, { children: true })
    }
  }

  // ------------------------------------------------------------ state helpers
  private page(): Page {
    return getCurrentPage()
  }
  private frameById(id: NodeId | undefined | null): FrameNode | null {
    if (!id) return null
    const f = this.page().children.find((c) => c.id === id)
    return f && f.type === 'frame' ? f : null
  }
  currentFrame(): FrameNode | null {
    return this.base?.frame ?? null
  }
  topLayer(): Layer | null {
    return this.overlays[this.overlays.length - 1] ?? this.base
  }
  frameIdsOnScreen(): NodeId[] {
    return [this.base, ...this.overlays].filter((l): l is Layer => !!l).map((l) => l.frame.id)
  }

  layout(): void {
    const f = this.base?.frame
    if (!f) return
    const W = this.app.screen.width
    const H = this.app.screen.height
    this.scale = this.scaleMode === '100' ? 1 : Math.min(W / f.width, H / f.height)
    this.offset = { x: Math.round((W - f.width * this.scale) / 2), y: Math.round((H - f.height * this.scale) / 2) }
    this.world.position.set(this.offset.x, this.offset.y)
    this.world.scale.set(this.scale)
  }

  setScaleMode(m: PresentScale): void {
    this.scaleMode = m
    this.layout()
  }

  private makeLayer(frame: FrameNode, via: Connection | null, isOverlay: boolean): Layer {
    const layer = new Layer(frame, via, isOverlay)
    syncScene(layer.scene, framePage(this.page(), frame), useEditor.getState().doc.assets)
    layer.scene.onTextureLoaded = () => {}
    if (isOverlay && via?.overlay) {
      const base = this.base!.frame
      layer.pos = overlayPosition(base, frame, via.overlay)
      if (via.overlay.dim) {
        const dim = new Graphics()
        const col = parseInt(via.overlay.dimColor.replace('#', ''), 16)
        dim.rect(-base.width * 2, -base.height * 2, base.width * 5, base.height * 5).fill({ color: Number.isFinite(col) ? col : 0, alpha: via.overlay.dimOpacity })
        layer.dim = dim
        layer.root.addChildAt(dim, 0)
      }
      layer.scene.root.position.set(layer.pos.x, layer.pos.y)
    }
    return layer
  }

  // ------------------------------------------------------------ navigation
  restart(): void {
    this.clearTimers()
    this.flushTweens()
    this.ghostRoot.removeChildren().forEach((c) => c.destroy({ children: true }))
    for (const o of this.overlays) o.destroy()
    this.overlays = []
    this.history = []
    const f = this.frameById(this.startFrameId) ?? (this.page().children.find((c) => c.type === 'frame') as FrameNode | undefined)
    if (!f) return
    this.base?.destroy()
    this.base = this.makeLayer(f, null, false)
    this.layersRoot.addChild(this.base.root)
    this.layout()
    this.afterShow()
  }

  /** Jump to a frame without history / animation (toolbar dropdown, arrow keys). */
  jump(id: NodeId): void {
    const f = this.frameById(id)
    if (!f) return
    this.navigate(f, null, { transition: 'instant', duration: 0 }, false)
  }

  navigate(to: FrameNode, via: Connection | null, anim: Anim, pushHistory = true): void {
    if (!this.base) return
    this.flushTweens()
    const from = this.base
    if (pushHistory) this.history.push(from.frame)
    // overlays close with the screen
    for (const o of this.overlays) o.destroy()
    this.overlays = []
    const next = this.makeLayer(to, via, false)
    this.base = next
    this.layersRoot.addChild(next.root)
    this.layout()
    this.animateSwap(from, next, anim)
    this.afterShow()
  }

  openOverlay(to: FrameNode, via: Connection, anim: Anim, replaceTop = false): void {
    if (!this.base) return
    this.flushTweens()
    if (replaceTop && this.overlays.length) {
      const old = this.overlays.pop()!
      this.animateOut(old, { transition: 'dissolve', duration: Math.min(150, anim.duration), easing: 'ease-out' }, () => old.destroy())
    }
    const layer = this.makeLayer(to, via, true)
    this.overlays.push(layer)
    this.layersRoot.addChild(layer.root)
    this.animateIn(layer, anim)
    this.afterShow()
  }

  closeOverlay(anim?: Anim): void {
    this.flushTweens()
    const top = this.overlays.pop()
    if (!top) return
    const a = anim ?? reverseTransition(top.via ?? ({ transition: 'dissolve', duration: 200 } as Connection))
    this.animateOut(top, a, () => top.destroy())
    this.afterShow()
  }

  back(anim?: Anim): void {
    if (this.overlays.length) {
      this.closeOverlay(anim)
      return
    }
    const prev = this.history.pop()
    if (!prev || !this.base) return
    const a = anim ?? reverseTransition(this.base.via ?? ({ transition: 'dissolve', duration: 200 } as Connection))
    this.navigate(prev, null, a, false)
  }

  private afterShow(): void {
    this.onChange()
    this.scheduleDelayTriggers()
  }

  // ------------------------------------------------------------ running a connection
  run(c: Connection, reverse = false): void {
    const conn = normalizeConnection(c)
    const anim: Anim = reverse ? reverseTransition(conn) : conn
    switch (conn.action) {
      case 'navigate': {
        const f = this.frameById(conn.to)
        if (!f) return
        if (reverse) this.back(anim)
        else this.navigate(f, conn, anim)
        return
      }
      case 'overlay': {
        const f = this.frameById(conn.to)
        if (!f) return
        if (reverse) this.closeOverlay(anim)
        else this.openOverlay(f, conn, anim)
        return
      }
      case 'swap': {
        const f = this.frameById(conn.to)
        if (!f) return
        this.openOverlay(f, conn, anim, true)
        return
      }
      case 'back':
        this.back(anim)
        return
      case 'close':
        this.closeOverlay(anim)
        return
    }
  }

  // ------------------------------------------------------------ animation
  /** Finish every running animation immediately (before layers are destroyed by the next action). */
  private flushTweens(): void {
    const list = this.tweens
    this.tweens = []
    for (const t of list) {
      try {
        t.apply(1)
        t.done()
      } catch (e) {
        console.warn('present tween flush failed', e)
      }
    }
  }

  private addTween(dur: number, easing: Easing | undefined, apply: (k: number) => void, done: () => void): void {
    if (dur <= 0) {
      apply(1)
      done()
      return
    }
    this.tweens.push({ t0: performance.now(), dur, easing: easing ?? 'ease-out', apply, done })
  }

  private dirVector(d: Anim['direction']): { x: number; y: number } {
    const f = this.base!.frame
    switch (d ?? 'left') {
      case 'right':
        return { x: -f.width, y: 0 }
      case 'up':
        return { x: 0, y: f.height }
      case 'down':
        return { x: 0, y: -f.height }
      default:
        return { x: f.width, y: 0 }
    }
  }

  /** Base screen change: outgoing layer becomes a ghost, incoming animates in. */
  private animateSwap(from: Layer, to: Layer, anim: Anim): void {
    const tr: Transition = anim.transition
    if (tr === 'instant' || anim.duration <= 0) {
      from.destroy()
      return
    }
    if (tr === 'smart') {
      this.smartAnimate(from, to, anim)
      return
    }
    // keep the old screen alive as a ghost under/over the new one
    this.ghostRoot.addChild(from.root)
    const v = this.dirVector(anim.direction)
    const inRoot = to.scene.root
    const outRoot = from.scene.root
    const finish = (): void => {
      from.destroy()
      inRoot.position.set(0, 0)
      inRoot.scale.set(1)
      inRoot.alpha = 1
    }
    switch (tr) {
      case 'dissolve':
        this.addTween(anim.duration, anim.easing, (k) => (outRoot.alpha = 1 - k), finish)
        break
      case 'move-in':
        // new screen slides over the old one (layersRoot is above ghostRoot)
        this.addTween(anim.duration, anim.easing, (k) => inRoot.position.set(v.x * (1 - k), v.y * (1 - k)), finish)
        break
      case 'move-out':
        // old screen slides away revealing the new one
        this.world.setChildIndex(this.ghostRoot, 1)
        this.addTween(anim.duration, anim.easing, (k) => outRoot.position.set(-v.x * k, -v.y * k), () => {
          this.world.setChildIndex(this.ghostRoot, 0)
          finish()
        })
        break
      case 'push':
        this.addTween(anim.duration, anim.easing, (k) => {
          inRoot.position.set(v.x * (1 - k), v.y * (1 - k))
          outRoot.position.set(-v.x * k, -v.y * k)
        }, finish)
        break
      case 'slide-in':
        this.addTween(anim.duration, anim.easing, (k) => {
          inRoot.position.set(v.x * (1 - k), v.y * (1 - k))
          outRoot.position.set(-v.x * 0.3 * k, -v.y * 0.3 * k)
          outRoot.alpha = 1 - k * 0.5
        }, finish)
        break
      case 'slide-out':
        this.world.setChildIndex(this.ghostRoot, 1)
        this.addTween(anim.duration, anim.easing, (k) => {
          outRoot.position.set(-v.x * k, -v.y * k)
          inRoot.position.set(v.x * 0.3 * (1 - k), v.y * 0.3 * (1 - k))
        }, () => {
          this.world.setChildIndex(this.ghostRoot, 0)
          finish()
        })
        break
      case 'scale-in': {
        const f = to.frame
        inRoot.pivot.set(f.width / 2, f.height / 2)
        inRoot.position.set(f.width / 2, f.height / 2)
        this.addTween(anim.duration, anim.easing, (k) => {
          inRoot.scale.set(0.8 + 0.2 * k)
          inRoot.alpha = Math.min(1, k * 2)
        }, () => {
          inRoot.pivot.set(0, 0)
          finish()
        })
        break
      }
      case 'scale-out': {
        const f = from.frame
        this.world.setChildIndex(this.ghostRoot, 1)
        outRoot.pivot.set(f.width / 2, f.height / 2)
        outRoot.position.set(f.width / 2, f.height / 2)
        this.addTween(anim.duration, anim.easing, (k) => {
          outRoot.scale.set(1 + 0.2 * k)
          outRoot.alpha = 1 - k
        }, () => {
          this.world.setChildIndex(this.ghostRoot, 0)
          finish()
        })
        break
      }
      default:
        finish()
    }
  }

  /** Smart animate: nodes with the same path tween between the two screens; the rest cross-fade. */
  private smartAnimate(from: Layer, to: Layer, anim: Anim): void {
    const pageFrom = framePage(this.page(), from.frame)
    const pageTo = framePage(this.page(), to.frame)
    const pathsFrom = pathMap(from.frame)
    const pathsTo = pathMap(to.frame)
    // nodes that don't match by full path still match when their NAME is unique on both screens
    // (a button moved out of a group keeps animating)
    {
      const byNameFrom = new Map<string, string[]>()
      const byNameTo = new Map<string, string[]>()
      for (const p of pathsFrom.keys()) byNameFrom.set(nameOf(p), [...(byNameFrom.get(nameOf(p)) ?? []), p])
      for (const p of pathsTo.keys()) byNameTo.set(nameOf(p), [...(byNameTo.get(nameOf(p)) ?? []), p])
      for (const [pTo] of [...pathsTo]) {
        if (pathsFrom.has(pTo)) continue
        const cands = byNameFrom.get(nameOf(pTo)) ?? []
        const cTo = byNameTo.get(nameOf(pTo)) ?? []
        if (cands.length === 1 && cTo.length === 1 && !pathsTo.has(cands[0])) {
          const n = pathsFrom.get(cands[0])!
          pathsFrom.delete(cands[0])
          pathsFrom.set(pTo, n)
        }
      }
    }
    this.ghostRoot.addChild(from.root)
    type Pair = { c: Container; dx: number; dy: number; sx: number; sy: number; a0: number; a1: number; base: { x: number; y: number } }
    const pairs: Pair[] = []
    const fadeIn: Container[] = []
    const fadeOut: Container[] = []
    for (const [path, nTo] of pathsTo) {
      const eTo = to.scene.entries.get(nTo.id)
      if (!eTo) continue
      const nFrom = pathsFrom.get(path)
      if (!nFrom) {
        fadeIn.push(eTo.container)
        continue
      }
      const rFrom = absRect(pageFrom, nFrom.id)
      const rTo = absRect(pageTo, nTo.id)
      if (!rFrom || !rTo) continue
      const eFrom = from.scene.entries.get(nFrom.id)
      if (eFrom) eFrom.container.visible = false
      // only animate the outermost matched node of a subtree (children move with their parent)
      const c = eTo.container
      pairs.push({ c, dx: rFrom.x - rTo.x, dy: rFrom.y - rTo.y, sx: rTo.width ? rFrom.width / rTo.width : 1, sy: rTo.height ? rFrom.height / rTo.height : 1, a0: nFrom.opacity, a1: nTo.opacity, base: { x: c.position.x, y: c.position.y } })
    }
    for (const [path, nFrom] of pathsFrom) {
      if (pathsTo.has(path)) continue
      const e = from.scene.entries.get(nFrom.id)
      if (e) fadeOut.push(e.container)
    }
    // ancestors override: drop pairs whose ancestor is also paired (they'd double-move)
    const pairedIds = new Set<Container>(pairs.map((p) => p.c))
    const filtered = pairs.filter((p) => {
      let a = p.c.parent
      while (a) {
        if (pairedIds.has(a)) return false
        a = a.parent
      }
      return true
    })
    const finish = (): void => {
      from.destroy()
      for (const p of filtered) {
        p.c.position.set(p.base.x, p.base.y)
        p.c.scale.set(1)
        p.c.alpha = p.a1
      }
      for (const c of fadeIn) c.alpha = 1
    }
    for (const c of fadeIn) c.alpha = 0
    this.addTween(anim.duration, anim.easing, (k) => {
      const inv = 1 - k
      for (const p of filtered) {
        p.c.position.set(p.base.x + p.dx * inv, p.base.y + p.dy * inv)
        p.c.scale.set(p.sx + (1 - p.sx) * k, p.sy + (1 - p.sy) * k)
        p.c.alpha = p.a0 + (p.a1 - p.a0) * k
      }
      for (const c of fadeIn) c.alpha = k
      for (const c of fadeOut) c.alpha = inv
    }, finish)
  }

  /** Overlay entering. */
  private animateIn(layer: Layer, anim: Anim): void {
    const root = layer.scene.root
    const f = layer.frame
    const p = layer.pos
    const dim = layer.dim
    if (dim) dim.alpha = 0
    const finish = (): void => {
      root.position.set(p.x, p.y)
      root.scale.set(1)
      root.alpha = 1
      root.pivot.set(0, 0)
      if (dim) dim.alpha = 1
    }
    if (anim.transition === 'instant' || anim.duration <= 0) {
      finish()
      return
    }
    const v = this.dirVector(anim.direction)
    switch (anim.transition) {
      case 'move-in':
      case 'slide-in':
      case 'push':
      case 'move-out':
      case 'slide-out':
        this.addTween(anim.duration, anim.easing, (k) => {
          root.position.set(p.x + v.x * (1 - k), p.y + v.y * (1 - k))
          if (dim) dim.alpha = k
        }, finish)
        break
      case 'scale-in':
      case 'scale-out':
      case 'smart':
        root.pivot.set(f.width / 2, f.height / 2)
        this.addTween(anim.duration, anim.easing, (k) => {
          root.position.set(p.x + f.width / 2, p.y + f.height / 2)
          root.scale.set(0.7 + 0.3 * k)
          root.alpha = Math.min(1, k * 2)
          if (dim) dim.alpha = k
        }, finish)
        break
      default:
        this.addTween(anim.duration, anim.easing, (k) => {
          root.alpha = k
          if (dim) dim.alpha = k
        }, finish)
    }
  }

  /** Overlay leaving. */
  private animateOut(layer: Layer, anim: Anim, done: () => void): void {
    const root = layer.scene.root
    const f = layer.frame
    const p = layer.pos
    const dim = layer.dim
    if (anim.transition === 'instant' || anim.duration <= 0) {
      done()
      return
    }
    const v = this.dirVector(anim.direction)
    switch (anim.transition) {
      case 'move-out':
      case 'slide-out':
      case 'push':
      case 'move-in':
      case 'slide-in':
        this.addTween(anim.duration, anim.easing, (k) => {
          root.position.set(p.x - v.x * k, p.y - v.y * k)
          if (dim) dim.alpha = 1 - k
        }, done)
        break
      case 'scale-out':
      case 'scale-in':
      case 'smart':
        root.pivot.set(f.width / 2, f.height / 2)
        this.addTween(anim.duration, anim.easing, (k) => {
          root.position.set(p.x + f.width / 2, p.y + f.height / 2)
          root.scale.set(1 - 0.3 * k)
          root.alpha = 1 - k
          if (dim) dim.alpha = 1 - k
        }, done)
        break
      default:
        this.addTween(anim.duration, anim.easing, (k) => {
          root.alpha = 1 - k
          if (dim) dim.alpha = 1 - k
        }, done)
    }
  }

  tick(): void {
    const now = performance.now()
    if (this.tweens.length) {
      const keep: Tween[] = []
      for (const t of this.tweens) {
        const k = Math.min(1, (now - t.t0) / t.dur)
        try {
          t.apply(ease(k, t.easing))
          if (k >= 1) t.done()
          else keep.push(t)
        } catch (e) {
          console.warn('present tween failed', e)
        }
      }
      this.tweens = keep
    }
    // hotspot hints
    this.overlayG.clear()
    if (this.showHotspots || now < this.flashUntil) {
      const page = this.page()
      const top = this.topLayer()
      if (top) {
        const fp = framePage(page, top.frame)
        const idx = indexPage(fp)
        for (const c of page.connections) {
          if (c.trigger === 'after-delay' || c.trigger === 'key') continue
          if (!idx.byId.has(c.from) || c.from === top.frame.id) continue
          const r = absRect(fp, c.from)
          if (!r) continue
          this.overlayG
            .rect(this.offset.x + (top.pos.x + r.x) * this.scale, this.offset.y + (top.pos.y + r.y) * this.scale, r.width * this.scale, r.height * this.scale)
            .fill({ color: 0x4f9dff, alpha: 0.22 })
            .stroke({ color: 0x4f9dff, width: 2 })
        }
      }
    }
  }

  // ------------------------------------------------------------ triggers
  private clearTimers(): void {
    for (const t of this.delayTimers) window.clearTimeout(t)
    this.delayTimers = []
  }

  scheduleDelayTriggers(): void {
    this.clearTimers()
    const page = this.page()
    const top = this.topLayer()
    if (!top) return
    const idx = indexPage(framePage(page, top.frame))
    for (const c of page.connections) {
      if (c.trigger !== 'after-delay' || !idx.byId.has(c.from)) continue
      this.delayTimers.push(window.setTimeout(() => this.run(c), c.delay ?? 1000))
    }
  }

  onKey(e: KeyboardEvent): boolean {
    const page = this.page()
    const top = this.topLayer()
    if (!top) return false
    const idx = indexPage(framePage(page, top.frame))
    const key = e.key.toLowerCase()
    for (const c of page.connections) {
      if (c.trigger !== 'key' || !idx.byId.has(c.from)) continue
      if ((c.key ?? '').toLowerCase() === key) {
        this.run(c)
        return true
      }
    }
    return false
  }

  /** Top-most layer hit at screen point + the node chain inside it. */
  private hit(e: PointerEvent): { layer: Layer; chain: SceneNode[]; inside: boolean } | null {
    const rect = this.app.canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left - this.offset.x) / this.scale
    const y = (e.clientY - rect.top - this.offset.y) / this.scale
    const page = this.page()
    const layers = [...this.overlays].reverse()
    for (const l of layers) {
      const lx = x - l.pos.x
      const ly = y - l.pos.y
      const inside = lx >= 0 && ly >= 0 && lx <= l.frame.width && ly <= l.frame.height
      if (inside) return { layer: l, chain: hitChain(framePage(page, l.frame), lx, ly), inside: true }
      // overlays are modal: clicks outside stop at the top overlay
      return { layer: l, chain: [], inside: false }
    }
    if (!this.base) return null
    return { layer: this.base, chain: hitChain(framePage(page, this.base.frame), x, y), inside: true }
  }

  private findConn(chain: SceneNode[], trigger: Connection['trigger']): { c: Connection; node: SceneNode } | null {
    const page = this.page()
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = page.connections.find((k) => k.from === chain[i].id && k.trigger === trigger)
      if (c) return { c, node: chain[i] }
    }
    return null
  }

  onPointerDown = (e: PointerEvent): void => {
    const h = this.hit(e)
    if (!h) return
    if (!h.inside) {
      const top = this.overlays[this.overlays.length - 1]
      if (top?.via?.overlay?.closeOutside) this.closeOverlay()
      else this.flashUntil = performance.now() + 350
      return
    }
    const press = this.findConn(h.chain, 'press')
    if (press) {
      this.pressState = { nodeId: press.node.id, c: press.c }
      this.run(press.c)
      return
    }
    const drag = this.findConn(h.chain, 'drag')
    if (drag) {
      this.dragStart = { x: e.clientX, y: e.clientY, c: drag.c }
      return
    }
    const click = this.findConn(h.chain, 'click')
    if (click) {
      this.run(click.c)
      return
    }
    this.flashUntil = performance.now() + 350
  }

  dragStart: { x: number; y: number; c: Connection } | null = null

  onPointerUp = (): void => {
    if (this.pressState) {
      const s = this.pressState
      this.pressState = null
      this.run(s.c, true)
    }
    this.dragStart = null
  }

  onPointerMove = (e: PointerEvent): void => {
    if (this.dragStart && Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y) > 12) {
      const c = this.dragStart.c
      this.dragStart = null
      this.run(c)
      return
    }
    const h = this.hit(e)
    const hov = h?.inside ? this.findConn(h.chain, 'hover') : null
    if (hov && (!this.hoverState || this.hoverState.nodeId !== hov.node.id)) {
      if (this.hoverState) this.run(this.hoverState.c, true)
      this.hoverState = { nodeId: hov.node.id, c: hov.c, reverted: false }
      this.run(hov.c)
    } else if (!hov && this.hoverState) {
      // still over the same node? (overlay might cover it) – leave when the node is no longer under the cursor
      const stillOver = h?.chain.some((n) => n.id === this.hoverState!.nodeId)
      if (!stillOver) {
        const s = this.hoverState
        this.hoverState = null
        this.run(s.c, true)
      }
    }
    const clickable = h?.inside && (this.findConn(h.chain, 'click') || this.findConn(h.chain, 'press') || this.findConn(h.chain, 'drag'))
    this.app.canvas.style.cursor = clickable ? 'pointer' : 'default'
  }

  onPointerLeave = (): void => {
    if (this.hoverState) {
      const s = this.hoverState
      this.hoverState = null
      this.run(s.c, true)
    }
  }
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** "Group/btn" → node, for smart animate matching. */
function pathMap(frame: FrameNode): Map<string, SceneNode> {
  const m = new Map<string, SceneNode>()
  const walk = (list: SceneNode[], prefix: string): void => {
    for (const n of list) {
      const p = prefix ? `${prefix}/${n.name}` : n.name
      if (!m.has(p)) m.set(p, n)
      if (isContainer(n)) walk(n.children, p)
    }
  }
  walk(frame.children, '')
  return m
}

export function Present(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const ctlRef = useRef<Presenter | null>(null)
  const [frameName, setFrameName] = useState('')
  const [frameId, setFrameId] = useState<string>('')
  const [overlayNames, setOverlayNames] = useState<string[]>([])
  const [canBack, setCanBack] = useState(false)
  const [hotspots, setHotspots] = useState(false)
  const [scaleMode, setScaleMode] = useState<PresentScale>('fit')
  const setPresenting = useEditor((s) => s.setPresenting)
  const page = getCurrentPage()
  const frames = page.children.filter((c): c is FrameNode => c.type === 'frame')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const s = useEditor.getState()
    const page = getCurrentPage()
    const frames = page.children.filter((c): c is FrameNode => c.type === 'frame')
    if (!frames.length) {
      setPresenting(false)
      return
    }
    let start = s.presentFrom ?? page.startFrameId
    if (!start && s.selection.length) {
      const e = indexPage(page).byId.get(s.selection[0])
      let cur = e
      while (cur?.parent) cur = indexPage(page).byId.get(cur.parent.id)
      if (cur?.node.type === 'frame') start = cur.node.id
    }
    if (!start) start = frames[0].id
    const ctl = new Presenter(host)
    ctlRef.current = ctl
    ;(window as unknown as { __dmPresenter?: Presenter }).__dmPresenter = ctl
    ctl.onChange = () => {
      const f = ctl.currentFrame()
      setFrameName(f?.name ?? '')
      setFrameId(f?.id ?? '')
      setOverlayNames(ctl.overlays.map((o) => o.frame.name))
      setCanBack(ctl.history.length > 0 || ctl.overlays.length > 0)
    }
    let disposed = false
    void ctl.init(start).then(() => disposed && ctl.destroy())
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return
      if (ctl.onKey(e)) return
      if (e.key === 'Escape') {
        if (ctl.overlays.length) ctl.closeOverlay()
        else setPresenting(false)
      } else if (e.key === 'Backspace') ctl.back()
      else if (e.key === 'r' || e.key === 'R') ctl.restart()
      else if (e.key === 'h' || e.key === 'H') setHotspots((v) => !v)
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const i = frames.findIndex((f) => f.id === ctl.currentFrame()?.id)
        const next = frames[(i + (e.key === 'ArrowRight' ? 1 : -1) + frames.length) % frames.length]
        if (next) ctl.jump(next.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      disposed = true
      window.removeEventListener('keydown', onKey)
      if (ctl.ready) ctl.destroy()
      delete (window as unknown as { __dmPresenter?: Presenter }).__dmPresenter
    }
  }, [setPresenting])

  useEffect(() => {
    if (ctlRef.current) ctlRef.current.showHotspots = hotspots
  }, [hotspots])
  useEffect(() => {
    ctlRef.current?.setScaleMode(scaleMode)
  }, [scaleMode])

  return (
    <div className="present">
      <div className="present-bar">
        <button className="pb-btn" title="Back (Backspace)" disabled={!canBack} onClick={() => ctlRef.current?.back()}>
          ←
        </button>
        <button className="pb-btn" title="Restart (R)" onClick={() => ctlRef.current?.restart()}>
          ⟲
        </button>
        <select className="pb-select" value={frameId} onChange={(e) => ctlRef.current?.jump(e.target.value)} title="Nhảy tới frame">
          {frames.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
              {page.startFrameId === f.id ? ' (start)' : ''}
            </option>
          ))}
        </select>
        {overlayNames.length > 0 && <span className="pb-overlays">⧉ {overlayNames.join(' › ')}</span>}
        <span className="pb-spacer" />
        <button className={`pb-btn ${hotspots ? 'active' : ''}`} title="Hiện hotspot (H)" onClick={() => setHotspots((v) => !v)}>
          ◎ Hotspots
        </button>
        <select className="pb-select" value={scaleMode} onChange={(e) => setScaleMode(e.target.value as PresentScale)}>
          <option value="fit">Fit</option>
          <option value="100">100%</option>
        </select>
        <span className="dim pb-hint">Click hotspot · Backspace back · R restart · ←/→ đổi frame · Esc đóng overlay/thoát</span>
        <button className="pb-btn" onClick={() => setPresenting(false)}>
          Thoát
        </button>
      </div>
      <div className="present-host" ref={hostRef} />
      <span style={{ display: 'none' }}>{frameName}</span>
    </div>
  )
}
