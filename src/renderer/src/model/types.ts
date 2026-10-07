// ---------------------------------------------------------------------------
// Document model. Coordinates: pixels, origin top-left, Y down (editor space).
// Every node's x/y is relative to its parent's top-left corner.
// Anchor / pivot use 0..1 fractions in the SAME top-left/Y-down convention;
// conversion to Unity (Y up) happens only at export time (see export/layout.ts).
// ---------------------------------------------------------------------------
import type { AdjustmentLayer, LayerEffectsInfo } from 'ag-psd'
import type { GameLink } from './game'

export type NodeId = string

export interface Anchor {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Vec2 {
  x: number
  y: number
}

export interface RGBA {
  r: number // 0..255
  g: number
  b: number
  a: number // 0..1
}

export interface Fill {
  color: RGBA
  visible: boolean
}

export interface Stroke {
  color: RGBA
  width: number
  visible: boolean
}

export interface Insets {
  left: number
  top: number
  right: number
  bottom: number
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'add'

export interface BaseNode {
  id: NodeId
  name: string
  x: number
  y: number
  width: number
  height: number
  rotation: number // degrees, clockwise, around pivot
  opacity: number // 0..1
  visible: boolean
  locked: boolean
  anchor: Anchor
  pivot: Vec2
  blendMode?: BlendMode
  /** anchor against the device safe area instead of the full screen (top-level nodes) */
  safeArea?: boolean
  /** free-form metadata (psd source info, tags for agents, ...) */
  meta?: Record<string, unknown>
}

/** Figma-like auto layout for frames/groups: children are placed in a row/column automatically. */
export interface AutoLayout {
  direction: 'horizontal' | 'vertical'
  gap: number
  padding: { top: number; right: number; bottom: number; left: number }
  /** cross-axis alignment */
  align: 'start' | 'center' | 'end'
  /** frame resizes to its content (groups always hug) */
  hug: boolean
}

/** Non-destructive image edits applied to the raw pixels before the layer style. */
export interface ImageEdits {
  flipH?: boolean
  flipV?: boolean
  rotate?: 0 | 90 | 180 | 270
  /** crop rect in ORIGINAL source pixels (before flip/rotate) */
  crop?: { x: number; y: number; width: number; height: number }
  adjustments?: AdjustmentLayer[]
}

export interface InstanceOverride {
  text?: string
  visible?: boolean
  assetId?: string
  fontSize?: number
}

export interface FrameNode extends BaseNode {
  type: 'frame'
  children: SceneNode[]
  fill: Fill
  clipsContent: boolean
  layout?: AutoLayout
  /** marks this frame as a component master */
  component?: { name: string }
}

export interface GroupNode extends BaseNode {
  type: 'group'
  children: SceneNode[]
  /** Photoshop layer style of the group (rendered into "(style below)" / "(style above)" child images) */
  effects?: LayerEffectsInfo
  layout?: AutoLayout
  /** marks this group as a component master */
  component?: { name: string }
}

/** Instance of a component master: `children` are DERIVED (regenerated from the master on every change). */
export interface InstanceNode extends BaseNode {
  type: 'instance'
  componentId: NodeId
  /** keyed by the master child's id */
  overrides: Record<NodeId, InstanceOverride>
  /** set when the instance is resized: its own box (children follow their anchors, like a RectTransform);
   *  without it the instance takes the master's size */
  size?: { width: number; height: number }
  children: SceneNode[]
}

/** Fields shared by image-like nodes that carry an editable Photoshop layer style. */
export interface StyledImage {
  /** raw pixels before layer style (assets); present when the style can be re-rendered */
  sourceAssetId?: string
  /** position of the raw content inside the rendered asset (effect margin), asset px */
  contentOffset?: Vec2
  /** Photoshop "Fill" opacity (pixels only, effects stay opaque) */
  fillOpacity?: number
  /** Photoshop layer style, same shape as the PSD data (ag-psd LayerEffectsInfo) */
  effects?: LayerEffectsInfo
}

export interface ImageNode extends BaseNode, StyledImage {
  type: 'image'
  assetId: string
  /** original (untouched) pixels when edits were applied; sourceAssetId holds the edited raw */
  originalAssetId?: string
  edits?: ImageEdits
}

export interface NineSliceNode extends BaseNode, StyledImage {
  type: 'nineslice'
  originalAssetId?: string
  edits?: ImageEdits
  assetId: string
  /** border sizes in SOURCE image pixels */
  insets: Insets
}

export interface RectNode extends BaseNode {
  type: 'rect'
  fill: Fill
  stroke?: Stroke
  cornerRadius: number
  /** ellipse = drawn as an ellipse inscribed in the rect (wireframe icons, avatars) */
  shape?: 'rect' | 'ellipse'
}

export type TextAlign = 'left' | 'center' | 'right'

export interface TextStrokeFx {
  color: RGBA // a = opacity
  width: number // px
  position: 'outside' | 'center' | 'inside'
}
export interface TextShadowFx {
  color: RGBA // a = opacity
  distance: number
  angle: number // degrees, Photoshop convention (90 = shadow below)
  blur: number
}
export interface TextGlowFx {
  color: RGBA
  size: number
}
export interface TextGradientFx {
  stops: { color: RGBA; pos: number }[]
  angle: number // degrees, Photoshop convention (90 = bottom → top)
}
/** Layer-style subset a live text can carry (mirrors TMP outline/underlay/glow/gradient). */
export interface TextEffects {
  stroke?: TextStrokeFx
  shadow?: TextShadowFx
  glow?: TextGlowFx
  gradient?: TextGradientFx
  colorOverlay?: RGBA
  unsupported?: string[]
}

export interface TextNode extends BaseNode {
  type: 'text'
  text: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  color: RGBA
  align: TextAlign
  lineHeight: number // multiplier
  autoSize: boolean
  italic?: boolean
  letterSpacing?: number // px
  uppercase?: boolean
  /** Photoshop layer style (same shape as PSD data); rendered through the raster effects pipeline */
  effects?: LayerEffectsInfo
}

export type SceneNode = FrameNode | GroupNode | InstanceNode | ImageNode | NineSliceNode | RectNode | TextNode
export type ContainerNode = FrameNode | GroupNode | InstanceNode
export type NodeType = SceneNode['type']

export function isContainer(n: SceneNode): n is ContainerNode {
  return n.type === 'frame' || n.type === 'group' || n.type === 'instance'
}

export interface Asset {
  id: string
  /** file name inside the project's assets/ folder */
  file: string
  width: number
  height: number
  /** original source description, e.g. "psd:ui_main.psd/Buttons/btn_play" */
  source?: string
}

export type Transition = 'instant' | 'dissolve' | 'smart' | 'move-in' | 'move-out' | 'push' | 'slide-in' | 'slide-out' | 'scale-in' | 'scale-out'
export type Trigger = 'click' | 'hover' | 'press' | 'drag' | 'after-delay' | 'key'
export type Direction = 'left' | 'right' | 'up' | 'down'
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'back-out' | 'spring'

export interface OverlaySettings {
  position: 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'manual'
  x?: number
  y?: number
  /** dim the screen behind the overlay */
  dim: boolean
  dimColor: string
  dimOpacity: number
  /** clicking outside the overlay closes it */
  closeOutside: boolean
}

/** A prototype interaction (Figma-style): trigger on `from` → action (→ frame `to`) with an animation. */
export interface Connection {
  id: string
  from: NodeId // hotspot node (or a frame, for after-delay / key)
  /** destination frame (top-level frame on the same page); unused for back / close */
  to?: NodeId
  trigger: Trigger
  /** ms, for after-delay */
  delay?: number
  /** key name for trigger 'key' (e.g. "Escape", "Enter", "a") */
  key?: string
  action: 'navigate' | 'overlay' | 'swap' | 'back' | 'close'
  transition: Transition
  direction?: Direction
  duration: number // ms
  easing?: Easing
  /** overlay placement / dim (action overlay & swap) */
  overlay?: OverlaySettings
}

export interface Guide {
  id: string
  axis: 'x' | 'y'
  pos: number // page coordinate
}

export interface Page {
  id: string
  name: string
  guides?: Guide[]
  /** bottom-to-top order (last child renders on top) */
  children: SceneNode[]
  connections: Connection[]
  startFrameId?: NodeId
}

export interface PatternDef {
  name: string
  assetId: string
  width: number
  height: number
}

/** Mirrors Unity CanvasScaler (Scale With Screen Size). */
export interface CanvasScalerSettings {
  /** expand: canvas never smaller than the reference on either axis (nothing overlaps, extra space appears);
   *  shrink: never larger; match: matchWidthOrHeight blend */
  mode: 'expand' | 'shrink' | 'match'
  /** 0 = width, 1 = height (mode match) */
  match: number
}

export const DEFAULT_SCALER: CanvasScalerSettings = { mode: 'expand', match: 0 }

export interface DesignDocument {
  schema: 'uiforge-design'
  version: 1
  name: string
  pages: Page[]
  assets: Record<string, Asset>
  /** Photoshop patterns used by layer styles (id → PNG asset) */
  patterns?: Record<string, PatternDef>
  /** Photoshop Global Light (shared by styles with useGlobalLight) */
  globalLight?: { angle: number; altitude: number }
  /** component masters registry: master node id → name + page */
  components?: Record<NodeId, { name: string; pageId: string }>
  /** device presets chosen for the responsive preview */
  previewDevices?: string[]
  /** Unity CanvasScaler settings used for multi-resolution simulation and export */
  scaler?: CanvasScalerSettings
  /** set when this project mirrors the UI of a game project (see model/game.ts) */
  game?: GameLink
}

export const DEFAULT_ANCHOR: Anchor = { minX: 0, minY: 0, maxX: 0, maxY: 0 }
export const DEFAULT_PIVOT: Vec2 = { x: 0.5, y: 0.5 }
