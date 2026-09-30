import { scalerOf } from '@/model/simulate'
import type { Anchor, Asset, AutoLayout, CanvasScalerSettings, Connection, DesignDocument, FrameNode, GroupNode, ImageEdits, Insets, NodeId, OverlaySettings, Page, SceneNode, TextEffects, Vec2 } from '@/model/types'
import { actionLabel, normalizeConnection, transitionLabel, triggerLabel } from '@/model/flows'
import { findMaster } from '@/model/instances'
import { stateMap } from '@/model/states'
import type { AtlasPlan } from './atlas'
import { isContainer } from '@/model/types'
import { toUnityRect, type UnityRect } from '@/model/anchors'
import { rgbaToHex } from '@/model/color'
import { safeFileName } from '@/model/naming'
import { textEffectsFromPsd } from '@/psd/textEffects'

export interface LayoutRect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutNode {
  id: NodeId
  name: string
  /** slash-separated path from the frame root, e.g. "Popup/Buttons/btn_ok" */
  path: string
  type: SceneNode['type']
  parentId: NodeId | null
  /** index among siblings, 0 = bottom-most (rendered first) */
  index: number
  depth: number
  visible: boolean
  locked: boolean
  opacity: number
  rotation: number
  blendMode: string
  /** absolute rect in FRAME space (top-left origin, Y down, pixels) */
  rect: LayoutRect
  /** rect relative to parent (top-left origin, Y down) */
  local: LayoutRect
  /** anchor / pivot in editor convention (Y down) */
  anchor: Anchor
  pivot: Vec2
  /** ready-to-use Unity RectTransform values (Y up) */
  unity: UnityRect
  image?: {
    assetId: string
    file: string
    width: number
    height: number
    nineSlice: Insets | null
    sourceFile?: string
    contentOffset?: Vec2
    fillOpacity?: number
    effects?: unknown
    /** non-destructive edits applied to originalFile (crop/flip/rotate/adjustments) — already baked into `file` */
    edits?: ImageEdits
    originalFile?: string
    /** where this sprite sits in the page sprite atlas (export/atlas/<page>_<sheet>.png) */
    atlas?: { sheet: number; name: string; x: number; y: number; width: number; height: number }
  }
  text?: { text: string; fontFamily: string; fontSize: number; fontWeight: number; color: string; align: string; lineHeight: number; italic: boolean; letterSpacing: number; uppercase: boolean; psdFont?: string; effects?: TextEffects; layerStyle?: unknown; /** font file exported to export/fonts (relative to export/) */ fontFile?: string; fontPostScript?: string }
  fill?: { color: string; alpha: number } | null
  cornerRadius?: number
  shape?: 'ellipse'
  stroke?: { color: string; alpha: number; width: number }
  clipsContent?: boolean
  children: NodeId[]
  meta?: Record<string, unknown>
  /** auto layout → Unity Horizontal/VerticalLayoutGroup (+ContentSizeFitter when hug) */
  layout?: AutoLayout
  /** anchor this node to the device safe area (Unity: UIForgeSafeArea wrapper) */
  safeArea?: boolean
  /** this node is a component master → Unity prefab; states: state name → child node id (Button SpriteState) */
  component?: { name: string; states?: Record<string, NodeId> }
  /** this node is an instance of a component; its children are derived copies (meta.instanceOf = master child id) */
  instance?: { componentId: NodeId; componentName: string; overrides: Record<NodeId, unknown>; states?: Record<string, NodeId> }
}

/** One prototype interaction, as exported (see LAYOUT_SPEC §3.2). */
export interface FlowExport {
  id: string
  from: NodeId
  fromPath: string
  trigger: string
  delay?: number
  key?: string
  action: Connection['action']
  to: NodeId | null
  toFrame: string
  transition: string
  direction?: string
  duration: number
  easing: string
  overlay?: OverlaySettings
}

export function exportFlow(c: Connection, fromPath: string, frameById: Map<NodeId, FrameNode>): FlowExport {
  const n = normalizeConnection(c)
  const f: FlowExport = { id: n.id, from: n.from, fromPath, trigger: n.trigger, action: n.action, to: n.to ?? null, toFrame: n.to ? (frameById.get(n.to)?.name ?? '') : '', transition: n.transition, duration: n.duration, easing: n.easing ?? 'ease-out' }
  if (n.delay !== undefined) f.delay = n.delay
  if (n.key !== undefined) f.key = n.key
  if (n.direction) f.direction = n.direction
  if (n.overlay && (n.action === 'overlay' || n.action === 'swap')) f.overlay = n.overlay
  return f
}

