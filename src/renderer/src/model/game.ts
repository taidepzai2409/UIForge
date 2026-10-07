// Game link: a UIForge project that mirrors the UI of an HTML5 game project.
//
//   game → app   the game's agent pushes its screens (elements + source art files + flows): `mergeGameDesign`
//   in the app   art is replaced / elements are moved; everything is compared with the pushed baseline: `diffGame`
//   app → game   "Sync" writes the replaced art back into the game and a change list for the game's agent
//
// Pure module (no DOM / Pixi) so the MCP server can use it without the app.
import type { Connection, ContainerNode, DesignDocument, FrameNode, GroupNode, ImageNode, InstanceNode, InstanceOverride, Insets, NineSliceNode, NodeId, OverlaySettings, Page, SceneNode, Transition, Trigger } from './types'
import { isContainer } from './types'
import { createFrame, createGroup, createImage, createInstance, createNineSlice, createPage, createRect, createText, newId } from './create'
import { hexToRgba, rgbaToHex } from './color'
import { DEFAULT_OVERLAY, defaultsForAction, normalizeConnection } from './flows'
import { COMPONENTS_SCREEN, type GameComponentRule } from './gameComponents'
import { findMaster } from './instances'

export const GAME_PAGE_NAME = 'Game UI'
export const GAME_DIR = 'uiforge'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// ----------------------------------------------------------------- pushed by the game
export interface GameElement {
  /** stable id, unique inside its screen */
  id: string
  name?: string
  type: 'image' | 'nineslice' | 'text' | 'rect' | 'group'
  /** absolute rect inside the screen: px, origin top-left, Y down */
  x: number
  y: number
  width: number
  height: number
  /** image / nineslice: source art file, relative to the game root */
  asset?: string
  /** region of `asset` that is shown (atlas frame), in asset px */
  crop?: Rect
  /** no source file (drawn by code / CSS): cut this rect out of the screen's screenshot */
  snapshot?: boolean
  /** no source file, but a PNG with exactly this element's pixels (absolute, or relative to the game root) */
  image?: string
  insets?: Insets
  text?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  color?: string
  align?: 'left' | 'center' | 'right'
  fill?: string | null
  cornerRadius?: number
  stroke?: string
  strokeWidth?: number
  shape?: 'rect' | 'ellipse'
  opacity?: number
  visible?: boolean
  /** can be clicked in the game (hint for flows) */
  interactive?: boolean
  /** where the game lays this element out, e.g. "src/scenes/Hub.ts:120" or a CSS selector */
  code?: string
  note?: string
  /** this element is an occurrence of a shared widget (component master, see model/gameComponents.ts) */
  component?: string
  /** (set by prepareComponents) occurrence element id → master element id */
  componentMap?: Record<string, string>
  /** (set by prepareComponents) the element is the master of this component */
  master?: string
  /** (set by prepareComponents) master copies take their art from the occurrence they were copied from */
  origin?: { screenId: string; elementId: string }
  children?: GameElement[]
}

export interface GameScreen {
  id: string
  name?: string
  width: number
  height: number
  kind?: 'screen' | 'popup'
  /** PNG of the screen as the game renders it (absolute, or relative to the game root) */
  screenshot?: string
  /** same screen without any text: snapshot elements are cut from this one so labels are not baked into them */
  snapshotFrom?: string
  background?: string
  code?: string
  /** bottom-to-top */
  elements: GameElement[]
}

export interface GameFlow {
  /** "screen/element", an element id, or a screen id (frame-level trigger) */
  from: string
  /** destination screen id (navigate / overlay / swap) */
  to?: string
  action?: Connection['action']
  trigger?: Trigger
  transition?: Transition
  delay?: number
  key?: string
  overlay?: Partial<OverlaySettings>
}

export interface GameInfo {
  name: string
  /** absolute path of the game project folder */
  root: string
  engine?: string
  devUrl?: string
}

export interface GameDesign {
  schema: 'uiforge-game-design'
  version: 1
  game: GameInfo
  screens: GameScreen[]
  flows?: GameFlow[]
  /** screen id the flow starts on */
  start?: string
  /** shared widgets of the game: groups matching `match` become instances of the component `name` */
  components?: GameComponentRule[]
  /** detect repeated groups (same structure and art) as components; default true */
  autoComponents?: boolean
}

// ----------------------------------------------------------------- stored in the document (baseline)
export interface GameElementBase {
  type: GameElement['type']
  name: string
  rect: Rect
  parent?: string
  source?: string
  crop?: Rect
  snapshot?: boolean
  assetId?: string
  insets?: Insets
  text?: string
  fontSize?: number
  fontFamily?: string
  color?: string
  fill?: string | null
  cornerRadius?: number
  opacity: number
  visible: boolean
  interactive?: boolean
  code?: string
  note?: string
  /** instance of this component (rect = the instance's box) */
  component?: string
  /** instance overrides keyed by the master element's game id */
  overrides?: Record<string, InstanceOverride>
}

export interface GameScreenBase {
  name: string
  width: number
  height: number
  kind?: 'screen' | 'popup'
  code?: string
  elements: Record<string, GameElementBase>
}

export interface GameLink extends GameInfo {
  pushedAt: string
  /** number of syncs written to the game */
  revision: number
  syncedAt?: string
  screens: Record<string, GameScreenBase>
  /** source file → what the game had when it was pushed */
  assets: Record<string, { assetId: string; width: number; height: number }>
  /** flow keys the game reported (see flowKey) */
  flows?: string[]
  /** component name → structure signature (model/gameComponents.ts) */
  componentSignatures?: Record<string, string>
}

// ----------------------------------------------------------------- helpers
const EPS = 0.5

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function sameRect(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS && Math.abs(a.width - b.width) <= EPS && Math.abs(a.height - b.height) <= EPS
}

export function gameIdOf(n: SceneNode): string | undefined {
  const v = n.meta?.gameId
  return typeof v === 'string' ? v : undefined
}

export function gameScreenOf(n: SceneNode): string | undefined {
  const v = n.meta?.gameScreen
  return typeof v === 'string' ? v : undefined
}

function isReference(n: SceneNode): boolean {
  return n.meta?.gameRef === true
}

function setMeta(n: SceneNode, key: string, value: unknown): void {
  if (value === undefined) {
    if (n.meta) delete n.meta[key]
  } else n.meta = { ...(n.meta ?? {}), [key]: value }
}

function elementType(n: SceneNode): GameElement['type'] {
  return n.type === 'image' || n.type === 'nineslice' || n.type === 'text' || n.type === 'rect' ? n.type : 'group'
}

/** game ids of a master's elements (game id → node id) */
function masterIds(master: SceneNode): Map<string, NodeId> {
  const out = new Map<string, NodeId>()
  const visit = (n: SceneNode): void => {
    const g = gameIdOf(n)
    if (g) out.set(g, n.id)
    if (isContainer(n) && n.type !== 'instance') n.children.forEach(visit)
  }
  if (isContainer(master)) master.children.forEach(visit)
  return out
}

function cleanOverride(o: InstanceOverride): InstanceOverride | null {
  const out: InstanceOverride = {}
  if (o.text !== undefined) out.text = o.text
  if (o.visible !== undefined) out.visible = o.visible
  if (o.assetId !== undefined) out.assetId = o.assetId
  if (o.fontSize !== undefined) out.fontSize = round(o.fontSize)
  return Object.keys(out).length ? out : null
}

function canonical(o: Record<string, InstanceOverride> | undefined): string {
  if (!o) return '{}'
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k].text, o[k].visible, o[k].assetId, o[k].fontSize]))
}

/** Component name and overrides (keyed by the master elements' game ids) of an instance. */
function instanceState(doc: DesignDocument, n: InstanceNode): { component?: string; overrides: Record<string, InstanceOverride>; masterSize?: { width: number; height: number } } {
  const m = findMaster(doc, n.componentId)
  if (!m) return { overrides: {} }
  const name = (m.node as GroupNode).component?.name ?? m.node.name
  const idToGame = new Map<NodeId, string>()
  for (const [g, id] of masterIds(m.node)) idToGame.set(id, g)
  const overrides: Record<string, InstanceOverride> = {}
  for (const [mid, o] of Object.entries(n.overrides)) {
    const g = idToGame.get(mid)
    const c = cleanOverride(o)
    if (g && c) overrides[g] = c
  }
  return { component: name, overrides, masterSize: { width: m.node.width, height: m.node.height } }
}

