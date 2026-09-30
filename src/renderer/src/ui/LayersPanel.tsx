import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { NodeId, SceneNode } from '@/model/types'
import { isContainer } from '@/model/types'
import { ancestorsOf, getEntry } from '@/model/nodes'
import { useCurrentPage, useEditor } from '@/store/editor'
import { useHover } from '@/store/hover'
import { Icon } from './icons'

const ROW_H = 26

interface Row {
  node: SceneNode
  depth: number
  parentId: NodeId | null
  index: number
  hasChildren: boolean
}

type DropPos = 'before' | 'after' | 'inside'

function hasFx(n: SceneNode): boolean {
  const fx = (n as { effects?: Record<string, unknown> }).effects
  if (!fx) return false
  return Object.values(fx).some((v) => {
    const e = Array.isArray(v) ? v[0] : v
    return e && typeof e === 'object' && (e as { enabled?: boolean }).enabled === true
  })
}

function TypeIcon({ type, master }: { type: SceneNode['type']; master?: boolean }): React.JSX.Element {
  if (master) return <Icon.component />
  switch (type) {
    case 'frame':
      return <Icon.frame />
    case 'group':
      return <Icon.group />
    case 'image':
      return <Icon.image />
    case 'nineslice':
      return <Icon.nineSlice />
    case 'rect':
      return <Icon.rect />
    case 'text':
      return <Icon.text />
    case 'instance':
      return <Icon.instance />
  }
}

interface RowProps {
  row: Row
  selected: boolean
  collapsed: boolean
  editing: boolean
  drop: DropPos | null
  top: number
  onClick: (e: React.MouseEvent, r: Row) => void
  onToggle: (id: NodeId) => void
  onRename: (id: NodeId, name: string | null) => void
  onDragStart: (id: NodeId) => void
  onDragOver: (e: React.DragEvent, r: Row) => void
  onDrop: (e: React.DragEvent, r: Row) => void
  onStartEdit: (id: NodeId) => void
}

