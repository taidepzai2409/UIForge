// Left-panel "Game" tab + "Sync → Game" window: the art files of the linked game, replacing them
// (button, drag & drop, by folder), the pending change list, and writing it all back into the game.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor } from '@/store/editor'
import { getBlobUrl } from '@/store/assets'
import { GAME_DIR, diffGame, gameSources, type GameChanges, type GameSource } from '@/model/game'
import { ackGame, pickAndReplaceSource, replaceFromFiles, replaceFromFolder, replaceSource, revertSource, runGameAgent, syncGame, type SyncResult } from '@/store/game'
import { FloatingWindow } from './FloatingWindow'

const OPT_KEY = 'uiforge.gameSync'

function fileName(p: string): string {
  return p.replace(/^.*[\\/]/, '')
}

function isImageFile(f: File): boolean {
  return /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f.name)
}

/** diffGame walks every game frame: recompute a moment after the last edit, not on every drag step. */
function usePending(): GameChanges | null {
  const doc = useEditor((s) => s.doc)
  const [pending, setPending] = useState<GameChanges | null>(null)
  useEffect(() => {
    if (!doc.game) {
      setPending(null)
      return
    }
    const t = setTimeout(() => {
      try {
        setPending(diffGame(doc))
      } catch {
        setPending(null)
      }
    }, 200)
    return () => clearTimeout(t)
  }, [doc])
  return pending
}

function Thumb({ assetId }: { assetId: string }): React.JSX.Element {
  const asset = useEditor((s) => s.doc.assets[assetId])
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (asset) void getBlobUrl(asset).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [asset])
  return <div className="game-thumb">{url && <img src={url} alt="" />}</div>
}

function SourceRow({ s }: { s: GameSource }): React.JSX.Element {
  const [over, setOver] = useState(false)
  const current = useEditor((st) => st.doc.assets[s.currentAssetId])
  const select = (): void => {
    const st = useEditor.getState()
    const ids = s.usedBy.map((u) => u.nodeId)
    const page = st.doc.pages.find((p) => JSON.stringify(p.children).includes(`"id":"${ids[0]}"`))
    if (page && page.id !== st.pageId) st.setPage(page.id)
    st.select(ids)
  }
  return (
    <div
      className={`game-row ${over ? 'drop' : ''} ${s.replaced ? 'replaced' : ''}`}
      title={`${s.source}\nKéo-thả ảnh vào đây để thay · click để chọn ${s.usedBy.length} chỗ dùng`}
      onClick={select}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const f = Array.from(e.dataTransfer.files).find(isImageFile)
        if (f) void f.arrayBuffer().then((b) => replaceSource(s.source, new Uint8Array(b), f.name))
      }}
    >
      <Thumb assetId={s.currentAssetId} />
      <div className="game-row-text">
        <div className="game-row-name">{fileName(s.source)}</div>
        <div className="dim">
          {current ? `${current.width}×${current.height}` : `${s.width}×${s.height}`}
          {s.replaced && current && (current.width !== s.width || current.height !== s.height) ? ` (gốc ${s.width}×${s.height})` : ''} · ×{s.usedBy.length}
        </div>
      </div>
      {s.replaced && <span className="game-badge">đã thay</span>}
      <div className="game-row-actions" onClick={(e) => e.stopPropagation()}>
        {s.replaced && (
          <button className="mini" title="Trả về ảnh gốc của game" onClick={() => revertSource(s.source)}>
            ↺
          </button>
        )}
        <button className="mini" title="Chọn ảnh thay thế" onClick={() => void pickAndReplaceSource(s.source)}>
          Thay…
        </button>
      </div>
    </div>
  )
}

