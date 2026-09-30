import { useEffect, useRef, useState } from 'react'
import type { AutoLayout, FrameNode, GroupNode, InstanceNode, NineSliceNode, SceneNode, TextNode } from '@/model/types'
import { findMaster } from '@/model/instances'
import { STATE_NAMES, stateChildren, type StateName } from '@/model/states'
import { defaultLayout } from '@/model/create'
import { locate } from '@/store/editor'
import { isContainer } from '@/model/types'
import { ANCHOR_PRESETS, presetKeyFor } from '@/model/anchors'
import { FRAME_PRESETS, createText } from '@/model/create'
import { hexToRgba } from '@/model/color'
import { getEntry } from '@/model/nodes'
import { useCurrentPage, useEditor } from '@/store/editor'
import { getBlobUrl } from '@/store/assets'
import { fontFamilies } from '@/store/fonts'
import { Check, ColorField, NumField, Section, TextField } from './fields'
import { alignSelection, type AlignKind } from './actions'

import { ConnectionEditor, FlowsOverview, PrototypeSection } from './PrototypePanel'

function ModeTabs(): React.JSX.Element {
  const mode = useEditor((s) => s.mode)
  const setMode = useEditor((s) => s.setMode)
  return (
    <div className="rp-tabs">
      <button className={mode === 'design' ? 'active' : ''} onClick={() => setMode('design')}>
        Design
      </button>
      <button className={mode === 'prototype' ? 'active' : ''} onClick={() => setMode('prototype')}>
        Prototype
      </button>
    </div>
  )
}

export function PropertiesPanel(): React.JSX.Element {
  return (
    <>
      <ModeTabs />
      <PropertiesBody />
    </>
  )
}

function PropertiesBody(): React.JSX.Element {
  const page = useCurrentPage()
  const selection = useEditor((s) => s.selection)
  const mode = useEditor((s) => s.mode)
  const selectedConnectionId = useEditor((s) => s.selectedConnectionId)
  const doc = useEditor((s) => s.doc)
  const projectDir = useEditor((s) => s.projectDir)

  if (selectedConnectionId) {
    const c = page.connections.find((x) => x.id === selectedConnectionId)
    if (c) return <div className="props">{<ConnectionEditor c={c} />}</div>
  }
  if (!selection.length && mode === 'prototype') {
    return (
      <div className="props">
        <FlowsOverview />
      </div>
    )
  }
  if (!selection.length) {
    const frames = page.children.filter((n) => n.type === 'frame').length
    return (
      <div className="props">
        <Section title="Project">
          <div className="kv">
            <span>Name</span>
            <span>{doc.name}</span>
          </div>
          <div className="kv">
            <span>Folder</span>
            <span className="dim small">{projectDir ?? '(chưa lưu)'}</span>
          </div>
          <div className="kv">
            <span>Page</span>
            <span>{page.name}</span>
          </div>
          <div className="kv">
            <span>Frames</span>
            <span>{frames}</span>
          </div>
          <div className="kv">
            <span>Assets</span>
            <span>{Object.keys(doc.assets).length}</span>
          </div>
        </Section>
        <Section title="Shortcuts">
          <div className="hint">
            V move · H hand · F frame · R rect · T text · N 9-slice · P prototype
            <br />
            Ctrl+Z/Y undo/redo · Ctrl+D duplicate · Ctrl+G group · Ctrl+Shift+G ungroup
            <br />
            Ctrl+[ ] order · Del delete · Enter vào group · Esc ra ngoài · F2 rename
            <br />
            Ctrl+wheel zoom · Space+drag pan · Shift+1 fit · Shift+2 fit selection · Shift+R rulers
            <br />
            Ctrl+S save · Ctrl+Shift+I import PSD · Ctrl+Shift+E export · F5 present · Ctrl+, settings
          </div>
        </Section>
      </div>
    )
  }
  if (selection.length > 1)
    return (
      <>
        <AlignBar count={selection.length} />
        <MultiProps ids={selection} />
      </>
    )
  const entry = getEntry(page, selection[0])
  if (!entry) return <div className="props" />
  return (
    <>
      {entry.parent && <AlignBar count={1} />}
      <NodeProps node={entry.node} parentSize={entry.parent ? { w: entry.parent.width, h: entry.parent.height } : null} mode={mode} />
    </>
  )
}

