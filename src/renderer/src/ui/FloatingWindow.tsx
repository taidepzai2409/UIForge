import { useEffect, useRef, useState } from 'react'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Props {
  /** storage key for remembered position/size */
  id: string
  title: React.ReactNode
  defaultRect: Rect
  minW?: number
  minH?: number
  onClose: () => void
  footer?: React.ReactNode
  children: React.ReactNode
}

function load(id: string, def: Rect, minW: number, minH: number): Rect {
  try {
    const r = JSON.parse(localStorage.getItem(`uiforge.win.${id}`) ?? 'null') as Rect | null
    if (r && Number.isFinite(r.x) && Number.isFinite(r.w)) return clampToScreen({ ...r, w: Math.max(r.w, minW), h: Math.max(r.h, minH) })
  } catch {
    /* ignore */
  }
  return clampToScreen({ ...def, w: Math.max(def.w, minW), h: Math.max(def.h, minH) })
}

function clampToScreen(r: Rect): Rect {
  const W = window.innerWidth
  const H = window.innerHeight
  const w = Math.min(r.w, W - 20)
  const h = Math.min(r.h, H - 20)
  return { x: Math.max(0, Math.min(r.x, W - w)), y: Math.max(0, Math.min(r.y, H - h)), w, h }
}

/** Non-modal floating window: draggable title bar, resizable corner, remembered geometry. */
export function FloatingWindow({ id, title, defaultRect, minW = 360, minH = 240, onClose, footer, children }: Props): React.JSX.Element {
  const [rect, setRect] = useState<Rect>(() => load(id, defaultRect, minW, minH))
  const drag = useRef<{ kind: 'move' | 'resize'; sx: number; sy: number; start: Rect } | null>(null)

  useEffect(() => {
    localStorage.setItem(`uiforge.win.${id}`, JSON.stringify(rect))
  }, [id, rect])

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const d = drag.current
      if (!d) return
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      if (d.kind === 'move') setRect(clampToScreen({ ...d.start, x: d.start.x + dx, y: d.start.y + dy }))
      else setRect({ ...d.start, w: Math.max(minW, d.start.w + dx), h: Math.max(minH, d.start.h + dy) })
    }
    const up = (): void => {
      drag.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [minW, minH])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const inInput = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
      if (e.key === 'Escape' && !inInput) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  return (
    <div className="float-win" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} onPointerDown={(e) => e.stopPropagation()}>
      <div
        className="float-title"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          drag.current = { kind: 'move', sx: e.clientX, sy: e.clientY, start: rect }
        }}
        onDoubleClick={() => setRect(clampToScreen(defaultRect))}
        title="Kéo để di chuyển · double-click về vị trí mặc định"
      >
        <span className="float-title-text">{title}</span>
        <button className="mini" onClick={onClose} title="Đóng (Esc)">
          ✕
        </button>
      </div>
      <div className="float-body">{children}</div>
      {footer && <div className="float-footer">{footer}</div>}
      <div className="float-resize" onPointerDown={(e) => (drag.current = { kind: 'resize', sx: e.clientX, sy: e.clientY, start: rect })} title="Kéo để đổi kích thước" />
    </div>
  )
}
