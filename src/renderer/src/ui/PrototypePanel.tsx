// Right panel · Prototype tab: interaction editor (Figma-style) + flows overview.
import type { Connection, FrameNode, NodeId, OverlaySettings, SceneNode } from '@/model/types'
import { ACTIONS, DIRECTIONS, EASINGS, OVERLAY_POSITIONS, TRANSITIONS, TRIGGERS, actionLabel, ownerFrameId, transitionLabel, triggerLabel } from '@/model/flows'
import { getEntry } from '@/model/nodes'
import { useCurrentPage, useEditor } from '@/store/editor'
import { Check, NumField, Section } from './fields'

const KEY_HINT = 'Escape, Enter, Space, a…z, ArrowLeft…'

function frameOf(page: ReturnType<typeof useCurrentPage>, id: NodeId): FrameNode | null {
  const f = page.children.find((c) => c.id === id)
  return f && f.type === 'frame' ? f : null
}

/** Prototype tab for a selected node: its interactions + add button. */
export function PrototypeSection({ n }: { n: SceneNode }): React.JSX.Element {
  const page = useCurrentPage()
  const st = useEditor.getState()
  const conns = page.connections.filter((c) => c.from === n.id)
  const own = ownerFrameId(page, n.id)
  const targets = page.children.filter((c): c is FrameNode => c.type === 'frame' && c.id !== own)
  const isFrame = n.type === 'frame' && !getEntry(page, n.id)?.parent
  const add = (): void => {
    const to = targets[0]?.id
    if (isFrame) st.addConnection(n.id, to, { trigger: 'after-delay', delay: 1000, action: to ? 'navigate' : 'back' })
    else st.addConnection(n.id, to, to ? undefined : { action: 'back' })
  }
  return (
    <>
      <Section
        title="Interactions"
        right={
          <button className="mini" onClick={add} title="Thêm tương tác">
            +
          </button>
        }
      >
        {conns.length === 0 && (
          <div className="hint">
            {isFrame
              ? 'Frame có thể tự chuyển sau N ms (After delay) hoặc theo phím. Bấm + để thêm.'
              : 'Kéo nút ⊕ bên phải node tới frame khác để tạo flow (giữ Alt = mở overlay), hoặc bấm +.'}
          </div>
        )}
        {conns.map((c) => (
          <ConnectionEditor key={c.id} c={c} compact />
        ))}
      </Section>
      {isFrame && (
        <Section title="Flow">
          <button className={page.startFrameId === n.id ? 'accent' : ''} onClick={() => st.setStartFrame(page.startFrameId === n.id ? undefined : n.id)}>
            {page.startFrameId === n.id ? '▶ Flow start (bỏ)' : 'Đặt làm Flow start'}
          </button>
          <button onClick={() => st.setPresenting(true, n.id)}>▶ Chạy thử từ frame này</button>
        </Section>
      )}
    </>
  )
}