interface Walked {
  node: SceneNode
  rect: Rect
  parent: ContainerNode
  /** game id of the nearest ancestor that has one */
  parentGameId?: string
  gameId?: string
  /** first node carrying this game id (later ones are user copies) */
  primary: boolean
}

/** Every node of a game frame (not the reference layer, not derived instance children), with rects relative to the frame. */
function walkFrame(frame: FrameNode): Walked[] {
  const out: Walked[] = []
  const seen = new Set<string>()
  const visit = (list: SceneNode[], parent: ContainerNode, ox: number, oy: number, parentGameId?: string): void => {
    for (const n of list) {
      if (isReference(n)) continue
      const rect = { x: ox + n.x, y: oy + n.y, width: n.width, height: n.height }
      const gameId = gameIdOf(n)
      const primary = !!gameId && !seen.has(gameId)
      if (gameId) seen.add(gameId)
      out.push({ node: n, rect, parent, parentGameId, gameId, primary })
      if (isContainer(n) && n.type !== 'instance') visit(n.children, n, rect.x, rect.y, primary ? gameId : parentGameId)
    }
  }
  visit(frame.children, frame, 0, 0)
  return out
}

/** Components earlier pushes made (for prepareComponents). */
export function priorComponents(doc: DesignDocument): { assigned: Record<string, string>; signatures: Record<string, string> } {
  const assigned: Record<string, string> = {}
  const signatures: Record<string, string> = {}
  const link = doc.game
  if (!link) return { assigned, signatures }
  for (const [sid, s] of Object.entries(link.screens)) for (const [id, b] of Object.entries(s.elements)) if (b.component) assigned[`${sid}\n${id}`] = b.component
  for (const [name, sig] of Object.entries(link.componentSignatures ?? {})) signatures[sig] = name
  return { assigned, signatures }
}

export function gameFrames(doc: DesignDocument): { page: Page; frame: FrameNode; screenId: string }[] {
  const out: { page: Page; frame: FrameNode; screenId: string }[] = []
  for (const page of doc.pages)
    for (const c of page.children) {
      const sid = c.type === 'frame' ? gameScreenOf(c) : undefined
      if (c.type === 'frame' && sid) out.push({ page, frame: c, screenId: sid })
    }
  return out
}

function baseFromNode(doc: DesignDocument, n: SceneNode, rect: Rect, parentGameId: string | undefined, prev: GameElementBase | undefined): GameElementBase {
  const b: GameElementBase = { type: elementType(n), name: n.name, rect: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) }, opacity: n.opacity, visible: n.visible }
  if (parentGameId) b.parent = parentGameId
  if (n.type === 'instance') {
    const st = instanceState(doc, n)
    if (st.component) b.component = st.component
    if (Object.keys(st.overrides).length) b.overrides = st.overrides
  }
  if (prev) {
    for (const k of ['source', 'crop', 'snapshot', 'interactive', 'code', 'note'] as const) if (prev[k] !== undefined) (b as unknown as Record<string, unknown>)[k] = prev[k]
  }
  if (n.type === 'image' || n.type === 'nineslice') {
    b.assetId = n.assetId
    if (n.type === 'nineslice') b.insets = { ...n.insets }
  } else if (n.type === 'text') {
    b.text = n.text
    b.fontSize = n.fontSize
    b.fontFamily = n.fontFamily
    b.color = rgbaToHex(n.color)
  } else if (n.type === 'rect') {
    b.fill = n.fill.visible ? rgbaToHex(n.fill.color) : null
    b.cornerRadius = n.cornerRadius
  }
  return b
}

// ----------------------------------------------------------------- merge (game → app)
export interface ResolvedAssets {
  /** project asset id showing this element (source file, crop or screenshot cut-out); undefined = could not be loaded */
  element: (screenId: string, el: GameElement) => string | undefined
  screenshot: (screenId: string) => string | undefined
}

export interface MergeReport {
  screens: { id: string; frameId: NodeId; created: boolean; elements: number; added: number; updated: number; kept: number; removed: number }[]
  /** component masters of this push */
  components?: string[]
  flows: number
  warnings: string[]
}

function buildNode(el: GameElement, assetId: string | undefined, x: number, y: number): SceneNode {
  const name = el.name || el.id
  const w = Math.max(1, el.width)
  const h = Math.max(1, el.height)
  let node: SceneNode
  if (el.type === 'group') node = createGroup(name, x, y, w, h)
  else if (el.type === 'text') {
    const t = createText(name, x, y, el.text ?? '')
    t.width = w
    t.height = h
    t.autoSize = false
    if (el.fontSize) t.fontSize = el.fontSize
    if (el.fontFamily) t.fontFamily = el.fontFamily
    if (el.fontWeight) t.fontWeight = el.fontWeight
    t.color = hexToRgba(el.color ?? '#ffffff') ?? t.color
    t.align = el.align ?? 'left'
    node = t
  } else if ((el.type === 'image' || el.type === 'nineslice') && assetId) {
    node = el.type === 'nineslice' ? createNineSlice(name, x, y, w, h, assetId, el.insets) : createImage(name, x, y, w, h, assetId)
  } else {
    // rect, or an image whose art could not be loaded (placeholder)
    const r = createRect(name, x, y, w, h)
    const missing = el.type !== 'rect'
    const fill = missing ? '#ff00ff' : el.fill
    if (fill === null) r.fill.visible = false
    else if (fill) r.fill = { color: hexToRgba(fill.slice(0, 7), missing ? 0.35 : 1) ?? r.fill.color, visible: true }
    if (el.cornerRadius) r.cornerRadius = el.cornerRadius
    if (el.stroke) r.stroke = { color: hexToRgba(el.stroke) ?? r.fill.color, width: el.strokeWidth ?? 2, visible: true }
    if (el.shape === 'ellipse') r.shape = 'ellipse'
    node = r
  }
  if (typeof el.opacity === 'number') node.opacity = el.opacity
  if (el.visible === false) node.visible = false
  node.meta = { gameId: el.id }
  return node
}

function baseFromElement(el: GameElement, assetId: string | undefined, parentGameId: string | undefined): GameElementBase {
  const isImg = el.type === 'image' || el.type === 'nineslice'
  const b: GameElementBase = {
    type: isImg && !assetId ? 'rect' : el.type,
    name: el.name || el.id,
    rect: { x: round(el.x), y: round(el.y), width: round(Math.max(1, el.width)), height: round(Math.max(1, el.height)) },
    opacity: el.opacity ?? 1,
    visible: el.visible !== false
  }
  if (parentGameId) b.parent = parentGameId
  if (el.asset) b.source = el.asset
  if (el.crop) b.crop = el.crop
  if (el.snapshot || (!el.asset && (el.type === 'image' || el.type === 'nineslice'))) b.snapshot = true
  if (el.interactive) b.interactive = true
  if (el.code) b.code = el.code
  if (el.note) b.note = el.note
  if (isImg && assetId) {
    b.assetId = assetId
    if (el.type === 'nineslice') b.insets = el.insets ?? { left: 10, top: 10, right: 10, bottom: 10 }
  } else if (el.type === 'text') {
    b.text = el.text ?? ''
    if (el.fontSize) b.fontSize = el.fontSize
    if (el.fontFamily) b.fontFamily = el.fontFamily
    b.color = (el.color ?? '#ffffff').slice(0, 7).toLowerCase()
  } else if (el.type === 'rect') {
    b.fill = el.fill === null ? null : (el.fill ?? '#d9d9d9').slice(0, 7).toLowerCase()
    b.cornerRadius = el.cornerRadius ?? 0
  } else if (isImg) {
    b.fill = '#ff00ff'
    b.cornerRadius = 0
    b.note = [el.note, 'art could not be loaded when pushed'].filter(Boolean).join('; ')
  }
  return b
}

