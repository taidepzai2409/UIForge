import { Container, Graphics, NineSliceSprite, Sprite, Text, Texture } from 'pixi.js'
import type { Asset, NodeId, Page, SceneNode } from '@/model/types'
import { isContainer } from '@/model/types'
import { getTexture, getTextureSync } from '@/store/assets'
import { rgbaToNumber } from '@/model/color'
import { rasterizeText } from './textRaster'
import { applyLayerEffects, hasEnabledEffects } from '@/psd/effects'
import type { LayerEffectsInfo, PatternInfo } from 'ag-psd'

let patternInfos: PatternInfo[] = []
let globalLightAngle = 120
export function setPatternInfos(list: PatternInfo[]): void {
  patternInfos = list
}
export function setGlobalLightAngle(a: number): void {
  globalLightAngle = a
}

interface Entry {
  container: Container
  node: SceneNode
  view: Sprite | NineSliceSprite | Graphics | Text | null
  content: Container // where children go (frame: clipped content; group: container itself)
  bg?: Graphics
  maskG?: Graphics
  textKey?: string
  texAsset?: string
  pendingTex?: string
  fxSprite?: Sprite
  fxKey?: string
}

export interface SceneView {
  root: Container
  entries: Map<NodeId, Entry>
  onTextMeasured?: (id: NodeId, w: number, h: number) => void
  onTextureLoaded?: () => void
}

export function createScene(): SceneView {
  const root = new Container()
  root.sortableChildren = false
  return { root, entries: new Map() }
}

const BLEND: Record<string, 'normal' | 'add' | 'multiply' | 'screen'> = {
  normal: 'normal',
  add: 'add',
  multiply: 'multiply',
  screen: 'screen'
}

function applyBase(c: Container, n: SceneNode): void {
  const px = n.pivot.x * n.width
  const py = n.pivot.y * n.height
  c.pivot.set(px, py)
  c.position.set(n.x + px, n.y + py)
  c.rotation = (n.rotation * Math.PI) / 180
  c.alpha = n.opacity
  c.visible = n.visible
  c.blendMode = BLEND[n.blendMode ?? 'normal'] ?? 'normal'
}

function createEntry(n: SceneNode): Entry {
  const container = new Container()
  container.label = n.name
  const e: Entry = { container, node: n, view: null, content: container }
  if (n.type === 'frame') {
    e.bg = new Graphics()
    e.maskG = new Graphics()
    e.content = new Container()
    container.addChild(e.bg, e.maskG, e.content)
  } else if (n.type === 'rect') {
    e.view = new Graphics()
    container.addChild(e.view)
  } else if (n.type === 'text') {
    e.view = new Text({ text: '', style: { fontFamily: 'Arial', fontSize: 24 } })
    container.addChild(e.view)
  }
  return e
}

function loadTextureFor(scene: SceneView, e: Entry, asset: Asset | undefined, apply: (t: Texture) => void): void {
  if (!asset) return
  const t = getTextureSync(asset.id)
  if (t) {
    apply(t)
    return
  }
  if (e.pendingTex === asset.id) return
  e.pendingTex = asset.id
  getTexture(asset)
    .then((tex) => {
      if (e.pendingTex !== asset.id) return
      e.pendingTex = undefined
      // node may have changed while loading: re-apply current node's asset
      const cur = e.node
      if ((cur.type === 'image' || cur.type === 'nineslice') && cur.assetId === asset.id) {
        apply(tex)
        scene.onTextureLoaded?.()
      }
    })
    .catch((err) => {
      e.pendingTex = undefined
      console.warn('texture load failed', asset, err)
    })
}

