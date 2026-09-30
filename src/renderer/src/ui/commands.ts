// Command registry + user-configurable key bindings.
// A binding is a string like "Ctrl+Shift+E", "Alt+A", "F5", "Delete", "Shift+1".
import { getCurrentPage, useEditor } from '@/store/editor'
import { exportLayout, importPsdFiles, newProject, openProject, saveProject } from '@/store/project'
import { getEntry } from '@/model/nodes'
import { isContainer } from '@/model/types'
import { alignSelection, copySelection, cutSelection, pasteClipboard, requestRename, toggleNineSlice } from './actions'
import { zoomBy, zoomTo, zoomToFitAll, zoomToSelection } from './zoom'

export interface Command {
  id: string
  label: string
  group: string
  defaultKeys: string[]
  /** allowed while typing in an input (file commands) */
  global?: boolean
  run: () => void
}

const KEYS_STORAGE = 'uiforge.keybindings'

let overrides: Record<string, string[]> = {}
try {
  overrides = JSON.parse(localStorage.getItem(KEYS_STORAGE) ?? '{}') as Record<string, string[]>
} catch {
  overrides = {}
}

const listeners = new Set<() => void>()
export function onBindingsChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function bindingsFor(cmd: Command): string[] {
  return overrides[cmd.id] ?? cmd.defaultKeys
}

export function setBindings(id: string, keys: string[] | null): void {
  if (keys === null) delete overrides[id]
  else overrides[id] = keys
  localStorage.setItem(KEYS_STORAGE, JSON.stringify(overrides))
  listeners.forEach((l) => l())
}

export function resetAllBindings(): void {
  overrides = {}
  localStorage.removeItem(KEYS_STORAGE)
  listeners.forEach((l) => l())
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Esc',
  delete: 'Delete',
  backspace: 'Backspace',
  enter: 'Enter',
  '=': '=',
  '+': '+',
  '-': '-'
}

/** Normalizes a KeyboardEvent to a binding string (uses e.code for letters/digits so Shift+1 stays "Shift+1"). */
export function eventToBinding(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let key: string
  const code = e.code
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^F[0-9]{1,2}$/.test(code)) key = code
  else if (code === 'BracketLeft') key = '['
  else if (code === 'BracketRight') key = ']'
  else if (code === 'Equal') key = '='
  else if (code === 'Minus') key = '-'
  else if (code === 'Comma') key = ','
  else if (code === 'Period') key = '.'
  else if (code === 'Slash') key = '/'
  else if (code === 'Backquote') key = '`'
  else key = KEY_NAMES[e.key.toLowerCase()] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return parts.join('+')
  parts.push(key)
  return parts.join('+')
}

export function isModifierOnly(binding: string): boolean {
  return /^(Ctrl|Alt|Shift)(\+(Ctrl|Alt|Shift))*$/.test(binding) || binding === ''
}

function s(): ReturnType<typeof useEditor.getState> {
  return useEditor.getState()
}

