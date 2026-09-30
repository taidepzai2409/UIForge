import { useEffect, useRef, useState } from 'react'
import { useEditor, type Tool } from '@/store/editor'
import { exportLayout, importPsdFiles, newProject, openProject, saveProject } from '@/store/project'
import { zoomBy, zoomTo, zoomToFitAll, zoomToSelection } from './zoom'
import { toggleNineSlice } from './actions'
import { Icon } from './icons'
import { useCurrentPage } from '@/store/editor'
import { getEntry } from '@/model/nodes'
import { COMMANDS, bindingsFor } from './commands'

const TOOLS: { id: Tool; label: string; icon: keyof typeof Icon; cmd: string }[] = [
  { id: 'select', label: 'Move', icon: 'move', cmd: 'tool.select' },
  { id: 'hand', label: 'Hand', icon: 'hand', cmd: 'tool.hand' },
  { id: 'frame', label: 'Frame', icon: 'frame', cmd: 'tool.frame' },
  { id: 'rect', label: 'Rectangle', icon: 'rect', cmd: 'tool.rect' },
  { id: 'text', label: 'Text', icon: 'text', cmd: 'tool.text' }
]

function keyOf(cmdId: string): string {
  const c = COMMANDS.find((x) => x.id === cmdId)
  return c ? bindingsFor(c)[0] ?? '' : ''
}

function FileMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])
  const item = (label: string, cmd: string, fn: () => void): React.JSX.Element => (
    <button
      className="menu-item"
      onClick={() => {
        setOpen(false)
        fn()
      }}
    >
      <span>{label}</span>
      <span className="key">{keyOf(cmd)}</span>
    </button>
  )
  return (
    <div className="file-menu" ref={ref}>
      <button className={`tb-btn ${open ? 'active' : ''}`} onClick={() => setOpen(!open)} title="Menu">
        <Icon.menu />
      </button>
      {open && (
        <div className="menu-pop">
          {item('New project', 'file.new', () => void newProject())}
          {item('Open project…', 'file.open', () => void openProject())}
          {item('Save', 'file.save', () => void saveProject())}
          {item('Save as…', 'file.saveAs', () => void saveProject(true))}
          <hr />
          {item('Import PSD…', 'file.importPsd', () => void importPsdFiles())}
          {item('Export layout for Unity', 'file.export', () => void exportLayout())}
          <hr />
          {item('Settings / Shortcuts', 'view.settings', () => window.dispatchEvent(new CustomEvent('dm:settings')))}
        </div>
      )}
    </div>
  )
}

export function TopBar(): React.JSX.Element {
  const tool = useEditor((s) => s.tool)
  const zoom = useEditor((s) => s.view.zoom)
  const dirty = useEditor((s) => s.dirty)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const docName = useEditor((s) => s.doc.name)
  const { setTool, undo, redo, setPresenting } = useEditor.getState()
  const page = useCurrentPage()
  const selection = useEditor((s) => s.selection)
  const editSlices = useEditor((s) => s.editSlices)
  const selNode = selection.length === 1 ? getEntry(page, selection[0])?.node : undefined
  const canSlice = selNode?.type === 'image' || selNode?.type === 'nineslice'
  const [zoomOpen, setZoomOpen] = useState(false)
  const gameName = useEditor((s) => s.doc.game?.name)
  return (
    <div className="topbar">
      <div className="tb-group">
        <FileMenu />
        <span className="tb-sep" />
        {TOOLS.map((t) => (
          <button key={t.id} className={`tb-btn ${tool === t.id ? 'active' : ''}`} onClick={() => setTool(t.id)} title={`${t.label} (${keyOf(t.cmd)})`}>
            {Icon[t.icon]()}
          </button>
        ))}
        <button className={`tb-btn ${editSlices ? 'active' : ''}`} disabled={!canSlice} onClick={toggleNineSlice} title={`9-slice (${keyOf('tool.nineSlice')})`}>
          <Icon.nineSlice />
        </button>
        <span className="tb-sep" />
        <button className="tb-btn" onClick={undo} disabled={!canUndo} title={`Undo (${keyOf('edit.undo')})`}>
          <Icon.undo />
        </button>
        <button className="tb-btn" onClick={redo} disabled={!canRedo} title={`Redo (${keyOf('edit.redo')})`}>
          <Icon.redo />
        </button>
      </div>
      <div className="tb-center">
        <span className="doc-name" title={docName}>
          {docName}
          {dirty ? <span className="dirty-dot" title="Chưa lưu (Ctrl+S)" /> : null}
        </span>
      </div>
      <div className="tb-group right">
        <button className="tb-btn" onClick={() => void importPsdFiles()} title={`Import PSD (${keyOf('file.importPsd')})`}>
          <Icon.image />
          <span className="tb-label">Import PSD</span>
        </button>
        <button className="tb-btn" onClick={() => void exportLayout()} title={`Export layout (${keyOf('file.export')})`}>
          <span className="tb-label">Export</span>
        </button>
        {gameName && (
          <button className="tb-btn" onClick={() => window.dispatchEvent(new CustomEvent('dm:game-sync'))} title={`Ghi art + thay đổi UI về game ${gameName} (${keyOf('game.sync')})`}>
            <span className="tb-label">Sync → Game</span>
          </button>
        )}
        <span className="tb-sep" />
        <div className="zoom-menu">
          <button className="tb-btn" onClick={() => setZoomOpen(!zoomOpen)} title="Zoom">
            <span className="tb-label">{Math.round(zoom * 100)}%</span>
            <Icon.chevron />
          </button>
          {zoomOpen && (
            <div className="menu-pop" onClick={() => setZoomOpen(false)}>
              <button className="menu-item" onClick={() => zoomBy(1.25)}>
                <span>Zoom in</span>
                <span className="key">{keyOf('view.zoomIn')}</span>
              </button>
              <button className="menu-item" onClick={() => zoomBy(0.8)}>
                <span>Zoom out</span>
                <span className="key">{keyOf('view.zoomOut')}</span>
              </button>
              <button className="menu-item" onClick={() => zoomTo(1)}>
                <span>Zoom to 100%</span>
                <span className="key">{keyOf('view.zoom100')}</span>
              </button>
              <button className="menu-item" onClick={zoomToFitAll}>
                <span>Zoom to fit</span>
                <span className="key">{keyOf('view.fitAll')}</span>
              </button>
              <button className="menu-item" onClick={zoomToSelection}>
                <span>Zoom to selection</span>
                <span className="key">{keyOf('view.fitSelection')}</span>
              </button>
            </div>
          )}
        </div>
        <button className="tb-btn primary" onClick={() => setPresenting(true)} title={`Present (${keyOf('view.present')})`}>
          <Icon.play />
        </button>
        <button className="tb-btn" onClick={() => window.dispatchEvent(new CustomEvent('dm:settings'))} title="Settings">
          <Icon.gear />
        </button>
      </div>
    </div>
  )
}

export function StatusBar(): React.JSX.Element {
  const status = useEditor((s) => s.status)
  const sel = useEditor((s) => s.selection.length)
  const dir = useEditor((s) => s.projectDir)
  const scope = useEditor((s) => s.scopeId)
  return (
    <div className="statusbar">
      <span>{status}</span>
      <span className="spacer" />
      {scope && <span>Inside container · Esc to exit</span>}
      <span>{sel ? `${sel} selected` : ''}</span>
      <span className="dim">{dir ?? 'Unsaved project'}</span>
    </div>
  )
}