/** Did the user change this node since it was pushed? (rect is not checked for groups: their bounds are derived) */
function touched(doc: DesignDocument, w: Walked, base: GameElementBase | undefined): boolean {
  if (!base) return false
  const n = w.node
  if (elementType(n) !== base.type) return true
  if ((n.type === 'instance') !== !!base.component) return true
  if (n.type === 'instance') {
    const st = instanceState(doc, n)
    if (st.component !== base.component || canonical(st.overrides) !== canonical(base.overrides)) return true
  }
  if (n.type !== 'group' && !sameRect(w.rect, base.rect)) return true
  if ((n.type === 'image' || n.type === 'nineslice') && n.assetId !== base.assetId) return true
  if (n.type === 'text' && (n.text !== base.text || (base.fontSize !== undefined && n.fontSize !== base.fontSize) || (base.color !== undefined && rgbaToHex(n.color) !== base.color))) return true
  if (n.type === 'rect' && base.fill !== undefined && (n.fill.visible ? rgbaToHex(n.fill.color) : null) !== base.fill) return true
  return n.visible !== base.visible
}

function flowFromKey(c: Connection, keyOfNode: Map<NodeId, string>, screenOfFrame: Map<NodeId, string>): string | null {
  const from = keyOfNode.get(c.from)
  if (!from) return null
  const to = c.to ? screenOfFrame.get(c.to) : ''
  if (c.to && !to) return null
  return `${from}|${c.trigger}|${c.action}|${to ?? ''}`
}

/** Maps of the game nodes on a page: node id → "screen/element" (or "screen" for the frame) and frame id → screen id. */
function gameKeys(page: Page): { keyOfNode: Map<NodeId, string>; screenOfFrame: Map<NodeId, string> } {
  const keyOfNode = new Map<NodeId, string>()
  const screenOfFrame = new Map<NodeId, string>()
  for (const c of page.children) {
    const sid = c.type === 'frame' ? gameScreenOf(c) : undefined
    if (c.type !== 'frame' || !sid) continue
    screenOfFrame.set(c.id, sid)
    keyOfNode.set(c.id, sid)
    for (const w of walkFrame(c)) keyOfNode.set(w.node.id, `${sid}/${w.primary ? w.gameId : '~' + w.node.name}`)
  }
  return { keyOfNode, screenOfFrame }
}

/**
 * Anchors for the parts of a new master, like a designer would set them: a part covering the component
 * stretches with it, a centred text box stretches horizontally, everything else sticks to its nearest side
 * (or the centre). Resized instances then lay out like a Unity RectTransform.
 */
function masterAnchors(master: GroupNode): void {
  const W = Math.max(1, master.width)
  const H = Math.max(1, master.height)
  const side = (c: number, size: number, extent: number): [number, number] => {
    if (extent / size > 0.9) return [0, 1]
    const t = c / size
    return t < 0.34 ? [0, 0] : t > 0.66 ? [1, 1] : [0.5, 0.5]
  }
  for (const c of master.children) {
    const [minX, maxX] = c.type === 'text' && c.align === 'center' && c.width / W > 0.6 ? [0, 1] : side(c.x + c.width / 2, W, c.width)
    const [minY, maxY] = side(c.y + c.height / 2, H, c.height)
    c.anchor = { minX, minY, maxX, maxY }
  }
}

/**
 * Upserts the pushed screens into the document (call on an immer draft).
 * Nodes the user has not touched follow the game; touched ones keep the user's change (it stays pending).
 */