const ALIGN_BTNS: { k: AlignKind; label: string; title: string }[] = [
  { k: 'left', label: '⇤', title: 'Căn trái (Alt+A)' },
  { k: 'hcenter', label: '↔', title: 'Căn giữa ngang (Alt+H)' },
  { k: 'right', label: '⇥', title: 'Căn phải (Alt+D)' },
  { k: 'top', label: '⤒', title: 'Căn trên (Alt+W)' },
  { k: 'vcenter', label: '↕', title: 'Căn giữa dọc (Alt+V)' },
  { k: 'bottom', label: '⤓', title: 'Căn dưới (Alt+S)' },
  { k: 'dist-h', label: '⫴', title: 'Chia đều ngang (Alt+Shift+H, ≥3 node)' },
  { k: 'dist-v', label: '☰', title: 'Chia đều dọc (Alt+Shift+V, ≥3 node)' }
]

function AlignBar({ count }: { count: number }): React.JSX.Element {
  return (
    <div className="align-bar" title={count === 1 ? 'Căn theo node cha' : 'Căn theo khung bao của selection'}>
      {ALIGN_BTNS.map((b) => (
        <button key={b.k} title={b.title} disabled={b.k.startsWith('dist') && count < 3} onClick={() => alignSelection(b.k)}>
          {b.label}
        </button>
      ))}
    </div>
  )
}

function MultiProps({ ids }: { ids: string[] }): React.JSX.Element {
  const { setSelectionProps, groupSelection } = useEditor.getState()
  return (
    <div className="props">
      <Section title={`${ids.length} nodes`}>
        <button onClick={groupSelection}>Group (Ctrl+G)</button>
      </Section>
      <AnchorSection onApply={(anchor, pivot) => setSelectionProps({ anchor, pivot })} />
    </div>
  )
}

function describeAnchor(a: SceneNode['anchor']): string {
  const y = a.minY !== a.maxY ? 'giãn dọc' : a.minY === 0 ? 'Top' : a.minY === 1 ? 'Bottom' : a.minY === 0.5 ? 'Middle' : `y=${a.minY}`
  const x = a.minX !== a.maxX ? 'giãn ngang' : a.minX === 0 ? 'Left' : a.minX === 1 ? 'Right' : a.minX === 0.5 ? 'Center' : `x=${a.minX}`
  if (a.minX === 0 && a.maxX === 1 && a.minY === 0 && a.maxY === 1) return 'Stretch 4 phía (All)'
  return `${y} · ${x}`
}