function updateEntry(scene: SceneView, e: Entry, n: SceneNode, assets: Record<string, Asset>): void {
  const c = e.container
  applyBase(c, n)
  c.label = n.name
  switch (n.type) {
    case 'frame': {
      const bg = e.bg!
      bg.clear()
      if (n.fill.visible && n.fill.color.a > 0) {
        bg.rect(0, 0, n.width, n.height).fill({ color: rgbaToNumber(n.fill.color), alpha: n.fill.color.a })
      }
      const m = e.maskG!
      m.clear()
      m.rect(0, 0, n.width, n.height).fill(0xffffff)
      e.content.mask = n.clipsContent ? m : null
      m.visible = n.clipsContent
      break
    }
    case 'group':
    case 'instance':
      break
    case 'image': {
      const asset = assets[n.assetId]
      const dead = e.view instanceof Sprite && e.view.texture !== Texture.EMPTY && !e.view.texture.source
      if (e.texAsset !== n.assetId || !e.view || dead) {
        if (e.view) {
          e.view.destroy()
          e.view = null
        }
        const sp = new Sprite(Texture.EMPTY)
        e.view = sp
        c.addChild(sp)
        e.texAsset = n.assetId
        loadTextureFor(scene, e, asset, (t) => {
          if (e.view instanceof Sprite) {
            e.view.texture = t
            e.view.width = e.node.width
            e.view.height = e.node.height
          }
        })
      }
      const sp = e.view as Sprite
      if (sp.texture !== Texture.EMPTY) {
        sp.width = n.width
        sp.height = n.height
      }
      break
    }
    case 'nineslice': {
      const asset = assets[n.assetId]
      const build = (t: Texture): void => {
        if (e.view) e.view.destroy()
        const tw = t.width
        const th = t.height
        const l = Math.min(n.insets.left, tw - 1)
        const r = Math.min(n.insets.right, tw - 1 - l)
        const tp = Math.min(n.insets.top, th - 1)
        const b = Math.min(n.insets.bottom, th - 1 - tp)
        const ns = new NineSliceSprite({ texture: t, leftWidth: l, topHeight: tp, rightWidth: r, bottomHeight: b })
        ns.width = e.node.width
        ns.height = e.node.height
        e.view = ns
        c.addChild(ns)
      }
      const deadNs = e.view instanceof NineSliceSprite && !e.view.texture.source
      if (e.texAsset !== n.assetId || !(e.view instanceof NineSliceSprite) || deadNs) {
        if (e.view) {
          e.view.destroy()
          e.view = null
        }
        e.texAsset = n.assetId
        loadTextureFor(scene, e, asset, build)
      } else {
        const ns = e.view as NineSliceSprite
        const tw = ns.texture.width
        const th = ns.texture.height
        const l = Math.min(n.insets.left, tw - 1)
        const r = Math.min(n.insets.right, tw - 1 - l)
        const tp = Math.min(n.insets.top, th - 1)
        const b = Math.min(n.insets.bottom, th - 1 - tp)
        ns.leftWidth = l
        ns.rightWidth = r
        ns.topHeight = tp
        ns.bottomHeight = b
        ns.width = n.width
        ns.height = n.height
      }
      break
    }
    case 'rect': {
      const g = e.view as Graphics
      g.clear()
      const r = Math.min(n.cornerRadius, n.width / 2, n.height / 2)
      if (n.shape === 'ellipse') g.ellipse(n.width / 2, n.height / 2, n.width / 2, n.height / 2)
      else if (r > 0) g.roundRect(0, 0, n.width, n.height, r)
      else g.rect(0, 0, n.width, n.height)
      if (n.fill.visible) g.fill({ color: rgbaToNumber(n.fill.color), alpha: n.fill.color.a })
      if (n.stroke?.visible && n.stroke.width > 0) g.stroke({ color: rgbaToNumber(n.stroke.color), alpha: n.stroke.color.a, width: n.stroke.width })
      break
    }
    case 'text': {
      const t = e.view as Text
      const fx = n.effects as LayerEffectsInfo | undefined
      const styled = !!fx && hasEnabledEffects(fx)
      if (styled) {
        // Photoshop layer style on text: rasterize + run the same effects pipeline as images
        const key = JSON.stringify([n.text, n.fontFamily, n.fontSize, n.fontWeight, n.color, n.align, n.lineHeight, n.width, n.italic, n.letterSpacing, n.uppercase, fx, patternInfos.length, globalLightAngle])
        t.visible = false
        if (e.fxKey !== key) {
          e.fxKey = key
          const raw = rasterizeText(n, 1)
          const out = applyLayerEffects({ canvas: raw.canvas, left: raw.left, top: raw.top }, fx, globalLightAngle, () => {}, patternInfos)
          const tex = Texture.from(out.canvas, true) // skip Pixi's resource cache: never share with another scene's sprite
          tex.source.scaleMode = 'linear'
          if (e.fxSprite) {
            const old = e.fxSprite.texture
            e.fxSprite.texture = tex
            old.destroy(true)
          } else {
            e.fxSprite = new Sprite(tex)
            c.addChild(e.fxSprite)
          }
          e.fxSprite.position.set(out.left, out.top)
        }
        if (e.fxSprite) e.fxSprite.visible = true
        break
      }
      if (e.fxSprite) e.fxSprite.visible = false
      t.visible = true
      const key = JSON.stringify([n.text, n.fontFamily, n.fontSize, n.fontWeight, n.color, n.align, n.lineHeight, n.autoSize, n.width, n.italic, n.letterSpacing, n.uppercase])
      if (e.textKey !== key) {
        e.textKey = key
        t.text = n.uppercase ? n.text.toUpperCase() : n.text
        t.style = {
          fontFamily: [n.fontFamily, 'Arial', 'sans-serif'],
          fontSize: n.fontSize,
          fontStyle: n.italic ? 'italic' : 'normal',
          letterSpacing: n.letterSpacing ?? 0,
          fontWeight: String(n.fontWeight) as '400',
          fill: { color: rgbaToNumber(n.color), alpha: n.color.a },
          align: n.align,
          lineHeight: n.fontSize * n.lineHeight,
          wordWrap: !n.autoSize,
          wordWrapWidth: n.autoSize ? 0 : n.width
        }
        if (n.autoSize) {
          const w = Math.ceil(t.width)
          const h = Math.ceil(t.height)
          if (Math.abs(w - n.width) > 0.5 || Math.abs(h - n.height) > 0.5) scene.onTextMeasured?.(n.id, w, h)
        }
      }
      if (n.align === 'center') t.x = (n.width - t.width) / 2
      else if (n.align === 'right') t.x = n.width - t.width
      else t.x = 0
      t.y = 0
      break
    }
  }
}

