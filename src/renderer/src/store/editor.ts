import { create } from 'zustand'
import { produce } from 'immer'
import type {
  Connection,
  ContainerNode,
  DesignDocument,
  NodeId,
  Page,
  SceneNode,
} from '@/model/types'
import { isContainer } from '@/model/types'
import { createDocument, createGroup, createImage, createNineSlice, createPage, newId } from '@/model/create'
import { cloneNodeDeep, fitAllGroups, getEntry, indexPage } from '@/model/nodes'
import { applyAutoLayouts } from '@/model/autoLayout'
import { applyAnchorSuggestions, suggestAnchors, type AutoAnchorRules } from '@/model/autoAnchor'
import { DEFAULT_OVERLAY, defaultsForAction, normalizeConnection, normalizePage } from '@/model/flows'
import { stateChildren } from '@/model/states'
import { expandInstances, findMaster, usesComponent } from '@/model/instances'
import { createInstance } from '@/model/create'
import type { AutoLayout, ImageEdits, InstanceOverride, ContainerNode as CNode, FrameNode, GroupNode } from '@/model/types'

export type Tool = 'select' | 'hand' | 'frame' | 'rect' | 'text'
export type Mode = 'design' | 'prototype'

export interface ViewState {
  x: number
  y: number
  zoom: number
}

interface Located {
  node: SceneNode
  parent: ContainerNode | null
  list: SceneNode[]
  index: number
}

/** Locate a node inside a (draft) page by walking the tree. */
export function locate(page: Page, id: NodeId): Located | null {
  const walk = (list: SceneNode[], parent: ContainerNode | null): Located | null => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i]
      if (n.id === id) return { node: n, parent, list, index: i }
      if (isContainer(n)) {
        const r = walk(n.children, n)
        if (r) return r
      }
    }
    return null
  }
  return walk(page.children, null)
}

export interface EditorState {
  doc: DesignDocument
  projectDir: string | null
  dirty: boolean
  pageId: string
  selection: NodeId[]
  scopeId: NodeId | null
  tool: Tool
  mode: Mode
  view: ViewState
  editSlices: boolean
  presenting: boolean
  /** frame to start Present from (overrides page.startFrameId once) */
  presentFrom: NodeId | null
  selectedConnectionId: string | null
  past: DesignDocument[]
  future: DesignDocument[]
  status: string
  canvasSize: { width: number; height: number }
  notice: { title: string; lines: string[]; kind: 'info' | 'warning' | 'error' } | null
  showRulers: boolean

  // --- document lifecycle ---
  setDoc: (doc: DesignDocument, projectDir: string | null) => void
  setProjectDir: (dir: string | null) => void
  markSaved: () => void
  setStatus: (s: string) => void
  setNotice: (n: EditorState['notice']) => void
  setShowRulers: (v: boolean) => void

  // --- history ---
  snapshot: () => void
  undo: () => void
  redo: () => void

  // --- generic mutation ---
  update: (fn: (doc: DesignDocument) => void, opts?: { history?: boolean }) => void
  updatePage: (fn: (page: Page) => void, opts?: { history?: boolean }) => void

  // --- ui state ---
  select: (ids: NodeId[], opts?: { toggle?: boolean; add?: boolean }) => void
  setScope: (id: NodeId | null) => void
  setTool: (t: Tool) => void
  setMode: (m: Mode) => void
  setView: (v: ViewState) => void
  setEditSlices: (v: boolean) => void
  setPresenting: (v: boolean, fromFrameId?: NodeId | null) => void
  setSelectedConnection: (id: string | null) => void
  setPage: (id: string) => void
  setCanvasSize: (w: number, h: number) => void

