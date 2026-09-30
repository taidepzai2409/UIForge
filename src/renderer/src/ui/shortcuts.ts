import { useEditor } from '@/store/editor'
import { commandForEvent } from './commands'

export { zoomBy, zoomTo, zoomToFitAll, zoomToSelection } from './zoom'

/** Global keyboard handling: every shortcut is a command in commands.ts (user-rebindable). */
export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null
    const inInput = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    const s = useEditor.getState()
    const cmd = commandForEvent(e)
    if (!cmd) return
    if (inInput && !cmd.global) {
      if (cmd.id === 'edit.escape') t?.blur()
      return
    }
    if (s.presenting && !cmd.global) return
    // let native text copy/cut work when the user has selected text on the page
    if ((cmd.id === 'edit.copy' || cmd.id === 'edit.cut') && (window.getSelection()?.toString() ?? '').length > 0) return
    e.preventDefault()
    cmd.run()
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
