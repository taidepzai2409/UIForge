// "Layer Style" dialog laid out like Photoshop: Styles list (left) · settings (middle) ·
// OK / Cancel / Reset / Preview (right). Edits node.effects (ag-psd LayerEffectsInfo shape)
// for image, text and group nodes, re-rendering live on the canvas.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LayerEffectsInfo } from 'ag-psd'
import type { GroupNode, ImageNode, NineSliceNode, RGBA, SceneNode, TextNode } from '@/model/types'
import { getCurrentPage, useEditor } from '@/store/editor'
import { getEntry } from '@/model/nodes'
import { scheduleRestyle } from '@/psd/restyle'
import { rgbaToHex, hexToRgba } from '@/model/color'
import { getBlobUrl } from '@/store/assets'
import { rasterizeText } from '@/canvas/textRaster'
import { FloatingWindow } from './FloatingWindow'

type Fx = Record<string, unknown>
type Units = { value: number; units: string }
const P = (v: number): Units => ({ value: v, units: 'Pixels' })

const BLEND_MODES = ['normal', 'dissolve', 'darken', 'multiply', 'color burn', 'linear burn', 'darker color', 'lighten', 'screen', 'color dodge', 'linear dodge', 'lighter color', 'overlay', 'soft light', 'hard light', 'vivid light', 'linear light', 'pin light', 'hard mix', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity']

/** Photoshop contour presets (approximations of the built-in curves). */
export const CONTOURS: Record<string, { x: number; y: number }[]> = {
  Linear: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  Cone: [{ x: 0, y: 0 }, { x: 128, y: 255 }, { x: 255, y: 0 }],
  'Cone - Inverted': [{ x: 0, y: 255 }, { x: 128, y: 0 }, { x: 255, y: 255 }],
  'Cove - Deep': [{ x: 0, y: 0 }, { x: 40, y: 150 }, { x: 110, y: 235 }, { x: 255, y: 255 }],
  'Cove - Shallow': [{ x: 0, y: 0 }, { x: 128, y: 190 }, { x: 255, y: 255 }],
  Cylinder: [{ x: 0, y: 0 }, { x: 70, y: 255 }, { x: 185, y: 255 }, { x: 255, y: 0 }],
  Gaussian: [{ x: 0, y: 0 }, { x: 64, y: 25 }, { x: 128, y: 128 }, { x: 192, y: 230 }, { x: 255, y: 255 }],
  'Half Round': [{ x: 0, y: 0 }, { x: 100, y: 230 }, { x: 255, y: 255 }],
  Ring: [{ x: 0, y: 0 }, { x: 64, y: 255 }, { x: 128, y: 0 }, { x: 192, y: 255 }, { x: 255, y: 0 }],
  'Ring - Double': [{ x: 0, y: 0 }, { x: 43, y: 255 }, { x: 85, y: 0 }, { x: 128, y: 255 }, { x: 170, y: 0 }, { x: 213, y: 255 }, { x: 255, y: 0 }],
  'Rolling Slope - Descending': [{ x: 0, y: 0 }, { x: 60, y: 60 }, { x: 128, y: 210 }, { x: 255, y: 255 }],
  'Rounded Steps': [{ x: 0, y: 0 }, { x: 50, y: 95 }, { x: 90, y: 100 }, { x: 140, y: 190 }, { x: 180, y: 195 }, { x: 255, y: 255 }],
  Sawtooth: [{ x: 0, y: 0 }, { x: 84, y: 255 }, { x: 86, y: 0 }, { x: 170, y: 255 }, { x: 172, y: 0 }, { x: 255, y: 255 }]
}

interface Field {
  key: string
  label: string
  kind: 'slider' | 'percent' | 'angle' | 'color' | 'select' | 'check' | 'blend' | 'pattern' | 'gradient' | 'contour'
  min?: number
  max?: number
  options?: string[]
  units?: boolean
  unit?: string
  /** put on the same row as the previous field */
  inline?: boolean
}
interface Sect {
  title: string
  fields: Field[]
}
interface FxDef {
  kind: string
  label: string
  array: boolean
  sections: Sect[]
  defaults: Fx
}

const GRAD_DEFAULT = { name: 'custom', type: 'solid', colorStops: [{ color: { r: 0, g: 0, b: 0 }, location: 0, midpoint: 50 }, { color: { r: 255, g: 255, b: 255 }, location: 4096, midpoint: 50 }], opacityStops: [{ opacity: 1, location: 0, midpoint: 50 }, { opacity: 1, location: 4096, midpoint: 50 }] }
const LINEAR = { name: 'Linear', curve: CONTOURS.Linear }

const QUALITY: Sect = { title: 'Quality', fields: [{ key: 'contour', label: 'Contour', kind: 'contour' }, { key: 'antialiased', label: 'Anti-aliased', kind: 'check', inline: true }, { key: 'noise', label: 'Noise', kind: 'slider', min: 0, max: 100, unit: '%' }] }

// order = Photoshop dialog order
const FX: FxDef[] = [
  {
    kind: 'bevel',
    label: 'Bevel & Emboss',
    array: false,
    sections: [
      {
        title: 'Structure',
        fields: [
          { key: 'style', label: 'Style', kind: 'select', options: ['outer bevel', 'inner bevel', 'emboss', 'pillow emboss', 'stroke emboss'] },
          { key: 'technique', label: 'Technique', kind: 'select', options: ['smooth', 'chisel hard', 'chisel soft'] },
          { key: 'strength', label: 'Depth', kind: 'slider', min: 1, max: 1000, unit: '%' },
          { key: 'direction', label: 'Direction', kind: 'select', options: ['up', 'down'] },
          { key: 'size', label: 'Size', kind: 'slider', min: 0, max: 250, units: true, unit: 'px' },
          { key: 'soften', label: 'Soften', kind: 'slider', min: 0, max: 16, units: true, unit: 'px' }
        ]
      },
      {
        title: 'Shading',
        fields: [
          { key: 'angle', label: 'Angle', kind: 'angle' },
          { key: 'altitude', label: 'Altitude', kind: 'slider', min: 0, max: 90, unit: '°' },
          { key: 'highlightBlendMode', label: 'Highlight Mode', kind: 'blend' },
          { key: 'highlightColor', label: '', kind: 'color', inline: true },
          { key: 'highlightOpacity', label: 'Opacity', kind: 'percent' },
          { key: 'shadowBlendMode', label: 'Shadow Mode', kind: 'blend' },
          { key: 'shadowColor', label: '', kind: 'color', inline: true },
          { key: 'shadowOpacity', label: 'Opacity', kind: 'percent' }
        ]
      }
    ],
    defaults: { enabled: true, present: true, style: 'inner bevel', technique: 'smooth', strength: 100, direction: 'up', size: P(5), soften: P(0), angle: 120, useGlobalLight: true, altitude: 30, highlightBlendMode: 'screen', highlightColor: { r: 255, g: 255, b: 255 }, highlightOpacity: 0.5, shadowBlendMode: 'multiply', shadowColor: { r: 0, g: 0, b: 0 }, shadowOpacity: 0.5 }
  },
  {
    kind: 'stroke',
    label: 'Stroke',
    array: true,
    sections: [
      {
        title: 'Structure',
        fields: [
          { key: 'size', label: 'Size', kind: 'slider', min: 1, max: 250, units: true, unit: 'px' },
          { key: 'position', label: 'Position', kind: 'select', options: ['outside', 'inside', 'center'] },
          { key: 'blendMode', label: 'Blend Mode', kind: 'blend' },
          { key: 'opacity', label: 'Opacity', kind: 'percent' },
          { key: 'overprint', label: 'Overprint', kind: 'check' }
        ]
      },
      {
        title: 'Fill Type',
        fields: [
          { key: 'fillType', label: 'Fill Type', kind: 'select', options: ['color', 'gradient', 'pattern'] },
          { key: 'color', label: 'Color', kind: 'color' },
          { key: 'gradient', label: 'Gradient', kind: 'gradient' },
          { key: 'reverse', label: 'Reverse', kind: 'check' },
          { key: 'angle', label: 'Angle', kind: 'angle' },
          { key: 'pattern', label: 'Pattern', kind: 'pattern' },
          { key: 'scale', label: 'Scale', kind: 'slider', min: 1, max: 1000, unit: '%' }
        ]
      }
    ],
    defaults: { enabled: true, present: true, size: P(3), position: 'outside', blendMode: 'normal', opacity: 1, overprint: false, fillType: 'color', color: { r: 0, g: 0, b: 0 }, angle: 90, scale: 100 }
  },
  {
    kind: 'innerShadow',
    label: 'Inner Shadow',
    array: true,
    sections: [
      {
        title: 'Structure',
        fields: [
          { key: 'blendMode', label: 'Blend Mode', kind: 'blend' },
          { key: 'color', label: '', kind: 'color', inline: true },
          { key: 'opacity', label: 'Opacity', kind: 'percent' },
          { key: 'angle', label: 'Angle', kind: 'angle' },
          { key: 'distance', label: 'Distance', kind: 'slider', min: 0, max: 30000, units: true, unit: 'px' },
          { key: 'choke', label: 'Choke', kind: 'slider', min: 0, max: 100, units: true, unit: '%' },
          { key: 'size', label: 'Size', kind: 'slider', min: 0, max: 250, units: true, unit: 'px' }
        ]
      },
      QUALITY
    ],
    defaults: { enabled: true, present: true, blendMode: 'multiply', color: { r: 0, g: 0, b: 0 }, opacity: 0.75, angle: 120, useGlobalLight: true, distance: P(5), choke: P(0), size: P(5), contour: LINEAR, antialiased: false, noise: 0 }
  },
  {
    kind: 'innerGlow',
    label: 'Inner Glow',
    array: false,
    sections: [
      {
        title: 'Structure',
        fields: [
          { key: 'blendMode', label: 'Blend Mode', kind: 'blend' },
          { key: 'opacity', label: 'Opacity', kind: 'percent' },
          { key: 'noise', label: 'Noise', kind: 'slider', min: 0, max: 100, unit: '%' },
          { key: 'color', label: 'Color', kind: 'color' }
        ]
      },
      {
        title: 'Elements',
        fields: [
          { key: 'technique', label: 'Technique', kind: 'select', options: ['softer', 'precise'] },
          { key: 'source', label: 'Source', kind: 'select', options: ['edge', 'center'] },
          { key: 'choke', label: 'Choke', kind: 'slider', min: 0, max: 100, units: true, unit: '%' },
          { key: 'size', label: 'Size', kind: 'slider', min: 0, max: 250, units: true, unit: 'px' }
        ]
      },
      { title: 'Quality', fields: [{ key: 'contour', label: 'Contour', kind: 'contour' }, { key: 'antialiased', label: 'Anti-aliased', kind: 'check', inline: true }, { key: 'range', label: 'Range', kind: 'slider', min: 1, max: 100, unit: '%' }] }
    ],
    defaults: { enabled: true, present: true, blendMode: 'screen', opacity: 0.75, noise: 0, color: { r: 255, g: 255, b: 190 }, technique: 'softer', source: 'edge', choke: P(0), size: P(5), contour: LINEAR, antialiased: false, range: 50 }
  },
  {
    kind: 'satin',
    label: 'Satin',
    array: false,
    sections: [
      {
        title: 'Structure',
        fields: [
          { key: 'blendMode', label: 'Blend Mode', kind: 'blend' },
          { key: 'color', label: '', kind: 'color', inline: true },
          { key: 'opacity', label: 'Opacity', kind: 'percent' },
          { key: 'angle', label: 'Angle', kind: 'angle' },
          { key: 'distance', label: 'Distance', kind: 'slider', min: 1, max: 250, units: true, unit: 'px' },
          { key: 'size', label: 'Size', kind: 'slider', min: 0, max: 250, units: true, unit: 'px' },
          { key: 'contour', label: 'Contour', kind: 'contour' },
          { key: 'antialiased', label: 'Anti-aliased', kind: 'check', inline: true },
          { key: 'invert', label: 'Invert', kind: 'check' }
        ]
      }
    ],
    defaults: { enabled: true, present: true, blendMode: 'multiply', color: { r: 0, g: 0, b: 0 }, opacity: 0.5, angle: 19, distance: P(11), size: P(14), contour: LINEAR, antialiased: true, invert: true }
  },
  {
    kind: 'solidFill',
    label: 'Color Overlay',
    array: true,
    sections: [{ title: 'Color', fields: [{ key: 'blendMode', label: 'Blend Mode', kind: 'blend' }, { key: 'color', label: '', kind: 'color', inline: true }, { key: 'opacity', label: 'Opacity', kind: 'percent' }] }],
    defaults: { enabled: true, present: true, blendMode: 'normal', color: { r: 255, g: 0, b: 0 }, opacity: 1 }
  },
  {
    kind: 'gradientOverlay',
    label: 'Gradient Overlay',
    array: true,
    sections: [
      {
        title: 'Gradient',
        fields: [
          { key: 'blendMode', label: 'Blend Mode', kind: 'blend' },
          { key: 'dither', label: 'Dither', kind: 'check', inline: true },
          { key: 'opacity', label: 'Opacity', kind: 'percent' },
          { key: 'gradient', label: 'Gradient', kind: 'gradient' },
          { key: 'reverse', label: 'Reverse', kind: 'check', inline: true },
          { key: 'type', label: 'Style', kind: 'select', options: ['linear', 'radial', 'angle', 'reflected', 'diamond'] },
          { key: 'align', label: 'Align with Layer', kind: 'check', inline: true },
          { key: 'angle', label: 'Angle', kind: 'angle' },
          { key: 'scale', label: 'Scale', kind: 'slider', min: 10, max: 150, unit: '%' }
        ]
      }
    ],
    defaults: { enabled: true, present: true, blendMode: 'normal', dither: false, opacity: 1, gradient: GRAD_DEFAULT, reverse: false, type: 'linear', align: true, angle: 90, scale: 100 }
  },
  {
    kind: 'patternOverlay',
    label: 'Pattern Overlay',
    array: false,
    sections: [{ title: 'Pattern', fields: [{ key: 'blendMode', label: 'Blend Mode', kind: 'blend' }, { key: 'opacity', label: 'Opacity', kind: 'percent' }, { key: 'pattern', label: 'Pattern', kind: 'pattern' }, { key: 'scale', label: 'Scale', kind: 'slider', min: 1, max: 1000, unit: '%' }, { key: 'align', label: 'Link with Layer', kind: 'check' }] }],
    defaults: { enabled: true, present: true, blendMode: 'normal', opacity: 1, scale: 100, align: true }
  },
  {
    kind: 'outerGlow',
    label: 'Outer Glow',
    array: false,
    sections: [
      { title: 'Structure', fields: [{ key: 'blendMode', label: 'Blend Mode', kind: 'blend' }, { key: 'opacity', label: 'Opacity', kind: 'percent' }, { key: 'noise', label: 'Noise', kind: 'slider', min: 0, max: 100, unit: '%' }, { key: 'color', label: 'Color', kind: 'color' }] },
      { title: 'Elements', fields: [{ key: 'technique', label: 'Technique', kind: 'select', options: ['softer', 'precise'] }, { key: 'choke', label: 'Spread', kind: 'slider', min: 0, max: 100, units: true, unit: '%' }, { key: 'size', label: 'Size', kind: 'slider', min: 0, max: 250, units: true, unit: 'px' }] },
      { title: 'Quality', fields: [{ key: 'contour', label: 'Contour', kind: 'contour' }, { key: 'antialiased', label: 'Anti-aliased', kind: 'check', inline: true }, { key: 'range', label: 'Range', kind: 'slider', min: 1, max: 100, unit: '%' }, { key: 'jitter', label: 'Jitter', kind: 'slider', min: 0, max: 100, unit: '%' }] }
    ],
    defaults: { enabled: true, present: true, blendMode: 'screen', opacity: 0.75, noise: 0, color: { r: 255, g: 255, b: 190 }, technique: 'softer', choke: P(0), size: P(5), contour: LINEAR, antialiased: false, range: 50, jitter: 0 }
  },
  {
    kind: 'dropShadow',
    label: 'Drop Shadow',
    array: true,
    sections: [
      {
        title: 'Structure',
        fields: [
          { key: 'blendMode', label: 'Blend Mode', kind: 'blend' },
          { key: 'color', label: '', kind: 'color', inline: true },
          { key: 'opacity', label: 'Opacity', kind: 'percent' },
          { key: 'angle', label: 'Angle', kind: 'angle' },
          { key: 'distance', label: 'Distance', kind: 'slider', min: 0, max: 30000, units: true, unit: 'px' },
          { key: 'choke', label: 'Spread', kind: 'slider', min: 0, max: 100, units: true, unit: '%' },
          { key: 'size', label: 'Size', kind: 'slider', min: 0, max: 250, units: true, unit: 'px' }
        ]
      },
      { title: 'Quality', fields: [{ key: 'contour', label: 'Contour', kind: 'contour' }, { key: 'antialiased', label: 'Anti-aliased', kind: 'check', inline: true }, { key: 'noise', label: 'Noise', kind: 'slider', min: 0, max: 100, unit: '%' }, { key: 'layerConceals', label: 'Layer Knocks Out Drop Shadow', kind: 'check' }] }
    ],
    defaults: { enabled: true, present: true, blendMode: 'multiply', color: { r: 0, g: 0, b: 0 }, opacity: 0.75, angle: 120, useGlobalLight: true, distance: P(5), choke: P(0), size: P(5), contour: LINEAR, antialiased: false, noise: 0, layerConceals: true }
  }
]

const DEFAULTS_KEY = 'uiforge.layerStyleDefaults'
function userDefaults(): Record<string, Fx> {
  try {
    return JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? '{}') as Record<string, Fx>
  } catch {
    return {}
  }
}
function defaultsFor(d: FxDef): Fx {
  const u = userDefaults()[d.kind]
  return JSON.parse(JSON.stringify(u ?? d.defaults)) as Fx
}