/**
 * Reconcile the Pixi display tree with the page. Nodes whose object reference is
 * unchanged (immer structural sharing) are skipped entirely.
 */
export function syncScene(scene: SceneView, page: Page, assets: Record<string, Asset>): void {
  const visited = new Set<NodeId>()
  const syncList = (list: SceneNode[], parent: Container): void => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i]
      let e = scene.entries.get(n.id)
      let changed = false
      if (!e || (e.node.type !== n.type)) {
        if (e) destroyEntry(e)
        e = createEntry(n)
        scene.entries.set(n.id, e)
        changed = true
      } else if (e.node !== n) {
        changed = true
      }
      visited.add(n.id)
      if (changed) {
        updateEntry(scene, e, n, assets)
        e.node = n
      }
      if (parent.children[i] !== e.container) parent.addChildAt(e.container, Math.min(i, parent.children.length))
      if (isContainer(n)) {
        if (changed || true) syncList(n.children, e.content)
      }
    }
    // remove extra children
    while (parent.children.length > list.length) {
      const extra = parent.children[parent.children.length - 1]
      parent.removeChild(extra)
    }
  }
  syncList(page.children, scene.root)
  for (const [id, e] of scene.entries) {
    if (!visited.has(id)) {
      destroyEntry(e)
      scene.entries.delete(id)
    }
  }
}

function destroyEntry(e: Entry): void {
  e.container.removeFromParent()
  e.container.destroy({ children: true })
}

export function setTextResolution(scene: SceneView, res: number): void {
  for (const e of scene.entries.values()) {
    if (e.view instanceof Text && e.view.resolution !== res) e.view.resolution = res
  }
}

export function destroyScene(scene: SceneView): void {
  for (const e of scene.entries.values()) destroyEntry(e)
  scene.entries.clear()
  scene.root.destroy({ children: true })
}
