import { useState } from 'react'
import { useEditor } from '@/store/editor'

export function PagesPanel(): React.JSX.Element {
  const pages = useEditor((s) => s.doc.pages)
  const pageId = useEditor((s) => s.pageId)
  const { setPage, addPage, renamePage, deletePage } = useEditor.getState()
  const [editing, setEditing] = useState<string | null>(null)
  const [text, setText] = useState('')
  return (
    <div className="pages">
      <div className="panel-title">
        <span>Pages</span>
        <button className="mini" onClick={addPage} title="Add page">
          +
        </button>
      </div>
      {pages.map((p) => (
        <div
          key={p.id}
          className={`page-row ${p.id === pageId ? 'active' : ''}`}
          onClick={() => setPage(p.id)}
          onDoubleClick={() => {
            setEditing(p.id)
            setText(p.name)
          }}
        >
          {editing === p.id ? (
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                if (text.trim()) renamePage(p.id, text.trim())
                setEditing(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span className="name">{p.name}</span>
          )}
          {pages.length > 1 && (
            <button
              className="mini danger"
              title="Delete page"
              onClick={(e) => {
                e.stopPropagation()
                if (confirm(`Xoá page "${p.name}"?`)) deletePage(p.id)
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
