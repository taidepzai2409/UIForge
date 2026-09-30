import { useEffect, useState } from 'react'
import type { RGBA } from '@/model/types'
import { hexToRgba, rgbaToHex } from '@/model/color'

export function NumField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  disabled,
  title
}: {
  label?: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  disabled?: boolean
  title?: string
}): React.JSX.Element {
  const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100))
  const [text, setText] = useState(fmt(value))
  useEffect(() => setText(fmt(value)), [value])
  const commit = (): void => {
    let v = Number(text.replace(',', '.'))
    if (!Number.isFinite(v)) {
      setText(fmt(value))
      return
    }
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    if (v !== value) onChange(v)
    else setText(fmt(value))
  }
  return (
    <label className="field num" title={title}>
      {label && <span className="field-label">{label}</span>}
      <input
        type="text"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? step * 10 : step)
            let v = (Number(text) || 0) + d
            if (min !== undefined) v = Math.max(min, v)
            if (max !== undefined) v = Math.min(max, v)
            onChange(Math.round(v * 100) / 100)
          }
        }}
      />
    </label>
  )
}

export function TextField({
  label,
  value,
  onChange,
  placeholder
}: {
  label?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onChange(text)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  )
}

export function ColorField({ label, value, onChange }: { label?: string; value: RGBA; onChange: (c: RGBA) => void }): React.JSX.Element {
  const hex = rgbaToHex(value)
  const [text, setText] = useState(hex)
  useEffect(() => setText(hex), [hex])
  return (
    <div className="field color">
      {label && <span className="field-label">{label}</span>}
      <input type="color" value={hex} onChange={(e) => onChange({ ...hexToRgba(e.target.value, value.a)! })} />
      <input
        type="text"
        className="hex"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const c = hexToRgba(text, value.a)
          if (c) onChange(c)
          else setText(hex)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <NumField value={Math.round(value.a * 100)} min={0} max={100} onChange={(v) => onChange({ ...value, a: v / 100 })} title="Alpha %" />
    </div>
  )
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="section">
      <div className="section-title">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  )
}