export function mergeGameDesign(doc: DesignDocument, design: GameDesign, res: ResolvedAssets): MergeReport {
  const report: MergeReport = { screens: [], flows: 0, warnings: [] }
  let page = doc.pages.find((p) => p.name === GAME_PAGE_NAME)
  if (!page) {
    const first = doc.pages[0]
    if (first && first.children.length === 0) {
      first.name = GAME_PAGE_NAME
      page = first
    } else {
      page = createPage(GAME_PAGE_NAME)
      doc.pages.push(page)
    }
  }
  const link: GameLink = (doc.game ??= { ...design.game, pushedAt: '', revision: 0, screens: {}, assets: {} })
  Object.assign(link, design.game)
  link.pushedAt = new Date().toISOString()

  const real = design.screens.filter((s) => s.id !== COMPONENTS_SCREEN)
  const cellW = Math.max(...real.map((s) => s.width), 1) + 160
  const cellH = Math.max(...real.map((s) => s.height), 1) + 240
  let slot = page.children.filter((c) => c.type === 'frame' && gameScreenOf(c) && gameScreenOf(c) !== COMPONENTS_SCREEN).length
  /** component masters of this push, by name (filled while placing the `__components` pseudo-screen, which comes first) */
  const masters = new Map<string, GroupNode>()

  for (const screen of design.screens) {
    const oldBase = link.screens[screen.id]
    let frame = page.children.find((c): c is FrameNode => c.type === 'frame' && gameScreenOf(c) === screen.id)
    const created = !frame
    if (!frame) {
      frame =
        screen.id === COMPONENTS_SCREEN
          ? createFrame(screen.name || 'Components', -screen.width - 240, 0, screen.width, screen.height)
          : createFrame(screen.name || screen.id, (slot % 6) * cellW, Math.floor(slot / 6) * cellH, screen.width, screen.height)
      if (screen.id !== COMPONENTS_SCREEN) slot++
      frame.meta = { gameScreen: screen.id }
      page.children.push(frame)
    } else {
      if (!oldBase || (frame.width === oldBase.width && frame.height === oldBase.height)) {
        frame.width = screen.width
        frame.height = screen.height
      }
      if (!oldBase || frame.name === oldBase.name) frame.name = screen.name || screen.id
    }
    frame.fill = { color: hexToRgba((screen.background ?? '#1e1e24').slice(0, 7)) ?? frame.fill.color, visible: true }
    if (screen.kind) setMeta(frame, 'gameKind', screen.kind)

    // reference layer (the game's own rendering), always at the bottom
    const shot = res.screenshot(screen.id)
    const refIdx = frame.children.findIndex(isReference)
    if (shot) {
      if (refIdx >= 0) {
        const ref = frame.children[refIdx] as ImageNode
        ref.assetId = shot
        ref.width = frame.width
        ref.height = frame.height
      } else {
        // the elements rebuild the whole screen: the game's own rendering stays as a hidden layer to compare with
        const ref = createImage('_reference', 0, 0, frame.width, frame.height, shot)
        ref.locked = true
        ref.visible = screen.elements.length === 0
        ref.meta = { gameRef: true }
        frame.children.unshift(ref)
      }
    }

    const existing = new Map<string, Walked>()
    for (const w of walkFrame(frame)) if (w.primary && w.gameId) existing.set(w.gameId, w)
    const newBase: Record<string, GameElementBase> = {}
    const stat = { elements: 0, added: 0, updated: 0, kept: 0, removed: 0 }
    const seenIds = new Set<string>()

    const place = (els: GameElement[], container: ContainerNode | null, cx: number, cy: number, parentGameId?: string): void => {
      for (let el of els) {
        if (seenIds.has(el.id)) {
          report.warnings.push(`${screen.id}: element id trùng "${el.id}" (bỏ qua bản sau)`)
          continue
        }
        seenIds.add(el.id)
        stat.elements++
        // single-line text: a little room on the right so the app's font metrics never wrap it
        if (el.type === 'text' && el.text && !el.text.includes('\n') && !el.note?.includes('padded') && screen.id !== COMPONENTS_SCREEN) {
          const pad = Math.round(el.width * 0.08 + 4)
          el = { ...el, width: el.width + pad, x: el.align === 'center' ? el.x - pad / 2 : el.align === 'right' ? el.x - pad : el.x, note: [el.note, 'padded'].filter(Boolean).join('; ') }
        }
        if (el.component && masters.has(el.component)) {
          placeInstance(el, container, cx, cy, parentGameId)
          continue
        }
        const wantsArt = el.type === 'image' || el.type === 'nineslice'
        const assetId = wantsArt ? res.element(screen.id, el) : undefined
        if (wantsArt && !assetId) report.warnings.push(`${screen.id}/${el.id}: không nạp được ảnh ${el.asset ?? '(snapshot)'}`)
        const base = baseFromElement(el, assetId, parentGameId)
        newBase[el.id] = base
        const old = oldBase?.elements[el.id]
        const w = existing.get(el.id)
        let node: SceneNode | null = w?.node ?? null
        let nx = el.x
        let ny = el.y
        if (!w) {
          if (old) {
            // the user deleted it in the app: keep it deleted (pending "removed" change)
            stat.kept++
          } else if (container) {
            node = buildNode(el, assetId, el.x - cx, el.y - cy)
            container.children.push(node)
            stat.added++
          }
        } else if (touched(doc, w, old)) {
          stat.kept++
          nx = w.rect.x
          ny = w.rect.y
        } else if (elementType(w.node) !== base.type || w.node.type === 'instance') {
          // the game changed what this element is: swap the node, keep its id (flows point at it)
          const fresh = buildNode(el, assetId, el.x - (w.rect.x - w.node.x), el.y - (w.rect.y - w.node.y))
          fresh.id = w.node.id
          const list = w.parent.children
          list[list.indexOf(w.node)] = fresh
          node = fresh
          stat.updated++
        } else {
          const n = w.node
          const before = JSON.stringify([n.x, n.y, n.width, n.height, (n as ImageNode).assetId, n.name, n.opacity, n.visible])
          if (!old || n.name === old.name) n.name = base.name
          n.opacity = base.opacity
          n.visible = base.visible
          if (n.type !== 'group') {
            // parent's current position = this node's absolute position minus its local one
            n.x = el.x - (w.rect.x - n.x)
            n.y = el.y - (w.rect.y - n.y)
            n.width = base.rect.width
            n.height = base.rect.height
          } else {
            nx = w.rect.x
            ny = w.rect.y
          }
          if ((n.type === 'image' || n.type === 'nineslice') && assetId) {
            n.assetId = assetId
            if (n.type === 'nineslice' && el.insets) n.insets = el.insets
          } else if (n.type === 'text') {
            n.text = el.text ?? ''
            if (el.fontSize) n.fontSize = el.fontSize
            if (el.fontFamily) n.fontFamily = el.fontFamily
            n.color = hexToRgba((el.color ?? '#ffffff').slice(0, 7)) ?? n.color
          } else if (n.type === 'rect') {
            if (base.fill === null) n.fill.visible = false
            else if (base.fill) n.fill = { color: hexToRgba(base.fill) ?? n.fill.color, visible: true }
            n.cornerRadius = base.cornerRadius ?? 0
          }
          if (before !== JSON.stringify([n.x, n.y, n.width, n.height, (n as ImageNode).assetId, n.name, n.opacity, n.visible])) stat.updated++
        }
        if (el.children?.length) place(el.children, node && isContainer(node) ? node : null, nx, ny, el.id)
        if (el.master && node && node.type === 'group') markMaster(node, el.master, !w)
      }
    }

    /** a master group: registered as component; new masters get anchors so resized instances keep their layout */
    const markMaster = (node: GroupNode, name: string, created: boolean): void => {
      node.component = { name }
      doc.components = { ...(doc.components ?? {}), [node.id]: { name, pageId: page!.id } }
      if (created) masterAnchors(node)
      masters.set(name, node)
    }

    /** an occurrence of a component: an instance of its master, overrides from what differs */
    const placeInstance = (el: GameElement, container: ContainerNode | null, cx: number, cy: number, parentGameId?: string): void => {
      const m = masters.get(el.component!)!
      const ids = masterIds(m)
      const byGame = new Map<string, SceneNode>()
      const visitM = (n: SceneNode): void => {
        const g = gameIdOf(n)
        if (g) byGame.set(g, n)
        if (isContainer(n) && n.type !== 'instance') n.children.forEach(visitM)
      }
      m.children.forEach(visitM)
      const occ = new Map<string, GameElement>()
      const visitO = (list: GameElement[]): void => {
        for (const c of list) {
          occ.set(c.id, c)
          if (c.children) visitO(c.children)
        }
      }
      visitO(el.children ?? [])
      const overrides: Record<string, InstanceOverride> = {}
      const mapped = new Set<string>()
      for (const [oid, gid] of Object.entries(el.componentMap ?? {})) {
        const oc = occ.get(oid)
        const mn = byGame.get(gid)
        if (!oc || !mn) continue
        mapped.add(gid)
        const ov: InstanceOverride = {}
        if (oc.visible === false && mn.visible) ov.visible = false
        if (oc.visible !== false && !mn.visible) ov.visible = true
        if (mn.type === 'text' && oc.type === 'text') {
          if ((oc.text ?? '') !== mn.text) ov.text = oc.text ?? ''
          if (oc.fontSize && Math.abs(oc.fontSize - mn.fontSize) > 0.5) ov.fontSize = round(oc.fontSize)
        }
        if ((mn.type === 'image' || mn.type === 'nineslice') && (oc.type === 'image' || oc.type === 'nineslice')) {
          const a = res.element(screen.id, oc)
          if (a && a !== mn.assetId) ov.assetId = a
        }
        const c = cleanOverride(ov)
        if (c) overrides[gid] = c
      }
      // master parts this occurrence does not have
      for (const [gid, mn] of byGame) if (!mapped.has(gid) && mn.visible && !(isContainer(mn) && mn.type !== 'instance')) overrides[gid] = { visible: false }

      const resized = Math.abs(el.width - m.width) > 1 || Math.abs(el.height - m.height) > 1
      const width = resized ? el.width : m.width
      const height = resized ? el.height : m.height
      const base: GameElementBase = { ...baseFromElement({ ...el, type: 'group', children: undefined }, undefined, parentGameId), rect: { x: round(el.x), y: round(el.y), width: round(width), height: round(height) }, component: el.component }
      if (Object.keys(overrides).length) base.overrides = overrides
      newBase[el.id] = base
      stat.elements++
      const nodeOverrides: Record<NodeId, InstanceOverride> = {}
      for (const [gid, o] of Object.entries(overrides)) {
        const id = ids.get(gid)
        if (id) nodeOverrides[id] = o
      }
      const apply = (n: InstanceNode, x: number, y: number): void => {
        n.componentId = m.id
        n.overrides = nodeOverrides
        n.x = x
        n.y = y
        n.width = width
        n.height = height
        if (resized) n.size = { width, height }
        else delete n.size
        n.name = base.name
        n.opacity = base.opacity
        n.visible = base.visible
        n.meta = { ...(n.meta ?? {}), gameId: el.id }
      }
      const old = oldBase?.elements[el.id]
      const w = existing.get(el.id)
      if (!w) {
        if (old) stat.kept++ // deleted in the app: stays deleted (pending)
        else if (container) {
          const inst = createInstance(base.name, 0, 0, m.id, width, height)
          apply(inst, el.x - cx, el.y - cy)
          container.children.push(inst)
          stat.added++
        }
        return
      }
      if (touched(doc, w, old)) {
        stat.kept++
        return
      }
      const px = w.rect.x - w.node.x
      const py = w.rect.y - w.node.y
      if (w.node.type !== 'instance') {
        // was a plain group (or another type): becomes an instance, same node id (flows point at it)
        const inst = createInstance(base.name, 0, 0, m.id, width, height)
        inst.id = w.node.id
        apply(inst, el.x - px, el.y - py)
        const list = w.parent.children
        list[list.indexOf(w.node)] = inst
      } else apply(w.node, el.x - px, el.y - py)
      stat.updated++
    }

    place(screen.elements, frame, 0, 0)

    // masters of components this (partial) push does not mention stay as they are
    if (screen.id === COMPONENTS_SCREEN && oldBase) {
      const pushed = new Set(screen.elements.map((e) => e.id))
      for (const [id, b] of Object.entries(oldBase.elements)) if (!newBase[id] && !pushed.has(id.split('/')[0])) newBase[id] = b
    }

    // elements the game no longer has
    for (const [id, w] of existing) {
      if (newBase[id]) continue
      const list = w.parent.children
      const i = list.indexOf(w.node)
      if (i < 0) continue // parent already removed
      if (touched(doc, w, oldBase?.elements[id])) setMeta(w.node, 'gameId', undefined)
      else {
        list.splice(i, 1)
        stat.removed++
      }
    }

    link.screens[screen.id] = { name: screen.name || screen.id, width: screen.width, height: screen.height, kind: screen.kind, code: screen.code, elements: newBase }
    report.screens.push({ id: screen.id, frameId: frame.id, created, ...stat })
  }
  if (masters.size) report.components = Array.from(masters.keys())

  // flows
  if (design.flows) {
    const frames = new Map<string, FrameNode>()
    for (const c of page.children) if (c.type === 'frame' && gameScreenOf(c)) frames.set(gameScreenOf(c)!, c)
    const resolveFrom = (ref: string): NodeId | null => {
      const slash = ref.indexOf('/')
      const scope = slash > 0 && frames.has(ref.slice(0, slash)) ? [frames.get(ref.slice(0, slash))!] : Array.from(frames.values())
      const want = slash > 0 && frames.has(ref.slice(0, slash)) ? ref.slice(slash + 1) : ref
      if (slash < 0 && frames.has(ref)) return frames.get(ref)!.id
      let loose: NodeId | null = null
      for (const f of scope)
        for (const w of walkFrame(f)) {
          if (!w.primary) continue
          if (w.gameId === want) return w.node.id
          if (!loose && (w.node.name === want || w.gameId!.endsWith('/' + want) || w.gameId!.endsWith(want))) loose = w.node.id
        }
      // a part of a component instance (or an element the game nested deeper): the closest element above it
      if (!loose && slash > 0 && ref.lastIndexOf('/') > slash) return resolveFrom(ref.slice(0, ref.lastIndexOf('/')))
      return loose
    }
    for (const f of design.flows) {
      const action = f.action ?? 'navigate'
      const trigger = f.trigger ?? 'click'
      const needsTarget = action === 'navigate' || action === 'overlay' || action === 'swap'
      const from = resolveFrom(f.from)
      const to = f.to ? frames.get(f.to) : undefined
      if (!from || (needsTarget && !to)) {
        report.warnings.push(`flow ${f.from} → ${f.to ?? action}: không tìm thấy ${!from ? 'nguồn' : 'màn đích'}`)
        continue
      }
      page.connections = page.connections.filter((c) => !(c.from === from && c.trigger === trigger && (trigger !== 'key' || c.key === f.key)))
      page.connections.push(
        normalizeConnection({
          id: newId(),
          from,
          to: needsTarget ? to!.id : undefined,
          trigger,
          action,
          ...defaultsForAction(action),
          ...(f.transition ? { transition: f.transition } : {}),
          ...(typeof f.delay === 'number' ? { delay: f.delay } : {}),
          ...(f.key ? { key: f.key } : {}),
          ...(action === 'overlay' || action === 'swap' ? { overlay: { ...DEFAULT_OVERLAY, ...(f.overlay ?? {}) } } : {})
        } as Connection)
      )
      report.flows++
    }
    const start = design.start ? frames.get(design.start) : undefined
    if (start) page.startFrameId = start.id
    else if (!page.startFrameId && design.screens[0]) page.startFrameId = frames.get(design.screens[0].id)?.id
    const { keyOfNode, screenOfFrame } = gameKeys(page)
    link.flows = page.connections.map((c) => flowFromKey(c, keyOfNode, screenOfFrame)).filter((k): k is string => !!k)
  }
  return report
}