export const COMMANDS: Command[] = [
  // ---- file
  { id: 'file.new', label: 'New project', group: 'File', defaultKeys: ['Ctrl+N'], global: true, run: () => void newProject() },
  { id: 'file.open', label: 'Open project', group: 'File', defaultKeys: ['Ctrl+O'], global: true, run: () => void openProject() },
  { id: 'file.save', label: 'Save', group: 'File', defaultKeys: ['Ctrl+S'], global: true, run: () => void saveProject() },
  { id: 'file.saveAs', label: 'Save as', group: 'File', defaultKeys: ['Ctrl+Shift+S'], global: true, run: () => void saveProject(true) },
  { id: 'file.importPsd', label: 'Import PSD', group: 'File', defaultKeys: ['Ctrl+Shift+I'], global: true, run: () => void importPsdFiles() },
  { id: 'file.export', label: 'Export layout', group: 'File', defaultKeys: ['Ctrl+Shift+E'], global: true, run: () => void exportLayout() },
  { id: 'game.sync', label: 'Sync → Game (ghi art + thay đổi về game)', group: 'File', defaultKeys: ['Ctrl+Alt+S'], global: true, run: () => window.dispatchEvent(new CustomEvent('dm:game-sync')) },
  { id: 'view.present', label: 'Present / stop', group: 'View', defaultKeys: ['F5'], global: true, run: () => s().setPresenting(!s().presenting) },
  { id: 'view.settings', label: 'Settings (shortcuts)', group: 'View', defaultKeys: ['Ctrl+,'], global: true, run: () => window.dispatchEvent(new CustomEvent('dm:settings')) },
  // ---- tools
  { id: 'tool.select', label: 'Select tool', group: 'Tools', defaultKeys: ['V'], run: () => s().setTool('select') },
  { id: 'tool.hand', label: 'Hand tool', group: 'Tools', defaultKeys: ['H'], run: () => s().setTool('hand') },
  { id: 'tool.frame', label: 'Frame tool', group: 'Tools', defaultKeys: ['F'], run: () => s().setTool('frame') },
  { id: 'tool.rect', label: 'Rectangle tool', group: 'Tools', defaultKeys: ['R'], run: () => s().setTool('rect') },
  { id: 'tool.text', label: 'Text tool', group: 'Tools', defaultKeys: ['T'], run: () => s().setTool('text') },
  { id: 'tool.nineSlice', label: '9-slice / edit slices', group: 'Tools', defaultKeys: ['N'], run: toggleNineSlice },
  { id: 'tool.layerStyle', label: 'Layer Style…', group: 'Tools', defaultKeys: ['Ctrl+Shift+L'], run: () => window.dispatchEvent(new CustomEvent('dm:layer-style')) },
  { id: 'component.create', label: 'Create component', group: 'Tools', defaultKeys: ['Ctrl+Alt+K'], run: () => s().createComponent() },
  { id: 'component.detach', label: 'Detach instance', group: 'Tools', defaultKeys: ['Ctrl+Alt+B'], run: () => s().selection.forEach((id) => s().detachInstance(id)) },
  { id: 'layout.toggle', label: 'Auto layout on/off', group: 'Tools', defaultKeys: ['Shift+A'], run: () => {
      const st = s()
      const page = getCurrentPage()
      for (const id of st.selection) {
        const n = getEntry(page, id)?.node
        if (!n || (n.type !== 'frame' && n.type !== 'group')) continue
        st.setLayout(id, n.layout ? undefined : { direction: n.width >= n.height ? 'horizontal' : 'vertical', gap: 8, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: 'start', hug: true })
      }
    } },
  { id: 'image.edit', label: 'Chỉnh ảnh (crop / lật / màu)…', group: 'Tools', defaultKeys: ['Ctrl+Shift+U'], run: () => window.dispatchEvent(new CustomEvent('dm:image-edit')) },
  { id: 'frame.autoAnchor', label: 'Tự neo anchor theo rule (frame đang chọn)', group: 'Tools', defaultKeys: ['Ctrl+Alt+A'], run: () => s().autoAnchor() },
  { id: 'frame.autoAnchorAll', label: 'Tự neo anchor theo rule, ghi đè anchor chỉnh tay', group: 'Tools', defaultKeys: [], run: () => s().autoAnchor(undefined, { overwrite: true }) },
  { id: 'view.devicePreview', label: 'Xem trước thiết bị / safe area', group: 'View', defaultKeys: ['Shift+D'], run: () => window.dispatchEvent(new CustomEvent('dm:device-preview')) },
  { id: 'mode.toggle', label: 'Design / Prototype', group: 'Tools', defaultKeys: ['P'], run: () => s().setMode(s().mode === 'design' ? 'prototype' : 'design') },
  // ---- edit
  { id: 'edit.undo', label: 'Undo', group: 'Edit', defaultKeys: ['Ctrl+Z'], run: () => s().undo() },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', defaultKeys: ['Ctrl+Shift+Z', 'Ctrl+Y'], run: () => s().redo() },
  { id: 'edit.copy', label: 'Copy', group: 'Edit', defaultKeys: ['Ctrl+C'], run: () => copySelection() },
  { id: 'edit.cut', label: 'Cut', group: 'Edit', defaultKeys: ['Ctrl+X'], run: cutSelection },
  { id: 'edit.paste', label: 'Paste', group: 'Edit', defaultKeys: ['Ctrl+V'], run: () => void pasteClipboard() },
  { id: 'edit.duplicate', label: 'Duplicate', group: 'Edit', defaultKeys: ['Ctrl+D'], run: () => s().duplicateSelection() },
  { id: 'edit.delete', label: 'Delete', group: 'Edit', defaultKeys: ['Delete', 'Backspace'], run: () => {
      const st = s()
      if (st.selectedConnectionId) st.removeConnection(st.selectedConnectionId)
      else if (st.selection.length) st.deleteSelection()
      else window.dispatchEvent(new CustomEvent('dm:delete-guide'))
    } },
  { id: 'edit.group', label: 'Group', group: 'Edit', defaultKeys: ['Ctrl+G'], run: () => s().groupSelection() },
  { id: 'edit.ungroup', label: 'Ungroup', group: 'Edit', defaultKeys: ['Ctrl+Shift+G'], run: () => s().ungroupSelection() },
  { id: 'edit.selectAll', label: 'Select all (in scope)', group: 'Edit', defaultKeys: ['Ctrl+A'], run: () => {
      const st = s()
      const page = getCurrentPage()
      const scope = st.scopeId ? getEntry(page, st.scopeId)?.node : null
      const list = scope && isContainer(scope) ? scope.children : page.children
      st.select(list.filter((n) => n.visible && !n.locked).map((n) => n.id))
    } },
  { id: 'edit.rename', label: 'Rename layer', group: 'Edit', defaultKeys: ['F2'], run: requestRename },
  { id: 'edit.toggleVisible', label: 'Show / hide', group: 'Edit', defaultKeys: ['Ctrl+Shift+H'], run: () => s().selection.forEach((id) => s().toggleVisible(id)) },
  { id: 'edit.toggleLock', label: 'Lock / unlock', group: 'Edit', defaultKeys: ['Ctrl+Shift+K'], run: () => s().selection.forEach((id) => s().toggleLocked(id)) },
  { id: 'edit.escape', label: 'Escape (exit scope / clear)', group: 'Edit', defaultKeys: ['Esc'], run: () => {
      const st = s()
      if (st.editSlices) st.setEditSlices(false)
      else if (st.selectedConnectionId) st.setSelectedConnection(null)
      else if (st.selection.length) {
        const page = getCurrentPage()
        const parent = getEntry(page, st.selection[0])?.parent
        if (parent && st.scopeId) {
          const gp = getEntry(page, parent.id)?.parent
          st.setScope(gp ? gp.id : null)
          st.select([parent.id])
        } else {
          st.select([])
          st.setScope(null)
        }
      } else if (st.scopeId) st.setScope(null)
      else if (st.tool !== 'select') st.setTool('select')
    } },
  { id: 'edit.enter', label: 'Enter group (select child)', group: 'Edit', defaultKeys: ['Enter'], run: () => {
      const st = s()
      const page = getCurrentPage()
      if (st.selection.length !== 1) return
      const n = getEntry(page, st.selection[0])?.node
      if (n && isContainer(n) && n.children.length) {
        st.setScope(n.id)
        st.select([n.children[n.children.length - 1].id])
      }
    } },
  // ---- arrange
  { id: 'arrange.forward', label: 'Bring forward', group: 'Arrange', defaultKeys: ['Ctrl+]'], run: () => s().reorderSelection('forward') },
  { id: 'arrange.backward', label: 'Send backward', group: 'Arrange', defaultKeys: ['Ctrl+['], run: () => s().reorderSelection('backward') },
  { id: 'arrange.front', label: 'Bring to front', group: 'Arrange', defaultKeys: ['Ctrl+Shift+]'], run: () => s().reorderSelection('front') },
  { id: 'arrange.back', label: 'Send to back', group: 'Arrange', defaultKeys: ['Ctrl+Shift+['], run: () => s().reorderSelection('back') },
  { id: 'align.left', label: 'Align left', group: 'Arrange', defaultKeys: ['Alt+A'], run: () => alignSelection('left') },
  { id: 'align.hcenter', label: 'Align horizontal center', group: 'Arrange', defaultKeys: ['Alt+H'], run: () => alignSelection('hcenter') },
  { id: 'align.right', label: 'Align right', group: 'Arrange', defaultKeys: ['Alt+D'], run: () => alignSelection('right') },
  { id: 'align.top', label: 'Align top', group: 'Arrange', defaultKeys: ['Alt+W'], run: () => alignSelection('top') },
  { id: 'align.vcenter', label: 'Align vertical center', group: 'Arrange', defaultKeys: ['Alt+V'], run: () => alignSelection('vcenter') },
  { id: 'align.bottom', label: 'Align bottom', group: 'Arrange', defaultKeys: ['Alt+S'], run: () => alignSelection('bottom') },
  { id: 'align.distH', label: 'Distribute horizontally', group: 'Arrange', defaultKeys: ['Alt+Shift+H'], run: () => alignSelection('dist-h') },
  { id: 'align.distV', label: 'Distribute vertically', group: 'Arrange', defaultKeys: ['Alt+Shift+V'], run: () => alignSelection('dist-v') },
  { id: 'nudge.left', label: 'Nudge left', group: 'Arrange', defaultKeys: ['Left'], run: () => s().moveSelection(-1, 0) },
  { id: 'nudge.right', label: 'Nudge right', group: 'Arrange', defaultKeys: ['Right'], run: () => s().moveSelection(1, 0) },
  { id: 'nudge.up', label: 'Nudge up', group: 'Arrange', defaultKeys: ['Up'], run: () => s().moveSelection(0, -1) },
  { id: 'nudge.down', label: 'Nudge down', group: 'Arrange', defaultKeys: ['Down'], run: () => s().moveSelection(0, 1) },
  { id: 'nudge.left10', label: 'Nudge left 10px', group: 'Arrange', defaultKeys: ['Shift+Left'], run: () => s().moveSelection(-10, 0) },
  { id: 'nudge.right10', label: 'Nudge right 10px', group: 'Arrange', defaultKeys: ['Shift+Right'], run: () => s().moveSelection(10, 0) },
  { id: 'nudge.up10', label: 'Nudge up 10px', group: 'Arrange', defaultKeys: ['Shift+Up'], run: () => s().moveSelection(0, -10) },
  { id: 'nudge.down10', label: 'Nudge down 10px', group: 'Arrange', defaultKeys: ['Shift+Down'], run: () => s().moveSelection(0, 10) },
  // ---- view
  { id: 'view.zoomIn', label: 'Zoom in', group: 'View', defaultKeys: ['Ctrl+=', 'Ctrl++'], run: () => zoomBy(1.25) },
  { id: 'view.zoomOut', label: 'Zoom out', group: 'View', defaultKeys: ['Ctrl+-'], run: () => zoomBy(0.8) },
  { id: 'view.zoom100', label: 'Zoom 100%', group: 'View', defaultKeys: ['Ctrl+0'], run: () => zoomTo(1) },
  { id: 'view.fitAll', label: 'Zoom to fit', group: 'View', defaultKeys: ['Shift+1'], run: zoomToFitAll },
  { id: 'view.fitSelection', label: 'Zoom to selection', group: 'View', defaultKeys: ['Shift+2'], run: zoomToSelection },
  { id: 'view.rulers', label: 'Toggle rulers', group: 'View', defaultKeys: ['Shift+R'], run: () => s().setShowRulers(!s().showRulers) }
]

/** Finds the command bound to a key event, or null. */
export function commandForEvent(e: KeyboardEvent): Command | null {
  const b = eventToBinding(e)
  if (isModifierOnly(b)) return null
  for (const c of COMMANDS) if (bindingsFor(c).includes(b)) return c
  return null
}
