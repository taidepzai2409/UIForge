// Responsive preview: renders the selected frame as Unity would lay it out on several devices
// (CanvasScaler + anchors), draws the safe area and lists nodes that overflow it.
import { useEffect, useMemo, useState } from 'react'
import { getCurrentPage, useEditor } from '@/store/editor'
import { getEntry } from '@/model/nodes'
import type { FrameNode } from '@/model/types'
import { DEFAULT_PREVIEW_DEVICES, DEVICE_PRESETS, frameForSim, scalerOf, simulateFrame, type SimResult } from '@/model/simulate'
import { renderFrameToCanvas } from '@/canvas/render'
import { FloatingWindow } from './FloatingWindow'

interface Shot {
  sim: SimResult
  url: string
  w: number
  h: number
}

export function DevicePreview(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const doc = useEditor((s) => s.doc)
  const selection = useEditor((s) => s.selection)
  const chosen = doc.previewDevices ?? DEFAULT_PREVIEW_DEVICES
  const [shots, setShots] = useState<Shot[]>([])
  const [busy, setBusy] = useState(false)
  const st = useEditor.getState()

  useEffect(() => {
    const on = (): void => setOpen((o) => !o)
    window.addEventListener('dm:device-preview', on)
    return () => window.removeEventListener('dm:device-preview', on)
  }, [])

  const frame = useMemo(() => {
    const page = getCurrentPage()
    if (!selection.length) return page.children.find((c) => c.type === 'frame') as FrameNode | undefined
    let e = getEntry(page, selection[0])
    while (e?.parent) e = getEntry(page, e.parent.id)
    return e?.node.type === 'frame' ? (e.node as FrameNode) : undefined
  }, [doc, selection])

  useEffect(() => {
    if (!open || !frame) return
    let alive = true
    setBusy(true)
    ;(async () => {
      const page = getCurrentPage()
      const out: Shot[] = []
      for (const id of chosen) {
        const dev = DEVICE_PRESETS.find((d) => d.id === id)
        if (!dev) continue
        const sim = simulateFrame(frame, dev, scalerOf(doc))
        const f = frameForSim(frame, sim)
        const scale = Math.min(1, 520 / Math.max(sim.canvas.width, sim.canvas.height))
        try {
          const c = await renderFrameToCanvas(page, f, doc.assets, scale)
          // draw unsafe bands + issue boxes on top
          const g = c.getContext('2d')!
          g.fillStyle = 'rgba(255,0,0,0.18)'
          const s = sim.safe
          g.fillRect(0, 0, c.width, s.y * scale)
          g.fillRect(0, (s.y + s.height) * scale, c.width, c.height - (s.y + s.height) * scale)
          g.fillRect(0, 0, s.x * scale, c.height)
          g.fillRect((s.x + s.width) * scale, 0, c.width - (s.x + s.width) * scale, c.height)
          g.strokeStyle = '#ff3b30'
          g.lineWidth = 2
          for (const n of sim.nodes) if (n.issues.length && n.visible) g.strokeRect(n.rect.x * scale, n.rect.y * scale, n.rect.width * scale, n.rect.height * scale)
          out.push({ sim, url: c.toDataURL(), w: c.width, h: c.height })
        } catch (e) {
          console.warn('device preview failed', e)
        }
      }
      if (alive) {
        setShots(out)
        setBusy(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, frame, doc, chosen.join(',')])

  if (!open) return null
  const toggleDevice = (id: string): void => {
    const next = chosen.includes(id) ? chosen.filter((d) => d !== id) : [...chosen, id]
    st.update((d) => {
      d.previewDevices = next
    }, { history: false })
  }
  return (
    <FloatingWindow id="devicePreview" title={<>Xem trước thiết bị · {frame?.name ?? 'chọn một frame'}</>} defaultRect={{ x: 40, y: 60, w: 1100, h: 640 }} minW={600} minH={320} onClose={() => setOpen(false)}>
      <div className="dp-body">
        <div className="dp-toolbar">
          {DEVICE_PRESETS.filter((d) => d.id !== 'ref').map((d) => (
            <label key={d.id} className="ps-check">
              <input type="checkbox" checked={chosen.includes(d.id)} onChange={() => toggleDevice(d.id)} /> {d.name}
            </label>
          ))}
          <span className="tb-sep" />
          <label className="ps-check" title="Unity CanvasScaler (Scale With Screen Size). Expand: canvas không bao giờ nhỏ hơn thiết kế ở cả hai chiều → không gì đè nhau, chỉ thừa khoảng trống. Match width/height: co theo một chiều (có thể đè). Lưu vào project và xuất sang Unity.">
            Scaler
            <select
              value={`${scalerOf(doc).mode}:${scalerOf(doc).match}`}
              onChange={(e) => {
                const [mode, m] = e.target.value.split(':')
                st.update((d) => {
                  d.scaler = { mode: mode as 'expand' | 'shrink' | 'match', match: Number(m) }
                })
              }}
            >
              <option value="expand:0">Expand (không đè, khuyên dùng)</option>
              <option value="match:0">Match width</option>
              <option value="match:0.5">Match 0.5</option>
              <option value="match:1">Match height</option>
              <option value="shrink:0">Shrink (phủ kín, có thể cắt)</option>
            </select>
          </label>
          <span className="tb-sep" />
          <button
            className="accent"
            title="Nửa trên neo Top, nửa dưới neo Bottom, sát trái/phải neo Left/Right, ở giữa neo Center/Middle, nền full → stretch; node neo theo mép đi theo safe area. Chỉ đổi node chưa chỉnh anchor bằng tay (Ctrl+Alt+A)."
            onClick={() => frame && st.autoAnchor([frame.id])}
            disabled={!frame}
          >
            ⚓ Tự neo theo rule
          </button>
          <button title="Đổi cả node đã chỉnh anchor bằng tay" onClick={() => frame && st.autoAnchor([frame.id], { overwrite: true })} disabled={!frame}>
            ghi đè
          </button>
          {busy && <span className="dim">đang render...</span>}
        </div>
        <div className="dp-grid">
          {shots.map((s) => (
            <div key={s.sim.device.id} className="dp-card">
              <div className="dp-card-head">
                <b>{s.sim.device.name}</b>
                <span className="dim">
                  {s.sim.device.width}×{s.sim.device.height} · canvas {Math.round(s.sim.canvas.width)}×{Math.round(s.sim.canvas.height)} · scale {s.sim.scale.toFixed(2)}
                </span>
              </div>
              <img src={s.url} width={s.w} height={s.h} alt="" />
              {s.sim.issues.length ? (
                <ul className="dp-issues">
                  {s.sim.issues.slice(0, 8).map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                  {s.sim.issues.length > 8 && <li>… và {s.sim.issues.length - 8} lỗi khác</li>}
                </ul>
              ) : (
                <div className="dp-ok">Không có node nào tràn màn hình hay lấn vùng không an toàn.</div>
              )}
            </div>
          ))}
        </div>
        <div className="hint" style={{ padding: '4px 10px' }}>
          Vùng đỏ = ngoài safe area (tai thỏ, home bar). Node đỏ = có vấn đề. Sửa bằng cách đổi Anchor hoặc bật "Neo theo safe area" ở panel phải; kết quả cập nhật ngay.
        </div>
      </div>
    </FloatingWindow>
  )
}