// ----------------------------------------------------------------- diff (what the game has to pick up)
export interface ElementChange {
  element: string
  name: string
  kind: 'rect' | 'asset' | 'text' | 'style' | 'visible' | 'added' | 'removed'
  code?: string
  from?: unknown
  to?: unknown
  note?: string
}

export interface AssetChange {
  /** project asset (PNG) holding the new art */
  assetId: string
  file: string
  /** overwrite = the game's own file is replaced; incoming = new art the game has no file for yet */
  mode: 'overwrite' | 'incoming'
  /** path relative to the game root where sync writes the art */
  target: string
  source?: string
  oldSize?: { width: number; height: number }
  newSize: { width: number; height: number }
  usedBy: string[]
  note?: string
}

export interface ScreenChanges {
  id: string
  name: string
  frameId: NodeId
  width: number
  height: number
  code?: string
  sizeFrom?: { width: number; height: number }
  changes: ElementChange[]
}

export interface GameChanges {
  schema: 'uiforge-game-changes'
  version: 1
  game: GameInfo
  revision: number
  generatedAt: string
  /** true once "Sync" has written the art files into the game */
  synced?: boolean
  assets: AssetChange[]
  screens: ScreenChanges[]
  flows: { added: string[]; removed: string[]; current: string[] }
  /** components (shared widgets): where the game builds them and every instance */
  components?: Record<string, { code?: string; usedBy: string[] }>
  total: number
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-.]+/g, '_').replace(/^_+|_+$/g, '') || 'element'
}