function AnchorSection({ current, onApply }: { current?: SceneNode; onApply: (anchor: SceneNode['anchor'], pivot: SceneNode['pivot']) => void }): React.JSX.Element {
  const key = current ? presetKeyFor(current.anchor, current.pivot) : null
  const grid = ANCHOR_PRESETS.slice(0, 9)
  const stretch = ANCHOR_PRESETS.slice(9)
  return (
    <Section title="Anchor (Unity)">
      <div className="anchor-grid">
        {grid.map((p) => (
          <button key={p.key} className={`anchor-btn ${key === p.key ? 'active' : ''}`} title={p.label} onClick={() => onApply({ ...p.anchor }, { ...p.pivot })}>
            <i style={{ left: `${p.pivot.x * 100}%`, top: `${p.pivot.y * 100}%` }} />
          </button>
        ))}
      </div>
      <div className="anchor-stretch">
        {stretch.map((p) => (
          <button key={p.key} className={`chip ${key === p.key ? 'active' : ''}`} title={p.label} onClick={() => onApply({ ...p.anchor }, { ...p.pivot })}>
            {p.label.replace('Stretch ', '↔ ')}
          </button>
        ))}
      </div>
      {current && (
        <>
          <div className="hint">
            Đang neo: <b>{describeAnchor(current.anchor)}</b>
            {current.safeArea ? ' · theo safe area' : ''}
          </div>
          <div className="row4">
            <NumField label="Min X" value={current.anchor.minX} step={0.1} min={0} max={1} onChange={(v) => onApply({ ...current.anchor, minX: v }, current.pivot)} />
            <NumField label="Min Y" value={current.anchor.minY} step={0.1} min={0} max={1} onChange={(v) => onApply({ ...current.anchor, minY: v }, current.pivot)} />
            <NumField label="Max X" value={current.anchor.maxX} step={0.1} min={0} max={1} onChange={(v) => onApply({ ...current.anchor, maxX: v }, current.pivot)} />
            <NumField label="Max Y" value={current.anchor.maxY} step={0.1} min={0} max={1} onChange={(v) => onApply({ ...current.anchor, maxY: v }, current.pivot)} />
          </div>
          <div className="row2">
            <NumField label="Pivot X" value={current.pivot.x} step={0.1} min={0} max={1} onChange={(v) => onApply(current.anchor, { ...current.pivot, x: v })} />
            <NumField label="Pivot Y" value={current.pivot.y} step={0.1} min={0} max={1} onChange={(v) => onApply(current.anchor, { ...current.pivot, y: v })} />
          </div>
          <div className="hint">Anchor/pivot theo toạ độ editor (0,0 = góc trên trái). Export sẽ đổi sang Unity (Y hướng lên).</div>
        </>
      )}
    </Section>
  )
}