/** Prototype tab with nothing selected: overview of all flows on the page. */
export function FlowsOverview(): React.JSX.Element {
  const page = useCurrentPage()
  const st = useEditor.getState()
  const frames = page.children.filter((c): c is FrameNode => c.type === 'frame')
  const byFrame = new Map<NodeId, Connection[]>()
  for (const c of page.connections) {
    const f = ownerFrameId(page, c.from)
    if (!f) continue
    byFrame.set(f, [...(byFrame.get(f) ?? []), c])
  }
  const reach = new Set<NodeId>()
  for (const c of page.connections) if (c.to) reach.add(c.to)
  return (
    <>
      <Section title="Flow">
        <label className="field">
          <span className="field-label">Start frame</span>
          <select value={page.startFrameId ?? ''} onChange={(e) => st.setStartFrame(e.target.value || undefined)}>
            <option value="">(frame đầu tiên)</option>
            {frames.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <button className="accent" onClick={() => st.setPresenting(true)} title="F5">
          ▶ Present
        </button>
        <div className="hint">Chọn node rồi kéo nút ⊕ tới frame khác để tạo flow. Giữ Alt khi thả = overlay (popup). Bấm vào mũi tên để sửa.</div>
      </Section>
      <Section title={`Interactions (${page.connections.length})`}>
        {page.connections.length === 0 && <div className="hint">Chưa có flow nào.</div>}
        {frames.map((f) => {
          const list = byFrame.get(f.id) ?? []
          if (!list.length) return null
          return (
            <div key={f.id} className="flow-group">
              <div className="flow-frame">
                {f.name}
                {page.startFrameId === f.id ? ' ▶' : ''}
              </div>
              {list.map((c) => {
                const from = getEntry(page, c.from)
                const to = c.to ? frameOf(page, c.to) : null
                return (
                  <button key={c.id} className="flow-row" onClick={() => st.setSelectedConnection(c.id)} title={transitionLabel(c)}>
                    <span className="flow-from">{from?.node.id === f.id ? '(frame)' : (from?.node.name ?? '?')}</span>
                    <span className="flow-what">
                      {triggerLabel(c)} {actionLabel(c, to?.name)}
                    </span>
                  </button>
                )
              })}
            </div>
          )
        })}
        {frames.filter((f) => !reach.has(f.id) && f.id !== page.startFrameId && page.connections.length > 0).length > 0 && (
          <div className="hint">
            Chưa có flow nào dẫn tới: {frames.filter((f) => !reach.has(f.id) && f.id !== page.startFrameId).map((f) => f.name).join(', ')}
          </div>
        )}
      </Section>
    </>
  )
}

export function ConnectionEditor({ c, compact }: { c: Connection; compact?: boolean }): React.JSX.Element {
  const page = useCurrentPage()
  const st = useEditor.getState()
  const from = getEntry(page, c.from)
  const own = ownerFrameId(page, c.from)
  const targets = page.children.filter((x): x is FrameNode => x.type === 'frame' && x.id !== own)
  const upd = (patch: Partial<Connection>): void => st.updateConnection(c.id, patch)
  const act = ACTIONS.find((a) => a.id === c.action) ?? ACTIONS[0]
  const isOverlay = c.action === 'overlay' || c.action === 'swap'
  const tr = TRANSITIONS.find((t) => t.id === c.transition)
  const ov: OverlaySettings = c.overlay ?? { position: 'center', dim: true, dimColor: '#000000', dimOpacity: 0.5, closeOutside: true }
  const setOv = (patch: Partial<OverlaySettings>): void => upd({ overlay: { ...ov, ...patch } })
  const to = c.to ? frameOf(page, c.to) : null
  const body = (
    <>
      {!compact && (
        <div className="kv">
          <span>Hotspot</span>
          <button className="link" onClick={() => st.select([c.from])}>
            {from?.path ?? c.from}
          </button>
        </div>
      )}
      <div className="conn-summary">
        {triggerLabel(c)} {actionLabel(c, to?.name)} · {transitionLabel(c)}
      </div>
      <label className="field">
        <span className="field-label">Trigger</span>
        <select value={c.trigger} onChange={(e) => upd({ trigger: e.target.value as Connection['trigger'] })}>
          {TRIGGERS.map((t) => (
            <option key={t.id} value={t.id} title={t.hint}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      {c.trigger === 'after-delay' && <NumField label="Delay ms" value={c.delay ?? 1000} min={0} step={100} onChange={(v) => upd({ delay: v })} />}
      {c.trigger === 'key' && (
        <label className="field">
          <span className="field-label">Key</span>
          <input
            value={c.key ?? ''}
            placeholder={KEY_HINT}
            onKeyDown={(e) => {
              if (e.key === 'Tab') return
              e.preventDefault()
              upd({ key: e.key === ' ' ? 'Space' : e.key })
            }}
            onChange={() => {}}
          />
        </label>
      )}
      <label className="field">
        <span className="field-label">Action</span>
        <select value={c.action} onChange={(e) => upd({ action: e.target.value as Connection['action'], to: c.to ?? targets[0]?.id })}>
          {ACTIONS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      {act.needsTarget && (
        <label className="field">
          <span className="field-label">Destination</span>
          <select value={c.to ?? ''} onChange={(e) => upd({ to: e.target.value || undefined })}>
            <option value="">Chọn frame…</option>
            {targets.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span className="field-label">Animation</span>
        <select value={c.transition} onChange={(e) => upd({ transition: e.target.value as Connection['transition'] })}>
          {TRANSITIONS.filter((t) => !isOverlay || t.overlayOk).map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      {tr?.directional && (
        <div className="dir-row">
          {DIRECTIONS.map((d) => (
            <button key={d.id} className={`chip ${(c.direction ?? 'left') === d.id ? 'active' : ''}`} title={d.label} onClick={() => upd({ direction: d.id })}>
              {d.arrow}
            </button>
          ))}
          <span className="dim small">{DIRECTIONS.find((d) => d.id === (c.direction ?? 'left'))?.label}</span>
        </div>
      )}
      {c.transition !== 'instant' && (
        <div className="row2">
          <label className="field">
            <span className="field-label">Easing</span>
            <select value={c.easing ?? 'ease-out'} onChange={(e) => upd({ easing: e.target.value as Connection['easing'] })}>
              {EASINGS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          <NumField label="Duration ms" value={c.duration} min={0} step={50} onChange={(v) => upd({ duration: v })} />
        </div>
      )}
      {c.transition === 'smart' && <div className="hint">Smart animate: node cùng tên/path ở hai frame sẽ trượt/đổi cỡ/mờ dần sang vị trí mới; node khác tên cross-fade.</div>}
      {isOverlay && (
        <fieldset className="ps-group">
          <legend>Overlay</legend>
          <label className="field">
            <span className="field-label">Position</span>
            <select value={ov.position} onChange={(e) => setOv({ position: e.target.value as OverlaySettings['position'] })}>
              {OVERLAY_POSITIONS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {ov.position === 'manual' && (
            <div className="row2">
              <NumField label="X" value={ov.x ?? 0} onChange={(v) => setOv({ x: v })} />
              <NumField label="Y" value={ov.y ?? 0} onChange={(v) => setOv({ y: v })} />
            </div>
          )}
          <Check label="Đóng khi bấm ra ngoài" checked={ov.closeOutside} onChange={(v) => setOv({ closeOutside: v })} />
          <Check label="Làm tối nền phía sau" checked={ov.dim} onChange={(v) => setOv({ dim: v })} />
          {ov.dim && (
            <div className="row2">
              <label className="field">
                <span className="field-label">Màu</span>
                <input type="color" value={ov.dimColor} onChange={(e) => setOv({ dimColor: e.target.value })} />
              </label>
              <NumField label="Opacity %" value={Math.round(ov.dimOpacity * 100)} min={0} max={100} onChange={(v) => setOv({ dimOpacity: Math.max(0, Math.min(1, v / 100)) })} />
            </div>
          )}
        </fieldset>
      )}
      <div className="row2">
        <button onClick={() => st.setPresenting(true, own)} title="Present bắt đầu từ frame chứa hotspot này">
          ▶ Chạy thử
        </button>
        <button className="danger" onClick={() => st.removeConnection(c.id)}>
          Xoá
        </button>
      </div>
    </>
  )
  if (compact) return <div className="conn">{body}</div>
  return <Section title="Interaction">{body}</Section>
}
