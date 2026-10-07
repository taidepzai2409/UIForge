// Components for game links: turns repeated UI of a pushed game (the same button on five screens, the rows of
// a shop list…) into one component master + instances, so an edit in the app happens once and the game's
// agent changes the one piece of code that builds it.
//
// Components come from
//   1. the game: an element with `component: "<name>"` (push_game_design), or a recipe rule
//      `components: [{ name, match, code }]` (capture_game) — the game's own widgets;
//   2. detection (`autoComponents`, on by default): groups with the same structure and art, which only differ
//      by their texts, overall size or a hidden part.
//
// The masters live on a pseudo-screen `__components` (a frame "Components" on the game page) so they get a
// baseline, diffs and art replacement like any screen; occurrences become instances with overrides.
// Pure module (no DOM / Pixi).
import type { GameDesign, GameElement, GameScreen } from './game'

export const COMPONENTS_SCREEN = '__components'

export interface GameComponentRule {
  name: string
  /** regular expression tested against element ids (and names), case-insensitive */
  match: string
  /** where the game builds this widget, e.g. "src/ui/widgets.ts button()" */
  code?: string
}

export interface PreparedComponent {
  name: string
  code?: string
  width: number
  height: number
  occurrences: { screenId: string; elementId: string }[]
  source: 'game' | 'rule' | 'auto'
}

export interface PreparedDesign {
  design: GameDesign
  components: PreparedComponent[]
  notes: string[]
  /** structure signature of each component (kept in the link so later pushes recognise single occurrences) */
  signatures: Record<string, string>
}

/** What earlier pushes decided, so a partial capture (`only`) does not undo components. */
export interface PriorComponents {
  /** "<screenId>\n<elementId>" → component name */
  assigned: Record<string, string>
  /** structure signature → component name */
  signatures: Record<string, string>
}

interface Found {
  el: GameElement
  screen: GameScreen
  parent: GameElement | null
}

const LEAF_ORDER: Record<string, number> = { image: 0, nineslice: 1, rect: 2, text: 3, group: 4 }

function walk(els: GameElement[], screen: GameScreen, parent: GameElement | null, out: Found[]): void {
  for (const el of els) {
    out.push({ el, screen, parent })
    if (el.children) walk(el.children, screen, el, out)
  }
}