function NodeProps({ node: n, parentSize, mode }: { node: SceneNode; parentSize: { w: number; h: number } | null; mode: string }): React.JSX.Element {
  const st = useEditor.getState()
  const pageForTop = useCurrentPage()
  const entryForTop = getEntry(pageForTop, n.id)
  const parentIsTopFrame = !!entryForTop?.parent && entryForTop.parent.type === 'frame' && !getEntry(pageForTop, entryForTop.parent.id)?.parent
  const set = (props: Partial<SceneNode>): void => st.setNodeProps(n.id, props)
  return (
    <div className="props">
      <Section title={n.type.toUpperCase()} right={<span className="dim small">{n.id}</span>}>
        <TextField label="Name" value={n.name} onChange={(v) => set({ name: v })} />
        <div className="row2">
          <NumField label="X" value={n.x} onChange={(v) => set({ x: v })} />
          <NumField label="Y" value={n.y} onChange={(v) => set({ y: v })} />
        </div>
        <div className="row2">
          <NumField label="W" value={n.width} min={1} onChange={(v) => set({ width: v, ...(n.type === 'text' ? { autoSize: false } : {}) })} />
          <NumField label="H" value={n.height} min={1} onChange={(v) => set({ height: v, ...(n.type === 'text' ? { autoSize: false } : {}) })} />
        </div>
        <div className="row2">
          <NumField label="Rotate" value={n.rotation} onChange={(v) => set({ rotation: v })} />
          <NumField label="Opacity %" value={Math.round(n.opacity * 100)} min={0} max={100} onChange={(v) => set({ opacity: v / 100 })} />
        </div>
        <div className="row2">
          <Check label="Visible" checked={n.visible} onChange={(v) => set({ visible: v })} />
          <Check label="Locked" checked={n.locked} onChange={(v) => set({ locked: v })} />
        </div>
        {parentSize && (
          <div className="hint">
            Parent {parentSize.w}×{parentSize.h}
          </div>
        )}
      </Section>

      {n.type === 'frame' && <FrameProps n={n} />}
      {n.type === 'rect' && (
        <Section title="Fill">
          <ColorField value={n.fill.color} onChange={(c) => set({ fill: { ...n.fill, color: c } } as Partial<SceneNode>)} />
          <Check label="Fill visible" checked={n.fill.visible} onChange={(v) => set({ fill: { ...n.fill, visible: v } } as Partial<SceneNode>)} />
          <NumField label="Corner radius" value={n.cornerRadius} min={0} onChange={(v) => set({ cornerRadius: v } as Partial<SceneNode>)} />
          <div className="section-title">Stroke</div>
          <ColorField
            value={n.stroke?.color ?? { r: 0, g: 0, b: 0, a: 1 }}
            onChange={(c) => set({ stroke: { width: n.stroke?.width ?? 1, visible: true, color: c } } as Partial<SceneNode>)}
          />
          <div className="row2">
            <NumField label="Width" value={n.stroke?.width ?? 0} min={0} onChange={(v) => set({ stroke: { color: n.stroke?.color ?? { r: 0, g: 0, b: 0, a: 1 }, visible: v > 0, width: v } } as Partial<SceneNode>)} />
            <Check label="Ellipse" checked={(n as { shape?: string }).shape === 'ellipse'} onChange={(v) => set({ shape: v ? 'ellipse' : undefined } as Partial<SceneNode>)} />
            <Check label="Visible" checked={!!n.stroke?.visible} onChange={(v) => set({ stroke: { color: n.stroke?.color ?? { r: 0, g: 0, b: 0, a: 1 }, width: n.stroke?.width ?? 1, visible: v } } as Partial<SceneNode>)} />
          </div>
        </Section>
      )}
      {n.type === 'text' && <TextProps n={n} />}
      {(n.type === 'image' || n.type === 'nineslice') && <ImageProps n={n} />}
      {(n.type === 'image' || n.type === 'nineslice' || n.type === 'text' || n.type === 'group') && <LayerStyleSummary node={n} />}
      {isContainer(n) && n.type === 'group' && (
        <Section title="Group">
          <div className="hint">{n.children.length} children. Ctrl+Shift+G để ungroup, Enter để vào trong.</div>
        </Section>
      )}

      {(n.type === 'frame' || n.type === 'group') && <LayoutSection n={n} />}
      {(n.type === 'frame' || n.type === 'group' || n.type === 'instance') && <ComponentSection n={n} />}
      <AnchorSection current={n} onApply={(anchor, pivot) => set({ anchor, pivot })} />
      {!parentSize || parentIsTopFrame ? (
        <Section title="Safe area">
          <Check label="Neo theo safe area (tai thỏ / home bar)" checked={!!n.safeArea} onChange={(v) => set({ safeArea: v || undefined })} />
          <div className="hint">Khi bật, anchor của node tính theo vùng an toàn của máy thay vì cả màn hình. Xem trước: Shift+D.</div>
        </Section>
      ) : null}

      {mode === 'prototype' && <PrototypeSection n={n} />}

      {n.meta && Object.keys(n.meta).length > 0 && <MetaSection n={n} />}
    </div>
  )
}

function LayoutSection({ n }: { n: FrameNode | GroupNode }): React.JSX.Element {
  const st = useEditor.getState()
  const L = n.layout
  const setL = (patch: Partial<AutoLayout>): void => st.setLayout(n.id, { ...(L ?? defaultLayout(n.width >= n.height ? 'horizontal' : 'vertical')), ...patch })
  return (
    <Section
      title="Auto layout"
      right={
        <button className="mini" onClick={() => (L ? st.setLayout(n.id, undefined) : setL({}))} title="Shift+A">
          {L ? '−' : '+'}
        </button>
      }
    >
      {!L ? (
        <div className="hint">Bấm + để xếp các node con thành hàng/cột tự động (Unity: Horizontal/Vertical Layout Group).</div>
      ) : (
        <>
          <div className="row2">
            <label className="field">
              <span className="field-label">Hướng</span>
              <select value={L.direction} onChange={(e) => setL({ direction: e.target.value as AutoLayout['direction'] })}>
                <option value="horizontal">Ngang →</option>
                <option value="vertical">Dọc ↓</option>
              </select>
            </label>
            <NumField label="Gap" value={L.gap} min={0} onChange={(v) => setL({ gap: v })} />
          </div>
          <div className="row4">
            <NumField label="T" value={L.padding.top} min={0} onChange={(v) => setL({ padding: { ...L.padding, top: v } })} />
            <NumField label="R" value={L.padding.right} min={0} onChange={(v) => setL({ padding: { ...L.padding, right: v } })} />
            <NumField label="B" value={L.padding.bottom} min={0} onChange={(v) => setL({ padding: { ...L.padding, bottom: v } })} />
            <NumField label="L" value={L.padding.left} min={0} onChange={(v) => setL({ padding: { ...L.padding, left: v } })} />
          </div>
          <div className="row2">
            <label className="field">
              <span className="field-label">Căn</span>
              <select value={L.align} onChange={(e) => setL({ align: e.target.value as AutoLayout['align'] })}>
                <option value="start">Đầu</option>
                <option value="center">Giữa</option>
                <option value="end">Cuối</option>
              </select>
            </label>
            {n.type === 'frame' && <Check label="Ôm nội dung" checked={L.hug} onChange={(v) => setL({ hug: v })} />}
          </div>
          <div className="hint">{n.type === 'group' ? 'Group luôn ôm sát nội dung (padding bỏ qua).' : 'Frame có thể giữ kích thước cố định (bỏ "Ôm nội dung").'}</div>
        </>
      )}
    </Section>
  )
}

