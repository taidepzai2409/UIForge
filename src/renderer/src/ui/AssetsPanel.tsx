import { useEffect, useState } from 'react'
import { useEditor } from '@/store/editor'
import { findMaster } from '@/model/instances'
import { getEntry } from '@/model/nodes'
import { renderFrameToCanvas } from '@/canvas/render'
import { Icon } from './icons'
import type { FrameNode } from '@/model/types'

/** Left-panel "Assets" tab: component masters with thumbnails; click = insert an instance. */
export function AssetsPanel(): React.JSX.Element {
  const doc = useEditor((s) => s.doc)
  const components = doc.components ?? {}
  const st = useEditor.getState()
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    ;(async () => {
      const out: Record<string, string> = {}
      for (const id of Object.keys(components)) {
        const m = findMaster(doc, id)
        if (!m || m.node.type === 'instance') continue
        try {
          const f: FrameNode = { ...(m.node as FrameNode), type: 'frame', fill: { color: { r: 0, g: 0, b: 0, a: 0 }, visible: false }, clipsContent: false, x: 0, y: 0 }
          const c = await renderFrameToCanvas(m.page, f, doc.assets, Math.min(1, 120 / Math.max(m.node.width, m.node.height)))
          out[id] = c.toDataURL()
        } catch {
          /* ignore */
        }
      }
      if (alive) setThumbs(out)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc])

  const insert = (id: string): void => {
    const s = useEditor.getState()
    const page = s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.pages[0]
    // into the selected top-level frame (or the frame of the selection), else page root
    let parentId: string | null = null
    let x = 100
    let y = 100
    if (s.selection.length) {
      const e = getEntry(page, s.selection[0])
      let top = e
      while (top?.parent) top = getEntry(page, top.parent.id)
      if (top?.node.type === 'frame') {
        parentId = top.node.id
        x = Math.round(top.node.width / 2 - 50)
        y = Math.round(top.node.height / 2 - 50)
      }
    } else {
      const f = page.children.find((c) => c.type === 'frame')
      if (f) {
        parentId = f.id
        x = Math.round(f.width / 2 - 50)
        y = Math.round(f.height / 2 - 50)
      }
    }
    st.createInstanceOf(id, parentId, x, y)
  }

  const ids = Object.keys(components)
  return (
    <div className="assets">
      <div className="panel-title">
        <span>Components</span>
        <span className="dim">{ids.length}</span>
      </div>
      {ids.length === 0 && (
        <div className="empty-hint">
          Chưa có component. Chọn một group/frame rồi bấm <b>Create component</b> (Ctrl+Alt+K). Instance tạo từ đây sẽ cập nhật theo master.
        </div>
      )}
      <div className="assets-grid">
        {ids.map((id) => {
          const m = findMaster(doc, id)
          if (!m) return null
          const name = components[id].name
          return (
            <div key={id} className="asset-card" title="Click: chèn instance · Double-click: tới master">
              <div className="asset-thumb" onClick={() => insert(id)} onDoubleClick={() => st.select([id])}>
                {thumbs[id] ? <img src={thumbs[id]} alt="" /> : <Icon.component />}
              </div>
              <div className="asset-name">
                <Icon.component />
                <span>{name}</span>
              </div>
              <div className="asset-actions">
                <button className="mini" onClick={() => insert(id)} title="Chèn instance">
                  <Icon.plus />
                </button>
                <button className="mini" onClick={() => st.select([id])} title="Tới master">
                  →
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