const toRgba = (c: unknown): RGBA => {
  const o = (c as { r?: number; g?: number; b?: number }) ?? {}
  return { r: o.r ?? 0, g: o.g ?? 0, b: o.b ?? 0, a: 1 }
}
const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase())

type Styled = ImageNode | NineSliceNode | TextNode | GroupNode
const EMPTY_PATTERNS: Record<string, { name: string; assetId: string; width: number; height: number }> = {}

function canStyle(n: SceneNode | undefined): n is Styled {
  return !!n && (n.type === 'image' || n.type === 'nineslice' || n.type === 'text' || n.type === 'group')
}

interface Active {
  kind: string
  index: number
}

export function LayerStyleDialog(): React.JSX.Element | null {
  const [nodeId, setNodeId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<{ effects?: LayerEffectsInfo; fillOpacity?: number; opacity: number; blendMode?: string } | null>(null)
  const [active, setActive] = useState<Active>({ kind: 'blending', index: 0 })
  const [preview, setPreview] = useState(true)
  const [thumb, setThumb] = useState<string | null>(null)
  const page = useEditor((s) => s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.pages[0])
  const patterns = useEditor((s) => s.doc.patterns) ?? EMPTY_PATTERNS
  const globalLight = useEditor((s) => s.doc.globalLight)
  const st = useEditor.getState()
  const liveFx = useRef<Fx | undefined>(undefined)

  useEffect(() => {
    const open = (): void => {
      const s = useEditor.getState()
      if (s.selection.length !== 1) {
        s.setStatus('Chọn đúng một layer (ảnh, text hoặc group) để mở Layer Style')
        return
      }
      const n = getEntry(getCurrentPage(), s.selection[0])?.node
      if (!canStyle(n)) {
        s.setStatus('Layer Style chỉ áp dụng cho ảnh, text, group')
        return
      }
      if ((n.type === 'image' || n.type === 'nineslice') && !n.sourceAssetId) {
        s.setStatus('Ảnh này chưa có pixel gốc (import từ bản cũ). Import lại PSD để chỉnh layer style.')
        return
      }
      setSnapshot({ effects: n.effects ? (JSON.parse(JSON.stringify(n.effects)) as LayerEffectsInfo) : undefined, fillOpacity: (n as ImageNode).fillOpacity, opacity: n.opacity, blendMode: n.blendMode })
      liveFx.current = n.effects ? (JSON.parse(JSON.stringify(n.effects)) as Fx) : undefined
      setPreview(true)
      setNodeId(n.id)
      const first = FX.find((d) => {
        const v = (n.effects as Fx | undefined)?.[d.kind]
        const e = Array.isArray(v) ? v[0] : v
        return e && (e as Fx).enabled !== false
      })
      setActive({ kind: first?.kind ?? 'blending', index: 0 })
    }
    window.addEventListener('dm:layer-style', open)
    return () => window.removeEventListener('dm:layer-style', open)
  }, [])

  const node = useMemo(() => (nodeId ? (getEntry(page, nodeId)?.node as Styled | undefined) : undefined), [page, nodeId])

  useEffect(() => {
    let alive = true
    if (!node) return
    if (node.type === 'image' || node.type === 'nineslice') {
      const a = useEditor.getState().doc.assets[node.assetId]
      if (a) void getBlobUrl(a).then((u) => alive && setThumb(u))
    } else if (node.type === 'text') {
      const r = rasterizeText({ ...node, fontSize: Math.min(node.fontSize, 48), width: 200 }, 1)
      setThumb(r.canvas.toDataURL())
    } else setThumb(null)
    return () => {
      alive = false
    }
  }, [node])

  if (!nodeId || !node) return null
  const fx = (node.effects ?? {}) as Fx

  const applyFx = (nextFx: Fx | undefined, extra: Partial<ImageNode> = {}): void => {
    liveFx.current = nextFx
    if (!preview && !('fillOpacity' in extra)) return
    st.setNodeProps(node.id, { effects: nextFx as unknown as LayerEffectsInfo, ...extra } as Partial<SceneNode>, { history: false })
    if (node.type !== 'text') scheduleRestyle(node.id)
  }
  const instancesOf = (d: FxDef): Fx[] => {
    const v = fx[d.kind]
    if (!v) return []
    return (Array.isArray(v) ? v : [v]) as Fx[]
  }
  const writeInstances = (d: FxDef, list: Fx[]): void => {
    const next: Fx = { ...fx }
    if (!list.length) delete next[d.kind]
    else next[d.kind] = d.array ? list : list[0]
    applyFx(next)
  }
  const writeEntry = (d: FxDef, index: number, e: Fx | undefined): void => {
    const list = instancesOf(d).slice()
    if (e === undefined) list.splice(index, 1)
    else list[index] = e
    writeInstances(d, list)
  }
  const togglePreview = (on: boolean): void => {
    setPreview(on)
    const target = on ? liveFx.current : (snapshot?.effects as Fx | undefined)
    st.setNodeProps(node.id, { effects: target as unknown as LayerEffectsInfo } as Partial<SceneNode>, { history: false })
    if (node.type !== 'text') scheduleRestyle(node.id)
  }
  const restoreSnapshot = (): void => {
    if (!snapshot) return
    st.setNodeProps(node.id, { effects: snapshot.effects, fillOpacity: snapshot.fillOpacity, opacity: snapshot.opacity, blendMode: snapshot.blendMode } as Partial<SceneNode>, { history: false })
    if (node.type !== 'text') scheduleRestyle(node.id)
  }
  const ok = (): void => {
    const cur = getEntry(getCurrentPage(), node.id)?.node as Styled | undefined
    if (cur && snapshot) {
      const final = { effects: liveFx.current as unknown as LayerEffectsInfo, fillOpacity: (cur as ImageNode).fillOpacity, opacity: cur.opacity, blendMode: cur.blendMode }
      st.setNodeProps(node.id, { effects: snapshot.effects, fillOpacity: snapshot.fillOpacity, opacity: snapshot.opacity, blendMode: snapshot.blendMode } as Partial<SceneNode>, { history: false })
      useEditor.getState().snapshot()
      st.setNodeProps(node.id, final as Partial<SceneNode>, { history: false })
      if (node.type !== 'text') scheduleRestyle(node.id)
    }
    setNodeId(null)
  }
  const cancel = (): void => {
    restoreSnapshot()
    setNodeId(null)
  }
  const reset = (): void => {
    liveFx.current = snapshot?.effects ? (JSON.parse(JSON.stringify(snapshot.effects)) as Fx) : undefined
    restoreSnapshot()
  }
  const activeDef = FX.find((d) => d.kind === active.kind)
  const activeEntry = activeDef ? instancesOf(activeDef)[active.index] : undefined

  const setGlobalAngle = (angle: number): void => {
    st.update((doc) => {
      doc.globalLight = { angle, altitude: doc.globalLight?.altitude ?? 30 }
    }, { history: false })
    if (node.type !== 'text') scheduleRestyle(node.id)
  }

  const renderField = (d: FxDef, e: Fx, f: Field): React.JSX.Element | null => {
    const val = e[f.key]
    const set = (v: unknown): void => writeEntry(d, active.index, { ...e, [f.key]: v })
    if (d.kind === 'stroke') {
      const ft = (e.fillType as string) ?? 'color'
      if (f.key === 'color' && ft !== 'color') return null
      if ((f.key === 'gradient' || f.key === 'angle' || f.key === 'reverse') && ft !== 'gradient') return null
      if ((f.key === 'pattern' || f.key === 'scale') && ft !== 'pattern') return null
    }
    switch (f.kind) {
      case 'blend':
        return (
          <div className="ps-row" key={f.key}>
            <span className="ps-label">{f.label}:</span>
            <select className="ps-select" value={String(val ?? 'normal')} onChange={(ev) => set(ev.target.value)}>
              {BLEND_MODES.map((m) => (
                <option key={m} value={m}>
                  {cap(m)}
                </option>
              ))}
            </select>
          </div>
        )
      case 'select':
        return (
          <div className="ps-row" key={f.key}>
            <span className="ps-label">{f.label}:</span>
            <select className="ps-select" value={String(val ?? f.options?.[0])} onChange={(ev) => set(ev.target.value)}>
              {f.options?.map((m) => (
                <option key={m} value={m}>
                  {cap(m)}
                </option>
              ))}
            </select>
          </div>
        )
      case 'check':
        return (
          <div className={`ps-row ${f.inline ? 'inline' : ''}`} key={f.key}>
            {!f.inline && <span className="ps-label" />}
            <label className="ps-check">
              <input type="checkbox" checked={!!val} onChange={(ev) => set(ev.target.checked)} /> {f.label}
            </label>
          </div>
        )
      case 'color': {
        const c = toRgba(val)
        return (
          <div className={`ps-row ${f.inline ? 'inline' : ''}`} key={f.key}>
            {!f.inline && <span className="ps-label">{f.label}:</span>}
            <span className="ps-swatch" title={rgbaToHex(c)}>
              <input
                type="color"
                value={rgbaToHex(c)}
                onChange={(ev) => {
                  const p = hexToRgba(ev.target.value)
                  if (p) set({ r: p.r, g: p.g, b: p.b })
                }}
              />
            </span>
          </div>
        )
      }
      case 'percent':
        return <PsSlider key={f.key} label={f.label} value={Math.round(((val as number) ?? 1) * 100)} min={0} max={100} unit="%" onChange={(x) => set(x / 100)} />
      case 'angle': {
        const useGlobal = !!e.useGlobalLight
        const hasGlobalOpt = 'useGlobalLight' in d.defaults
        const v = useGlobal ? (globalLight?.angle ?? 120) : ((val as number) ?? 120)
        return (
          <div className="ps-row" key={f.key}>
            <span className="ps-label">{f.label}:</span>
            <span className="ps-angle">
              <AngleDial value={v} onChange={(x) => (useGlobal ? setGlobalAngle(x) : set(x))} />
              <input
                type="text"
                className="ps-num"
                value={Math.round(v)}
                onChange={(ev) => {
                  const x = Number(ev.target.value)
                  if (Number.isFinite(x)) {
                    if (useGlobal) setGlobalAngle(x)
                    else set(x)
                  }
                }}
              />
              <span className="ps-unit">°</span>
              {hasGlobalOpt && (
                <label className="ps-check">
                  <input type="checkbox" checked={useGlobal} onChange={(ev) => writeEntry(d, active.index, { ...e, useGlobalLight: ev.target.checked, angle: v })} /> Use Global Light
                </label>
              )}
            </span>
          </div>
        )
      }
      case 'slider': {
        const isUnits = f.units || (typeof val === 'object' && val !== null)
        const v = isUnits ? ((val as Units)?.value ?? 0) : ((val as number) ?? 0)
        return <PsSlider key={f.key} label={f.label} value={v} min={f.min ?? 0} max={f.max ?? 100} unit={f.unit ?? ''} onChange={(x) => set(isUnits ? P(x) : x)} />
      }
      case 'contour': {
        const cur = (val as { name?: string; curve?: { x: number; y: number }[] } | undefined)?.name ?? 'Linear'
        const curve = CONTOURS[cur] ?? (val as { curve?: { x: number; y: number }[] } | undefined)?.curve ?? CONTOURS.Linear
        return (
          <div className="ps-row" key={f.key}>
            <span className="ps-label">{f.label}:</span>
            <span className="ps-contour">
              <ContourThumb curve={curve} />
              <select className="ps-select" value={CONTOURS[cur] ? cur : 'Custom'} onChange={(ev) => set({ name: ev.target.value, curve: CONTOURS[ev.target.value] })}>
                {!CONTOURS[cur] && <option value="Custom">Custom</option>}
                {Object.keys(CONTOURS).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </span>
          </div>
        )
      }
      case 'gradient': {
        const g = (val as typeof GRAD_DEFAULT | undefined) ?? GRAD_DEFAULT
        const stops = g.colorStops
        const setStop = (i: number, c: RGBA): void => {
          const ng = JSON.parse(JSON.stringify(g)) as typeof GRAD_DEFAULT
          ng.colorStops[i].color = { r: c.r, g: c.g, b: c.b }
          set(ng)
        }
        const css = `linear-gradient(90deg, ${stops.map((s) => `${rgbaToHex(toRgba(s.color))} ${(s.location / 4096) * 100}%`).join(', ')})`
        return (
          <div className="ps-row" key={f.key}>
            <span className="ps-label">{f.label}:</span>
            <span className="ps-gradient">
              <input type="color" value={rgbaToHex(toRgba(stops[0].color))} onChange={(ev) => setStop(0, hexToRgba(ev.target.value)!)} title="Màu đầu" />
              <span className="ps-gradient-bar" style={{ background: css }} />
              <input type="color" value={rgbaToHex(toRgba(stops[stops.length - 1].color))} onChange={(ev) => setStop(stops.length - 1, hexToRgba(ev.target.value)!)} title="Màu cuối" />
            </span>
          </div>
        )
      }
      case 'pattern': {
        const cur = (val as { id?: string } | undefined)?.id ?? ''
        const list = Object.entries(patterns)
        return (
          <div className="ps-row" key={f.key}>
            <span className="ps-label">{f.label}:</span>
            <select className="ps-select" value={cur} onChange={(ev) => set({ id: ev.target.value, name: patterns[ev.target.value]?.name ?? '' })}>
              <option value="">(chọn pattern từ PSD)</option>
              {list.map(([id, p]) => (
                <option key={id} value={id}>
                  {p.name} ({p.width}×{p.height})
                </option>
              ))}
            </select>
          </div>
        )
      }
      default:
        return null
    }
  }

  const renderSection = (d: FxDef, e: Fx, sec: Sect): React.JSX.Element => {
    const rows: React.JSX.Element[] = []
    let i = 0
    while (i < sec.fields.length) {
      const f = sec.fields[i]
      const inl: Field[] = []
      let j = i + 1
      while (j < sec.fields.length && sec.fields[j].inline) inl.push(sec.fields[j++])
      const main = renderField(d, e, f)
      if (main) {
        const extras = inl.map((x) => renderField(d, e, x)).filter(Boolean)
        if (extras.length) {
          rows.push(
            <div className="ps-row-group" key={f.key}>
              {main}
              {extras}
            </div>
          )
        } else rows.push(main)
      }
      i = j
    }
    return (
      <fieldset className="ps-group" key={sec.title}>
        <legend>{sec.title}</legend>
        {rows}
      </fieldset>
    )
  }

  return (
    <FloatingWindow id="layerStyle" title={<>Layer Style</>} defaultRect={{ x: Math.max(20, window.innerWidth - 980), y: 60, w: 940, h: 640 }} minW={760} minH={420} onClose={cancel}>
      <div className="ps-dialog">
        <div className="ps-styles">
          <div className="ps-styles-head">Styles</div>
          <div className={`ps-item ${active.kind === 'blending' ? 'active' : ''}`} onClick={() => setActive({ kind: 'blending', index: 0 })}>
            <span className="ps-item-pad" />
            <span className="ps-item-name">Blending Options</span>
          </div>
          {FX.map((d) => {
            const list = instancesOf(d)
            const rows = list.length ? list : [undefined]
            return rows.map((e, idx) => {
              const on = !!e && e.enabled !== false
              const isActive = active.kind === d.kind && active.index === idx
              return (
                <div key={`${d.kind}-${idx}`} className={`ps-item ${isActive ? 'active' : ''}`} onClick={() => setActive({ kind: d.kind, index: idx })}>
                  <input
                    type="checkbox"
                    checked={on}
                    onClick={(ev) => ev.stopPropagation()}
                    onChange={(ev) => {
                      if (ev.target.checked) writeEntry(d, idx, { ...(e ?? defaultsFor(d)), enabled: true })
                      else if (e) writeEntry(d, idx, { ...e, enabled: false })
                      setActive({ kind: d.kind, index: idx })
                    }}
                  />
                  <span className="ps-item-name">{d.label}</span>
                  {d.array && idx === 0 && (
                    <button
                      className="ps-plus"
                      title="Thêm một instance nữa (như Photoshop)"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        const base = e ?? defaultsFor(d)
                        writeInstances(d, [...list, { ...(JSON.parse(JSON.stringify(base)) as Fx), enabled: true }])
                        setActive({ kind: d.kind, index: list.length })
                      }}
                    >
                      +
                    </button>
                  )}
                  {d.array && list.length > 1 && (
                    <button
                      className="ps-plus"
                      title="Xoá instance này"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        writeEntry(d, idx, undefined)
                        setActive({ kind: d.kind, index: 0 })
                      }}
                    >
                      🗑
                    </button>
                  )}
                </div>
              )
            })
          })}
        </div>

        <div className="ps-settings">
          {active.kind === 'blending' ? (
            <>
              <div className="ps-title">Blending Options</div>
              <fieldset className="ps-group">
                <legend>General Blending</legend>
                <div className="ps-row">
                  <span className="ps-label">Blend Mode:</span>
                  <select className="ps-select" value={node.blendMode ?? 'normal'} onChange={(ev) => st.setNodeProps(node.id, { blendMode: ev.target.value as SceneNode['blendMode'] }, { history: false })}>
                    {['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'add'].map((m) => (
                      <option key={m} value={m}>
                        {cap(m)}
                      </option>
                    ))}
                  </select>
                </div>
                <PsSlider label="Opacity" value={Math.round(node.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => st.setNodeProps(node.id, { opacity: v / 100 }, { history: false })} />
              </fieldset>
              <fieldset className="ps-group">
                <legend>Advanced Blending</legend>
                <PsSlider label="Fill Opacity" value={Math.round(((node as ImageNode).fillOpacity ?? 1) * 100)} min={0} max={100} unit="%" onChange={(v) => applyFx(liveFx.current, { fillOpacity: v / 100 })} />
              </fieldset>
              <fieldset className="ps-group">
                <legend>Global Light</legend>
                <div className="ps-row">
                  <span className="ps-label">Angle:</span>
                  <span className="ps-angle">
                    <AngleDial value={globalLight?.angle ?? 120} onChange={setGlobalAngle} />
                    <input type="text" className="ps-num" value={Math.round(globalLight?.angle ?? 120)} onChange={(ev) => Number.isFinite(Number(ev.target.value)) && setGlobalAngle(Number(ev.target.value))} />
                    <span className="ps-unit">°</span>
                  </span>
                </div>
                <div className="hint">Dùng cho mọi style có bật "Use Global Light" (như Photoshop).</div>
              </fieldset>
            </>
          ) : activeDef ? (
            <>
              <div className="ps-title">{activeDef.label}</div>
              {!activeEntry || activeEntry.enabled === false ? (
                <div className="hint">
                  Style đang tắt.{' '}
                  <button className="mini" onClick={() => writeEntry(activeDef, active.index, { ...(activeEntry ?? defaultsFor(activeDef)), enabled: true })}>
                    Bật
                  </button>
                </div>
              ) : (
                <>
                  {activeDef.sections.map((sec) => renderSection(activeDef, activeEntry, sec))}
                  <div className="ps-defaults">
                    <button
                      onClick={() => {
                        const u = userDefaults()
                        u[activeDef.kind] = JSON.parse(JSON.stringify(activeEntry)) as Fx
                        localStorage.setItem(DEFAULTS_KEY, JSON.stringify(u))
                        st.setStatus(`Đã lưu ${activeDef.label} làm mặc định`)
                      }}
                    >
                      Make Default
                    </button>
                    <button onClick={() => writeEntry(activeDef, active.index, { ...defaultsFor(activeDef), enabled: true })}>Reset to Default</button>
                  </div>
                </>
              )}
            </>
          ) : null}
        </div>

        <div className="ps-actions">
          <button className="accent" onClick={ok}>
            OK
          </button>
          <button onClick={cancel}>Cancel</button>
          <button onClick={reset} title="Về trạng thái lúc mở hộp thoại">
            Reset
          </button>
          <label className="ps-check ps-preview">
            <input type="checkbox" checked={preview} onChange={(e) => togglePreview(e.target.checked)} /> Preview
          </label>
          <div className="ps-thumb">{thumb ? <img src={thumb} alt="" /> : <span className="dim small">{node.type}</span>}</div>
        </div>
      </div>
    </FloatingWindow>
  )
}