function ComponentSection({ n }: { n: FrameNode | GroupNode | InstanceNode }): React.JSX.Element {
  const st = useEditor.getState()
  const doc = useEditor((s) => s.doc)
  if (n.type === 'instance') {
    const master = findMaster(doc, n.componentId)
    const name = master ? ((master.node as GroupNode).component?.name ?? master.node.name) : '(mất master)'
    // overridable children: texts + images (visibility) from the master
    const kids: { id: string; name: string; type: string; text?: string }[] = []
    const walk = (list: SceneNode[]): void => {
      for (const c of list) {
        if (c.type === 'text') kids.push({ id: c.id, name: c.name, type: 'text', text: c.text })
        else if (c.type === 'image' || c.type === 'nineslice') kids.push({ id: c.id, name: c.name, type: 'image' })
        if (isContainer(c) && c.type !== 'instance') walk(c.children)
      }
    }
    if (master) walk(master.node.children)
    return (
      <Section title="Instance">
        <div className="kv">
          <span>Component</span>
          <span>{name}</span>
        </div>
        <div className="row2">
          <button onClick={() => st.select([n.componentId])}>Tới master</button>
          <button onClick={() => st.detachInstance(n.id)} title="Ctrl+Alt+B">
            Detach
          </button>
        </div>
        {kids.length > 0 && <div className="section-title">Overrides</div>}
        {kids.map((k) => {
          const ov = n.overrides[k.id] ?? {}
          return (
            <div key={k.id} className="ov-row">
              <Check label={k.name} checked={ov.visible ?? true} onChange={(v) => st.setOverride(n.id, k.id, { visible: v })} />
              {k.type === 'text' && <TextField value={ov.text ?? k.text ?? ''} onChange={(v) => st.setOverride(n.id, k.id, { text: v })} />}
            </div>
          )
        })}
        <div className="hint">Instance cập nhật theo master; chỉ text và ẩn/hiện được ghi đè. Export giữ tên component để Unity tạo prefab.</div>
      </Section>
    )
  }
  const isMaster = !!n.component
  const count = Object.values(doc.pages).reduce((acc, p) => acc + countInstances(p.children, n.id), 0)
  return (
    <Section title="Component">
      {isMaster ? (
        <>
          <TextField label="Tên" value={n.component!.name} onChange={(v) => st.update((d) => {
            const pg = d.pages.find((p) => p.id === st.pageId) ?? d.pages[0]
            const l = locate(pg, n.id)
            if (l && (l.node.type === 'frame' || l.node.type === 'group')) l.node.component = { name: v }
            if (d.components?.[n.id]) d.components[n.id].name = v
          })} />
          <div className="kv">
            <span>Instances</span>
            <span>{count}</span>
          </div>
          <StateRow master={n} />
          <div className="hint">Sửa master là mọi instance đổi theo. Chèn instance từ tab Assets.</div>
        </>
      ) : (
        <button onClick={st.createComponent} title="Ctrl+Alt+K">
          ◈ Create component
        </button>
      )}
    </Section>
  )
}

