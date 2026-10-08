// The UI art of a linked game, as a list an art agent can work from: every game file the UI shows (size,
// 9-slice insets, where and how big it is shown, which component, a role guess) and every element the game
// draws in code / cuts from an atlas (no file of its own: new art needs a name to come back under).
// Pure module (no DOM / Pixi): used by the MCP server and the uiforge CLI.
import type { DesignDocument, FrameNode, Insets, NodeId, SceneNode } from './types'
import { isContainer } from './types'
import { gameFrames, gameIdOf, gameSources } from './game'
import { COMPONENTS_SCREEN } from './gameComponents'

export type AssetRole = 'button' | 'panel' | 'popup' | 'icon' | 'background' | 'bar' | 'badge' | 'tab' | 'frame' | 'decoration'

export interface AssetUse {
  screen: string
  element: string
  /** shown size in the design (px) */
  width: number
  height: number
  component?: string
}

export interface AssetEntry {
  /** 1-based, matches the contact sheet */
  index: number
  /** 'file' = an art file of the game; 'drawn' = drawn in code / cut from an atlas (no file of its own) */
  kind: 'file' | 'drawn'
  /** game file (relative to the game root); for 'drawn', the file name new art must use to be matched */
  file: string
  /** name to save new art under (base name; any image extension) */
  stageName: string
  width: number
  height: number
  nineSlice?: Insets
  role: AssetRole
  uses: AssetUse[]
  components: string[]
  /** places it is drawn, instances included */
  shownCount: number
  /** the art currently in the UIForge project (relative to the game root) */
  preview?: string
  replaced: boolean
  /** project node to target for 'drawn' entries */
  nodeId?: NodeId
  note?: string
}

const ROLE_WORDS: [RegExp, AssetRole][] = [
  [/(^|[^a-z])(btn|button|claim|play|close|back)([^a-z]|$)/i, 'button'],
  [/popup|dialog|window|modal/i, 'popup'],
  [/tab([^l]|$)/i, 'tab'],
  [/bar|progress|slider|gage|gauge|fill|track|knob/i, 'bar'],
  [/badge|dot|tag|new|red_?point|notice/i, 'badge'],
  [/icon|ico_|coin|gem|gold|star|heart/i, 'icon'],
  [/frame|border|slot|cell/i, 'frame'],
  [/panel|board|bg|base|plate|card|box/i, 'panel']
]

function guessRole(name: string, w: number, h: number, screenW: number, screenH: number, nine: boolean): AssetRole {
  if (w * h >= 0.6 * screenW * screenH) return 'background'
  for (const [re, role] of ROLE_WORDS) if (re.test(name)) return role
  if (nine) return w / Math.max(1, h) > 2.2 ? 'button' : 'panel'
  if (Math.max(w, h) <= 140 && Math.abs(w - h) <= 0.25 * Math.max(w, h)) return 'icon'
  return 'decoration'
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-.]+/g, '_').replace(/^_+|_+$/g, '').slice(-80) || 'element'
}

interface Found {
  node: SceneNode
  screen: string
  frame: FrameNode
  gameId?: string
  component?: string
}

/** Every node of every game frame (instance parts excluded: their art is the master's). */
function allNodes(doc: DesignDocument): Found[] {
  const out: Found[] = []
  for (const { frame, screenId } of gameFrames(doc)) {
    const visit = (list: SceneNode[], component?: string): void => {
      for (const n of list) {
        if (n.meta?.gameRef) continue
        const comp = component ?? (screenId === COMPONENTS_SCREEN && (n.type === 'group' || n.type === 'frame') && n.component ? n.component.name : undefined)
        out.push({ node: n, screen: screenId, frame, gameId: gameIdOf(n), component: comp })
        if (isContainer(n) && n.type !== 'instance') visit(n.children, comp)
      }
    }
    visit(frame.children)
  }
  return out
}