/** Leaves of an occurrence (a nested component counts as one leaf), in a position order shared by all its copies. */
function leaves(root: GameElement): GameElement[] {
  const out: GameElement[] = []
  const visit = (list: GameElement[]): void => {
    for (const c of list) {
      if (c.component || !c.children?.length) out.push(c)
      else visit(c.children)
    }
  }
  visit(root.children ?? [])
  const w = Math.max(1, root.width)
  const h = Math.max(1, root.height)
  const key = (c: GameElement): [number, number, number] => [c.component ? 5 : (LEAF_ORDER[c.type] ?? 6), Math.round(((c.y + c.height / 2 - root.y) / h) * 20), Math.round(((c.x + c.width / 2 - root.x) / w) * 20)]
  return out
    .map((c) => ({ c, k: key(c) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2])
    .map((x) => x.c)
}

/** Structure of a group independent of its texts and of its overall scale. */
function signature(root: GameElement): string | null {
  const ls = leaves(root)
  if (ls.length < 2 || ls.length > 24) return null
  if (!ls.some((c) => (c.type === 'image' || c.type === 'nineslice') && c.asset)) return null
  const w = Math.max(1, root.width)
  const h = Math.max(1, root.height)
  const q = (v: number): number => Math.round(v * 20)
  return JSON.stringify([
    Math.round((w / h) * 10),
    ls.map((c) =>
      c.component
        ? ['c', c.component, q((c.x - root.x) / w), q((c.y - root.y) / h)]
        : c.type === 'text'
          ? ['t', q((c.y + c.height / 2 - root.y) / h)]
          : [c.type, c.asset ?? (c.snapshot ? 'snap' : c.fill ?? ''), c.crop ? `${c.crop.x},${c.crop.y}` : '', q((c.x - root.x) / w), q((c.y - root.y) / h), q(c.width / w), q(c.height / h)]
    )
  ])
}

function lastSegment(id: string): string {
  return id.split('/').pop()!.replace(/~\d+$/, '')
}

function nameFor(found: Found[], taken: Set<string>): string {
  const names = found.map((f) => lastSegment(f.el.name || f.el.id))
  let base = names[0]
  if (!names.every((n) => n === base)) {
    // common prefix ("btn_play", "btn_shop" → "btn"), else the main art's file name
    let p = names[0]
    for (const n of names) while (p && !n.startsWith(p)) p = p.slice(0, -1)
    p = p.replace(/[_\-\s.~]+$/, '')
    const art = leaves(found[0].el).find((c) => c.asset)?.asset?.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
    base = p.length >= 3 ? p : (art ?? 'component')
  }
  base = base.replace(/[_\-\s]*\d+$/, '').replace(/[^a-zA-Z0-9_\-]+/g, '_') || 'component'
  let name = base
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}_${i}`
  taken.add(name.toLowerCase())
  return name
}

function isInside(a: Found, b: Found, parents: Map<GameElement, GameElement | null>): boolean {
  let p = parents.get(a.el) ?? null
  while (p) {
    if (p === b.el) return true
    p = parents.get(p) ?? null
  }
  return false
}

function relId(id: string, rootId: string): string {
  return id.startsWith(rootId + '/') ? id.slice(rootId.length + 1) : id.replace(/\//g, '_')
}

/**
 * Marks component occurrences in a (copied) design and adds the `__components` pseudo-screen with one master
 * per component. Occurrences keep their children (overrides are computed from them) and get
 * `componentMap`: occurrence element id → master child id.
 */
export function prepareComponents(input: GameDesign, prior: PriorComponents = { assigned: {}, signatures: {} }): PreparedDesign {
  const design = JSON.parse(JSON.stringify(input)) as GameDesign
  design.screens = design.screens.filter((s) => s.id !== COMPONENTS_SCREEN)
  const notes: string[] = []
  const all: Found[] = []
  for (const s of design.screens) walk(s.elements, s, null, all)
  const parents = new Map<GameElement, GameElement | null>(all.map((f) => [f.el, f.parent]))
  const source = new Map<string, PreparedComponent['source']>()
  const codes = new Map<string, string>()

  for (const f of all) if (f.el.component) source.set(f.el.component, 'game')
  // what earlier pushes made a component stays one (also when this push sees a single occurrence)
  for (const f of all) {
    const name = prior.assigned[`${f.screen.id}\n${f.el.id}`]
    if (name && !f.el.component && f.el.type === 'group' && f.el.children?.length) {
      f.el.component = name
      if (!source.has(name)) source.set(name, 'auto')
    }
  }
  // 1. recipe rules
  for (const r of design.components ?? []) {
    let re: RegExp
    try {
      re = new RegExp(r.match, 'i')
    } catch {
      notes.push(`component "${r.name}": regex không hợp lệ ${r.match}`)
      continue
    }
    let n = 0
    for (const f of all) {
      if (f.el.component || f.el.type !== 'group' || !f.el.children?.length) continue
      if (re.test(f.el.id) || (f.el.name && re.test(f.el.name))) {
        f.el.component = r.name
        n++
      }
    }
    if (!n) notes.push(`component "${r.name}": không element (group) nào khớp ${r.match}`)
    source.set(r.name, 'rule')
    if (r.code) codes.set(r.name, r.code)
  }
  // 2. detection: same structure + art, found at least twice, not the screen's whole content
  if (design.autoComponents !== false) {
    const bySig = new Map<string, Found[]>()
    for (const f of all) {
      const el = f.el
      if (el.component || el.type !== 'group' || !el.children?.length) continue
      if (el.width * el.height > 0.4 * f.screen.width * f.screen.height) continue
      // inside an occurrence that is already a component: that component covers it
      let p = f.parent
      let covered = false
      while (p && !covered) {
        if (p.component) covered = true
        p = parents.get(p) ?? null
      }
      if (covered) continue
      const sig = signature(el)
      if (!sig) continue
      bySig.set(sig, [...(bySig.get(sig) ?? []), f])
    }
    const taken = new Set<string>([...Array.from(source.keys()), ...Object.values(prior.signatures)].map((k) => k.toLowerCase()))
    // a known structure joins its component even alone
    for (const [sig, list] of bySig) {
      const name = prior.signatures[sig]
      if (!name) continue
      for (const f of list) if (!f.el.component) f.el.component = name
      if (!source.has(name)) source.set(name, 'auto')
      bySig.delete(sig)
    }
    // bigger groups first, so a repeated card wins over the repeated button inside it
    const groups = Array.from(bySig.values())
      .filter((g) => g.length >= 2)
      .sort((a, b) => b[0].el.width * b[0].el.height - a[0].el.width * a[0].el.height)
    for (const g of groups) {
      const free = g.filter((f) => !f.el.component && !all.some((o) => o.el.component && o.el !== f.el && (isInside(f, o, parents) || isInside(o, f, parents)) && source.get(o.el.component!) === 'auto'))
      if (free.length < 2) continue
      const name = nameFor(free, taken)
      for (const f of free) f.el.component = name
      source.set(name, 'auto')
    }
  }

  // occurrences per component (an occurrence nested in another occurrence of the same component is dropped)
  const occ = new Map<string, Found[]>()
  for (const f of all) if (f.el.component) occ.set(f.el.component, [...(occ.get(f.el.component) ?? []), f])
  for (const [name, list] of occ) {
    let keep = list.filter((f) => !list.some((o) => o !== f && isInside(f, o, parents)))
    // a detected structure must really repeat (a wrapper around a copy of itself does not count)
    const known = Object.values(prior.signatures).includes(name) || list.some((f) => prior.assigned[`${f.screen.id}
${f.el.id}`] === name)
    if (source.get(name) === 'auto' && keep.length < 2 && !known) keep = []
    for (const f of list) if (!keep.includes(f)) delete f.el.component
    if (keep.length) occ.set(name, keep)
    else occ.delete(name)
  }

  // nested components first: a master that contains an instance needs that instance's master to exist
  const order: string[] = []
  const visiting = new Set<string>()
  const visit = (name: string): void => {
    if (order.includes(name) || visiting.has(name)) return
    visiting.add(name)
    const rep = occ.get(name)?.[0]?.el
    const inner = new Set<string>()
    const find = (list: GameElement[]): void => {
      for (const c of list) {
        if (c.component && c.component !== name) inner.add(c.component)
        else if (c.children) find(c.children)
      }
    }
    if (rep?.children) find(rep.children)
    for (const i of inner) visit(i)
    visiting.delete(name)
    order.push(name)
  }
  for (const name of Array.from(occ.keys()).sort()) visit(name)

  const masters: GameElement[] = []
  const components: PreparedComponent[] = []
  const signatures: Record<string, string> = {}
  const GAP = 60
  let y = GAP
  let maxW = 0
  for (const name of order) {
    const list = occ.get(name)!
    if (!list.length) continue
    // the most complete occurrence is the master
    const rep = list.reduce((best, f) => (leaves(f.el).length > leaves(best.el).length ? f : best), list[0])
    const repLeaves = leaves(rep.el)
    const ox = GAP - rep.el.x
    const oy = y - rep.el.y
    const idMap = new Map<string, string>()
    const copy = (e: GameElement): GameElement => {
      const id = `${name}/${relId(e.id, rep.el.id)}`
      idMap.set(e.id, id)
      const out: GameElement = { ...e, id, x: e.x + ox, y: e.y + oy, origin: { screenId: rep.screen.id, elementId: e.id } }
      delete out.componentMap
      if (e.children) out.children = e.children.map(copy)
      return out
    }
    const master: GameElement = { ...rep.el, id: name, name, x: GAP, y, master: name, children: (rep.el.children ?? []).map(copy), origin: { screenId: rep.screen.id, elementId: rep.el.id } }
    delete master.component
    delete master.componentMap
    master.code = codes.get(name) ?? rep.el.code
    // nested occurrences inside the master keep their maps, with keys renamed to the master copy's ids
    const fixMaps = (e: GameElement, orig: GameElement): void => {
      if (orig.componentMap) {
        e.componentMap = {}
        for (const [k, v] of Object.entries(orig.componentMap)) e.componentMap[idMap.get(k) ?? k] = v
      }
      e.children?.forEach((c, i) => fixMaps(c, orig.children![i]))
    }
    master.children!.forEach((c, i) => fixMaps(c, rep.el.children![i]))

    // texts: when every occurrence centres (or right-aligns) a text, the master's text box spans the
    // component so any label length stays in place
    const masterLeaves = leaves(master)
    if (list.length >= 2) {
      repLeaves.forEach((rl, i) => {
        if (rl.type !== 'text') return
        const ml = masterLeaves[i]
        const rel = list.map((f) => {
          const t = leaves(f.el)[i]
          if (!t || t.type !== 'text') return null
          const w = Math.max(1, f.el.width)
          return { c: (t.x + t.width / 2 - f.el.x) / w, r: (t.x + t.width - f.el.x) / w }
        })
        if (rel.some((r) => !r)) return
        const cs = rel.map((r) => r!.c)
        const rs = rel.map((r) => r!.r)
        const spread = (v: number[]): number => Math.max(...v) - Math.min(...v)
        if (spread(cs) < 0.04) {
          const c = cs.reduce((a, b) => a + b, 0) / cs.length
          const half = Math.min(c, 1 - c) * master.width
          ml.align = 'center'
          ml.x = master.x + c * master.width - half
          ml.width = half * 2
        } else if (spread(rs) < 0.04) {
          const r = rs.reduce((a, b) => a + b, 0) / rs.length
          ml.align = 'right'
          ml.width = r * master.width
          ml.x = master.x
        }
      })
    }

    // each occurrence: its leaves → the master's leaves (same id under the occurrence, else same position in order)
    const relOfMaster = new Map<string, string>()
    for (const ml of masterLeaves) relOfMaster.set(relId(ml.id, name), ml.id)
    for (const f of list) {
      const ls = leaves(f.el)
      const map: Record<string, string> = {}
      const used = new Set<string>()
      for (const l of ls) {
        const byId = relOfMaster.get(relId(l.id, f.el.id))
        if (byId && !used.has(byId)) {
          map[l.id] = byId
          used.add(byId)
        }
      }
      const rest = masterLeaves.filter((m) => !used.has(m.id))
      const free = ls.filter((l) => !map[l.id])
      for (const l of free) {
        const i = rest.findIndex((m) => (m.component ?? m.type) === (l.component ?? l.type))
        if (i < 0) continue
        map[l.id] = rest[i].id
        used.add(rest[i].id)
        rest.splice(i, 1)
      }
      const unmatched = free.filter((l) => !map[l.id]).length
      if (unmatched) notes.push(`${f.screen.id}/${f.el.id}: ${unmatched} phần tử không có trong master "${name}" (không hiện trong instance)`)
      f.el.componentMap = map
    }

    const sig = signature(rep.el)
    if (sig) signatures[name] = sig
    masters.push(master)
    components.push({ name, code: master.code, width: master.width, height: master.height, occurrences: list.map((f) => ({ screenId: f.screen.id, elementId: f.el.id })), source: source.get(name) ?? 'auto' })
    y += master.height + GAP
    maxW = Math.max(maxW, master.width)
  }

  if (masters.length) {
    design.screens.unshift({ id: COMPONENTS_SCREEN, name: 'Components', kind: 'screen', width: Math.ceil(maxW + GAP * 2), height: Math.ceil(y), background: '#2b2b33', code: 'các widget dùng chung của game', elements: masters })
  }
  return { design, components, notes, signatures }
}