function PsSlider({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }): React.JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const sliderMax = label === 'Distance' ? Math.min(max, 250) : max
  return (
    <div className="ps-row">
      <span className="ps-label">{label}:</span>
      <span className="ps-slider">
        <input type="range" min={min} max={sliderMax} value={Math.min(value, sliderMax)} onChange={(e) => onChange(Number(e.target.value))} />
        <input
          type="text"
          className="ps-num"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const v = Number(text)
            if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)))
            else setText(String(value))
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="ps-unit">{unit}</span>
      </span>
    </div>
  )
}

/** Photoshop-style angle dial: drag inside the circle to set the angle (0 = right, 90 = up). */
function AngleDial({ value, onChange }: { value: number; onChange: (v: number) => void }): React.JSX.Element {
  const ref = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)
  const cb = useRef(onChange)
  cb.current = onChange
  const update = (e: { clientX: number; clientY: number; shiftKey?: boolean }): void => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    let a = Math.round((Math.atan2(-dy, dx) * 180) / Math.PI)
    if (e.shiftKey) a = Math.round(a / 15) * 15
    cb.current(a)
  }
  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (dragging.current) update(e)
    }
    const up = (): void => {
      dragging.current = false
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])
  const rad = (value * Math.PI) / 180
  const x = 16 + Math.cos(rad) * 12
  const y = 16 - Math.sin(rad) * 12
  return (
    <svg
      ref={ref}
      className="ps-dial"
      width="32"
      height="32"
      viewBox="0 0 32 32"
      onPointerDown={(e) => {
        dragging.current = true
        update(e)
      }}
    >
      <circle cx="16" cy="16" r="14" fill="#1b1b1b" stroke="#777" />
      <line x1="16" y1="16" x2={x} y2={y} stroke="#e4e4e4" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2" fill="#e4e4e4" />
    </svg>
  )
}

function ContourThumb({ curve }: { curve: { x: number; y: number }[] }): React.JSX.Element {
  const pts = curve.map((p) => `${(p.x / 255) * 28 + 2},${30 - (p.y / 255) * 28}`).join(' ')
  return (
    <svg className="ps-contour-thumb" width="32" height="32" viewBox="0 0 32 32">
      <rect x="1" y="1" width="30" height="30" fill="#1b1b1b" stroke="#777" />
      <polyline points={pts} fill="none" stroke="#e4e4e4" strokeWidth="1.5" />
    </svg>
  )
}