/** Instances per component name (a master's art is shown once per instance). */
function instanceCounts(doc: DesignDocument): Map<string, number> {
  const byMaster = new Map<NodeId, string>()
  for (const [id, c] of Object.entries(doc.components ?? {})) byMaster.set(id, c.name)
  const counts = new Map<string, number>()
  for (const f of allNodes(doc)) {
    if (f.node.type !== 'instance') continue
    const name = byMaster.get(f.node.componentId)
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

export function listGameAssets(doc: DesignDocument): AssetEntry[] {
  const link = doc.game
  if (!link) throw new Error('Project này chưa nối với game (chưa capture_game / push_game_design).')
  const nodes = allNodes(doc)
  const byId = new Map(nodes.map((f) => [f.node.id, f]))
  const inst = instanceCounts(doc)
  const shownBy = (f: Found): number => (f.component ? Math.max(1, inst.get(f.component) ?? 0) : 1)
  // the design screen size (masters live on the Components frame, which is not a screen)
  const design = gameFrames(doc).find((g) => g.screenId !== COMPONENTS_SCREEN)?.frame
  const screen = { w: design?.width ?? 1080, h: design?.height ?? 1920 }
  const out: AssetEntry[] = []

  for (const s of gameSources(doc)) {
    const uses: AssetUse[] = []
    const comps = new Set<string>()
    let nine: Insets | undefined
    let shown = 0
    for (const u of s.usedBy) {
      const f = byId.get(u.nodeId)
      if (!f) continue
      uses.push({ screen: u.screenId, element: u.elementId, width: Math.round(f.node.width), height: Math.round(f.node.height), component: f.component })
      if (f.component) comps.add(f.component)
      if (f.node.type === 'nineslice') nine ??= { ...f.node.insets }
      shown += shownBy(f)
    }
    const current = doc.assets[s.currentAssetId]
    const base = s.source.replace(/^.*\//, '')
    const big = uses.reduce((m, u) => Math.max(m, u.width * u.height), 0)
    const biggest = uses.find((u) => u.width * u.height === big)
    out.push({
      index: 0,
      kind: 'file',
      file: s.source,
      stageName: base.replace(/\.[^.]+$/, ''),
      width: s.width,
      height: s.height,
      nineSlice: nine,
      role: guessRole(base, biggest?.width ?? s.width, biggest?.height ?? s.height, screen.w, screen.h, !!nine),
      uses,
      components: Array.from(comps),
      shownCount: shown,
      preview: current ? `uiforge/assets/${current.file}` : undefined,
      replaced: s.replaced
    })
  }

  // art with no file of its own: drawn in code (snapshot cut-outs) or a region of an atlas
  const taken = new Set(out.map((e) => e.stageName.toLowerCase()))
  for (const f of nodes) {
    const n = f.node
    if ((n.type !== 'image' && n.type !== 'nineslice') || !f.gameId) continue
    const b = link.screens[f.screen]?.elements[f.gameId]
    if (!b || (b.source && !b.crop)) continue
    let stage = slug(`${f.screen}__${f.gameId.split('/').slice(-2).join('_')}`)
    for (let i = 2; taken.has(stage.toLowerCase()); i++) stage = slug(`${f.screen}__${f.gameId.split('/').slice(-2).join('_')}_${i}`)
    taken.add(stage.toLowerCase())
    const a = doc.assets[n.assetId]
    out.push({
      index: 0,
      kind: 'drawn',
      file: `uiforge/incoming/${stage}.png`,
      stageName: stage,
      width: Math.round(n.width),
      height: Math.round(n.height),
      nineSlice: n.type === 'nineslice' ? { ...n.insets } : undefined,
      role: guessRole(f.gameId, n.width, n.height, screen.w, screen.h, n.type === 'nineslice'),
      uses: [{ screen: f.screen, element: f.gameId, width: Math.round(n.width), height: Math.round(n.height), component: f.component }],
      components: f.component ? [f.component] : [],
      shownCount: shownBy(f),
      preview: a ? `uiforge/assets/${a.file}` : undefined,
      replaced: n.assetId !== b.assetId,
      nodeId: n.id,
      note: b.crop ? `vùng ${b.crop.width}×${b.crop.height} của atlas ${b.source}` : 'game vẽ bằng code/CSS (ảnh hiện tại cắt từ screenshot)'
    })
  }

  // most visible first: what the player sees most is what a reskin should get right first
  out.sort((a, b) => b.shownCount - a.shownCount || b.width * b.height - a.width * a.height || a.file.localeCompare(b.file))
  out.forEach((e, i) => (e.index = i + 1))
  return out
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Same columns as the reskin asset inventories of the studio (kind,file,name,group,priority,…). */
export function assetsCsv(list: AssetEntry[]): string {
  const head = ['kind', 'file', 'name', 'group', 'priority', 'width', 'height', 'nine_slice_LBRT', 'pages', 'first_level', 'wave', 'used_in', 'note', 'index', 'role', 'shown', 'components', 'stage_name']
  const rows = list.map((e) => [
    e.kind === 'file' ? 'sprite' : 'drawn',
    e.file,
    e.stageName,
    e.role,
    e.shownCount >= 5 ? 'P0' : e.shownCount >= 2 ? 'P1' : 'P2',
    e.width,
    e.height,
    // Unity border order, as in the studio's inventories: left,bottom,right,top
    e.nineSlice ? `${e.nineSlice.left},${e.nineSlice.bottom},${e.nineSlice.right},${e.nineSlice.top}` : '',
    '',
    '',
    '',
    Array.from(new Set(e.uses.map((u) => u.screen))).filter((s) => s !== COMPONENTS_SCREEN).join(' '),
    e.note ?? '',
    e.index,
    e.role,
    e.shownCount,
    e.components.join(' '),
    e.stageName
  ])
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}

export function assetsMarkdown(game: string, list: AssetEntry[], sheet?: string): string {
  const L: string[] = []
  L.push(`# UI art của ${game} (${list.length} asset)`, '')
  L.push('Danh sách art UI đang hiện trên các màn đã capture, sắp theo mức hiển thị (dùng nhiều trước). Số `#` khớp với ảnh tổng hợp' + (sheet ? ` \`${sheet}\`` : '') + '.', '')
  L.push('**Quy tắc art mới**: PNG nền trong suốt, **đúng kích thước px** cột "Kích thước" (hoặc cùng tỉ lệ, UIForge thu về), lưu tên `<stage name>.png` → `uiforge stage-art`. Khung 9-slice: 4 góc nằm trong insets (trái, trên, phải, dưới), phần giữa vẽ phẳng để giãn không nhoè.', '')
  L.push('| # | Loại | Stage name | Kích thước | 9-slice L,T,R,B | Vai trò | Hiện | Component | Dùng ở | Ghi chú |')
  L.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const e of list) {
    const screens = Array.from(new Set(e.uses.map((u) => u.screen))).filter((s) => s !== COMPONENTS_SCREEN)
    L.push(
      `| ${e.index} | ${e.kind === 'file' ? 'file' : 'vẽ code'} | \`${e.stageName}\` | ${e.width}×${e.height} | ${e.nineSlice ? `${e.nineSlice.left},${e.nineSlice.top},${e.nineSlice.right},${e.nineSlice.bottom}` : ''} | ${e.role} | ${e.shownCount} | ${e.components.join(', ')} | ${screens.slice(0, 4).join(', ')}${screens.length > 4 ? ` +${screens.length - 4}` : ''} | ${[e.kind === 'file' ? e.file : '', e.replaced ? 'đã thay trong app' : '', e.note ?? ''].filter(Boolean).join(' · ')} |`
    )
  }
  return L.join('\n') + '\n'
}
