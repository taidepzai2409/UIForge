import { useEffect, useMemo, useState } from 'react'
import { COMMANDS, bindingsFor, eventToBinding, isModifierOnly, onBindingsChange, resetAllBindings, setBindings, type Command } from './commands'
import { FloatingWindow } from './FloatingWindow'
import { useTheme, type ThemePref } from '@/store/theme'

export function ShortcutsDialog(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [tick, setTick] = useState(0)
  const [capturing, setCapturing] = useState<{ id: string; index: number } | null>(null)
  const [filter, setFilter] = useState('')
  const themePref = useTheme((t) => t.pref)
  const setThemePref = useTheme((t) => t.setPref)

  useEffect(() => {
    const on = (): void => setOpen(true)
    window.addEventListener('dm:settings', on)
    return () => window.removeEventListener('dm:settings', on)
  }, [])
  useEffect(() => onBindingsChange(() => setTick((t) => t + 1)), [])

  useEffect(() => {
    if (!capturing) return
    const h = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      const b = eventToBinding(e)
      if (isModifierOnly(b)) return
      const cmd = COMMANDS.find((c) => c.id === capturing.id)!
      const keys = bindingsFor(cmd).slice()
      keys[capturing.index] = b
      // remove the same binding from other commands
      for (const other of COMMANDS) {
        if (other.id === cmd.id) continue
        const ob = bindingsFor(other)
        if (ob.includes(b)) setBindings(other.id, ob.filter((k) => k !== b))
      }
      setBindings(cmd.id, keys)
      setCapturing(null)
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [capturing])

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const map = new Map<string, Command[]>()
    for (const c of COMMANDS) {
      if (q && !c.label.toLowerCase().includes(q) && !bindingsFor(c).join(' ').toLowerCase().includes(q)) continue
      const arr = map.get(c.group) ?? []
      arr.push(c)
      map.set(c.group, arr)
    }
    return Array.from(map.entries())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, tick])

  if (!open) return null
  return (
    <FloatingWindow
      id="settings"
      title={
        <>
          Settings<span className="dim small"> · giao diện & phím tắt</span>
        </>
      }
      defaultRect={{ x: Math.max(20, window.innerWidth - 760), y: 60, w: 720, h: 640 }}
      onClose={() => {
        if (!capturing) setOpen(false)
      }}
      footer={
        <button className="accent" onClick={() => setOpen(false)}>
          Đóng
        </button>
      }
    >
      <div className="modal-body">
          <div className="settings-theme">
            <span className="field-label">Giao diện</span>
            <select value={themePref} onChange={(e) => setThemePref(e.target.value as ThemePref)} style={{ width: 200 }}>
              <option value="auto">Theo hệ thống (Windows)</option>
              <option value="light">Sáng</option>
              <option value="dark">Tối</option>
            </select>
          </div>
          <div className="section-title">Phím tắt</div>
          <div className="row2">
            <input type="text" placeholder="Tìm lệnh..." value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
            <button
              onClick={() => {
                if (confirm('Đặt lại toàn bộ phím tắt về mặc định?')) resetAllBindings()
              }}
            >
              Về mặc định
            </button>
          </div>
          <div className="keys-table">
            {groups.map(([group, cmds]) => (
              <div key={group}>
                <div className="section-title">{group}</div>
                {cmds.map((c) => {
                  const keys = bindingsFor(c)
                  const isDefault = JSON.stringify(keys) === JSON.stringify(c.defaultKeys)
                  return (
                    <div key={c.id} className="keys-row">
                      <span className="keys-label">{c.label}</span>
                      <span className="keys-binds">
                        {keys.map((k, i) => (
                          <span key={i} className="key-chip-wrap">
                            <button
                              className={`key-chip ${capturing?.id === c.id && capturing.index === i ? 'capturing' : ''}`}
                              onClick={() => setCapturing({ id: c.id, index: i })}
                              title="Bấm rồi gõ tổ hợp mới"
                            >
                              {capturing?.id === c.id && capturing.index === i ? 'Gõ phím...' : k}
                            </button>
                            <button className="mini" title="Xoá phím này" onClick={() => setBindings(c.id, keys.filter((_, j) => j !== i))}>
                              ×
                            </button>
                          </span>
                        ))}
                        <button className="mini" title="Thêm phím khác" onClick={() => setCapturing({ id: c.id, index: keys.length })}>
                          +
                        </button>
                        {!isDefault && (
                          <button className="mini" title="Về mặc định" onClick={() => setBindings(c.id, null)}>
                            ↺
                          </button>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
    </FloatingWindow>
  )
}
