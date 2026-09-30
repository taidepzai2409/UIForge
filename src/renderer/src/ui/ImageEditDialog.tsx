// Light image editing for image nodes: flip, rotate 90°, crop (numeric + canvas handles),
// and colour adjustments (Hue/Saturation, Brightness/Contrast, Levels) — non-destructive,
// stored in node.edits and re-rendered from the original pixels.
import { useEffect, useState } from 'react'
import type { AdjustmentLayer } from 'ag-psd'
import type { ImageEdits, ImageNode, NineSliceNode, SceneNode } from '@/model/types'
import { getCurrentPage, useEditor } from '@/store/editor'
import { getEntry } from '@/model/nodes'
import { scheduleRestyle } from '@/psd/restyle'
import { ensureSource } from './actions'
import { FloatingWindow } from './FloatingWindow'

type Img = ImageNode | NineSliceNode

export function ImageEditDialog(): React.JSX.Element | null {
  const [nodeId, setNodeId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ImageEdits | undefined>(undefined)
  const page = useEditor((s) => s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.pages[0])
  const assets = useEditor((s) => s.doc.assets)
  const st = useEditor.getState()

  useEffect(() => {
    const open = (): void => {
      const s = useEditor.getState()
      if (s.selection.length !== 1) return
      const n = getEntry(getCurrentPage(), s.selection[0])?.node
      if (!n || (n.type !== 'image' && n.type !== 'nineslice')) {
        s.setStatus('Chọn một ảnh để chỉnh')
        return
      }
      ensureSource(n.id)
      if (!(n as Img).originalAssetId) s.setNodeProps(n.id, { originalAssetId: (n as Img).sourceAssetId ?? n.assetId } as Partial<SceneNode>, { history: false })
      setSnapshot((n as Img).edits ? (JSON.parse(JSON.stringify((n as Img).edits)) as ImageEdits) : undefined)
      setNodeId(n.id)
    }
    window.addEventListener('dm:image-edit', open)
    return () => window.removeEventListener('dm:image-edit', open)
  }, [])

  if (!nodeId) return null
  const node = getEntry(page, nodeId)?.node as Img | undefined
  if (!node) return null
  const edits: ImageEdits = node.edits ?? {}
  const orig = assets[node.originalAssetId ?? node.sourceAssetId ?? node.assetId]
  const ow = orig?.width ?? node.width
  const oh = orig?.height ?? node.height

  const apply = (next: ImageEdits): void => {
    st.setImageEdits(node.id, Object.keys(next).length ? next : undefined)
    scheduleRestyle(node.id, 60)
  }
  const adjOf = (type: string): AdjustmentLayer | undefined => (edits.adjustments ?? []).find((a) => a.type === type)
  const setAdj = (adj: AdjustmentLayer | null, type: string): void => {
    const list = (edits.adjustments ?? []).filter((a) => a.type !== type)
    if (adj) list.push(adj)
    apply({ ...edits, adjustments: list.length ? list : undefined })
  }
  const hs = adjOf('hue/saturation') as (AdjustmentLayer & { type: 'hue/saturation' }) | undefined
  const bc = adjOf('brightness/contrast') as (AdjustmentLayer & { type: 'brightness/contrast' }) | undefined
  const lv = adjOf('levels') as (AdjustmentLayer & { type: 'levels' }) | undefined
  const hsv = { hue: hs?.master?.hue ?? 0, saturation: hs?.master?.saturation ?? 0, lightness: hs?.master?.lightness ?? 0 }
  const setHs = (patch: Partial<typeof hsv>): void => {
    const v = { ...hsv, ...patch }
    if (!v.hue && !v.saturation && !v.lightness) setAdj(null, 'hue/saturation')
    else setAdj({ type: 'hue/saturation', master: { a: 0, b: 0, c: 0, d: 0, ...v } }, 'hue/saturation')
  }
  const bcv = { brightness: bc?.brightness ?? 0, contrast: bc?.contrast ?? 0 }
  const setBc = (patch: Partial<typeof bcv>): void => {
    const v = { ...bcv, ...patch }
    if (!v.brightness && !v.contrast) setAdj(null, 'brightness/contrast')
    else setAdj({ type: 'brightness/contrast', ...v }, 'brightness/contrast')
  }
  const lvv = lv?.rgb ?? { shadowInput: 0, highlightInput: 255, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 }
  const setLv = (patch: Partial<typeof lvv>): void => {
    const v = { ...lvv, ...patch }
    if (v.shadowInput === 0 && v.highlightInput === 255 && v.shadowOutput === 0 && v.highlightOutput === 255 && Math.abs(v.midtoneInput - 1) < 0.001) setAdj(null, 'levels')
    else setAdj({ type: 'levels', rgb: v }, 'levels')
  }
  const crop = edits.crop ?? { x: 0, y: 0, width: ow, height: oh }
  const setCrop = (patch: Partial<typeof crop>): void => {
    const c = { ...crop, ...patch }
    c.x = Math.max(0, Math.min(ow - 1, Math.round(c.x)))
    c.y = Math.max(0, Math.min(oh - 1, Math.round(c.y)))
    c.width = Math.max(1, Math.min(ow - c.x, Math.round(c.width)))
    c.height = Math.max(1, Math.min(oh - c.y, Math.round(c.height)))
    const full = c.x === 0 && c.y === 0 && c.width === ow && c.height === oh
    apply({ ...edits, crop: full ? undefined : c })
  }
  const cancel = (): void => {
    st.setImageEdits(node.id, snapshot)
    scheduleRestyle(node.id, 0)
    setNodeId(null)
  }
  const ok = (): void => {
    const final = node.edits
    st.setImageEdits(node.id, snapshot)
    useEditor.getState().snapshot()
    st.setImageEdits(node.id, final)
    scheduleRestyle(node.id, 0)
    setNodeId(null)
  }

  return (
    <FloatingWindow
      id="imageEdit"
      title={<>Chỉnh ảnh · {node.name}</>}
      defaultRect={{ x: Math.max(20, window.innerWidth - 520), y: 80, w: 480, h: 560 }}
      minW={400}
      minH={360}
      onClose={cancel}
      footer={
        <>
          <span className="dim small" style={{ marginRight: 'auto' }}>
            Không phá huỷ: luôn tính lại từ ảnh gốc {ow}×{oh}
          </span>
          <button onClick={() => apply({})}>Reset</button>
          <button onClick={cancel}>Cancel</button>
          <button className="accent" onClick={ok}>
            OK
          </button>
        </>
      }
    >
      <div className="modal-body ie-body">
        <fieldset className="ps-group">
          <legend>Biến đổi</legend>
          <div className="ie-row">
            <button className={edits.flipH ? 'active' : ''} onClick={() => apply({ ...edits, flipH: !edits.flipH || undefined })}>
              Lật ngang
            </button>
            <button className={edits.flipV ? 'active' : ''} onClick={() => apply({ ...edits, flipV: !edits.flipV || undefined })}>
              Lật dọc
            </button>
            <button onClick={() => apply({ ...edits, rotate: (((edits.rotate ?? 0) + 270) % 360) as ImageEdits['rotate'] })}>↺ 90°</button>
            <button onClick={() => apply({ ...edits, rotate: (((edits.rotate ?? 0) + 90) % 360) as ImageEdits['rotate'] })}>↻ 90°</button>
            <span className="dim small">xoay: {edits.rotate ?? 0}°</span>
          </div>
        </fieldset>
        <fieldset className="ps-group">
          <legend>Crop (pixel ảnh gốc)</legend>
          <div className="row4">
            <label className="field num">
              <span className="field-label">X</span>
              <input type="number" value={crop.x} onChange={(e) => setCrop({ x: Number(e.target.value) })} />
            </label>
            <label className="field num">
              <span className="field-label">Y</span>
              <input type="number" value={crop.y} onChange={(e) => setCrop({ y: Number(e.target.value) })} />
            </label>
            <label className="field num">
              <span className="field-label">W</span>
              <input type="number" value={crop.width} onChange={(e) => setCrop({ width: Number(e.target.value) })} />
            </label>
            <label className="field num">
              <span className="field-label">H</span>
              <input type="number" value={crop.height} onChange={(e) => setCrop({ height: Number(e.target.value) })} />
            </label>
          </div>
          <div className="ie-row">
            <button onClick={() => window.dispatchEvent(new CustomEvent('dm:crop-mode', { detail: node.id }))}>Kéo khung crop trên canvas</button>
            <button onClick={() => apply({ ...edits, crop: undefined })}>Bỏ crop</button>
          </div>
        </fieldset>
        <fieldset className="ps-group">
          <legend>Hue / Saturation</legend>
          <Slider label="Hue" value={hsv.hue} min={-180} max={180} onChange={(v) => setHs({ hue: v })} />
          <Slider label="Saturation" value={hsv.saturation} min={-100} max={100} onChange={(v) => setHs({ saturation: v })} />
          <Slider label="Lightness" value={hsv.lightness} min={-100} max={100} onChange={(v) => setHs({ lightness: v })} />
        </fieldset>
        <fieldset className="ps-group">
          <legend>Brightness / Contrast</legend>
          <Slider label="Brightness" value={bcv.brightness} min={-150} max={150} onChange={(v) => setBc({ brightness: v })} />
          <Slider label="Contrast" value={bcv.contrast} min={-50} max={100} onChange={(v) => setBc({ contrast: v })} />
        </fieldset>
        <fieldset className="ps-group">
          <legend>Levels</legend>
          <Slider label="Shadows" value={lvv.shadowInput} min={0} max={253} onChange={(v) => setLv({ shadowInput: v })} />
          <Slider label="Midtones" value={Math.round(lvv.midtoneInput * 100) / 100} min={0.1} max={9.99} step={0.01} onChange={(v) => setLv({ midtoneInput: v })} />
          <Slider label="Highlights" value={lvv.highlightInput} min={2} max={255} onChange={(v) => setLv({ highlightInput: v })} />
        </fieldset>
      </div>
    </FloatingWindow>
  )
}

function Slider({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }): React.JSX.Element {
  return (
    <div className="ps-row">
      <span className="ps-label">{label}:</span>
      <span className="ps-slider">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <input type="number" className="ps-num" step={step} value={value} onChange={(e) => Number.isFinite(Number(e.target.value)) && onChange(Math.max(min, Math.min(max, Number(e.target.value))))} />
      </span>
    </div>
  )
}
