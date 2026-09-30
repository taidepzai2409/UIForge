import { nanoid } from 'nanoid'
import type {
  Anchor,
  DesignDocument,
  FrameNode,
  GroupNode,
  ImageNode,
  NineSliceNode,
  Page,
  RGBA,
  RectNode,
  TextNode,
  Vec2,
  InstanceNode,
  AutoLayout,
  NodeId
} from './types'
import { DEFAULT_ANCHOR, DEFAULT_PIVOT } from './types'

export const newId = (): string => nanoid(10)

function base(name: string, x: number, y: number, width: number, height: number) {
  return {
    id: newId(),
    name,
    x,
    y,
    width,
    height,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    anchor: { ...DEFAULT_ANCHOR } as Anchor,
    pivot: { ...DEFAULT_PIVOT } as Vec2
  }
}

export const rgba = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a })

export function createFrame(name: string, x: number, y: number, width: number, height: number): FrameNode {
  return {
    ...base(name, x, y, width, height),
    type: 'frame',
    children: [],
    fill: { color: rgba(255, 255, 255, 1), visible: true },
    clipsContent: true
  }
}

export function createGroup(name: string, x: number, y: number, width: number, height: number): GroupNode {
  return { ...base(name, x, y, width, height), type: 'group', children: [] }
}

export function createImage(name: string, x: number, y: number, width: number, height: number, assetId: string): ImageNode {
  return { ...base(name, x, y, width, height), type: 'image', assetId }
}

export function createNineSlice(
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  assetId: string,
  insets = { left: 10, top: 10, right: 10, bottom: 10 }
): NineSliceNode {
  return { ...base(name, x, y, width, height), type: 'nineslice', assetId, insets }
}

export function createRect(name: string, x: number, y: number, width: number, height: number): RectNode {
  return {
    ...base(name, x, y, width, height),
    type: 'rect',
    fill: { color: rgba(217, 217, 217, 1), visible: true },
    cornerRadius: 0
  }
}

export function createText(name: string, x: number, y: number, text = 'Text'): TextNode {
  return {
    ...base(name, x, y, 120, 28),
    type: 'text',
    text,
    fontFamily: 'Arial',
    fontSize: 24,
    fontWeight: 400,
    color: rgba(0, 0, 0, 1),
    align: 'left',
    lineHeight: 1.2,
    autoSize: true
  }
}

export function createInstance(name: string, x: number, y: number, componentId: NodeId, width: number, height: number): InstanceNode {
  return { ...base(name, x, y, width, height), type: 'instance', componentId, overrides: {}, children: [] }
}

export function defaultLayout(direction: AutoLayout['direction'] = 'vertical'): AutoLayout {
  return { direction, gap: 8, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: 'start', hug: true }
}

export function createPage(name: string): Page {
  return { id: newId(), name, children: [], connections: [] }
}

export function createDocument(name = 'Untitled'): DesignDocument {
  return { schema: 'uiforge-design', version: 1, name, pages: [createPage('Page 1')], assets: {} }
}

export const FRAME_PRESETS: { name: string; width: number; height: number }[] = [
  { name: '★ Game dọc 1080×1920 (chuẩn, 16:9)', width: 1080, height: 1920 },
  { name: '★ Game ngang 1920×1080 (chuẩn, 16:9)', width: 1920, height: 1080 },
  { name: 'Mobile Portrait 1080×2340 (19.5:9)', width: 1080, height: 2340 },
  { name: 'Mobile Landscape 2340×1080 (19.5:9)', width: 2340, height: 1080 },
  { name: 'Tablet 2048×1536', width: 2048, height: 1536 },
  { name: 'iPhone 14 390×844', width: 390, height: 844 },
  { name: 'Square 1024×1024', width: 1024, height: 1024 }
]