export function diffGame(doc: DesignDocument): GameChanges {
  const link = doc.game
  if (!link) throw new Error('Project này chưa liên kết với game nào (chưa có lần push nào từ game).')
  const out: GameChanges = { schema: 'uiforge-game-changes', version: 1, game: { name: link.name, root: link.root, engine: link.engine, devUrl: link.devUrl }, revision: link.revision + 1, generatedAt: new Date().toISOString(), assets: [], screens: [], flows: { added: [], removed: [], current: [] }, total: 0 }
  const assetByTarget = new Map<string, AssetChange>()
  const addAsset = (key: string, a: Omit<AssetChange, 'usedBy'>, user: string): void => {
    const prev = assetByTarget.get(key)
    if (prev) {
      prev.usedBy.push(user)
      if (prev.assetId !== a.assetId) prev.note = [prev.note, `${user} dùng ảnh khác (${a.file}) cho cùng file nguồn — chỉ một ảnh được ghi`].filter(Boolean).join('; ')
      return
    }
    assetByTarget.set(key, { ...a, usedBy: [user] })
  }
  const sizeOf = (assetId: string): { width: number; height: number } => ({ width: doc.assets[assetId]?.width ?? 0, height: doc.assets[assetId]?.height ?? 0 })

  for (const { frame, screenId } of gameFrames(doc)) {
    const base = link.screens[screenId]
    if (!base) continue
    const sc: ScreenChanges = { id: screenId, name: frame.name, frameId: frame.id, width: frame.width, height: frame.height, code: base.code, changes: [] }
    if (frame.width !== base.width || frame.height !== base.height) sc.sizeFrom = { width: base.width, height: base.height }
    const walked = walkFrame(frame)
    const found = new Set<string>()
    const delta = new Map<string, { dx: number; dy: number; dw: number; dh: number }>()
    const rectChange = new Map<string, ElementChange>()
    const insideAdded = new Set<SceneNode>()

    for (const w of walked) {
      const n = w.node
      const b = w.primary && w.gameId ? base.elements[w.gameId] : undefined
      if (!b) {
        if (insideAdded.has(w.parent as SceneNode)) {
          insideAdded.add(n)
          if (n.type !== 'image' && n.type !== 'nineslice') continue
        } else insideAdded.add(n)
        const key = `${screenId}/~${slug(n.name)}`
        const to: Record<string, unknown> = { type: n.type, rect: { x: round(w.rect.x), y: round(w.rect.y), width: round(n.width), height: round(n.height) }, parent: w.parentGameId }
        if (n.type === 'text') Object.assign(to, { text: n.text, fontSize: n.fontSize, color: rgbaToHex(n.color), fontFamily: n.fontFamily })
        if (n.type === 'rect') Object.assign(to, { fill: n.fill.visible ? rgbaToHex(n.fill.color) : null, cornerRadius: n.cornerRadius })
        if (n.type === 'image' || n.type === 'nineslice') {
          const a = doc.assets[n.assetId]
          const target = `${GAME_DIR}/incoming/${slug(screenId)}__${slug(n.name)}.png`
          addAsset(`${target}#${n.assetId}`, { assetId: n.assetId, file: a?.file ?? '', mode: 'incoming', target, newSize: sizeOf(n.assetId), note: 'element mới, game chưa có file cho ảnh này' }, key)
          to.art = target
          if (n.type === 'nineslice') to.insets = n.insets
        }
        if (n.type === 'instance') to.component = instanceState(doc, n).component
        else if (isContainer(n)) to.children = n.children.length
        sc.changes.push({ element: `~${slug(n.name)}`, name: n.name, kind: 'added', to })
        continue
      }
      const id = w.gameId!
      found.add(id)
      const type = elementType(n)
      // instances: component swap and per-instance overrides (their parts are diffed on the master)
      if (n.type === 'instance' || b.component) {
        const st = n.type === 'instance' ? instanceState(doc, n) : { component: undefined, overrides: {} as Record<string, InstanceOverride> }
        if (st.component !== b.component) sc.changes.push({ element: id, name: n.name, kind: 'style', code: b.code, from: { component: b.component ?? null }, to: { component: st.component ?? null }, note: st.component ? `giờ là instance của component ${st.component}` : 'không còn là instance' })
        else {
          const was = b.overrides ?? {}
          for (const gid of new Set([...Object.keys(was), ...Object.keys(st.overrides)])) {
            const a = was[gid] ?? {}
            const c = st.overrides[gid] ?? {}
            const part = `${id} › ${gid.slice(gid.indexOf('/') + 1)}`
            const note = `override trong instance của component ${b.component}`
            if (a.text !== c.text) sc.changes.push({ element: part, name: n.name, kind: 'text', code: b.code, from: { text: a.text ?? '(như master)' }, to: { text: c.text ?? '(như master)' }, note })
            if (a.fontSize !== c.fontSize) sc.changes.push({ element: part, name: n.name, kind: 'style', code: b.code, from: { fontSize: a.fontSize ?? '(như master)' }, to: { fontSize: c.fontSize ?? '(như master)' }, note })
            if (a.visible !== c.visible) sc.changes.push({ element: part, name: n.name, kind: 'visible', code: b.code, from: a.visible ?? true, to: c.visible ?? true, note })
            if (a.assetId !== c.assetId && c.assetId) {
              const target = `${GAME_DIR}/incoming/${slug(screenId)}__${slug(id)}__${slug(gid.slice(gid.indexOf('/') + 1))}.png`
              addAsset(`${target}#${c.assetId}`, { assetId: c.assetId, file: doc.assets[c.assetId]?.file ?? '', mode: 'incoming', target, newSize: sizeOf(c.assetId), note: `ảnh riêng của một instance (${b.component})` }, `${screenId}/${part}`)
              sc.changes.push({ element: part, name: n.name, kind: 'asset', code: b.code, from: a.assetId ? 'ảnh override cũ' : 'ảnh của master', to: target, note })
            }
          }
        }
      }
      // rect (groups are derived from their children; an instance has its own box)
      if ((type !== 'group' || n.type === 'instance') && !sameRect(w.rect, b.rect)) {
        const d = { dx: round(w.rect.x - b.rect.x), dy: round(w.rect.y - b.rect.y), dw: round(w.rect.width - b.rect.width), dh: round(w.rect.height - b.rect.height) }
        delta.set(id, d)
        // a master's part: relative to the component's top-left, which is what the widget code uses
        const top = screenId === COMPONENTS_SCREEN ? base.elements[id.split('/')[0]]?.rect : undefined
        const ox = top?.x ?? 0
        const oy = top?.y ?? 0
        const rel = (r: Rect): Rect => ({ x: round(r.x - ox), y: round(r.y - oy), width: round(r.width), height: round(r.height) })
        const code = b.code ?? (top ? base.elements[id.split('/')[0]]?.code : undefined)
        rectChange.set(id, { element: id, name: n.name, kind: 'rect', code, from: rel(b.rect), to: rel(w.rect), note: `dx ${d.dx}, dy ${d.dy}, dw ${d.dw}, dh ${d.dh}${top ? ' (toạ độ tính từ góc trên-trái component)' : ''}` })
      } else if (type !== 'group' || n.type === 'instance') delta.set(id, { dx: 0, dy: 0, dw: 0, dh: 0 })
      // art
      if (n.type === 'image' || n.type === 'nineslice') {
        if (type !== b.type || n.assetId !== b.assetId) {
          const a = doc.assets[n.assetId]
          const direct = !!b.source && !b.crop
          const target = direct ? b.source! : `${GAME_DIR}/incoming/${slug(b.source ? b.source.replace(/^.*\//, '').replace(/\.[^.]+$/, '') + '__' + id : screenId + '__' + id)}.png`
          const old = b.source ? link.assets[b.source] : undefined
          addAsset(
            direct ? target : `${target}#${n.assetId}`,
            {
              assetId: n.assetId,
              file: a?.file ?? '',
              mode: direct ? 'overwrite' : 'incoming',
              target,
              source: b.source,
              oldSize: old ? { width: old.width, height: old.height } : b.crop ? { width: b.crop.width, height: b.crop.height } : undefined,
              newSize: sizeOf(n.assetId),
              note: direct ? undefined : b.crop ? `ảnh gốc là một vùng của ${b.source} (atlas/sprite sheet): cần đóng gói lại` : 'element vẽ bằng code/CSS: game chưa có file cho ảnh này'
            },
            `${screenId}/${id}`
          )
          // art replaced in place needs nothing per element (see the asset list); new art has to be wired in
          if (!direct) sc.changes.push({ element: id, name: n.name, kind: 'asset', code: b.code, from: b.source ?? (b.type === 'rect' ? 'vẽ bằng code (rect)' : b.type === 'text' ? 'chữ' : 'vẽ bằng code'), to: target, note: 'ảnh mới nằm trong uiforge/incoming, cần nối vào game' })
        }
        if (n.type === 'nineslice' && b.insets && JSON.stringify(n.insets) !== JSON.stringify(b.insets)) sc.changes.push({ element: id, name: n.name, kind: 'style', code: b.code, from: { insets: b.insets }, to: { insets: n.insets } })
      } else if (type !== b.type) {
        sc.changes.push({ element: id, name: n.name, kind: 'style', code: b.code, from: { type: b.type }, to: { type }, note: 'loại element đã đổi' })
      }
      if (n.type === 'text' && b.type === 'text') {
        const from: Record<string, unknown> = {}
        const to: Record<string, unknown> = {}
        if (n.text !== b.text) (from.text = b.text), (to.text = n.text)
        if (b.fontSize !== undefined && n.fontSize !== b.fontSize) (from.fontSize = b.fontSize), (to.fontSize = n.fontSize)
        if (b.color !== undefined && rgbaToHex(n.color) !== b.color) (from.color = b.color), (to.color = rgbaToHex(n.color))
        if (b.fontFamily !== undefined && n.fontFamily !== b.fontFamily) (from.fontFamily = b.fontFamily), (to.fontFamily = n.fontFamily)
        if (Object.keys(to).length) sc.changes.push({ element: id, name: n.name, kind: 'text', code: b.code, from, to })
      }
      if (n.type === 'rect' && b.type === 'rect') {
        const fill = n.fill.visible ? rgbaToHex(n.fill.color) : null
        const from: Record<string, unknown> = {}
        const to: Record<string, unknown> = {}
        if (b.fill !== undefined && fill !== b.fill) (from.fill = b.fill), (to.fill = fill)
        if (b.cornerRadius !== undefined && n.cornerRadius !== b.cornerRadius) (from.cornerRadius = b.cornerRadius), (to.cornerRadius = n.cornerRadius)
        if (Object.keys(to).length) sc.changes.push({ element: id, name: n.name, kind: 'style', code: b.code, from, to })
      }
      if (Math.abs(n.opacity - b.opacity) > 0.005) sc.changes.push({ element: id, name: n.name, kind: 'style', code: b.code, from: { opacity: b.opacity }, to: { opacity: round(n.opacity) } })
      if (n.visible !== b.visible) sc.changes.push({ element: id, name: n.name, kind: 'visible', code: b.code, from: b.visible, to: n.visible })
    }

    // a group whose elements all moved by the same amount is one change, not one per child
    const groups = walked.filter((w) => w.primary && w.gameId && elementType(w.node) === 'group' && base.elements[w.gameId]).reverse()
    for (const g of groups) {
      const leaves = Object.entries(base.elements).filter(([id, b]) => (b.type !== 'group' || !!b.component) && found.has(id) && isUnder(base.elements, id, g.gameId!))
      if (leaves.length < 2) continue
      const first = delta.get(leaves[0][0])
      if (!first || (first.dx === 0 && first.dy === 0) || first.dw !== 0 || first.dh !== 0) continue
      if (!leaves.every(([id]) => {
        const d = delta.get(id)
        return !!d && Math.abs(d.dx - first.dx) <= EPS && Math.abs(d.dy - first.dy) <= EPS && d.dw === 0 && d.dh === 0
      })) continue
      for (const [id] of leaves) rectChange.delete(id)
      for (const other of groups) if (other !== g && isUnder(base.elements, other.gameId!, g.gameId!)) rectChange.delete(other.gameId!)
      const b = base.elements[g.gameId!]
      rectChange.set(g.gameId!, { element: g.gameId!, name: g.node.name, kind: 'rect', code: b.code, from: b.rect, to: { x: round(b.rect.x + first.dx), y: round(b.rect.y + first.dy), width: b.rect.width, height: b.rect.height }, note: `cả nhóm (${leaves.length} element) dời dx ${first.dx}, dy ${first.dy}` })
    }
    sc.changes.unshift(...rectChange.values())

    for (const [id, b] of Object.entries(base.elements)) {
      if (found.has(id)) continue
      // a removed group already says its children are gone
      if (b.parent && !found.has(b.parent) && base.elements[b.parent]) continue
      sc.changes.push({ element: id, name: b.name, kind: 'removed', code: b.code, from: { type: b.type, rect: b.rect, source: b.source } })
    }
    if (sc.changes.length || sc.sizeFrom) out.screens.push(sc)
    out.total += sc.changes.length + (sc.sizeFrom ? 1 : 0)
  }

  out.assets = Array.from(assetByTarget.values())
  // components touched by this change list: their code and every place that uses them
  const touchedComponents = new Set<string>()
  for (const s of out.screens) {
    if (s.id === COMPONENTS_SCREEN) for (const ch of s.changes) touchedComponents.add(ch.element.split('/')[0])
  }
  if (touchedComponents.size) {
    out.components = {}
    const cbase = link.screens[COMPONENTS_SCREEN]?.elements ?? {}
    for (const name of touchedComponents) out.components[name] = { code: cbase[name]?.code, usedBy: [] }
    for (const { frame, screenId } of gameFrames(doc)) {
      for (const w of walkFrame(frame)) {
        if (w.node.type !== 'instance') continue
        const c = instanceState(doc, w.node).component
        if (c && out.components[c]) out.components[c].usedBy.push(`${screenId}/${w.gameId ?? w.node.name}`)
      }
    }
  }
  if (link.flows) {
    const current: string[] = []
    for (const page of doc.pages) {
      const { keyOfNode, screenOfFrame } = gameKeys(page)
      for (const c of page.connections) {
        const k = flowFromKey(c, keyOfNode, screenOfFrame)
        if (k) current.push(k)
      }
    }
    const was = new Set(link.flows)
    const now = new Set(current)
    out.flows = { added: current.filter((k) => !was.has(k)), removed: link.flows.filter((k) => !now.has(k)), current }
    out.total += out.flows.added.length + out.flows.removed.length
  }
  return out
}