export function GamePanel(): React.JSX.Element {
  const doc = useEditor((s) => s.doc)
  const game = doc.game
  const sources = useMemo(() => (game ? gameSources(doc) : []), [doc, game])
  const pending = usePending()
  const [over, setOver] = useState(false)
  const [filter, setFilter] = useState('')

  if (!game) {
    return (
      <div className="assets">
        <div className="panel-title">
          <span>Game</span>
        </div>
        <div className="empty-hint">
          Project này chưa nối với game nào.
          <br />
          <br />
          Mở Claude Code trong thư mục game và bảo agent: <b>“đưa UI game này lên UIForge”</b> (tool <code>capture_game</code>). Các màn hình, art và flow của game sẽ hiện ở đây; thay art xong bấm <b>Sync → Game</b> để game tự cập nhật.
        </div>
      </div>
    )
  }
  const q = filter.trim().toLowerCase()
  const shown = q ? sources.filter((s) => s.source.toLowerCase().includes(q)) : sources
  const replaced = sources.filter((s) => s.replaced).length
  return (
    <div
      className={`assets game-panel ${over ? 'drop' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const files = Array.from(e.dataTransfer.files).filter(isImageFile)
        if (files.length) void replaceFromFiles(files.map((f) => ({ name: f.name, bytes: async () => new Uint8Array(await f.arrayBuffer()) }))).then(reportBulk)
      }}
    >
      <div className="panel-title">
        <span title={game.root}>{game.name}</span>
        <span className="dim">{game.engine ?? ''}</span>
      </div>
      <div className="game-head">
        <div className="dim game-root" title={game.root}>
          {game.root}
        </div>
        <div className="game-buttons">
          <button onClick={() => void replaceFromFolder().then((r) => r && reportBulk(r))} title="Chọn thư mục art mới; khớp theo tên file (hoặc id/tên element)">
            Thay từ thư mục…
          </button>
          <button className="accent" onClick={() => window.dispatchEvent(new CustomEvent('dm:game-sync'))} title="Ghi art + danh sách thay đổi về game">
            Sync → Game{pending?.total || pending?.assets.length ? ` (${(pending?.total ?? 0) || pending?.assets.length})` : ''}
          </button>
        </div>
        <div className="dim">
          {Object.keys(game.screens).length} màn · {sources.length} file art{replaced ? ` · ${replaced} đã thay` : ''} · rev {game.revision}
        </div>
      </div>
      <div className="game-filter">
        <input type="text" placeholder="Lọc file art…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="game-list">
        {shown.map((s) => (
          <SourceRow key={s.source} s={s} />
        ))}
        {!sources.length && <div className="empty-hint">UI của game này không dùng file ảnh nào (vẽ bằng code/CSS). Chuột phải một element → <b>Thay ảnh…</b> để đưa art vào.</div>}
      </div>
    </div>
  )
}

function reportBulk(r: { replaced: { file: string; target: string; count: number }[]; unmatched: string[] }): void {
  useEditor.getState().setNotice({
    kind: r.unmatched.length ? 'warning' : 'info',
    title: `Thay art: ${r.replaced.length} file khớp${r.unmatched.length ? `, ${r.unmatched.length} không khớp` : ''}`,
    lines: [...r.replaced.map((x) => `✓ ${fileName(x.file)} → ${x.target} (${x.count} chỗ)`), ...r.unmatched.map((x) => `⚠ không khớp tên: ${fileName(x)}`)]
  })
}

function loadOpts(): { resample: boolean; agent: boolean } {
  try {
    return { resample: true, agent: true, ...(JSON.parse(localStorage.getItem(OPT_KEY) ?? '{}') as object) }
  } catch {
    return { resample: true, agent: true }
  }
}

/** "Sync → Game": preview of what will be written, then art + change list go to the game and its agent runs. */
export function GameSyncDialog(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const game = useEditor((s) => s.doc.game)
  const pending = usePending()
  const [opts, setOpts] = useState(loadOpts)
  const [busy, setBusy] = useState<'sync' | 'agent' | null>(null)
  const [result, setResult] = useState<SyncResult | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const on = (): void => {
      setOpen(true)
      setResult(null)
      setError(null)
      setLog([])
    }
    window.addEventListener('dm:game-sync', on)
    return () => window.removeEventListener('dm:game-sync', on)
  }, [])
  useEffect(() => {
    localStorage.setItem(OPT_KEY, JSON.stringify(opts))
  }, [opts])
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [log])

  if (!open || !game) return null
  const nothing = !!pending && !pending.total && !pending.assets.length

  const agent = async (): Promise<void> => {
    setBusy('agent')
    try {
      const r = await runGameAgent((line) => setLog((l) => [...l.slice(-400), line]))
      setLog((l) => [...l, r.code === 0 ? (r.applied ? `— Agent xong. ${r.remaining ? `Còn ${r.remaining} thay đổi chưa khớp.` : 'Game đã khớp với thiết kế.'}` : '— Agent xong nhưng chưa báo đã áp dụng (chưa capture lại / chưa ghi applied.json).') : `— Agent dừng (mã ${r.code ?? 'không chạy được'}).`])
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
    setBusy(null)
  }
  const run = async (): Promise<void> => {
    setError(null)
    setBusy('sync')
    setLog([])
    try {
      const r = await syncGame({ resample: opts.resample })
      setResult(r)
      setBusy(null)
      if (opts.agent && r.changes.total + r.changes.assets.length > 0) await agent()
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      setBusy(null)
    }
  }

  const shownChanges = result?.changes ?? pending
  return (
    <FloatingWindow
      id="game-sync"
      title={`Sync → ${game.name}`}
      defaultRect={{ x: Math.max(40, window.innerWidth / 2 - 320), y: 90, w: 640, h: 560 }}
      minW={460}
      minH={320}
      onClose={() => setOpen(false)}
      footer={
        <>
          <label className="game-opt" title="Art mới cùng tỉ lệ nhưng khác số pixel được thu về kích thước cũ, game chạy đúng ngay không cần sửa code">
            <input type="checkbox" checked={opts.resample} onChange={(e) => setOpts({ ...opts, resample: e.target.checked })} /> Giữ kích thước pixel gốc
          </label>
          <label className="game-opt" title="Sau khi ghi, chạy Claude Code trong thư mục game để tự sửa code/CSS theo CHANGES.md">
            <input type="checkbox" checked={opts.agent} onChange={(e) => setOpts({ ...opts, agent: e.target.checked })} /> Chạy agent của game
          </label>
          <span style={{ flex: 1 }} />
          {busy === 'agent' && <button onClick={() => void window.api.stopAgent()}>Dừng agent</button>}
          {result && !busy && (
            <>
              <button onClick={() => void window.api.openPath(`${game.root}/${GAME_DIR}`)}>Mở thư mục</button>
              <button onClick={() => void agent()} title="Chạy lại agent của game với CHANGES.md hiện tại">
                Chạy agent
              </button>
              <button
                title="Game đã khớp thiết kế (đã sửa tay / agent đã làm xong): lấy thiết kế hiện tại làm mốc mới"
                onClick={() =>
                  void ackGame().then(() => {
                    setResult(null)
                    setLog([])
                  })
                }
              >
                Đánh dấu đã áp dụng
              </button>
            </>
          )}
          <button className="accent" disabled={!!busy || nothing} onClick={() => void run()}>
            {busy === 'sync' ? 'Đang ghi…' : busy === 'agent' ? 'Agent đang chạy…' : result ? 'Sync lại' : 'Sync → Game'}
          </button>
        </>
      }
    >
      <div className="modal-body game-sync">
        <div className="dim">{game.root}</div>
        {error && <div className="game-error">{error}</div>}
        {nothing && !result && <div className="empty-hint">Không có gì để sync: thiết kế đang khớp với game.</div>}
        {result && (
          <div className="game-result">
            ✓ Đã ghi {result.written.length} file art{result.unchanged.length ? ` (${result.unchanged.length} file đã đúng sẵn)` : ''}, {result.changes.total} thay đổi UI → <code>{GAME_DIR}/CHANGES.md</code>
            {result.backups.length ? ` · bản cũ lưu ở ${GAME_DIR}/backup/rev${result.changes.revision}` : ''}
          </div>
        )}
        {shownChanges && shownChanges.assets.length > 0 && (
          <div className="game-section">
            <div className="game-section-title">Art ({shownChanges.assets.length})</div>
            {shownChanges.assets.map((a) => (
              <div key={a.target + a.assetId} className="game-change">
                <span className={`game-tag ${a.mode}`}>{a.mode === 'overwrite' ? 'ghi đè' : 'ảnh mới'}</span>
                <code>{a.target}</code>
                <span className="dim">
                  {a.oldSize && (a.oldSize.width !== a.newSize.width || a.oldSize.height !== a.newSize.height) ? `${a.oldSize.width}×${a.oldSize.height} → ` : ''}
                  {a.newSize.width}×{a.newSize.height} · {a.usedBy.length} chỗ{a.note ? ` · ${a.note}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
        {shownChanges?.screens.map((s) => (
          <div key={s.id} className="game-section">
            <div className="game-section-title">
              {s.name} ({s.changes.length})
            </div>
            {s.sizeFrom && (
              <div className="game-change">
                <span className="game-tag">size</span>
                {s.sizeFrom.width}×{s.sizeFrom.height} → {s.width}×{s.height}
              </div>
            )}
            {s.changes.slice(0, 60).map((c, i) => (
              <div key={i} className="game-change" onClick={() => selectElement(s.frameId, c.element)} title={c.code ?? ''}>
                <span className={`game-tag ${c.kind}`}>{KIND[c.kind]}</span>
                <code>{c.name}</code>
                <span className="dim">{c.kind === 'rect' ? c.note : c.kind === 'asset' ? String(c.to) : c.kind === 'text' ? JSON.stringify(c.to) : (c.note ?? '')}</span>
              </div>
            ))}
            {s.changes.length > 60 && <div className="dim">… và {s.changes.length - 60} thay đổi nữa</div>}
          </div>
        ))}
        {shownChanges && (shownChanges.flows.added.length > 0 || shownChanges.flows.removed.length > 0) && (
          <div className="game-section">
            <div className="game-section-title">Flow</div>
            {shownChanges.flows.added.map((k) => (
              <div key={'a' + k} className="game-change">
                <span className="game-tag added">thêm</span>
                <code>{k.split('|').filter(Boolean).join(' → ')}</code>
              </div>
            ))}
            {shownChanges.flows.removed.map((k) => (
              <div key={'r' + k} className="game-change">
                <span className="game-tag removed">xoá</span>
                <code>{k.split('|').filter(Boolean).join(' → ')}</code>
              </div>
            ))}
          </div>
        )}
        {log.length > 0 && (
          <div className="game-log" ref={logRef}>
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </FloatingWindow>
  )
}

const KIND: Record<string, string> = { rect: 'vị trí', asset: 'art', text: 'chữ', style: 'style', visible: 'ẩn/hiện', added: 'thêm', removed: 'xoá' }

function selectElement(frameId: string, element: string): void {
  const st = useEditor.getState()
  for (const page of st.doc.pages) {
    const frame = page.children.find((c) => c.id === frameId)
    if (!frame || frame.type !== 'frame') continue
    if (page.id !== st.pageId) st.setPage(page.id)
    let hit: string | null = null
    const visit = (list: typeof frame.children): void => {
      for (const n of list) {
        if (!hit && (n.meta?.gameId === element || (element.startsWith('~') && n.name.replace(/[^a-zA-Z0-9_\-.]+/g, '_') === element.slice(1)))) hit = n.id
        if ('children' in n) visit(n.children)
      }
    }
    visit(frame.children)
    st.select([hit ?? frameId])
    return
  }
}