function StateRow({ master }: { master: FrameNode | GroupNode }): React.JSX.Element {
  const st = useEditor.getState()
  const sc = stateChildren(master)
  const have = Object.keys(sc) as StateName[]
  const missing = STATE_NAMES.filter((s) => !sc[s])
  const visible = have.find((s) => sc[s]?.visible)
  return (
    <div className="state-row">
      <div className="field-label">Trạng thái (Unity Button)</div>
      <div className="dir-row">
        {have.map((s) => (
          <button key={s} className={`chip ${visible === s ? 'active' : ''}`} onClick={() => st.showState(master.id, s)} title={`Hiện lớp ${s}`}>
            {s}
          </button>
        ))}
        {missing.length > 0 && (
          <select value="" onChange={(e) => e.target.value && st.addState(master.id, e.target.value)} title="Thêm trạng thái (bản sao của normal)">
            <option value="">+ thêm…</option>
            {missing.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="hint">{have.length ? 'Mỗi trạng thái là một lớp con tên normal/hover/pressed/disabled/selected; export thành Button SpriteState.' : 'Chưa có trạng thái. Chọn "+ thêm…" để tạo pressed/disabled…; nội dung hiện tại thành lớp "normal".'}</div>
    </div>
  )
}

function countInstances(list: SceneNode[], componentId: string): number {
  let n = 0
  for (const c of list) {
    if (c.type === 'instance' && c.componentId === componentId) n++
    if (isContainer(c) && c.type !== 'instance') n += countInstances(c.children, componentId)
  }
  return n
}

function FrameProps({ n }: { n: FrameNode }): React.JSX.Element {
  const st = useEditor.getState()
  const page = useCurrentPage()
  const isTop = !getEntry(page, n.id)?.parent
  const set = (props: Partial<FrameNode>): void => st.setNodeProps(n.id, props as Partial<SceneNode>)
  return (
    <Section title="Frame">
      <label className="field">
        <span className="field-label">Preset</span>
        <select
          value=""
          onChange={(e) => {
            const p = FRAME_PRESETS.find((x) => x.name === e.target.value)
            if (p) set({ width: p.width, height: p.height })
          }}
        >
          <option value="">Chọn kích thước...</option>
          {FRAME_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <ColorField label="Fill" value={n.fill.color} onChange={(c) => set({ fill: { ...n.fill, color: c } })} />
      <Check label="Fill visible" checked={n.fill.visible} onChange={(v) => set({ fill: { ...n.fill, visible: v } })} />
      <Check label="Clip content" checked={n.clipsContent} onChange={(v) => set({ clipsContent: v })} />
      {isTop && (
        <button className={page.startFrameId === n.id ? 'accent' : ''} onClick={() => st.setStartFrame(page.startFrameId === n.id ? undefined : n.id)}>
          {page.startFrameId === n.id ? '▶ Flow start (bỏ)' : 'Đặt làm Flow start'}
        </button>
      )}
      {isTop && (
        <>
          <button onClick={() => st.autoAnchor([n.id])} title="Ctrl+Alt+A">
            ⚓ Tự neo anchor theo rule
          </button>
          <div className="hint">Nửa trên → Top, nửa dưới → Bottom, sát trái/phải → Left/Right, giữa → Center, nền full → stretch; node neo theo mép đi theo safe area. Node đã chỉnh tay giữ nguyên.</div>
        </>
      )}
    </Section>
  )
}

const FX_LABELS: Record<string, string> = { bevel: 'Bevel & Emboss', stroke: 'Stroke', innerShadow: 'Inner Shadow', innerGlow: 'Inner Glow', satin: 'Satin', solidFill: 'Color Overlay', gradientOverlay: 'Gradient Overlay', patternOverlay: 'Pattern Overlay', outerGlow: 'Outer Glow', dropShadow: 'Drop Shadow' }

function LayerStyleSummary({ node }: { node: SceneNode }): React.JSX.Element {
  const fx = ((node as { effects?: Record<string, unknown> }).effects ?? {}) as Record<string, unknown>
  const on = Object.keys(FX_LABELS).filter((k) => {
    const v = fx[k]
    const e = Array.isArray(v) ? v[0] : v
    return e && (e as { enabled?: boolean }).enabled !== false
  })
  const img = node.type === 'image' || node.type === 'nineslice'
  const editable = !img || !!(node as { sourceAssetId?: string }).sourceAssetId
  return (
    <Section title="Layer Style">
      <button className={on.length ? 'accent' : ''} disabled={!editable} onClick={() => window.dispatchEvent(new CustomEvent('dm:layer-style'))} title="Ctrl+Shift+L, hoặc double-click chữ fx ở panel Layers">
        fx  Layer Style…
      </button>
      {on.length ? <div className="hint">{on.map((k) => FX_LABELS[k]).join(' · ')}</div> : <div className="hint">Chưa có style. Bấm để thêm như Photoshop.</div>}
      {!editable && <div className="hint">Ảnh này import từ bản cũ, không có pixel gốc. Import lại PSD để chỉnh.</div>}
    </Section>
  )
}

function TextProps({ n }: { n: TextNode }): React.JSX.Element {
  const st = useEditor.getState()
  const set = (props: Partial<TextNode>): void => st.setNodeProps(n.id, props as Partial<SceneNode>)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(n.text)
  useEffect(() => setText(n.text), [n.text])
  useEffect(() => {
    const h = (e: Event): void => {
      if ((e as CustomEvent).detail === n.id) {
        ref.current?.focus()
        ref.current?.select()
      }
    }
    window.addEventListener('dm:edit-text', h)
    return () => window.removeEventListener('dm:edit-text', h)
  }, [n.id])
  return (
    <Section title="Text">
      <textarea
        ref={ref}
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== n.text && set({ text })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
          if (e.key === 'Enter' && e.ctrlKey) (e.target as HTMLTextAreaElement).blur()
        }}
      />
      <label className="field">
        <span className="field-label">Font</span>
        <input type="text" list="dm-font-families" value={n.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} title="Font đã cài trên Windows hoặc trong thư mục fonts/ của project" />
        <datalist id="dm-font-families">
          {fontFamilies().map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </label>
      <div className="row2">
        <NumField label="Size" value={n.fontSize} min={1} onChange={(v) => set({ fontSize: v })} />
        <NumField label="Weight" value={n.fontWeight} min={100} max={900} step={100} onChange={(v) => set({ fontWeight: v })} />
      </div>
      <div className="row2">
        <Check label="Italic" checked={!!n.italic} onChange={(v) => set({ italic: v })} />
        <Check label="UPPERCASE" checked={!!n.uppercase} onChange={(v) => set({ uppercase: v })} />
      </div>
      <NumField label="Letter spacing" value={n.letterSpacing ?? 0} onChange={(v) => set({ letterSpacing: v })} />
      <div className="row2">
        <NumField label="Line height" value={n.lineHeight} step={0.1} min={0.5} onChange={(v) => set({ lineHeight: v })} />
        <label className="field">
          <span className="field-label">Align</span>
          <select value={n.align} onChange={(e) => set({ align: e.target.value as TextNode['align'] })}>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
      </div>
      <ColorField label="Color" value={n.color} onChange={(c) => set({ color: c })} />
      <Check label="Auto size" checked={n.autoSize} onChange={(v) => set({ autoSize: v })} />
    </Section>
  )
}

function ImageProps({ n }: { n: SceneNode & { assetId: string } }): React.JSX.Element {
  const st = useEditor.getState()
  const editSlices = useEditor((s) => s.editSlices)
  const asset = useEditor((s) => s.doc.assets[n.assetId])
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (asset) void getBlobUrl(asset).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [asset])
  const ns = n.type === 'nineslice' ? (n as NineSliceNode) : null
  const setIns = (patch: Partial<NineSliceNode['insets']>): void => {
    if (!ns) return
    st.setNodeProps(n.id, { insets: { ...ns.insets, ...patch } } as Partial<SceneNode>)
  }
  return (
    <Section title={ns ? '9-Slice' : 'Image'}>
      <div className="asset-preview">
        {url && <img src={url} alt="" />}
        <div className="small dim">
          {asset ? `${asset.file} · ${asset.width}×${asset.height}` : 'asset missing'}
          {asset?.source && <div title={asset.source}>{asset.source}</div>}
        </div>
      </div>
      <button onClick={() => window.dispatchEvent(new CustomEvent('dm:image-edit'))} title="Ctrl+Shift+U">
        Chỉnh ảnh: crop · lật · xoay · màu…
      </button>
      {(n as { edits?: unknown }).edits ? <div className="hint">Đã có chỉnh sửa ảnh (không phá huỷ, tính lại từ ảnh gốc).</div> : null}
      <div className="row2">
        <button onClick={() => asset && st.setNodeProps(n.id, { width: asset.width, height: asset.height })}>Reset size</button>
        {ns ? <button onClick={() => st.convertToImage(n.id)}>→ Image thường</button> : <button onClick={() => st.convertToNineSlice(n.id)}>→ 9-Slice</button>}
      </div>
      {ns && (
        <>
          <div className="row4">
            <NumField label="L" value={ns.insets.left} min={0} onChange={(v) => setIns({ left: v })} />
            <NumField label="T" value={ns.insets.top} min={0} onChange={(v) => setIns({ top: v })} />
            <NumField label="R" value={ns.insets.right} min={0} onChange={(v) => setIns({ right: v })} />
            <NumField label="B" value={ns.insets.bottom} min={0} onChange={(v) => setIns({ bottom: v })} />
          </div>
          <button className={editSlices ? 'accent' : ''} onClick={() => st.setEditSlices(!editSlices)}>
            {editSlices ? 'Xong chỉnh slice' : 'Chỉnh slice trên canvas'}
          </button>
          <div className="hint">Border tính theo pixel ảnh gốc (giống Sprite Editor của Unity). Kéo 4 đường hồng trên canvas để chỉnh.</div>
        </>
      )}
    </Section>
  )
}

function MetaSection({ n }: { n: SceneNode }): React.JSX.Element {
  const st = useEditor.getState()
  const page = useCurrentPage()
  const meta = n.meta ?? {}
  const psdText = meta.psdText as { text?: string; font?: string; fontSize?: number; color?: string } | undefined
  return (
    <Section title="Meta (PSD)">
      {psdText?.text && (
        <>
          <div className="kv">
            <span>Text</span>
            <span className="small">{psdText.text}</span>
          </div>
          <div className="kv">
            <span>Font</span>
            <span className="small">
              {psdText.font ?? '?'} {psdText.fontSize ? Math.round(psdText.fontSize) : ''} {psdText.color ?? ''}
            </span>
          </div>
          <button
            onClick={() => {
              const e = getEntry(page, n.id)
              const t = createText(n.name, n.x, n.y, psdText.text ?? '')
              t.fontFamily = psdText.font ?? t.fontFamily
              t.fontSize = psdText.fontSize ? Math.round(psdText.fontSize) : t.fontSize
              const c = psdText.color ? hexToRgba(psdText.color) : null
              if (c) t.color = c
              t.meta = { fromPsdImage: n.id }
              st.addNode(t, e?.parent?.id ?? null, (e?.index ?? 0) + 1)
            }}
          >
            Tạo Text node từ chữ PSD
          </button>
        </>
      )}
      {Object.entries(meta)
        .filter(([k]) => k !== 'psdText')
        .map(([k, v]) => (
          <div className="kv" key={k}>
            <span>{k}</span>
            <span className="small dim">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
          </div>
        ))}
    </Section>
  )
}