export interface FrameLayout {
  schema: 'uiforge-layout'
  version: 2
  project: string
  page: string
  exportedAt: string
  frame: { id: NodeId; name: string; width: number; height: number; fill: { color: string; alpha: number } | null }
  /** Unity CanvasScaler: mode expand/shrink/match (+ matchWidthOrHeight) */
  scaler: CanvasScalerSettings
  /** depth-first, parents before children, siblings bottom-to-top */
  nodes: LayoutNode[]
  flows: FlowExport[]
  assets: Record<string, { file: string; width: number; height: number; source?: string }>
  /** component masters defined in this frame (id → name/path); instances reference them by id */
  components: Record<NodeId, { name: string; path: string }>
  /** sprite atlas sheets of the page (relative to export/), present when exported from the app */
  atlas?: { sheets: { index: number; file: string; width: number; height: number }[] }
}

export interface DevicePreviewInfo {
  id: string
  name: string
  width: number
  height: number
  preview: string
  issues: string[]
}

export interface PageManifest {
  schema: 'uiforge-manifest'
  version: 2
  project: string
  page: string
  exportedAt: string
  startFrameId: NodeId | null
  frames: { id: NodeId; name: string; width: number; height: number; file: string; preview: string; devices?: DevicePreviewInfo[] }[]
  atlas?: { file: string; sheets: { index: number; file: string; width: number; height: number }[] }
  scaler: CanvasScalerSettings
  /** fonts exported to export/fonts (system fonts via queryLocalFonts, project fonts copied) */
  fonts?: { family: string; weight: number; italic: boolean; file: string; postscriptName: string; source: string }[]
  flows: (FlowExport & { fromFrame: NodeId })[]
}

export function frameFileName(frame: FrameNode): string {
  return `${safeFileName(frame.name)}_${frame.id}.json`
}

export function previewFileName(frame: FrameNode): string {
  return `${safeFileName(frame.name)}_${frame.id}_preview.png`
}

/** Mermaid flowchart of every page's screen flow, for humans and agents. */
export function buildFlowsMarkdown(doc: DesignDocument): string {
  const lines: string[] = [`# ${doc.name} — Screen flows`, '']
  for (const page of doc.pages) {
    const frames = page.children.filter((c): c is FrameNode => c.type === 'frame')
    if (!frames.length) continue
    const owner = new Map<NodeId, FrameNode>()
    const path = new Map<NodeId, string>()
    const mark = (n: SceneNode, f: FrameNode, p: string): void => {
      owner.set(n.id, f)
      path.set(n.id, p)
      if (isContainer(n)) n.children.forEach((c) => mark(c, f, p ? `${p}/${c.name}` : c.name))
    }
    frames.forEach((f) => f.children.forEach((c) => mark(c, f, c.name)))
    const fid = (f: FrameNode): string => `F_${f.id.replace(/[^a-zA-Z0-9]/g, '_')}`
    lines.push(`## Page: ${page.name}`, '')
    lines.push('```mermaid', 'flowchart LR')
    for (const f of frames) lines.push(`  ${fid(f)}["${f.name}<br/>${f.width}×${f.height}${page.startFrameId === f.id ? ' (start)' : ''}"]`)
    for (const raw of page.connections) {
      const c = normalizeConnection(raw)
      const from = owner.get(c.from)
      const to = frames.find((f) => f.id === c.to)
      if (!from) continue
      const label = `${path.get(c.from) || from.name} · ${triggerLabel(c)} · ${actionLabel(c, to?.name)}${c.transition !== 'instant' ? ` · ${transitionLabel(c)}` : ''}`
      if (to) lines.push(`  ${fid(from)} ${c.action === 'overlay' || c.action === 'swap' ? '-.->' : '-->'}|"${label.replace(/"/g, "'")}"| ${fid(to)}`)
      else lines.push(`  ${fid(from)} -->|"${label.replace(/"/g, "'")}"| ${fid(from)}`)
    }
    lines.push('```', '')
    lines.push('| From frame | Hotspot (path) | Trigger | Action | To frame | Transition | Overlay |', '|---|---|---|---|---|---|---|')
    for (const raw of page.connections) {
      const c = normalizeConnection(raw)
      const from = owner.get(c.from)
      const to = frames.find((f) => f.id === c.to)
      if (!from) continue
      const ov = c.overlay && (c.action === 'overlay' || c.action === 'swap') ? `${c.overlay.position}${c.overlay.dim ? `, dim ${Math.round(c.overlay.dimOpacity * 100)}%` : ''}${c.overlay.closeOutside ? ', close outside' : ''}` : ''
      lines.push(`| ${from.name} | ${path.get(c.from) || '(frame)'} | ${triggerLabel(c)} | ${c.action} | ${to?.name ?? ''} | ${transitionLabel(c)} · ${c.easing ?? 'ease-out'} | ${ov} |`)
    }
    lines.push('')
  }
  return lines.join(String.fromCharCode(10))
}