function isUnder(elements: Record<string, GameElementBase>, id: string, ancestor: string): boolean {
  let p = elements[id]?.parent
  let guard = 0
  while (p && guard++ < 64) {
    if (p === ancestor) return true
    p = elements[p]?.parent
  }
  return false
}

/** Current state of every game screen (rects of all elements), for the game's agent. */
export function currentLayout(doc: DesignDocument): { id: string; name: string; width: number; height: number; elements: { id: string; name: string; type: string; rect: Rect; parent?: string; source?: string; code?: string; text?: string; visible: boolean; component?: string }[] }[] {
  const link = doc.game
  if (!link) return []
  return gameFrames(doc).map(({ frame, screenId }) => ({
    id: screenId,
    name: frame.name,
    width: frame.width,
    height: frame.height,
    elements: walkFrame(frame).map((w) => {
      const b = w.primary && w.gameId ? link.screens[screenId]?.elements[w.gameId] : undefined
      return { id: b ? w.gameId! : `~${slug(w.node.name)}`, name: w.node.name, type: w.node.type, rect: { x: round(w.rect.x), y: round(w.rect.y), width: round(w.rect.width), height: round(w.rect.height) }, parent: w.parentGameId, source: b?.source, code: b?.code, text: w.node.type === 'text' ? w.node.text : undefined, visible: w.node.visible, component: w.node.type === 'instance' ? instanceState(doc, w.node).component : undefined }
    })
  }))
}

function flowText(key: string): string {
  const [from, trigger, action, to] = key.split('|')
  return `\`${from}\` — ${trigger} → ${action}${to ? ` \`${to}\`` : ''}`
}

export function buildChangesMarkdown(c: GameChanges): string {
  const L: string[] = []
  L.push(`# UIForge → ${c.game.name}: thay đổi UI cần áp dụng (revision ${c.revision})`)
  L.push('')
  L.push(`Sinh lúc ${c.generatedAt}. Toạ độ: px trong màn hình thiết kế, gốc trên-trái, Y xuống. \`from\` = game hiện tại, \`to\` = thiết kế mới.`)
  L.push(`Trạng thái đích đầy đủ của từng màn: \`${GAME_DIR}/layout/<screen>.json\`, ảnh đích: \`${GAME_DIR}/preview/<screen>.png\`.`)
  L.push('')
  if (!c.total && !c.assets.length) L.push('Không có thay đổi nào.')
  if (c.assets.length) {
    L.push('## Art')
    L.push('')
    if (!c.synced) L.push('_Chưa sync: file art chưa được ghi vào game (bấm Sync → Game hoặc gọi sync_game)._', '')
    for (const a of c.assets) {
      const size = a.oldSize && (a.oldSize.width !== a.newSize.width || a.oldSize.height !== a.newSize.height) ? ` — kích thước ${a.oldSize.width}×${a.oldSize.height} → ${a.newSize.width}×${a.newSize.height}` : ` — ${a.newSize.width}×${a.newSize.height}`
      L.push(`- ${a.mode === 'overwrite' ? (c.synced ? 'ĐÃ GHI ĐÈ' : 'SẼ GHI ĐÈ') : 'ẢNH MỚI'} \`${a.target}\`${size}; dùng bởi ${a.usedBy.map((u) => `\`${u}\``).join(', ')}${a.note ? ` — ${a.note}` : ''}`)
    }
    L.push('')
  }
  for (const s of c.screens) {
    if (s.id === COMPONENTS_SCREEN) {
      L.push('## Component dùng chung (master)', '', '_Sửa ở chỗ code dựng widget (hàm / prefab dùng chung) — mọi chỗ dùng component đổi theo. Không sửa từng màn._', '')
      for (const [name, info] of Object.entries(c.components ?? {})) L.push(`- component \`${name}\`${info.code ? ` — code: ${info.code}` : ''}; dùng ở ${info.usedBy.length} chỗ: ${info.usedBy.map((u) => `\`${u}\``).join(', ')}`)
      L.push('')
    }
    else L.push(`## Màn \`${s.id}\` (${s.name}, ${s.width}×${s.height})${s.code ? ` — ${s.code}` : ''}`)
    L.push('')
    if (s.sizeFrom) L.push(`- kích thước màn đổi ${s.sizeFrom.width}×${s.sizeFrom.height} → ${s.width}×${s.height}`)
    for (const ch of s.changes) {
      const where = ch.code ? ` (${ch.code})` : ''
      const j = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))
      if (ch.kind === 'rect') L.push(`- \`${ch.element}\`${where}: vị trí/kích thước ${j(ch.from)} → ${j(ch.to)} — ${ch.note}`)
      else if (ch.kind === 'asset') L.push(`- \`${ch.element}\`${where}: đổi art ${j(ch.from)} → \`${j(ch.to)}\` — ${ch.note}`)
      else if (ch.kind === 'added') L.push(`- THÊM \`${ch.name}\`: ${j(ch.to)}`)
      else if (ch.kind === 'removed') L.push(`- XOÁ \`${ch.element}\`${where}: ${j(ch.from)}`)
      else if (ch.kind === 'visible') L.push(`- \`${ch.element}\`${where}: ${ch.to ? 'hiện' : 'ẩn'}`)
      else L.push(`- \`${ch.element}\`${where}: ${ch.kind} ${j(ch.from)} → ${j(ch.to)}${ch.note ? ` — ${ch.note}` : ''}`)
    }
    L.push('')
  }
  if (c.flows.added.length || c.flows.removed.length) {
    L.push('## Flow')
    L.push('')
    for (const k of c.flows.added) L.push(`- THÊM ${flowText(k)}`)
    for (const k of c.flows.removed) L.push(`- XOÁ ${flowText(k)}`)
    L.push('')
  }
  return L.join('\n')
}