  // --- node ops ---
  setNodeProps: (id: NodeId, props: Partial<SceneNode>, opts?: { history?: boolean }) => void
  setSelectionProps: (props: Partial<SceneNode>, opts?: { history?: boolean }) => void
  addNode: (node: SceneNode, parentId: NodeId | null, index?: number) => void
  deleteSelection: () => void
  duplicateSelection: () => void
  groupSelection: () => void
  ungroupSelection: () => void
  moveSelection: (dx: number, dy: number, opts?: { history?: boolean }) => void
  reorderSelection: (dir: 'front' | 'back' | 'forward' | 'backward') => void
  reparent: (id: NodeId, newParentId: NodeId | null, index: number) => void
  convertToNineSlice: (id: NodeId) => void
  convertToImage: (id: NodeId) => void
  toggleVisible: (id: NodeId) => void
  toggleLocked: (id: NodeId) => void
  renameNode: (id: NodeId, name: string) => void

  // --- components / layout / image edits ---
  createComponent: () => void
  createInstanceOf: (componentId: NodeId, parentId: NodeId | null, x: number, y: number) => void
  detachInstance: (id: NodeId) => void
  setOverride: (instanceId: NodeId, masterChildId: NodeId, patch: InstanceOverride) => void
  setLayout: (id: NodeId, layout: AutoLayout | undefined) => void
  setImageEdits: (id: NodeId, edits: ImageEdits | undefined) => void
  /** rule-based anchors for the top-level nodes of the given frames (default: frames of the selection) → number changed */
  autoAnchor: (frameIds?: NodeId[], rules?: Partial<AutoAnchorRules>) => number
  /** show one state layer of a component master (hides the others) */
  showState: (masterId: NodeId, state: string) => void
  /** adds a state layer by duplicating the "normal" one (or wrapping the current content as "normal" first) */
  addState: (masterId: NodeId, state: string) => void

  // --- prototype ops ---
  addConnection: (from: NodeId, to: NodeId | undefined, init?: Partial<Connection>) => void
  updateConnection: (id: string, patch: Partial<Connection>) => void
  removeConnection: (id: string) => void
  setStartFrame: (id: NodeId | undefined) => void

  // --- pages ---
  addPage: () => void
  renamePage: (id: string, name: string) => void
  deletePage: (id: string) => void
}

const HISTORY_LIMIT = 200