const LayerRow = memo(function LayerRow(p: RowProps): React.JSX.Element {
  const n = p.row.node
  const hovered = useHover((s) => s.hoverId === n.id)
  const setHover = useHover((s) => s.setHover)
  const { toggleVisible, toggleLocked, select } = useEditor.getState()
  const [text, setText] = useState(n.name)
  useEffect(() => {
    if (p.editing) setText(n.name)
  }, [p.editing, n.name])
  const cls = ['layer-row']
  if (p.selected) cls.push('selected')
  if (hovered) cls.push('hover')
  if (!n.visible) cls.push('hidden')
  if (p.drop) cls.push(`drop-${p.drop}`)
  return (
    <div
      data-id={n.id}
      className={cls.join(' ')}
      style={{ top: p.top, paddingLeft: 8 + p.row.depth * 16 }}
      onClick={(e) => p.onClick(e, p.row)}
      onMouseEnter={() => setHover(n.id)}
      onMouseLeave={() => setHover(null)}
      onDoubleClick={() => p.onStartEdit(n.id)}
      draggable={!p.editing}
      onDragStart={(e) => {
        p.onDragStart(n.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => p.onDragOver(e, p.row)}
      onDrop={(e) => p.onDrop(e, p.row)}
    >
      <span
        className={`caret ${p.row.hasChildren ? '' : 'empty'} ${p.collapsed ? '' : 'open'}`}
        onClick={(e) => {
          e.stopPropagation()
          if (p.row.hasChildren) p.onToggle(n.id)
        }}
      >
        {p.row.hasChildren ? <Icon.chevron /> : null}
      </span>
      <span className={`type-icon t-${n.type} ${(n as { component?: unknown }).component ? 't-master' : ''}`}>
        <TypeIcon type={n.type} master={!!(n as { component?: unknown }).component} />
      </span>
      {p.editing ? (
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => p.onRename(n.id, text.trim() || null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') p.onRename(n.id, null)
            e.stopPropagation()
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="name" title={n.name}>
          {n.name}
        </span>
      )}
      {hasFx(n) && (
        <span
          className="fx-badge"
          title="Layer style — double-click để chỉnh"
          onDoubleClick={(e) => {
            e.stopPropagation()
            select([n.id])
            window.dispatchEvent(new CustomEvent('dm:layer-style'))
          }}
        >
          fx
        </span>
      )}
      <span className="row-actions">
        <button
          className={`mini ${n.locked ? 'on' : ''}`}
          title={n.locked ? 'Unlock' : 'Lock'}
          onClick={(e) => {
            e.stopPropagation()
            toggleLocked(n.id)
          }}
        >
          {n.locked ? <Icon.lock /> : <Icon.unlock />}
        </button>
        <button
          className={`mini ${n.visible ? '' : 'on'}`}
          title={n.visible ? 'Hide' : 'Show'}
          onClick={(e) => {
            e.stopPropagation()
            toggleVisible(n.id)
          }}
        >
          {n.visible ? <Icon.eye /> : <Icon.eyeOff />}
        </button>
      </span>
    </div>
  )
})

export function LayersPanel(): React.JSX.Element {
  const page = useCurrentPage()
  const selection = useEditor((s) => s.selection)
  const { select, renameNode, reparent, setScope } = useEditor.getState()
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(new Set())
  const [editing, setEditing] = useState<NodeId | null>(null)
  const [drop, setDrop] = useState<{ id: NodeId; pos: DropPos } | null>(null)
  const [query, setQuery] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const dragId = useRef<NodeId | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = (n: SceneNode): boolean => {
      if (!q) return true
      if (n.name.toLowerCase().includes(q)) return true
      return isContainer(n) && n.children.some(matches)
    }
    const out: Row[] = []
    const build = (nodes: SceneNode[], depth: number, parentId: NodeId | null): void => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        if (!matches(n)) continue
        const hasChildren = isContainer(n) && n.children.length > 0
        out.push({ node: n, depth, parentId, index: i, hasChildren })
        if (hasChildren && (q || !collapsed.has(n.id))) build((n as { children: SceneNode[] }).children, depth + 1, n.id)
      }
    }
    build(page.children, 0, null)
    return out
  }, [page, collapsed, query])

  // expand ancestors of the selection and scroll it into view
  useEffect(() => {
    if (!selection.length) return
    const anc = ancestorsOf(page, selection[0]).map((a) => a.id)
    if (anc.some((id) => collapsed.has(id))) {
      const next = new Set(collapsed)
      anc.forEach((id) => next.delete(id))
      setCollapsed(next)
      return
    }
    const idx = rows.findIndex((r) => r.node.id === selection[0])
    const el = listRef.current
    if (idx >= 0 && el) {
      const y = idx * ROW_H
      if (y < el.scrollTop || y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, y - el.clientHeight / 2)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  useEffect(() => {
    const h = (e: Event): void => {
      const id = (e as CustomEvent<NodeId>).detail
      if (getEntry(page, id)) setEditing(id)
    }
    window.addEventListener('dm:rename', h)
    return () => window.removeEventListener('dm:rename', h)
  }, [page])

  const onToggle = (id: NodeId): void => {
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const onClick = (e: React.MouseEvent, r: Row): void => {
    if (e.shiftKey) select([r.node.id], { toggle: true })
    else select([r.node.id])
    setScope(r.parentId)
  }
  const onRename = (id: NodeId, name: string | null): void => {
    if (name) renameNode(id, name)
    setEditing(null)
  }
  const onDragOver = (e: React.DragEvent, r: Row): void => {
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = (e.clientY - rect.top) / rect.height
    let pos: DropPos
    if (isContainer(r.node) && y > 0.3 && y < 0.7) pos = 'inside'
    else pos = y < 0.5 ? 'before' : 'after'
    setDrop((d) => (d && d.id === r.node.id && d.pos === pos ? d : { id: r.node.id, pos }))
  }
  const onDrop = (e: React.DragEvent, r: Row): void => {
    e.preventDefault()
    const id = dragId.current
    dragId.current = null
    const d = drop
    setDrop(null)
    if (!id || id === r.node.id || !d) return
    if (d.pos === 'inside') reparent(id, r.node.id, (r.node as { children: SceneNode[] }).children.length)
    else if (d.pos === 'before') reparent(id, r.parentId, r.index + 1)
    else reparent(id, r.parentId, r.index)
  }

  const selectedSet = useMemo(() => new Set(selection), [selection])
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5)
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 5)

  return (
    <div className="layers">
      <div className="panel-title">
        <span>Layers</span>
        <span className="dim">{rows.length}</span>
      </div>
      <div className="layer-search">
        <input type="text" placeholder="Search layers" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
      </div>
      <div className="layer-list" ref={listRef} onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)} onDragLeave={() => setDrop(null)}>
        <div className="layer-spacer" style={{ height: rows.length * ROW_H }}>
          {rows.slice(first, last).map((r, i) => (
            <LayerRow
              key={r.node.id}
              row={r}
              top={(first + i) * ROW_H}
              selected={selectedSet.has(r.node.id)}
              collapsed={collapsed.has(r.node.id)}
              editing={editing === r.node.id}
              drop={drop?.id === r.node.id ? drop.pos : null}
              onClick={onClick}
              onToggle={onToggle}
              onRename={onRename}
              onDragStart={(id) => (dragId.current = id)}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onStartEdit={setEditing}
            />
          ))}
        </div>
        {rows.length === 0 && <div className="empty-hint">Chưa có gì. Import PSD (Ctrl+Shift+I) hoặc vẽ Frame (F).</div>}
      </div>
    </div>
  )
}