// ----------------------------------------------------------------- rebaseline (the game now matches the design)
/** Makes the current design the new baseline (call on an immer draft, after the game applied the changes). */
export function rebaselineGame(doc: DesignDocument): number {
  const link = doc.game
  if (!link) return 0
  let n = 0
  for (const { frame, screenId } of gameFrames(doc)) {
    const old = link.screens[screenId]
    const elements: Record<string, GameElementBase> = {}
    const used = new Set<string>()
    for (const w of walkFrame(frame)) if (w.primary && w.gameId) used.add(w.gameId)
    // nodes added in the app get an id now; walk again afterwards so parents are known
    for (const w of walkFrame(frame)) {
      if (w.primary && w.gameId) continue
      let id = slug(w.node.name)
      for (let i = 2; used.has(id); i++) id = `${slug(w.node.name)}#${i}`
      used.add(id)
      setMeta(w.node, 'gameId', id)
    }
    for (const w of walkFrame(frame)) {
      if (!w.gameId) continue
      const prev = old?.elements[w.gameId]
      const b = baseFromNode(doc, w.node, w.rect, w.parentGameId, prev)
      if ((w.node.type === 'image' || w.node.type === 'nineslice') && b.source && !b.crop) link.assets[b.source] = { assetId: w.node.assetId, width: doc.assets[w.node.assetId]?.width ?? 0, height: doc.assets[w.node.assetId]?.height ?? 0 }
      elements[w.gameId] = b
      n++
    }
    link.screens[screenId] = { name: frame.name, width: frame.width, height: frame.height, kind: old?.kind, code: old?.code, elements }
  }
  for (const page of doc.pages) {
    const { keyOfNode, screenOfFrame } = gameKeys(page)
    const keys = page.connections.map((c) => flowFromKey(c, keyOfNode, screenOfFrame)).filter((k): k is string => !!k)
    if (keys.length || link.flows) link.flows = keys
  }
  return n
}

// ----------------------------------------------------------------- art replacement
export interface GameSource {
  source: string
  baseAssetId: string
  currentAssetId: string
  replaced: boolean
  width: number
  height: number
  usedBy: { screenId: string; elementId: string; nodeId: NodeId }[]
}

/** Art files of the game that the design uses (one row per source file). */
export function gameSources(doc: DesignDocument): GameSource[] {
  const link = doc.game
  if (!link) return []
  const map = new Map<string, GameSource>()
  for (const { frame, screenId } of gameFrames(doc)) {
    const base = link.screens[screenId]
    if (!base) continue
    for (const w of walkFrame(frame)) {
      const b = w.primary && w.gameId ? base.elements[w.gameId] : undefined
      if (!b?.source || b.crop || (w.node.type !== 'image' && w.node.type !== 'nineslice')) continue
      const orig = link.assets[b.source]
      let s = map.get(b.source)
      if (!s) {
        s = { source: b.source, baseAssetId: orig?.assetId ?? b.assetId ?? '', currentAssetId: w.node.assetId, replaced: false, width: orig?.width ?? 0, height: orig?.height ?? 0, usedBy: [] }
        map.set(b.source, s)
      }
      if (w.node.assetId !== s.baseAssetId) {
        s.replaced = true
        s.currentAssetId = w.node.assetId
      }
      s.usedBy.push({ screenId, elementId: w.gameId!, nodeId: w.node.id })
    }
  }
  return Array.from(map.values()).sort((a, b) => a.source.localeCompare(b.source))
}

function locateIn(list: SceneNode[], id: NodeId): { list: SceneNode[]; index: number } | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { list, index: i }
    const n = list[i]
    if (isContainer(n)) {
      const r = locateIn(n.children, id)
      if (r) return r
    }
  }
  return null
}

/**
 * Puts new art on a node (call on an immer draft). Images keep their centre (same aspect ⇒ same rect);
 * 9-slices keep their box; rect / text nodes become images.
 */
export function setNodeArt(doc: DesignDocument, nodeId: NodeId, assetId: string): boolean {
  const asset = doc.assets[assetId]
  if (!asset) return false
  for (const page of doc.pages) {
    const at = locateIn(page.children, nodeId)
    if (!at) continue
    const n = at.list[at.index]
    // a part of an instance: the art becomes an override of that instance
    const fromInstance = n.meta?.fromInstance as NodeId | undefined
    const instanceOf = n.meta?.instanceOf as NodeId | undefined
    if (fromInstance && instanceOf) {
      const inst = locateIn(page.children, fromInstance)
      const node = inst?.list[inst.index]
      if (!node || node.type !== 'instance' || (n.type !== 'image' && n.type !== 'nineslice')) return false
      node.overrides[instanceOf] = { ...(node.overrides[instanceOf] ?? {}), assetId }
      return true
    }
    if (n.type === 'nineslice') {
      n.assetId = assetId
      delete n.sourceAssetId
      delete n.originalAssetId
      delete n.edits
      delete n.effects
      delete n.contentOffset
      return true
    }
    if (n.type !== 'image' && n.type !== 'rect' && n.type !== 'text') return false
    // same aspect: same box. Otherwise keep the scale the old art was shown at (art drawn at the same
    // resolution, e.g. a taller logo) unless that overflows the old box a lot — then fit inside it.
    const old = n.type === 'image' ? doc.assets[n.assetId] : undefined
    const sameAspect = Math.abs(asset.width / asset.height - n.width / n.height) < 0.01 * (n.width / n.height)
    let kx = n.width / asset.width
    let ky = n.height / asset.height
    if (!sameAspect) {
      const keep = old ? Math.min(n.width / old.width, n.height / old.height) : 0
      const fit = Math.min(kx, ky)
      kx = ky = keep && asset.width * keep <= n.width * 1.6 && asset.height * keep <= n.height * 1.6 ? keep : fit
    }
    const w = Math.max(1, Math.round(asset.width * kx * 100) / 100)
    const h = Math.max(1, Math.round(asset.height * ky * 100) / 100)
    const img: ImageNode | NineSliceNode = { id: n.id, name: n.name, x: n.x + (n.width - w) / 2, y: n.y + (n.height - h) / 2, width: w, height: h, rotation: n.rotation, opacity: n.opacity, visible: n.visible, locked: n.locked, anchor: n.anchor, pivot: n.pivot, type: 'image', assetId }
    if (n.safeArea) img.safeArea = n.safeArea
    if (n.meta) img.meta = n.meta
    if (n.blendMode) img.blendMode = n.blendMode
    at.list[at.index] = img
    return true
  }
  return false
}

/** Replaces the art of every element that uses one source file of the game. */
export function replaceGameSource(doc: DesignDocument, source: string, assetId: string): number {
  let n = 0
  for (const s of gameSources(doc)) if (s.source === source) for (const u of s.usedBy) if (setNodeArt(doc, u.nodeId, assetId)) n++
  return n
}

/** Puts the game's original art (and the pushed rect) back on every element using a source file. */
export function revertGameSource(doc: DesignDocument, source: string): number {
  const link = doc.game
  const orig = link?.assets[source]
  if (!link || !orig) return 0
  let n = 0
  for (const { frame, screenId } of gameFrames(doc)) {
    for (const w of walkFrame(frame)) {
      const b = w.primary && w.gameId ? link.screens[screenId]?.elements[w.gameId] : undefined
      if (b?.source !== source || b.crop || (w.node.type !== 'image' && w.node.type !== 'nineslice')) continue
      w.node.assetId = b.assetId ?? orig.assetId
      w.node.x += b.rect.x - w.rect.x
      w.node.y += b.rect.y - w.rect.y
      w.node.width = b.rect.width
      w.node.height = b.rect.height
      n++
    }
  }
  return n
}