export interface BuildLayoutOptions {
  atlas?: AtlasPlan
  atlasFiles?: string[]
  /** key `${family}|${weight}|${italic}` → exported font descriptor */
  fonts?: Record<string, { file: string; postscriptName: string }>
}

export const fontKey = (family: string, weight: number, italic: boolean): string => `${family}|${weight}|${italic}`

export function buildFrameLayout(doc: DesignDocument, page: Page, frame: FrameNode, opts: BuildLayoutOptions = {}): FrameLayout {
  const nodes: LayoutNode[] = []
  const components: FrameLayout['components'] = {}
  const usedAssets = new Set<string>()
  const nodeFrame = new Map<NodeId, string>()

  const visit = (n: SceneNode, parent: SceneNode, parentAbs: { x: number; y: number }, index: number, depth: number, pathPrefix: string): void => {
    const absX = parentAbs.x + n.x
    const absY = parentAbs.y + n.y
    const path = pathPrefix ? `${pathPrefix}/${n.name}` : n.name
    nodeFrame.set(n.id, path)
    const ln: LayoutNode = {
      id: n.id,
      name: n.name,
      path,
      type: n.type,
      parentId: parent.id === frame.id ? null : parent.id,
      index,
      depth,
      visible: n.visible,
      locked: n.locked,
      opacity: n.opacity,
      rotation: n.rotation,
      blendMode: n.blendMode ?? 'normal',
      rect: { x: absX, y: absY, width: n.width, height: n.height },
      local: { x: n.x, y: n.y, width: n.width, height: n.height },
      anchor: n.anchor,
      pivot: n.pivot,
      unity: toUnityRect(n.x, n.y, n.width, n.height, n.anchor, n.pivot, n.rotation, parent.width, parent.height),
      children: isContainer(n) ? n.children.map((c) => c.id) : [],
      meta: n.meta
    }
    if (n.type === 'image' || n.type === 'nineslice') {
      const a = doc.assets[n.assetId]
      usedAssets.add(n.assetId)
      ln.image = {
        assetId: n.assetId,
        file: a ? `assets/${a.file}` : '',
        width: a?.width ?? n.width,
        height: a?.height ?? n.height,
        nineSlice: n.type === 'nineslice' ? n.insets : null
      }
      if (n.sourceAssetId && doc.assets[n.sourceAssetId]) {
        usedAssets.add(n.sourceAssetId)
        ln.image.sourceFile = `assets/${doc.assets[n.sourceAssetId].file}`
        ln.image.contentOffset = n.contentOffset
        ln.image.fillOpacity = n.fillOpacity
        ln.image.effects = n.effects
      }
      if (n.edits) {
        ln.image.edits = n.edits
        const oid = n.originalAssetId ?? n.sourceAssetId
        if (oid && doc.assets[oid]) {
          usedAssets.add(oid)
          ln.image.originalFile = `assets/${doc.assets[oid].file}`
        }
      }
      const ar = opts.atlas?.sprites[n.assetId]
      if (ar) ln.image.atlas = { sheet: ar.sheet, name: ar.name, x: ar.x, y: ar.y, width: ar.width, height: ar.height }
    }
    if ((n.type === 'frame' || n.type === 'group') && n.layout) ln.layout = n.layout
    if (n.safeArea) ln.safeArea = true
    if ((n.type === 'frame' || n.type === 'group') && n.component) {
      ln.component = { name: n.component.name }
      const sm = stateMap(n)
      if (sm) ln.component.states = sm
      components[n.id] = { name: n.component.name, path }
    }
    if (n.type === 'instance') {
      const m = findMaster(doc, n.componentId)
      ln.instance = { componentId: n.componentId, componentName: m ? ((m.node as GroupNode).component?.name ?? m.node.name) : n.name, overrides: n.overrides }
      const sm = stateMap(n)
      if (sm) ln.instance.states = sm
    }
    if (n.type === 'text') {
      ln.text = { text: n.text, fontFamily: n.fontFamily, fontSize: n.fontSize, fontWeight: n.fontWeight, color: rgbaToHex(n.color), align: n.align, lineHeight: n.lineHeight, italic: !!n.italic, letterSpacing: n.letterSpacing ?? 0, uppercase: !!n.uppercase, psdFont: (n.meta?.psdText as { font?: string } | undefined)?.font, effects: textEffectsFromPsd(n.effects, 120), layerStyle: n.effects }
      const ef = opts.fonts?.[fontKey(n.fontFamily, n.fontWeight, !!n.italic)]
      if (ef) {
        ln.text.fontFile = ef.file
        ln.text.fontPostScript = ef.postscriptName
      }
    }
    if (n.type === 'rect' || n.type === 'frame') {
      ln.fill = n.fill.visible ? { color: rgbaToHex(n.fill.color), alpha: n.fill.color.a } : null
    }
    if (n.type === 'rect') {
      ln.cornerRadius = n.cornerRadius
      if (n.shape === 'ellipse') ln.shape = 'ellipse'
      if (n.stroke?.visible && n.stroke.width > 0) ln.stroke = { color: rgbaToHex(n.stroke.color), alpha: n.stroke.color.a, width: n.stroke.width }
    }
    if (n.type === 'frame') ln.clipsContent = n.clipsContent
    nodes.push(ln)
    if (isContainer(n)) n.children.forEach((c, i) => visit(c, n, { x: absX, y: absY }, i, depth + 1, path))
  }
  frame.children.forEach((c, i) => visit(c, frame, { x: 0, y: 0 }, i, 0, ''))

  const frameById = new Map<NodeId, FrameNode>()
  for (const c of page.children) if (c.type === 'frame') frameById.set(c.id, c)
  const flows = page.connections.filter((c) => nodeFrame.has(c.from) || c.from === frame.id).map((c) => exportFlow(c, c.from === frame.id ? '' : nodeFrame.get(c.from)!, frameById))

  const assets: FrameLayout['assets'] = {}
  for (const id of usedAssets) {
    const a = doc.assets[id]
    if (a) assets[id] = { file: `assets/${a.file}`, width: a.width, height: a.height, source: a.source }
  }

  const out: FrameLayout = {
    schema: 'uiforge-layout',
    version: 2,
    project: doc.name,
    page: page.name,
    exportedAt: new Date().toISOString(),
    frame: {
      id: frame.id,
      name: frame.name,
      width: frame.width,
      height: frame.height,
      fill: frame.fill.visible ? { color: rgbaToHex(frame.fill.color), alpha: frame.fill.color.a } : null
    },
    scaler: scalerOf(doc),
    nodes,
    flows,
    assets,
    components
  }
  if (opts.atlas && opts.atlasFiles) out.atlas = { sheets: opts.atlas.sheets.map((sh) => ({ index: sh.index, file: opts.atlasFiles![sh.index], width: sh.width, height: sh.height })) }
  return out
}