export const useEditor = create<EditorState>((set, get) => {
  const currentPage = (doc: DesignDocument, pageId: string): Page => doc.pages.find((p) => p.id === pageId) ?? doc.pages[0]

  const mutate = (fn: (doc: DesignDocument) => void, history = true): void => {
    const s = get()
    const next = produce(s.doc, (draft) => {
      fn(draft)
      // post pass: auto layout → derived instance children → group bounds
      for (const p of draft.pages) applyAutoLayouts(p.children)
      for (const p of draft.pages) fitAllGroups(p.children)
      expandInstances(draft)
      for (const p of draft.pages) fitAllGroups(p.children)
    })
    if (next === s.doc) return
    if (history) {
      set({ doc: next, dirty: true, past: [...s.past.slice(-HISTORY_LIMIT), s.doc], future: [] })
    } else {
      set({ doc: next, dirty: true })
    }
  }

  const mutatePage = (fn: (page: Page) => void, history = true): void => {
    const pageId = get().pageId
    mutate((doc) => fn(currentPage(doc, pageId)), history)
  }

  const initial = createDocument()

  return {
    doc: initial,
    projectDir: null,
    dirty: false,
    pageId: initial.pages[0].id,
    selection: [],
    scopeId: null,
    tool: 'select',
    mode: 'design',
    view: { x: 80, y: 80, zoom: 0.5 },
    editSlices: false,
    presenting: false,
    presentFrom: null,
    selectedConnectionId: null,
    past: [],
    future: [],
    status: '',
    canvasSize: { width: 800, height: 600 },
    notice: null,
    showRulers: true,

    setDoc: (doc, projectDir) =>
      set({
        doc: (() => {
          for (const p of doc.pages) normalizePage(p)
          return doc
        })(),
        projectDir,
        dirty: false,
        pageId: doc.pages[0].id,
        selection: [],
        scopeId: null,
        past: [],
        future: [],
        selectedConnectionId: null,
        editSlices: false
      }),
    setProjectDir: (dir) => set({ projectDir: dir }),
    markSaved: () => set({ dirty: false }),
    setStatus: (status) => set({ status }),
    setNotice: (notice) => set({ notice }),
    setShowRulers: (showRulers) => set({ showRulers }),

    snapshot: () => {
      const s = get()
      set({ past: [...s.past.slice(-HISTORY_LIMIT), s.doc], future: [] })
    },
    undo: () => {
      const s = get()
      if (!s.past.length) return
      const prev = s.past[s.past.length - 1]
      set({ doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], dirty: true })
      // drop selection of nodes that no longer exist
      const page = currentPage(prev, s.pageId)
      const idx = indexPage(page)
      set({ selection: s.selection.filter((id) => idx.byId.has(id)) })
    },
    redo: () => {
      const s = get()
      if (!s.future.length) return
      const next = s.future[0]
      set({ doc: next, past: [...s.past, s.doc], future: s.future.slice(1), dirty: true })
      const page = currentPage(next, s.pageId)
      const idx = indexPage(page)
      set({ selection: s.selection.filter((id) => idx.byId.has(id)) })
    },

    update: (fn, opts) => mutate(fn, opts?.history ?? true),
    updatePage: (fn, opts) => mutatePage(fn, opts?.history ?? true),

    select: (ids, opts) => {
      const s = get()
      let sel: NodeId[]
      if (opts?.toggle) {
        sel = [...s.selection]
        for (const id of ids) {
          const i = sel.indexOf(id)
          if (i >= 0) sel.splice(i, 1)
          else sel.push(id)
        }
      } else if (opts?.add) {
        sel = Array.from(new Set([...s.selection, ...ids]))
      } else {
        sel = ids
      }
      set({ selection: sel, selectedConnectionId: null, editSlices: sel.length === 1 && s.editSlices && sel[0] === s.selection[0] })
    },
    setScope: (scopeId) => set({ scopeId }),
    setTool: (tool) => set({ tool }),
    setMode: (mode) => set({ mode, editSlices: false, selectedConnectionId: null }),
    setView: (view) => set({ view }),
    setEditSlices: (editSlices) => set({ editSlices }),
    setPresenting: (presenting, fromFrameId) => set({ presenting, presentFrom: presenting ? (fromFrameId ?? null) : null }),
    setSelectedConnection: (selectedConnectionId) => set({ selectedConnectionId, selection: selectedConnectionId ? [] : get().selection }),
    setPage: (pageId) => set({ pageId, selection: [], scopeId: null, selectedConnectionId: null }),
    setCanvasSize: (width, height) => set({ canvasSize: { width, height } }),

    setNodeProps: (id, props, opts) =>
      mutatePage((page) => {
        const l = locate(page, id)
        if (!l) return
        const fromInstance = (l.node.meta as { fromInstance?: string; instanceOf?: string } | undefined)?.fromInstance
        if (fromInstance) {
          // derived node: only text / visible / assetId can be overridden
          const inst = locate(page, fromInstance)?.node
          const masterChild = (l.node.meta as { instanceOf?: string }).instanceOf
          if (inst && inst.type === 'instance' && masterChild) {
            const ov: InstanceOverride = { ...(inst.overrides[masterChild] ?? {}) }
            const p = props as { text?: string; visible?: boolean; assetId?: string }
            if (p.text !== undefined) ov.text = p.text
            if (p.visible !== undefined) ov.visible = p.visible
            if (p.assetId !== undefined) ov.assetId = p.assetId
            inst.overrides[masterChild] = ov
          }
          return
        }
        Object.assign(l.node, props)
      }, opts?.history ?? true),
    setSelectionProps: (props, opts) =>
      mutatePage((page) => {
        for (const id of get().selection) {
          const l = locate(page, id)
          if (l) Object.assign(l.node, props)
        }
      }, opts?.history ?? true),

    addNode: (node, parentId, index) => {
      mutatePage((page) => {
        const list = parentId ? (locate(page, parentId)?.node as ContainerNode | undefined)?.children : page.children
        if (!list) return
        if (index === undefined || index < 0 || index > list.length) list.push(node)
        else list.splice(index, 0, node)
      })
      set({ selection: [node.id] })
    },

    deleteSelection: () => {
      const sel = get().selection
      if (!sel.length) return
      mutatePage((page) => {
        for (const id of sel) {
          const l = locate(page, id)
          if (l) l.list.splice(l.index, 1)
        }
        page.connections = page.connections.filter((c) => !sel.includes(c.from) && !(c.to && sel.includes(c.to)))
        if (page.startFrameId && sel.includes(page.startFrameId)) page.startFrameId = undefined
      })
      const comps = get().doc.components
      if (comps && sel.some((id) => comps[id])) {
        mutate((doc) => {
          for (const id of sel) if (doc.components?.[id]) delete doc.components[id]
        }, false)
      }
      set({ selection: [] })
    },

    duplicateSelection: () => {
      const sel = get().selection
      if (!sel.length) return
      const newIds: NodeId[] = []
      mutatePage((page) => {
        for (const id of sel) {
          const l = locate(page, id)
          if (!l) continue
          const copy = cloneNodeDeep(l.node, newId)
          copy.x += 10
          copy.y += 10
          l.list.splice(l.index + 1, 0, copy)
          newIds.push(copy.id)
        }
      })
      set({ selection: newIds })
    },

    groupSelection: () => {
      const sel = get().selection
      if (sel.length < 1) return
      let groupId: NodeId | null = null
      mutatePage((page) => {
        const located = sel.map((id) => locate(page, id)).filter((l): l is Located => !!l)
        if (!located.length) return
        const list = located[0].list
        if (!located.every((l) => l.list === list)) return // must share a parent
        located.sort((a, b) => a.index - b.index)
        const maxIndex = located[located.length - 1].index
        const nodes = located.map((l) => l.node)
        const x0 = Math.min(...nodes.map((n) => n.x))
        const y0 = Math.min(...nodes.map((n) => n.y))
        const x1 = Math.max(...nodes.map((n) => n.x + n.width))
        const y1 = Math.max(...nodes.map((n) => n.y + n.height))
        const g = createGroup('Group', x0, y0, x1 - x0, y1 - y0)
        for (const n of nodes) {
          n.x -= x0
          n.y -= y0
          g.children.push(n)
        }
        // remove originals (from highest index down)
        for (let i = located.length - 1; i >= 0; i--) list.splice(located[i].index, 1)
        const insertAt = maxIndex - (located.length - 1)
        list.splice(insertAt, 0, g)
        groupId = g.id
      })
      if (groupId) set({ selection: [groupId] })
    },

    ungroupSelection: () => {
      const sel = get().selection
      const newSel: NodeId[] = []
      mutatePage((page) => {
        for (const id of sel) {
          const l = locate(page, id)
          if (!l || l.node.type !== 'group') {
            if (l) newSel.push(id)
            continue
          }
          const g = l.node
          const kids = g.children.map((c) => ({ ...c, x: c.x + g.x, y: c.y + g.y }))
          l.list.splice(l.index, 1, ...kids)
          newSel.push(...kids.map((k) => k.id))
        }
      })
      set({ selection: newSel })
    },

    moveSelection: (dx, dy, opts) => {
      const sel = get().selection
      mutatePage((page) => {
        for (const id of sel) {
          const l = locate(page, id)
          if (l && !l.node.locked) {
            l.node.x += dx
            l.node.y += dy
          }
        }
      }, opts?.history ?? true)
    },

    reorderSelection: (dir) => {
      const sel = get().selection
      mutatePage((page) => {
        for (const id of sel) {
          const l = locate(page, id)
          if (!l) continue
          const { list, index, node } = l
          list.splice(index, 1)
          let target = index
          if (dir === 'front') target = list.length
          else if (dir === 'back') target = 0
          else if (dir === 'forward') target = Math.min(list.length, index + 1)
          else target = Math.max(0, index - 1)
          list.splice(target, 0, node)
        }
      })
    },

    reparent: (id, newParentId, index) => {
      mutatePage((page) => {
        const l = locate(page, id)
        if (!l) return
        if (newParentId === id) return
        // compute absolute position before moving
        const idx = indexPage(page)
        const ent = idx.byId.get(id)
        const absX = ent?.absX ?? l.node.x
        const absY = ent?.absY ?? l.node.y
        // prevent moving into own descendant
        if (newParentId) {
          let p: NodeId | null = newParentId
          while (p) {
            if (p === id) return
            const pe = locate(page, p)
            p = pe?.parent?.id ?? null
          }
        }
        l.list.splice(l.index, 1)
        const targetList = newParentId ? (locate(page, newParentId)?.node as ContainerNode | undefined)?.children : page.children
        if (!targetList) {
          l.list.splice(l.index, 0, l.node)
          return
        }
        let px = 0,
          py = 0
        if (newParentId) {
          const pe = indexPage(page).byId.get(newParentId)
          if (pe) {
            px = pe.absX
            py = pe.absY
          }
        }
        l.node.x = absX - px
        l.node.y = absY - py
        if (targetList === l.list && l.index < index) index -= 1
        const at = Math.max(0, Math.min(targetList.length, index))
        targetList.splice(at, 0, l.node)
      })
    },

    convertToNineSlice: (id) =>
      mutatePage((page) => {
        const l = locate(page, id)
        if (!l || l.node.type !== 'image') return
        const n = l.node
        const asset = get().doc.assets[n.assetId]
        const iw = asset?.width ?? n.width
        const ih = asset?.height ?? n.height
        const ins = Math.max(4, Math.round(Math.min(iw, ih) / 4))
        const ns = createNineSlice(n.name, n.x, n.y, n.width, n.height, n.assetId, { left: ins, top: ins, right: ins, bottom: ins })
        ns.id = n.id
        Object.assign(ns, { rotation: n.rotation, opacity: n.opacity, visible: n.visible, locked: n.locked, anchor: n.anchor, pivot: n.pivot, meta: n.meta })
        l.list.splice(l.index, 1, ns)
      }),

    convertToImage: (id) =>
      mutatePage((page) => {
        const l = locate(page, id)
        if (!l || l.node.type !== 'nineslice') return
        const n = l.node
        const img = createImage(n.name, n.x, n.y, n.width, n.height, n.assetId)
        img.id = n.id
        Object.assign(img, { rotation: n.rotation, opacity: n.opacity, visible: n.visible, locked: n.locked, anchor: n.anchor, pivot: n.pivot, meta: n.meta })
        l.list.splice(l.index, 1, img)
      }),

    toggleVisible: (id) =>
      mutatePage((page) => {
        const l = locate(page, id)
        if (l) l.node.visible = !l.node.visible
      }),
    toggleLocked: (id) =>
      mutatePage((page) => {
        const l = locate(page, id)
        if (l) l.node.locked = !l.node.locked
      }),
    renameNode: (id, name) =>
      mutatePage((page) => {
        const l = locate(page, id)
        if (l) l.node.name = name
      }),

    createComponent: () => {
      const sel = get().selection
      if (sel.length !== 1) {
        set({ status: 'Chọn đúng một group hoặc frame để tạo component' })
        return
      }
      const id = sel[0]
      let newId2: NodeId | null = null
      mutate((doc) => {
        const pg = doc.pages.find((p) => p.id === get().pageId) ?? doc.pages[0]
        const l = locate(pg, id)
        if (!l) return
        const n = l.node
        if (n.type === 'instance') return
        let target: FrameNode | GroupNode
        if (n.type === 'frame' || n.type === 'group') target = n
        else {
          const g = createGroup(n.name, n.x, n.y, n.width, n.height)
          g.children.push({ ...n, x: 0, y: 0 } as SceneNode)
          l.list.splice(l.index, 1, g)
          target = g
        }
        target.component = { name: target.name }
        doc.components = { ...(doc.components ?? {}), [target.id]: { name: target.name, pageId: pg.id } }
        newId2 = target.id
      })
      if (newId2) set({ selection: [newId2], status: 'Đã tạo component. Dùng tab Assets để đặt instance.' })
    },
    createInstanceOf: (componentId, parentId, x, y) => {
      const master = findMaster(get().doc, componentId)
      if (!master) return
      const mnode = master.node as FrameNode | GroupNode
      const inst = createInstance(mnode.component?.name ?? mnode.name, x, y, componentId, mnode.width, mnode.height)
      mutatePage((page) => {
        // cycle guard: cannot place an instance of X inside X
        if (parentId) {
          let p: NodeId | null = parentId
          while (p) {
            const pe = locate(page, p)
            if (!pe) break
            if (pe.node.id === componentId) return
            p = pe.parent?.id ?? null
          }
        }
        const list = parentId ? (locate(page, parentId)?.node as CNode | undefined)?.children : page.children
        list?.push(inst)
      })
      set({ selection: [inst.id] })
    },
    detachInstance: (id) => {
      let gid: NodeId | null = null
      mutatePage((page) => {
        const l = locate(page, id)
        if (!l || l.node.type !== 'instance') return
        const inst = l.node
        const g = createGroup(inst.name, inst.x, inst.y, inst.width, inst.height)
        const strip = (n: SceneNode): void => {
          n.locked = false
          if (n.meta) {
            delete (n.meta as Record<string, unknown>).instanceOf
            delete (n.meta as Record<string, unknown>).fromInstance
          }
          if (isContainer(n)) n.children.forEach(strip)
        }
        g.children = inst.children.map((c) => {
          const copy = cloneNodeDeep(c, newId)
          strip(copy)
          return copy
        })
        Object.assign(g, { opacity: inst.opacity, visible: inst.visible, anchor: inst.anchor, pivot: inst.pivot, rotation: inst.rotation })
        l.list.splice(l.index, 1, g)
        gid = g.id
      })
      if (gid) set({ selection: [gid] })
    },
    setOverride: (instanceId, masterChildId, patch) =>
      mutatePage((page) => {
        const l = locate(page, instanceId)
        if (!l || l.node.type !== 'instance') return
        l.node.overrides[masterChildId] = { ...(l.node.overrides[masterChildId] ?? {}), ...patch }
      }),
    setLayout: (id, layout) =>
      mutatePage((page) => {
        const l = locate(page, id)
        if (!l || (l.node.type !== 'frame' && l.node.type !== 'group')) return
        l.node.layout = layout ?? undefined
        if (!layout) delete l.node.layout
      }),
    setImageEdits: (id, edits) =>
      mutatePage((page) => {
        const l = locate(page, id)
        if (!l || (l.node.type !== 'image' && l.node.type !== 'nineslice')) return
        if (edits) l.node.edits = edits
        else delete l.node.edits
      }),

    showState: (masterId, state) =>
      mutatePage((page) => {
        const l = locate(page, masterId)
        if (!l || !isContainer(l.node)) return
        const sc = stateChildren(l.node)
        for (const [k, c] of Object.entries(sc)) if (c) c.visible = k === state
      }),
    addState: (masterId, state) => {
      let created: NodeId | null = null
      mutatePage((page) => {
        const l = locate(page, masterId)
        if (!l || !isContainer(l.node) || l.node.type === 'instance') return
        const m = l.node
        let sc = stateChildren(m)
        if (!sc.normal) {
          // wrap the current content into a "normal" state group
          const g = createGroup('normal', 0, 0, m.width, m.height)
          g.children = m.children.map((c) => c)
          m.children = [g]
          sc = stateChildren(m)
        }
        if (sc[state as keyof typeof sc]) return
        const copy = cloneNodeDeep(sc.normal!, newId)
        copy.name = state
        copy.visible = false
        m.children.push(copy)
        created = copy.id
      })
      if (created) set({ status: `Đã thêm trạng thái "${state}" (bản sao của normal, đang ẩn). Sửa nó rồi bấm chip để xem.` })
    },
    autoAnchor: (frameIds, rules) => {
      const page = getCurrentPage()
      let ids = frameIds
      if (!ids) {
        const set = new Set<NodeId>()
        for (const id of get().selection) {
          let e = getEntry(page, id)
          while (e?.parent) e = getEntry(page, e.parent.id)
          if (e?.node.type === 'frame') set.add(e.node.id)
        }
        if (!set.size) for (const c of page.children) if (c.type === 'frame') set.add(c.id)
        ids = [...set]
      }
      let count = 0
      const lines: string[] = []
      mutatePage((pg) => {
        for (const fid of ids!) {
          const l = locate(pg, fid)
          if (!l || l.node.type !== 'frame') continue
          const sug = suggestAnchors(l.node, rules)
          count += applyAnchorSuggestions(l.node, sug)
          for (const x of sug) if (x.apply) lines.push(`${l.node.name}/${x.name}: ${x.label}${x.safeArea ? ' + safe area' : ''} — ${x.reason}`)
        }
      })
      set({ status: count ? `Tự neo ${count} node theo rule (Shift+D để xem trước)` : 'Không có node nào cần đổi anchor (đã chỉnh tay? bật "ghi đè")' })
      if (lines.length) get().setNotice({ kind: 'info', title: `Tự neo ${count} node`, lines })
      return count
    },

    addConnection: (from, to, init) => {
      const action = init?.action ?? 'navigate'
      const c: Connection = normalizeConnection({ id: newId(), from, to, trigger: 'click', action, ...defaultsForAction(action), ...(init ?? {}) } as Connection)
      mutatePage((page) => {
        // one connection per hotspot + trigger (+ key): replace existing
        page.connections = page.connections.filter((x) => !(x.from === from && x.trigger === c.trigger && (c.trigger !== 'key' || x.key === c.key)))
        page.connections.push(c)
        if (!page.startFrameId) {
          const e = getEntry(page, from)
          let top: SceneNode | undefined = e?.node
          let cur = e
          while (cur?.parent) {
            top = cur.parent
            cur = getEntry(page, cur.parent.id)
          }
          if (top?.type === 'frame') page.startFrameId = top.id
        }
      })
      set({ selectedConnectionId: c.id })
    },
    updateConnection: (id, patch) =>
      mutatePage((page) => {
        const i = page.connections.findIndex((x) => x.id === id)
        if (i < 0) return
        const prev = page.connections[i]
        const next = { ...prev, ...patch } as Connection
        // switching action resets the animation to that action's defaults unless the patch sets it
        if (patch.action && patch.action !== prev.action && !patch.transition) Object.assign(next, defaultsForAction(patch.action))
        if ((next.action === 'overlay' || next.action === 'swap') && !next.overlay) next.overlay = { ...DEFAULT_OVERLAY }
        page.connections[i] = normalizeConnection(next)
      }),
    removeConnection: (id) => {
      mutatePage((page) => {
        page.connections = page.connections.filter((x) => x.id !== id)
      })
      if (get().selectedConnectionId === id) set({ selectedConnectionId: null })
    },
    setStartFrame: (id) =>
      mutatePage((page) => {
        page.startFrameId = id
      }),

    addPage: () => {
      const p = createPage(`Page ${get().doc.pages.length + 1}`)
      mutate((doc) => {
        doc.pages.push(p)
      })
      set({ pageId: p.id, selection: [], scopeId: null })
    },
    renamePage: (id, name) =>
      mutate((doc) => {
        const p = doc.pages.find((x) => x.id === id)
        if (p) p.name = name
      }),
    deletePage: (id) => {
      const s = get()
      if (s.doc.pages.length <= 1) return
      mutate((doc) => {
        doc.pages = doc.pages.filter((p) => p.id !== id)
      })
      if (s.pageId === id) set({ pageId: get().doc.pages[0].id, selection: [], scopeId: null })
    }
  }
})

export function useCurrentPage(): Page {
  return useEditor((s) => s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.pages[0])
}

export function getCurrentPage(): Page {
  const s = useEditor.getState()
  return s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.pages[0]
}
