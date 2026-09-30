import { useEffect, useMemo, useState } from 'react'
import { loadImportPrefs, saveImportPrefs, useImportDialog, type ImportChoice } from '@/store/importDialog'
import type { BuildOptions } from '@/psd/importPsd'

export function ImportPsdDialog(): React.JSX.Element | null {
  const pending = useImportDialog((s) => s.pending)
  const answer = useImportDialog((s) => s.answer)
  const parsed = pending?.parsed
  const groups = useMemo(() => parsed?.topLevel.filter((t) => t.isGroup) ?? [], [parsed])
  const loose = useMemo(() => parsed?.topLevel.filter((t) => !t.isGroup) ?? [], [parsed])
  const prefs = useMemo(() => loadImportPrefs(), [])
  const [mode, setMode] = useState<'single' | 'split'>('split')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [includeLoose, setIncludeLoose] = useState(prefs.includeLooseLayers ?? true)
  const [includeHiddenLoose, setIncludeHiddenLoose] = useState(prefs.includeHiddenLoose ?? false)
  const [textMode, setTextMode] = useState<BuildOptions['textMode']>(prefs.textMode ?? 'both')
  const [autoAnchor, setAutoAnchor] = useState(prefs.autoAnchor ?? true)

  useEffect(() => {
    if (!parsed) return
    setMode(groups.length >= 2 ? 'split' : 'single')
    setSelected(new Set(groups.map((g) => g.index)))
  }, [parsed, groups])

  if (!parsed) return null

  const toggle = (i: number): void => {
    const next = new Set(selected)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setSelected(next)
  }
  const ok = (): void => {
    const choice: ImportChoice = { mode, groupIndexes: Array.from(selected), includeLooseLayers: includeLoose, includeHiddenLoose, textMode, autoAnchor }
    saveImportPrefs(choice)
    answer(choice)
  }
  const visibleLoose = loose.filter((l) => !l.hidden).length
  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && answer(null)}>
      <div className="modal">
        <div className="modal-title">
          Import {parsed.baseName}.psd
          <span className="dim small">
            {' '}
            · {parsed.width}×{parsed.height} · {parsed.layerCount} layer · {parsed.textLayers} text
          </span>
        </div>
        <div className="modal-body">
          <label className="radio">
            <input type="radio" checked={mode === 'single'} onChange={() => setMode('single')} />
            <span>
              <b>Một frame</b> — cả PSD là một màn hình
            </span>
          </label>
          <label className="radio">
            <input type="radio" checked={mode === 'split'} onChange={() => setMode('split')} disabled={!groups.length} />
            <span>
              <b>Mỗi group cấp 1 = một frame</b> — PSD chứa nhiều màn hình ({groups.length} group)
            </span>
          </label>
          {mode === 'split' && (
            <div className="group-list">
              <div className="group-list-head">
                <button className="mini" onClick={() => setSelected(new Set(groups.map((g) => g.index)))}>
                  Chọn tất cả
                </button>
                <button className="mini" onClick={() => setSelected(new Set(groups.filter((g) => !g.hidden).map((g) => g.index)))}>
                  Chỉ group đang hiện
                </button>
                <button className="mini" onClick={() => setSelected(new Set())}>
                  Bỏ chọn
                </button>
                <span className="dim small">{selected.size} frame sẽ tạo</span>
              </div>
              {groups.map((g) => (
                <label key={g.index} className={`group-row ${g.hidden ? 'hidden' : ''}`}>
                  <input type="checkbox" checked={selected.has(g.index)} onChange={() => toggle(g.index)} />
                  <span className="name">{g.name}</span>
                  <span className="dim small">
                    {g.layerCount} layer{g.hidden ? ' · ẩn trong PSD' : ''}
                  </span>
                </label>
              ))}
              <label className="check">
                <input type="checkbox" checked={includeLoose} onChange={(e) => setIncludeLoose(e.target.checked)} />
                <span>
                  Thêm layer lẻ cấp 1 (không nằm trong group, ví dụ nền chung) vào mọi frame — {visibleLoose} đang hiện, {loose.length - visibleLoose} ẩn
                </span>
              </label>
              {includeLoose && (
                <label className="check indent">
                  <input type="checkbox" checked={includeHiddenLoose} onChange={(e) => setIncludeHiddenLoose(e.target.checked)} />
                  <span>Kể cả layer lẻ đang ẩn</span>
                </label>
              )}
            </div>
          )}
          <div className="field-block">
            <div className="field-label">Text layer ({parsed.textLayers})</div>
            <label className="radio">
              <input type="radio" checked={textMode === 'both'} onChange={() => setTextMode('both')} />
              <span>
                <b>Text sống + ảnh gốc ẩn</b> — Agent Dev dùng text, ảnh để đối chiếu (khuyên dùng)
              </span>
            </label>
            <label className="radio">
              <input type="radio" checked={textMode === 'live'} onChange={() => setTextMode('live')} />
              <span>Chỉ text sống</span>
            </label>
            <label className="radio">
              <input type="radio" checked={textMode === 'raster'} onChange={() => setTextMode('raster')} />
              <span>Chỉ ảnh (giữ nguyên hình như Photoshop, không sửa chữ được)</span>
            </label>
            <div className="hint">Text sống dùng font đã cài trên Windows hoặc file font trong thư mục fonts/ của project. Font thiếu sẽ được báo sau khi import.</div>
          </div>
          <div className="field-block">
            <div className="field-label">Đa màn hình</div>
            <label className="radio">
              <input type="checkbox" checked={autoAnchor} onChange={(e) => setAutoAnchor(e.target.checked)} />
              <span>
                <b>Tự neo anchor + safe area theo rule</b> — nửa trên neo Top, nửa dưới neo Bottom, trái/phải, giữa, nền → stretch; node neo theo mép đi theo safe area (tai thỏ/home bar)
              </span>
            </label>
            <div className="hint">Áp cho node cấp 1 của mỗi frame. Xem kết quả bằng Shift+D; chỉnh lại từng node ở mục Anchor (Unity) panel phải; Ctrl+Alt+A để chạy lại.</div>
          </div>
        </div>
        <div className="modal-actions">
          <button onClick={() => answer(null)}>Huỷ</button>
          <button className="accent" onClick={ok} disabled={mode === 'split' && selected.size === 0}>
            Import
          </button>
        </div>
      </div>
    </div>
  )
}