export function buildPageManifest(doc: DesignDocument, page: Page, extra: { devices?: Record<NodeId, DevicePreviewInfo[]>; atlas?: PageManifest['atlas']; fonts?: PageManifest['fonts'] } = {}): PageManifest {
  const frames = page.children.filter((c): c is FrameNode => c.type === 'frame')
  const ownerFrame = new Map<NodeId, NodeId>()
  const pathOf = new Map<NodeId, string>()
  const frameById = new Map<NodeId, FrameNode>(frames.map((f) => [f.id, f]))
  const mark = (n: SceneNode, fid: NodeId, p: string): void => {
    ownerFrame.set(n.id, fid)
    pathOf.set(n.id, p)
    if (isContainer(n)) n.children.forEach((c) => mark(c, fid, p ? `${p}/${c.name}` : c.name))
  }
  frames.forEach((f) => mark(f, f.id, ''))
  return {
    schema: 'uiforge-manifest',
    version: 2,
    project: doc.name,
    page: page.name,
    exportedAt: new Date().toISOString(),
    startFrameId: page.startFrameId ?? null,
    frames: frames.map((f) => ({ id: f.id, name: f.name, width: f.width, height: f.height, file: frameFileName(f), preview: previewFileName(f), devices: extra.devices?.[f.id] })),
    atlas: extra.atlas,
    fonts: extra.fonts,
    scaler: scalerOf(doc),
    flows: page.connections.map((c) => ({ ...exportFlow(c, pathOf.get(c.from) ?? '', frameById), fromFrame: ownerFrame.get(c.from) ?? '' }))
  }
}

export function collectUsedAssets(nodes: SceneNode[], assets: Record<string, Asset>): Asset[] {
  const ids = new Set<string>()
  const walk = (n: SceneNode): void => {
    if (n.type === 'image' || n.type === 'nineslice') {
      ids.add(n.assetId)
      if (n.sourceAssetId) ids.add(n.sourceAssetId)
      if (n.originalAssetId) ids.add(n.originalAssetId)
    }
    if (isContainer(n)) n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return Array.from(ids)
    .map((id) => assets[id])
    .filter((a): a is Asset => !!a)
}

/** Every distinct font face (family/weight/italic) used by text nodes. */
export function collectFontFaces(nodes: SceneNode[]): { family: string; weight: number; italic: boolean }[] {
  const seen = new Map<string, { family: string; weight: number; italic: boolean }>()
  const walk = (n: SceneNode): void => {
    if (n.type === 'text') seen.set(fontKey(n.fontFamily, n.fontWeight, !!n.italic), { family: n.fontFamily, weight: n.fontWeight, italic: !!n.italic })
    if (isContainer(n)) n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return [...seen.values()]
}
