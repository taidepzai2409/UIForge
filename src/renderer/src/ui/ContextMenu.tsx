import { useEffect, useState } from 'react'
import { useCurrentPage, useEditor } from '@/store/editor'
import { getEntry } from '@/model/nodes'
import { isContainer } from '@/model/types'
import { resetImageSize, toggleNineSlice } from './actions'
import { zoomToSelection } from './shortcuts'
import { pickAndReplaceNode } from '@/store/game'

interface Pos {
  x: number
  y: number
}

export function ContextMenu(): React.JSX.Element | null {
  const [pos, setPos] = useState<Pos | null>(null)
  const page = useCurrentPage()
  const selection = useEditor((s) => s.selection)
  const mode = useEditor((s) => s.mode)
  const st = useEditor.getState()

  useEffect(() => {
    const open = (e: Event): void => {
      const d = (e as CustomEvent<Pos>).detail
      setPos({ x: Math.min(d.x, window.innerWidth - 240), y: Math.min(d.y, window.innerHeight - 320) })
    }
    const close = (): void => setPos(null)
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPos(null)
    }
    window.addEventListener('dm:contextmenu', open)
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('dm:contextmenu', open)
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', key)
    }
  }, [])

  if (!pos) return null
  const single = selection.length === 1 ? getEntry(page, selection[0]) : undefined
  const n = single?.node
  const isImg = n?.type === 'image' || n?.type === 'nineslice'
  const isTopFrame = n?.type === 'frame' && !single?.parent
  const run = (fn: () => void) => (e: React.MouseEvent): void => {
    e.stopPropagation()
    setPos(null)
    fn()
  }
  const Item = ({ label, keys, onClick, disabled }: { label: string; keys?: string; onClick: () => void; disabled?: boolean }): React.JSX.Element => (
    <button disabled={disabled} onPointerDown={(e) => e.stopPropagation()} onClick={run(onClick)}>
      <span>{label}</span>
      {keys && <span className="key">{keys}</span>}
    </button>
  )
  return (
    <div className="ctx-menu" style={{ left: pos.x, top: pos.y }} onPointerDown={(e) => e.stopPropagation()}>
      <Item label={n?.type === 'nineslice' ? 'Chỉnh 9-slice' : 'Chuyển thành 9-Slice'} keys="N" disabled={!isImg} onClick={toggleNineSlice} />
      {n?.type === 'nineslice' && <Item label="Đổi về ảnh thường" onClick={() => st.convertToImage(n.id)} />}
      <Item label="Thay ảnh…" disabled={!n || !['image', 'nineslice', 'rect', 'text'].includes(n.type)} onClick={() => n && void pickAndReplaceNode(n.id).catch((e) => useEditor.getState().setStatus(String((e as Error)?.message ?? e)))} />
      <Item label="Reset về kích thước ảnh gốc" disabled={!isImg} onClick={resetImageSize} />
      <Item label="Chỉnh ảnh (crop / lật / màu)…" keys="Ctrl+Shift+U" disabled={!isImg} onClick={() => window.dispatchEvent(new CustomEvent('dm:image-edit'))} />
      <Item label="Layer Style…" keys="Ctrl+Shift+L" disabled={!n || !['image', 'nineslice', 'text', 'group'].includes(n.type)} onClick={() => window.dispatchEvent(new CustomEvent('dm:layer-style'))} />
      <hr />
      <Item label={n && (n as { component?: unknown }).component ? 'Đã là component' : 'Create component'} keys="Ctrl+Alt+K" disabled={!n || n.type === 'instance' || !!(n as { component?: unknown }).component} onClick={st.createComponent} />
      {n?.type === 'instance' && <Item label="Detach instance" keys="Ctrl+Alt+B" onClick={() => st.detachInstance(n.id)} />}
      {n?.type === 'instance' && <Item label="Tới master" onClick={() => st.select([n.componentId])} />}
      <Item label="Tự neo anchor theo rule" keys="Ctrl+Alt+A" onClick={() => st.autoAnchor()} />
      <Item label="Xem trước thiết bị / safe area" keys="Shift+D" onClick={() => window.dispatchEvent(new CustomEvent('dm:device-preview'))} />
      <hr />
      <Item label="Group" keys="Ctrl+G" disabled={!selection.length} onClick={st.groupSelection} />
      <Item label="Ungroup" keys="Ctrl+Shift+G" disabled={!n || n.type !== 'group'} onClick={st.ungroupSelection} />
      <Item label="Vào trong (chọn con)" keys="Enter" disabled={!n || !isContainer(n) || !n.children.length} onClick={() => {
        if (n && isContainer(n) && n.children.length) {
          st.setScope(n.id)
          st.select([n.children[n.children.length - 1].id])
        }
      }} />
      <hr />
      <Item label="Nhân bản" keys="Ctrl+D" disabled={!selection.length} onClick={st.duplicateSelection} />
      <Item label="Đưa lên trên cùng" keys="Ctrl+Shift+]" disabled={!selection.length} onClick={() => st.reorderSelection('front')} />
      <Item label="Đưa xuống dưới cùng" keys="Ctrl+Shift+[" disabled={!selection.length} onClick={() => st.reorderSelection('back')} />
      <Item label={n && !n.visible ? 'Hiện' : 'Ẩn'} keys="Ctrl+Shift+H" disabled={!selection.length} onClick={() => selection.forEach((id) => st.toggleVisible(id))} />
      <Item label={n?.locked ? 'Mở khoá' : 'Khoá'} keys="Ctrl+Shift+L" disabled={!selection.length} onClick={() => selection.forEach((id) => st.toggleLocked(id))} />
      <Item label="Zoom tới" keys="Shift+2" disabled={!selection.length} onClick={zoomToSelection} />
      <hr />
      {isTopFrame && <Item label={page.startFrameId === n?.id ? 'Bỏ Flow start' : 'Đặt làm Flow start'} onClick={() => st.setStartFrame(page.startFrameId === n?.id ? undefined : n?.id)} />}
      {mode === 'design' ? <Item label="Sang chế độ Prototype (kéo flow)" keys="P" onClick={() => st.setMode('prototype')} /> : <Item label="Về chế độ Design" keys="P" onClick={() => st.setMode('design')} />}
      <Item label="Xoá" keys="Del" disabled={!selection.length} onClick={st.deleteSelection} />
    </div>
  )
}
