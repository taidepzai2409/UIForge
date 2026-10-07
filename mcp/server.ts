#!/usr/bin/env node
// UIForge MCP server (stdio). Gives Claude Code / any agent tools to read layouts,
// flows and assets from a project folder, and — when the desktop app is running —
// to render frames, import PSDs and edit nodes/flows live through the local bridge.
//
// Usage: node out/mcp/server.js [--project <dir>] [--port 47821]
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { Connection, DesignDocument, FrameNode, NodeId, Page, SceneNode } from '@/model/types'
import { isContainer } from '@/model/types'
import { indexPage } from '@/model/nodes'
import { safeFileName } from '@/model/naming'
import { buildFlowsMarkdown, buildFrameLayout, buildPageManifest, collectUsedAssets, frameFileName, type LayoutNode } from '@/export/layout'
import { DEFAULT_PREVIEW_DEVICES, DEVICE_PRESETS, scalerOf, simulateFrame } from '@/model/simulate'
import { applyAnchorSuggestions, suggestAnchors } from '@/model/autoAnchor'
import { DEFAULT_OVERLAY, defaultsForAction, normalizeConnection } from '@/model/flows'
import specMarkdown from '../docs/LAYOUT_SPEC.md'
import gameGuide from '../docs/GAME_LINK.md'
import { GAME_DIR, buildChangesMarkdown, diffGame, type GameDesign, type GameElement } from '@/model/game'

// ----------------------------------------------------------------- args / state
const args = process.argv.slice(2)
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
let projectDir: string | null = argOf('--project') ?? process.env.DM_PROJECT ?? null
const port = Number(argOf('--port') ?? process.env.DM_BRIDGE_PORT ?? 47821)
const bridgeUrl = `http://127.0.0.1:${port}`

// ----------------------------------------------------------------- bridge client
async function appUp(timeoutMs = 600): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const r = await fetch(`${bridgeUrl}/health`, { signal: ctrl.signal })
    clearTimeout(t)
    return r.ok
  } catch {
    return false
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
let launching: Promise<boolean> | null = null

/** Starts the desktop app (packaged exe if present, else electron dev build) and waits for the bridge. */
async function launchApp(): Promise<boolean> {
  if (launching) return launching
  launching = (async () => {
    // prefer the dev build next to this server (same version); DM_APP_EXE or a packaged exe otherwise
    const devBuild = existsSync(join(repoRoot, 'out', 'main')) && existsSync(join(repoRoot, 'node_modules', '.bin'))
    const exe = process.env.DM_APP_EXE || (devBuild ? null : [join(repoRoot, 'dist', 'win-unpacked', 'UIForge.exe')].find((p) => existsSync(p)))
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    if (projectDir) env.DM_PROJECT = projectDir
    let child
    if (exe) child = spawn(exe, [], { detached: true, stdio: 'ignore', env, windowsHide: false })
    else if (devBuild) {
      const electron = process.platform === 'win32' ? join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe') : join(repoRoot, 'node_modules', '.bin', 'electron')
      child = spawn(electron, ['.'], { cwd: repoRoot, detached: true, stdio: 'ignore', env })
    } else return false
    child.unref()
    const t0 = Date.now()
    while (Date.now() - t0 < 25000) {
      await new Promise((r) => setTimeout(r, 500))
      if (await appUp(800)) {
        // wait for the project to finish loading (DM_PROJECT) so ops don't race the open
        // (the app also re-opens its last project on start, so wait a little even without --project)
        const t1 = Date.now()
        while (Date.now() - t1 < (projectDir ? 8000 : 4000)) {
          try {
            const p = await bridge<{ projectDir: string | null }>('ping')
            if (p.projectDir) {
              projectDir ??= p.projectDir
              break
            }
          } catch {
            /* retry */
          }
          await new Promise((r) => setTimeout(r, 300))
        }
        return true
      }
    }
    return false
  })()
  const ok = await launching
  launching = null
  return ok
}

/** App reachable? Launches it on demand (set DM_NO_AUTOLAUNCH=1 to disable). */
async function appAvailable(): Promise<boolean> {
  if (await appUp()) return true
  if (process.env.DM_NO_AUTOLAUNCH) return false
  return launchApp()
}

async function bridge<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${bridgeUrl}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
  const j = (await r.json()) as { result?: T; error?: string }
  if (j.error) throw new Error(j.error)
  return j.result as T
}

// ----------------------------------------------------------------- document access
interface Loaded {
  doc: DesignDocument
  source: 'app' | 'file'
  dir: string | null
}

async function loadDoc(): Promise<Loaded> {
  if (await appAvailable()) {
    const r = await bridge<{ projectDir: string | null; doc: DesignDocument }>('getDoc')
    if (r.projectDir) projectDir = r.projectDir
    return { doc: r.doc, source: 'app', dir: r.projectDir }
  }
  if (!projectDir) throw new Error('Chưa biết project: app không chạy và không có --project <dir>. Dùng tool open_project trước.')
  const file = join(projectDir, 'project.json')
  if (!existsSync(file)) throw new Error(`Không thấy ${file}`)
  const doc = JSON.parse(await readFile(file, 'utf8')) as DesignDocument
  return { doc, source: 'file', dir: projectDir }
}

async function saveDocFile(doc: DesignDocument): Promise<void> {
  if (!projectDir) throw new Error('no project dir')
  await writeFile(join(projectDir, 'project.json'), JSON.stringify(doc, null, 2))
}

function findFrame(doc: DesignDocument, ref: string): { page: Page; frame: FrameNode } {
  const lower = ref.toLowerCase()
  for (const page of doc.pages) for (const c of page.children) if (c.type === 'frame' && (c.id === ref || c.name.toLowerCase() === lower)) return { page, frame: c }
  throw new Error(`Không tìm thấy frame "${ref}". Frames: ${doc.pages.flatMap((p) => p.children.filter((c) => c.type === 'frame').map((c) => c.name)).join(', ')}`)
}

function findNode(doc: DesignDocument, ref: string): { page: Page; node: SceneNode; path: string } {
  const lower = ref.toLowerCase()
  let byName: { page: Page; node: SceneNode; path: string } | null = null
  for (const page of doc.pages) {
    const idx = indexPage(page)
    const e = idx.byId.get(ref)
    if (e) return { page, node: e.node, path: e.path }
    for (const en of idx.byId.values()) {
      if (en.path.toLowerCase() === lower) return { page, node: en.node, path: en.path }
      if (!byName && (en.node.name.toLowerCase() === lower || en.path.toLowerCase().endsWith('/' + lower))) byName = { page, node: en.node, path: en.path }
    }
  }
  if (byName) return byName
  throw new Error(`Không tìm thấy node "${ref}" (dùng id, path "Frame/Group/name" hoặc tên)`)
}

function ownerFrame(page: Page, nodeId: NodeId): FrameNode | null {
  for (const c of page.children) {
    if (c.type !== 'frame') continue
    if (c.id === nodeId) return c
    const idx = indexPage({ ...page, children: [c] })
    if (idx.byId.has(nodeId)) return c
  }
  return null
}

function text(v: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] }
}

function compactNode(n: LayoutNode): Record<string, unknown> {
  const o: Record<string, unknown> = { id: n.id, path: n.path, type: n.type, rect: n.rect, visible: n.visible }
  if (n.image) o.image = n.image.file + (n.image.nineSlice ? ` 9slice(${n.image.nineSlice.left},${n.image.nineSlice.top},${n.image.nineSlice.right},${n.image.nineSlice.bottom})` : '')
  if (n.text) o.text = n.text.text
  return o
}

// ----------------------------------------------------------------- write helpers (file mode)
type Op = Record<string, unknown> & { op: string }

async function applyOps(ops: Op[]): Promise<string[]> {
  if (await appAvailable()) {
    const r = await bridge<{ applied: string[] }>('apply', { ops })
    return r.applied
  }
  const { doc } = await loadDoc()
  const log: string[] = []
  for (const op of ops) {
    if (op.op === 'setNodeProps') {
      const { node } = findNode(doc, String(op.node))
      Object.assign(node, op.props as object)
      log.push(`setNodeProps ${node.name}`)
    } else if (op.op === 'addConnection') {
      const { page, node } = findNode(doc, String(op.from))
      const action = (op.action as Connection['action']) ?? (op.overlay === true ? 'overlay' : 'navigate')
      const needsTarget = action === 'navigate' || action === 'overlay' || action === 'swap'
      const frame = needsTarget ? findFrame(doc, String(op.to)).frame : null
      const trigger = (op.trigger as Connection['trigger']) ?? 'click'
      page.connections = page.connections.filter((c) => !(c.from === node.id && c.trigger === trigger && (trigger !== 'key' || c.key === op.key)))
      const c: Connection = normalizeConnection({
        id: Math.random().toString(36).slice(2, 12),
        from: node.id,
        to: frame?.id,
        trigger,
        action,
        ...defaultsForAction(action),
        ...(op.transition ? { transition: op.transition as Connection['transition'] } : {}),
        ...(op.direction ? { direction: op.direction as Connection['direction'] } : {}),
        ...(op.easing ? { easing: op.easing as Connection['easing'] } : {}),
        ...(typeof op.duration === 'number' ? { duration: op.duration } : {}),
        ...(typeof op.delay === 'number' ? { delay: op.delay } : {}),
        ...(typeof op.key === 'string' ? { key: op.key } : {}),
        ...(op.overlay && typeof op.overlay === 'object' ? { overlay: { ...DEFAULT_OVERLAY, ...(op.overlay as object) } } : {})
      } as Connection)
      page.connections.push(c)
      if (!page.startFrameId) page.startFrameId = ownerFrame(page, node.id)?.id
      log.push(`addConnection ${c.id}: ${node.name} ${action}${frame ? ` → ${frame.name}` : ''}`)
    } else if (op.op === 'removeConnection') {
      for (const page of doc.pages) page.connections = page.connections.filter((c) => c.id !== op.id)
      log.push(`removeConnection ${op.id}`)
    } else if (op.op === 'setStartFrame') {
      const { page, frame } = findFrame(doc, String(op.frame))
      page.startFrameId = frame.id
      log.push(`setStartFrame ${frame.name}`)
    } else if (op.op === 'createComponent') {
      const { page, node } = findNode(doc, String(op.node))
      if (node.type !== 'frame' && node.type !== 'group') throw new Error('Chỉ frame/group làm component được (file mode)')
      node.component = { name: String(op.name ?? node.name) }
      doc.components = { ...(doc.components ?? {}), [node.id]: { name: node.component.name, pageId: page.id } }
      log.push(`createComponent ${node.name}`)
    } else if (op.op === 'autoAnchor') {
      const { frame } = findFrame(doc, String(op.frame))
      const sug = suggestAnchors(frame, (op.rules as Record<string, unknown>) ?? {})
      const n = applyAnchorSuggestions(frame, sug)
      log.push(`autoAnchor ${frame.name}: ${n} node`)
    } else if (op.op === 'setLayout') {
      const { node } = findNode(doc, String(op.node))
      if (node.type !== 'frame' && node.type !== 'group') throw new Error('Chỉ frame/group có auto layout')
      if (op.layout) node.layout = op.layout as typeof node.layout
      else delete node.layout
      log.push(`setLayout ${node.name} (app sẽ xếp lại khi mở project)`)
    } else {
      throw new Error(`Op "${op.op}" cần app đang chạy`)
    }
  }
  await saveDocFile(doc)
  log.push('(đã ghi project.json trực tiếp; app không chạy)')
  return log
}

// ----------------------------------------------------------------- server
const server = new McpServer({ name: 'uiforge', version: '0.4.0' })

server.registerTool(
  'project_info',
  {
    description: 'Tổng quan project UIForge đang mở: thư mục, pages, frames (màn hình) với kích thước, số flow. Gọi tool này trước.',
    inputSchema: {}
  },
  async () => {
    const { doc, source, dir } = await loadDoc()
    return text({
      source: source === 'app' ? 'app đang chạy (dữ liệu live)' : 'đọc từ project.json (app không chạy)',
      projectDir: dir,
      name: doc.name,
      pages: doc.pages.map((p) => ({
        id: p.id,
        name: p.name,
        startFrame: p.children.find((c) => c.id === p.startFrameId)?.name ?? null,
        flows: p.connections.length,
        frames: p.children.filter((c): c is FrameNode => c.type === 'frame').map((f) => ({ id: f.id, name: f.name, width: f.width, height: f.height, nodes: indexPage({ ...p, children: [f] }).order.length - 1 }))
      })),
      assets: Object.keys(doc.assets).length,
      hint: 'Đọc get_spec để hiểu hệ toạ độ và cách map sang Unity. get_frame_layout(frame) trả về layout đầy đủ. Dựng lại UX từ ảnh: đọc ux_guide.'
    })
  }
)

server.registerTool('get_spec', { description: 'Trả về LAYOUT_SPEC.md: định nghĩa JSON layout, hệ toạ độ, cách chuyển sang Unity RectTransform.', inputSchema: {} }, async () => text(specMarkdown))

server.registerTool(
  'get_frame_layout',
  {
    description: 'Layout đầy đủ của một frame (màn hình): mọi node với rect tuyệt đối, local, anchor/pivot, giá trị Unity RectTransform, ảnh, 9-slice, text, flows. Đây là dữ liệu chính để dựng UI.',
    inputSchema: { frame: z.string().describe('tên hoặc id frame'), compact: z.boolean().optional().describe('true = chỉ id/path/type/rect (nhẹ hơn)') }
  },
  async ({ frame, compact }) => {
    const { doc } = await loadDoc()
    const f = findFrame(doc, frame)
    const layout = buildFrameLayout(doc, f.page, f.frame)
    if (compact) return text({ frame: layout.frame, nodes: layout.nodes.map(compactNode), flows: layout.flows })
    return text(layout)
  }
)

server.registerTool(
  'list_nodes',
  {
    description: 'Liệt kê node (rút gọn) trong một frame, lọc theo tên/path và type.',
    inputSchema: {
      frame: z.string(),
      query: z.string().optional().describe('chuỗi con trong path, không phân biệt hoa thường'),
      type: z.enum(['frame', 'group', 'image', 'nineslice', 'rect', 'text']).optional()
    }
  },
  async ({ frame, query, type }) => {
    const { doc } = await loadDoc()
    const f = findFrame(doc, frame)
    const layout = buildFrameLayout(doc, f.page, f.frame)
    const q = query?.toLowerCase()
    const nodes = layout.nodes.filter((n) => (!type || n.type === type) && (!q || n.path.toLowerCase().includes(q))).map(compactNode)
    return text({ frame: f.frame.name, count: nodes.length, nodes })
  }
)

server.registerTool(
  'get_node',
  {
    description: 'Chi tiết một node theo id, path ("Frame/Group/name") hoặc tên: rect, unity RectTransform, ảnh, 9-slice, text, meta (kể cả chữ gốc từ PSD).',
    inputSchema: { node: z.string() }
  },
  async ({ node }) => {
    const { doc } = await loadDoc()
    const found = findNode(doc, node)
    const frame = ownerFrame(found.page, found.node.id)
    if (!frame) return text({ node: found.node, note: 'node không nằm trong frame nào' })
    const layout = buildFrameLayout(doc, found.page, frame)
    const ln = layout.nodes.find((n) => n.id === found.node.id)
    return text({ frame: frame.name, node: ln ?? found.node, assetFile: ln?.image ? assetAbsPath(ln.image.file) : undefined })
  }
)

function assetAbsPath(rel: string): string | undefined {
  if (!projectDir) return undefined
  return resolve(projectDir, rel.replace(/^assets\//, 'assets/'))
}

server.registerTool(
  'get_flows',
  {
    description: 'Toàn bộ luồng màn hình (flows) của project: JSON + sơ đồ mermaid + bảng. Dùng để sinh navigation/điều hướng đúng thiết kế.',
    inputSchema: { page: z.string().optional() }
  },
  async ({ page }) => {
    const { doc } = await loadDoc()
    const pages = page ? doc.pages.filter((p) => p.id === page || p.name === page) : doc.pages
    const json = pages.map((p) => buildPageManifest(doc, p))
    return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }, { type: 'text', text: buildFlowsMarkdown({ ...doc, pages }) }] }
  }
)

server.registerTool(
  'get_asset',
  {
    description: 'Đường dẫn tuyệt đối tới file PNG của một asset (theo assetId hoặc node), tuỳ chọn trả kèm ảnh.',
    inputSchema: { asset: z.string().describe('assetId hoặc node id/path'), includeImage: z.boolean().optional() }
  },
  async ({ asset, includeImage }) => {
    const { doc } = await loadDoc()
    let a = doc.assets[asset]
    if (!a) {
      const { node } = findNode(doc, asset)
      if (node.type === 'image' || node.type === 'nineslice') a = doc.assets[node.assetId]
    }
    if (!a) throw new Error(`Không tìm thấy asset "${asset}"`)
    const p = projectDir ? resolve(projectDir, 'assets', a.file) : null
    const out: { type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }[] = [{ type: 'text', text: JSON.stringify({ ...a, path: p }, null, 2) }]
    if (includeImage && p && existsSync(p)) out.push({ type: 'image', data: (await readFile(p)).toString('base64'), mimeType: 'image/png' })
    return { content: out as { type: 'text'; text: string }[] }
  }
)

server.registerTool(
  'render_frame',
  {
    description: 'Render ảnh PNG của một frame đúng như app hiển thị (cần app đang chạy). Dùng để đối chiếu UI đã dựng.',
    inputSchema: {
      frame: z.string(),
      scale: z.number().min(0.05).max(2).optional().describe('mặc định 0.5'),
      savePath: z.string().optional().describe('nếu có, ghi PNG ra file này thay vì trả ảnh'),
      device: z.string().optional().describe('render như trên thiết bị (iphone15, iphoneSE, galaxyS, pixel, ipad, tablet, fold) — CanvasScaler + anchors + safe area')
    }
  },
  async ({ frame, scale, savePath, device }) => {
    if (!(await appAvailable())) throw new Error('App UIForge chưa chạy. Mở app rồi thử lại (hoặc dùng preview trong thư mục export/).')
    const r = device
      ? await bridge<{ frame: string; width: number; height: number; pngBase64: string; issues: string[] }>('renderDevice', { frame, device, scale: scale ?? 0.5 })
      : await bridge<{ frame: string; width: number; height: number; pngBase64: string }>('renderFrame', { frame, scale: scale ?? 0.5 })
    if (savePath) {
      await mkdir(resolve(savePath, '..'), { recursive: true })
      await writeFile(savePath, Buffer.from(r.pngBase64, 'base64'))
      return text({ saved: resolve(savePath), width: r.width, height: r.height })
    }
    return { content: [{ type: 'text', text: `${r.frame} ${r.width}×${r.height}` }, { type: 'image', data: r.pngBase64, mimeType: 'image/png' }] as { type: 'text'; text: string }[] }
  }
)

server.registerTool(
  'import_psd',
  {
    description: 'Import PSD thành frame mới (cần app đang chạy). split=true: mỗi group cấp 1 của PSD thành một frame (PSD chứa nhiều màn hình); mặc định cả PSD = 1 frame. Text layer thành Text node sống (kèm ảnh gốc ẩn).',
    inputSchema: {
      paths: z.array(z.string()).min(1),
      split: z.boolean().optional(),
      groupIndexes: z.array(z.number()).optional().describe('chỉ số group cấp 1 muốn lấy (split)'),
      includeLooseLayers: z.boolean().optional().describe('split: thêm layer lẻ cấp 1 vào mọi frame (mặc định true)'),
      textMode: z.enum(['live', 'raster', 'both']).optional(),
      autoAnchor: z.boolean().optional().describe('tự neo anchor + safe area theo rule sau import (mặc định true)')
    }
  },
  async ({ paths, split, groupIndexes, includeLooseLayers, textMode, autoAnchor }) => {
    if (!(await appAvailable())) throw new Error('App UIForge chưa chạy.')
    return text(await bridge('importPsd', { paths: paths.map((p) => resolve(p)), split, groupIndexes, includeLooseLayers, textMode, autoAnchor }))
  }
)

const NODE_PROPS_HINT = 'x,y tương đối với parent (góc trên-trái, Y xuống). Trả về id node mới (dùng cho parent/flow sau đó).'

server.registerTool(
  'launch_app',
  { description: 'Mở app UIForge (nếu chưa chạy) và mở project. Các tool cần app cũng tự gọi việc này.', inputSchema: { project: z.string().optional().describe('thư mục project để mở') } },
  async ({ project }) => {
    if (project) projectDir = resolve(project)
    const up = await appUp()
    if (!up && !(await launchApp())) throw new Error('Không mở được app: chưa build (npm run build) hoặc chưa đóng gói (dist/win-unpacked).')
    if (project) await bridge('openProject', { dir: projectDir })
    return text(await bridge('ping'))
  }
)

server.registerTool(
  'ux_guide',
  { description: 'Hướng dẫn dựng lại UX/wireframe từ ảnh giao diện (screenshot / mockup) bằng shape + text + component + auto layout + flow. Đọc trước khi dùng add_frame/add_node cho việc này.', inputSchema: {} },
  async () =>
    text(`# Dựng lại UX từ ảnh giao diện

Mục tiêu: tái hiện CẤU TRÚC và LUỒNG (wireframe có màu), không phải copy pixel. Không cắt ảnh gốc thành asset (add_node image/crop chỉ dành cho asset thật).

## Quy trình
1. add_frame {name, width, height} — KÍCH THƯỚC CHUẨN: game dọc 1080×1920, game ngang 1920×1080 (16:9, tỉ lệ hẹp nhất; máy dài hơn chỉ dư khoảng trống ở mép vì scaler Expand). Không dùng kích thước ảnh nếu ảnh không phải 16:9; scale toạ độ từ ảnh sang frame theo chiều rộng (dọc) hoặc chiều cao (ngang). background chỉ dùng khi có đường dẫn file (lớp tham chiếu _reference, khoá).
2. Dựng từng vùng bằng shape: rect (fill màu chủ đạo lấy từ ảnh, cornerRadius, stroke nếu cần, shape ellipse cho icon tròn/avatar), text (nội dung thật trong ảnh, fontSize/color/align ước lượng). Đặt tên có nghĩa: btn_play, panel_shop, txt_title, icon_coin, hud_top…
3. Gom group theo vùng UI (hud_top, panel_main, nav_bottom) bằng group_nodes hoặc add_node type group rồi thêm con.
4. Thứ gì lặp lại (nút cùng kiểu, item danh sách, thẻ, tab): dựng MỘT cái đầy đủ → create_component → create_instance cho các bản còn lại, đổi chữ bằng set_instance_override. Danh sách / hàng nút → set_layout (auto layout) trên group cha.
5. CHỈ dựng những màn hình / popup CÓ TRONG ẢNH. Không tự bịa popup, màn phụ hay nội dung không thấy trong ảnh; nút chưa biết dẫn đi đâu thì để trống (không add_flow) và liệt kê lại cho người dùng. Mỗi ảnh = một frame; popup trong ảnh = frame nhỏ riêng. Nối bằng add_flow chỉ khi đích thật sự có trong ảnh: nút → navigate, nút mở popup → overlay (dim, closeOutside), nút X → close, back → back.
6. auto_anchor cho từng frame (đa màn hình), simulate_frame kiểm tra (báo tràn / lấn safe area / đè lên nhau). Nếu đè nhau: set_scaler expand (mặc định) hoặc neo lại; không co kéo node để né.
7. render_frame để đối chiếu với ảnh gốc; chỉnh bằng set_node_props. Cuối cùng ẩn lớp _reference (set_node_props visible:false) hoặc delete_node.

## Nguyên tắc
- Ưu tiên đúng vị trí/kích thước tương đối, phân cấp và tên node; màu chỉ cần gần đúng.
- Text luôn là text node (không vẽ chữ bằng shape).
- Mỗi nút = group {rect nền + text}; component hoá nếu xuất hiện ≥ 2 lần.
- Đặt ảnh tham chiếu ở dưới cùng (index 0) và khoá; khi so sánh có thể set opacity 0.5.
- Trả cho người dùng: danh sách frame, component, flow đã tạo và những chỗ ước lượng chưa chắc.`)
)

server.registerTool(
  'add_frame',
  {
    description: 'Tạo frame (màn hình) mới trên page hiện tại — cần app đang chạy. Dựng UX từ ảnh: đọc ux_guide trước. ' + NODE_PROPS_HINT,
    inputSchema: {
      name: z.string(),
      width: z.number(),
      height: z.number(),
      x: z.number().optional().describe('vị trí trên canvas; bỏ trống = bên phải các frame hiện có'),
      y: z.number().optional(),
      fill: z.string().nullable().optional().describe('#rrggbb; null = không nền'),
      background: z.string().optional().describe('đường dẫn ảnh (screenshot) đặt làm lớp nền 1:1 để dựng đè lên')
    }
  },
  async ({ name, width, height, x, y, fill, background }) => {
    if (!(await appAvailable())) throw new Error('App chưa chạy.')
    const { doc } = await loadDoc()
    const page = doc.pages[0]
    let fx = x
    let fy = y
    if (fx === undefined || fy === undefined) {
      let right = 0
      let top = Infinity
      for (const c of page.children) {
        right = Math.max(right, c.x + c.width)
        top = Math.min(top, c.y)
      }
      fx ??= page.children.length ? right + 120 : 0
      fy ??= Number.isFinite(top) ? top : 0
    }
    const ops: Record<string, unknown>[] = [{ op: 'addNode', type: 'frame', name, x: fx, y: fy, width, height, fill: fill === undefined ? '#ffffff' : fill }]
    const r = await bridge<{ applied: string[]; selection: string[] }>('apply', { ops })
    const frameId = r.selection[0]
    if (background) {
      const r2 = await bridge<{ applied: string[]; selection: string[] }>('apply', { ops: [{ op: 'addNode', type: 'image', name: '_reference', file: resolve(background), x: 0, y: 0, width, height, parent: frameId, opacity: 1, props: { locked: true } }] })
      r.applied.push(...r2.applied)
    }
    return text({ frameId, applied: r.applied })
  }
)

server.registerTool(
  'add_node',
  {
    description:
      'Tạo node trong frame/group (cần app): rect (shape: fill, viền, bo góc, ellipse — dùng cho nút/panel/icon khi dựng UX), text (chữ sống), group (rỗng, thêm con sau bằng parent), image / nineslice (từ file ảnh, crop {x,y,width,height} theo pixel ảnh gốc — chỉ khi cần asset thật, KHÔNG dùng để dựng UX). Đọc ux_guide trước khi dựng lại giao diện từ ảnh. ' + NODE_PROPS_HINT,
    inputSchema: {
      type: z.enum(['rect', 'text', 'image', 'nineslice', 'group']),
      name: z.string(),
      parent: z.string().describe('frame/group đích (id, path hoặc tên)'),
      x: z.number().default(0),
      y: z.number().default(0),
      width: z.number().optional().describe('image: bỏ trống = kích thước ảnh/crop'),
      height: z.number().optional(),
      fill: z.string().nullable().optional().describe('rect: #rrggbb hoặc #rrggbbaa; null = trong suốt'),
      cornerRadius: z.number().optional(),
      stroke: z.string().optional().describe('rect: màu viền #rrggbb'),
      strokeWidth: z.number().optional(),
      shape: z.enum(['rect', 'ellipse']).optional().describe('rect: ellipse = hình tròn/oval'),
      text: z.string().optional(),
      fontSize: z.number().optional(),
      fontFamily: z.string().optional(),
      fontWeight: z.number().optional(),
      color: z.string().optional().describe('text: #rrggbb'),
      align: z.enum(['left', 'center', 'right']).optional(),
      file: z.string().optional().describe('image/nineslice: đường dẫn PNG/JPG'),
      crop: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
      insets: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).optional(),
      opacity: z.number().optional(),
      visible: z.boolean().optional(),
      index: z.number().optional().describe('vị trí trong children (0 = dưới cùng); mặc định trên cùng'),
      props: z.record(z.string(), z.unknown()).optional().describe('props thêm như set_node_props (anchor, pivot, safeArea, layout, meta…)')
    }
  },
  async (a) => {
    if (!(await appAvailable())) throw new Error('App chưa chạy.')
    const op: Record<string, unknown> = { ...a, op: 'addNode' }
    if (a.file) op.file = resolve(a.file)
    const r = await bridge<{ applied: string[]; selection: string[] }>('apply', { ops: [op] })
    return text({ nodeId: r.selection[0], applied: r.applied })
  }
)

server.registerTool(
  'add_nodes',
  {
    description: 'Tạo nhiều node một lần (cùng tham số như add_node, theo thứ tự; node sau có thể dùng parent là tên/path node trước). Nhanh hơn gọi add_node nhiều lần.',
    inputSchema: { nodes: z.array(z.record(z.string(), z.unknown())).min(1) }
  },
  async ({ nodes }) => {
    if (!(await appAvailable())) throw new Error('App chưa chạy.')
    const ops = nodes.map((n) => ({ ...n, op: 'addNode', ...(n.file ? { file: resolve(String(n.file)) } : {}) }))
    const r = await bridge<{ applied: string[] }>('apply', { ops })
    return text(r.applied)
  }
)

server.registerTool(
  'group_nodes',
  { description: 'Gom các node (cùng parent) thành group.', inputSchema: { nodes: z.array(z.string()).min(1), name: z.string().optional() } },
  async ({ nodes, name }) => {
    if (!(await appAvailable())) throw new Error('App chưa chạy.')
    const r = await bridge<{ applied: string[]; selection: string[] }>('apply', { ops: [{ op: 'groupNodes', nodes, name }] })
    return text({ groupId: r.selection[0], applied: r.applied })
  }
)

server.registerTool('delete_node', { description: 'Xoá node (và con của nó).', inputSchema: { node: z.string() } }, async ({ node }) => {
  if (!(await appAvailable())) throw new Error('App chưa chạy.')
  return text(await applyOps([{ op: 'deleteNode', node }]))
})

server.registerTool(
  'set_node_props',
  {
    description: 'Sửa thuộc tính node: name, x, y, width, height, rotation, opacity, visible, locked, anchor {minX,minY,maxX,maxY}, pivot {x,y}, insets (9-slice), text, fontSize, color, meta...',
    inputSchema: { node: z.string(), props: z.record(z.string(), z.unknown()) }
  },
  async ({ node, props }) => text(await applyOps([{ op: 'setNodeProps', node, props }]))
)

server.registerTool(
  'convert_nine_slice',
  {
    description: 'Chuyển image ↔ 9-slice. insets theo pixel ảnh gốc.',
    inputSchema: { node: z.string(), toNineSlice: z.boolean().default(true), insets: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).optional() }
  },
  async ({ node, toNineSlice, insets }) => text(await applyOps([{ op: toNineSlice ? 'convertToNineSlice' : 'convertToImage', node, insets }]))
)

server.registerTool(
  'add_flow',
  {
    description:
      'Thêm tương tác prototype (kiểu Figma): trigger trên node hotspot → action. action: navigate (đổi màn), overlay (mở popup đè lên, có dim + đóng khi bấm ngoài), swap (đổi popup đang mở), back (quay lại màn trước), close (đóng popup). Frame cũng làm hotspot được (after-delay / key). Cùng hotspot + trigger thì ghi đè.',
    inputSchema: {
      from: z.string().describe('node id/path/tên của hotspot (hoặc tên frame)'),
      to: z.string().optional().describe('frame đích (tên hoặc id) — bắt buộc với navigate/overlay/swap'),
      action: z.enum(['navigate', 'overlay', 'swap', 'back', 'close']).optional().describe('mặc định navigate'),
      trigger: z.enum(['click', 'hover', 'press', 'drag', 'after-delay', 'key']).optional().describe('mặc định click'),
      delay: z.number().optional().describe('ms, cho after-delay'),
      key: z.string().optional().describe('phím cho trigger key, vd "Escape", "Enter", "a"'),
      transition: z.enum(['instant', 'dissolve', 'smart', 'move-in', 'move-out', 'push', 'slide-in', 'slide-out', 'scale-in', 'scale-out']).optional().describe('mặc định: dissolve (navigate), scale-in (overlay)'),
      direction: z.enum(['left', 'right', 'up', 'down']).optional(),
      duration: z.number().optional().describe('ms'),
      easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back-out', 'spring']).optional(),
      overlay: z
        .object({
          position: z.enum(['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'manual']).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          dim: z.boolean().optional(),
          dimColor: z.string().optional(),
          dimOpacity: z.number().optional(),
          closeOutside: z.boolean().optional()
        })
        .optional()
        .describe('thiết lập popup cho action overlay/swap')
    }
  },
  async (a) => text(await applyOps([{ op: 'addConnection', ...a }]))
)

server.registerTool('remove_flow', { description: 'Xoá một flow theo id.', inputSchema: { id: z.string() } }, async ({ id }) => text(await applyOps([{ op: 'removeConnection', id }])))

server.registerTool('set_start_frame', { description: 'Đặt frame bắt đầu của luồng.', inputSchema: { frame: z.string() } }, async ({ frame }) => text(await applyOps([{ op: 'setStartFrame', frame }])))

server.registerTool(
  'export_layout',
  {
    description: 'Export toàn bộ: export/index.json, <page>/manifest.json, <page>/<frame>.json, preview PNG, assets/, FLOWS.md, SPEC.md. Khi app chạy sẽ có preview; không thì export từ file (không preview).',
    inputSchema: {}
  },
  async () => {
    if (await appAvailable()) return text(await bridge('export'))
    const { doc, dir } = await loadDoc()
    if (!dir) throw new Error('no project dir')
    const outDir = join(dir, 'export')
    await mkdir(join(outDir, 'assets'), { recursive: true })
    const index = { schema: 'uiforge-export-index', project: doc.name, exportedAt: new Date().toISOString(), pages: [] as { name: string; folder: string; manifest: string }[] }
    for (const page of doc.pages) {
      const folder = safeFileName(page.name)
      const pageDir = join(outDir, folder)
      await mkdir(pageDir, { recursive: true })
      await writeFile(join(pageDir, 'manifest.json'), JSON.stringify(buildPageManifest(doc, page), null, 2))
      index.pages.push({ name: page.name, folder, manifest: `${folder}/manifest.json` })
      for (const c of page.children) if (c.type === 'frame') await writeFile(join(pageDir, frameFileName(c)), JSON.stringify(buildFrameLayout(doc, page, c), null, 2))
      for (const a of collectUsedAssets(page.children, doc.assets)) {
        const src = join(dir, 'assets', a.file)
        if (existsSync(src)) await copyFile(src, join(outDir, 'assets', a.file))
      }
    }
    await writeFile(join(outDir, 'index.json'), JSON.stringify(index, null, 2))
    await writeFile(join(outDir, 'FLOWS.md'), buildFlowsMarkdown(doc))
    await writeFile(join(outDir, 'SPEC.md'), specMarkdown)
    return text({ outDir, note: 'export từ file, không có preview PNG (mở app để có)' })
  }
)

server.registerTool('save_project', { description: 'Lưu project trong app (cần app đang chạy).', inputSchema: { dir: z.string().optional() } }, async ({ dir }) => {
  if (!(await appAvailable())) throw new Error('App chưa chạy.')
  return text(await bridge('save', { dir }))
})

server.registerTool('open_project', { description: 'Chọn thư mục project (chứa project.json). Nếu app đang chạy sẽ mở trong app luôn.', inputSchema: { dir: z.string() } }, async ({ dir }) => {
  projectDir = resolve(dir)
  if (await appAvailable()) return text(await bridge('openProject', { dir: projectDir }))
  const { doc } = await loadDoc()
  return text({ projectDir, name: doc.name, pages: doc.pages.length })
})

server.registerTool(
  'find_nodes',
  { description: 'Tìm node trên toàn project theo chuỗi trong path và/hoặc type.', inputSchema: { query: z.string().optional(), type: z.enum(['frame', 'group', 'image', 'nineslice', 'rect', 'text', 'instance']).optional() } },
  async ({ query, type }) => {
    const { doc } = await loadDoc()
    const q = query?.toLowerCase()
    const out: unknown[] = []
    for (const page of doc.pages) {
      for (const e of indexPage(page).byId.values()) {
        if (type && e.node.type !== type) continue
        if (q && !e.path.toLowerCase().includes(q)) continue
        out.push({ id: e.node.id, path: e.path, type: e.node.type, page: page.name, rect: { x: e.absX, y: e.absY, width: e.node.width, height: e.node.height } })
        if (out.length >= 200) break
      }
    }
    return text(out)
  }
)

// ----------------------------------------------------------------- components / layout / devices / diff
server.registerTool(
  'list_components',
  { description: 'Liệt kê component master (group/frame đã Create component) và số instance. Export Unity sẽ tạo prefab theo tên component.', inputSchema: {} },
  async () => {
    if (await appAvailable()) return text(await bridge('listComponents'))
    const { doc } = await loadDoc()
    const out: unknown[] = []
    for (const page of doc.pages)
      for (const e of indexPage(page).byId.values()) {
        const n = e.node
        if ((n.type === 'frame' || n.type === 'group') && n.component) out.push({ id: n.id, name: n.component.name, page: page.name, path: e.path, width: n.width, height: n.height })
      }
    return text(out)
  }
)

server.registerTool(
  'create_component',
  { description: 'Biến một group/frame thành component master (như Figma). Instance sẽ cập nhật theo master.', inputSchema: { node: z.string(), name: z.string().optional() } },
  async ({ node, name }) => text(await applyOps([{ op: 'createComponent', node, name }]))
)

server.registerTool(
  'create_instance',
  {
    description: 'Đặt một instance của component vào frame/group (cần app đang chạy). x,y tương đối với parent.',
    inputSchema: { component: z.string().describe('id hoặc tên component'), parent: z.string().describe('frame/group đích (id, path hoặc tên)'), x: z.number().optional(), y: z.number().optional(), name: z.string().optional() }
  },
  async ({ component, parent, x, y, name }) => {
    if (!(await appAvailable())) throw new Error('App chưa chạy.')
    return text(await applyOps([{ op: 'createInstance', component, parent, x, y, name }]))
  }
)

server.registerTool(
  'set_instance_override',
  { description: 'Ghi đè text / ẩn-hiện của một child trong instance (child = id hoặc tên/path trong master).', inputSchema: { instance: z.string(), child: z.string(), text: z.string().optional(), visible: z.boolean().optional() } },
  async ({ instance, child, text: t, visible }) => {
    if (!(await appAvailable())) throw new Error('App chưa chạy.')
    const patch: Record<string, unknown> = {}
    if (t !== undefined) patch.text = t
    if (visible !== undefined) patch.visible = visible
    return text(await applyOps([{ op: 'setOverride', instance, child, patch }]))
  }
)

server.registerTool('detach_instance', { description: 'Tách instance thành group thường.', inputSchema: { node: z.string() } }, async ({ node }) => {
  if (!(await appAvailable())) throw new Error('App chưa chạy.')
  return text(await applyOps([{ op: 'detachInstance', node }]))
})

server.registerTool(
  'add_component_state',
  {
    description: 'Thêm trạng thái cho component master (Unity Button SpriteState): tạo lớp con tên <state> bằng cách sao chép lớp "normal" (nội dung hiện tại được gói thành "normal" nếu chưa có), ẩn sẵn. Sau đó sửa màu/ảnh trong lớp đó bằng set_node_props (path "<master>/<state>/…"). show=true để hiện lớp đó thay cho normal.',
    inputSchema: { component: z.string(), state: z.enum(['normal', 'hover', 'pressed', 'disabled', 'selected']), show: z.boolean().optional() }
  },
  async ({ component, state, show }) => {
    if (!(await appAvailable())) throw new Error('App chưa chạy.')
    return text(await applyOps([{ op: 'addState', component, state, show }]))
  }
)

server.registerTool(
  'set_layout',
  {
    description: 'Bật/tắt auto layout (hàng/cột) cho group/frame. Export Unity → Horizontal/VerticalLayoutGroup. layout=null để tắt.',
    inputSchema: {
      node: z.string(),
      layout: z
        .object({
          direction: z.enum(['horizontal', 'vertical']),
          gap: z.number().default(8),
          padding: z.object({ top: z.number(), right: z.number(), bottom: z.number(), left: z.number() }).default({ top: 0, right: 0, bottom: 0, left: 0 }),
          align: z.enum(['start', 'center', 'end']).default('start'),
          hug: z.boolean().default(true)
        })
        .nullable()
    }
  },
  async ({ node, layout }) => text(await applyOps([{ op: 'setLayout', node, layout }]))
)

server.registerTool(
  'set_image_edits',
  {
    description: 'Chỉnh ảnh không phá huỷ (cần app): crop {x,y,width,height} theo pixel ảnh gốc, flipH/flipV, rotate 0|90|180|270, adjustments (ag-psd AdjustmentLayer: hue/saturation, brightness/contrast, levels...). edits=null để bỏ.',
    inputSchema: { node: z.string(), edits: z.record(z.string(), z.unknown()).nullable() }
  },
  async ({ node, edits }) => {
    if (!(await appAvailable())) throw new Error('App chưa chạy.')
    return text(await applyOps([{ op: 'setImageEdits', node, edits }]))
  }
)

server.registerTool(
  'simulate_frame',
  {
    description: 'Mô phỏng frame trên nhiều tỷ lệ màn hình như Unity (CanvasScaler + anchors + safe area) và báo node tràn màn / lấn tai thỏ. Không cần app. devices: iphone15, iphoneSE, galaxyS, pixel, ipad, tablet, fold.',
    inputSchema: { frame: z.string(), devices: z.array(z.string()).optional(), scaler: z.object({ mode: z.enum(['expand', 'shrink', 'match']), match: z.number().min(0).max(1).optional() }).optional().describe('CanvasScaler thử nghiệm; mặc định theo project (expand = không đè)'), match: z.number().min(0).max(1).optional().describe('(cũ) matchWidthOrHeight'), allNodes: z.boolean().optional().describe('trả cả node không lỗi kèm rect mô phỏng') }
  },
  async ({ frame, devices, scaler, match, allNodes }) => {
    if (await appAvailable()) return text(await bridge('simulateFrame', { frame, devices, scaler, match, allNodes }))
    const { doc } = await loadDoc()
    const { frame: f } = findFrame(doc, frame)
    const ids = devices?.length ? devices : (doc.previewDevices ?? DEFAULT_PREVIEW_DEVICES)
    const out = ids
      .map((id) => DEVICE_PRESETS.find((d) => d.id === id))
      .filter((d): d is (typeof DEVICE_PRESETS)[number] => !!d)
      .map((d) => {
        const sim = simulateFrame(f, d, scaler ? { mode: scaler.mode, match: scaler.match ?? 0 } : scalerOf(doc, match))
        return { device: { id: d.id, name: d.name, width: d.width, height: d.height }, canvas: sim.canvas, safe: sim.safe, scale: sim.scale, issues: sim.issues, nodes: sim.nodes.filter((n) => n.issues.length || allNodes).map((n) => ({ id: n.id, path: n.path, rect: n.rect, issues: n.issues })) }
      })
    return text(out)
  }
)

server.registerTool(
  'auto_anchor',
  {
    description:
      'Tự đặt anchor/pivot/safe-area cho node cấp 1 của frame theo rule vị trí: nửa trên → Top, nửa dưới → Bottom, sát trái/phải → Left/Right, giữa → Center/Middle, nền phủ màn → stretch, 9-slice/rect rộng hết màn → giãn, node neo theo mép → safeArea (đi theo tai thỏ / home bar). apply=false chỉ trả gợi ý. Mặc định không đụng node đã chỉnh anchor tay (overwrite=true để đổi hết). Sau đó dùng simulate_frame để kiểm tra.',
    inputSchema: {
      frame: z.string(),
      apply: z.boolean().optional().describe('mặc định true'),
      overwrite: z.boolean().optional(),
      safeArea: z.boolean().optional().describe('gắn safeArea cho node sát mép, mặc định true'),
      centerBand: z.number().optional().describe('lệch tâm ≤ tỉ lệ này → Center/Middle, mặc định 0.12'),
      edgeBand: z.number().optional().describe('cách mép ≤ tỉ lệ này → safe area, mặc định 0.1')
    }
  },
  async ({ frame, apply, overwrite, safeArea, centerBand, edgeBand }) => {
    const rules: Record<string, unknown> = {}
    if (overwrite !== undefined) rules.overwrite = overwrite
    if (safeArea !== undefined) rules.safeArea = safeArea
    if (centerBand !== undefined) rules.centerBand = centerBand
    if (edgeBand !== undefined) rules.edgeBand = edgeBand
    const { doc } = await loadDoc()
    const { frame: f } = findFrame(doc, frame)
    const sug = suggestAnchors(f, rules).map((x) => ({ node: x.name, id: x.id, anchor: x.label, safeArea: x.safeArea, reason: x.reason, willApply: x.apply }))
    if (apply === false) return text(sug)
    const log = await applyOps([{ op: 'autoAnchor', frame, rules }])
    return text({ applied: log, suggestions: sug })
  }
)

server.registerTool(
  'set_scaler',
  {
    description: 'Đặt CanvasScaler cho project (mô phỏng + export Unity): expand = canvas không bao giờ nhỏ hơn thiết kế ở cả hai chiều nên không gì đè nhau (khuyên dùng); match = matchWidthOrHeight 0..1; shrink = phủ kín, có thể cắt.',
    inputSchema: { mode: z.enum(['expand', 'shrink', 'match']), match: z.number().min(0).max(1).optional() }
  },
  async ({ mode, match }) => {
    if (await appAvailable()) return text(await bridge('setDocProps', { props: { scaler: { mode, match: match ?? 0 } } }))
    const { doc } = await loadDoc()
    doc.scaler = { mode, match: match ?? 0 }
    await saveDocFile(doc)
    return text({ ok: true, scaler: doc.scaler, note: 'đã ghi project.json' })
  }
)

server.registerTool(
  'compare_frame',
  {
    description: 'So sánh ảnh capture từ Unity (UIForgeCapture.cs, đúng reference resolution) với bản render của tool; báo từng node lệch vị trí (dx,dy), thiếu, hoặc khác sprite/font. Cần app đang chạy.',
    inputSchema: {
      frame: z.string(),
      capturePath: z.string().describe('PNG capture từ Unity'),
      threshold: z.number().optional().describe('% sai lệch coi là lỗi, mặc định 3 (lệch vị trí phát hiện từ 0.5%)'),
      maxShift: z.number().optional().describe('px tìm dịch chuyển, mặc định 16'),
      diffPath: z.string().optional().describe('nếu có, ghi ảnh heat-map khác biệt ra đây')
    }
  },
  async ({ frame, capturePath, threshold, maxShift, diffPath }) => {
    if (!(await appAvailable())) throw new Error('App chưa chạy.')
    const r = await bridge<{ summary: string[]; nodes: unknown[]; mismatched: number; checked: number; overallDiff: number }>('compareFrame', { frame, capturePath: resolve(capturePath), threshold, maxShift, diffPath: diffPath ? resolve(diffPath) : undefined })
    const bad = (r.nodes as { status: string }[]).filter((n) => n.status !== 'ok')
    return text({ summary: r.summary, overallDiff: r.overallDiff, checked: r.checked, mismatched: r.mismatched, nodes: bad, diffPath: diffPath ? resolve(diffPath) : null })
  }
)

// ----------------------------------------------------------------- game link (HTML5 games ↔ UIForge)
const posix = (p: string): string => p.replace(/\\/g, '/')
const gameDir = (root: string): string => join(resolve(root), GAME_DIR)

/** Makes `<root>/uiforge` the open project (app running) or the file-mode project. */
async function openGame(root: string): Promise<unknown> {
  projectDir = gameDir(root)
  if (await appAvailable()) return bridge('openGame', { root: posix(resolve(root)) })
  return null
}

function elementTree(els: GameElement[], depth = 0, out: string[] = []): string[] {
  for (const e of els) {
    if (out.length >= 400) break
    const extra = e.type === 'text' ? ` "${(e.text ?? '').slice(0, 30)}"` : e.asset ? ` ${e.asset}` : e.snapshot ? ' (snapshot)' : ''
    out.push(`${'  '.repeat(depth)}${e.id} [${e.type}${e.interactive ? ', interactive' : ''}] ${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.width)}×${Math.round(e.height)}${extra}`)
    if (e.children) elementTree(e.children, depth + 1, out)
  }
  return out
}

server.registerTool('game_guide', { description: 'Hướng dẫn nối một game HTML5/web (Phaser, DOM/CSS, canvas) với UIForge: đưa mọi màn hình + flow của game lên app (capture_game / push_game_design), thay art, sync thay đổi về game và cách agent của game áp dụng. ĐỌC TRƯỚC khi dùng các tool game.', inputSchema: {} }, async () => text(gameGuide))

const captureScreen = z.object({
  id: z.string(),
  name: z.string().optional(),
  kind: z.enum(['screen', 'popup']).optional(),
  enter: z.string().optional().describe('JS chạy trong trang để tới màn này (dùng được await)'),
  reload: z.boolean().optional(),
  waitFor: z.string().optional().describe('biểu thức JS, chờ tới khi true (tối đa 15 s)'),
  waitMs: z.number().optional(),
  engine: z.enum(['phaser', 'dom', 'auto']).optional(),
  root: z.string().optional().describe('DOM: selector của màn'),
  scenes: z.array(z.string()).optional().describe('Phaser: chỉ đọc các scene này'),
  exclude: z.array(z.string()).optional(),
  only: z.array(z.string()).optional().describe('chỉ giữ element có id/tên khớp regex (cả cây con) — vd một popup container'),
  clip: z.union([z.literal('elements'), z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })]).optional(),
  screenshotOnly: z.boolean().optional(),
  code: z.string().optional().describe('file source dựng màn này')
})

server.registerTool(
  'capture_game',
  {
    description:
      'Chụp UI của một game HTML5 đang chạy (dev server) và đưa lên UIForge: app mở game trong cửa sổ ẩn, chạy JS `enter` để tới từng màn, chụp ảnh, đọc element (Phaser display list hoặc DOM), nối ảnh về file art trong thư mục game, tạo/cập nhật project <root>/uiforge với một frame mỗi màn + flows. Recipe được lưu ở <root>/uiforge/capture.json nên lần sau chỉ cần {root}. Đọc game_guide trước. dryRun=true: chỉ trả cây element (để viết flows), không đẩy lên app.',
    inputSchema: {
      root: z.string().describe('đường dẫn tuyệt đối thư mục game'),
      name: z.string().optional(),
      url: z.string().optional().describe('URL dev server, vd http://localhost:3140/'),
      engine: z.enum(['phaser', 'dom', 'auto']).optional(),
      game: z.string().optional().describe('đường dẫn tới Phaser.Game, vd "window.__game"'),
      viewport: z.object({ width: z.number(), height: z.number() }).optional().describe('độ phân giải thiết kế của game'),
      assetRoots: z.array(z.string()).optional().describe('thư mục (tương đối root) mà dev server phục vụ ở "/", mặc định thử "", public, static, src, dist'),
      settleMs: z.number().optional(),
      exclude: z.array(z.string()).optional(),
      screens: z.array(captureScreen).optional(),
      flows: z.array(z.record(z.string(), z.unknown())).optional().describe('[{from: "màn/element", to: "màn", action?, trigger?}]'),
      start: z.string().optional(),
      components: z.array(z.object({ name: z.string(), match: z.string().describe('regex theo id/tên element (group)'), code: z.string().optional().describe('chỗ code dựng widget này, vd "src/ui/widgets.ts button()"') })).optional().describe('widget dùng chung của game → component (master + instance). Xem game_guide mục Component'),
      autoComponents: z.boolean().optional().describe('tự nhận các group lặp lại (cùng cấu trúc + art) làm component; mặc định true'),
      only: z.array(z.string()).optional().describe('chỉ capture các màn có id này (màn khác trong app giữ nguyên) — NHANH, dùng khi capture lại'),
      fresh: z.boolean().optional().describe('mở cửa sổ game mới thay vì dùng lại cửa sổ đang sống từ lần capture trước'),
      dryRun: z.boolean().optional()
    }
  },
  async ({ root, only, dryRun, fresh, ...given }) => {
    if (!(await appAvailable())) throw new Error('App UIForge chưa chạy và không tự mở được.')
    const recipeFile = join(gameDir(root), 'capture.json')
    const saved = existsSync(recipeFile) ? (JSON.parse(await readFile(recipeFile, 'utf8')) as Record<string, unknown>) : {}
    const recipe: Record<string, unknown> = { ...saved, root: posix(resolve(root)) }
    for (const [k, v] of Object.entries(given)) if (v !== undefined) recipe[k] = v
    recipe.name ??= resolve(root).split(/[\\/]/).pop()
    if (!recipe.url || !recipe.viewport || !Array.isArray(recipe.screens) || !recipe.screens.length) throw new Error('Chưa có recipe: cần url, viewport {width,height} và screens[] (xem game_guide).')
    await mkdir(gameDir(root), { recursive: true })
    if (!dryRun) await writeFile(recipeFile, JSON.stringify(recipe, null, 2))
    const run = { ...recipe, ...(fresh ? { fresh: true } : {}), ...(only?.length ? { screens: (recipe.screens as { id: string }[]).filter((s) => only.includes(s.id)) } : {}) }
    const cap = await bridge<{ design: GameDesign; report: { id: string; engine: string; elements: number; sources: number; snapshots: number; warnings: string[] }[]; fonts?: { written: string[]; unchanged: string[]; warnings: string[] } }>('captureGame', run)
    await writeFile(join(gameDir(root), 'design.json'), JSON.stringify(cap.design, null, 2))
    const trees = cap.design.screens.map((s) => `## ${s.id} (${s.width}×${s.height})\n${elementTree(s.elements).join('\n')}`).join('\n\n')
    if (dryRun) return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, screens: cap.report, fonts: cap.fonts }, null, 2) }, { type: 'text', text: trees }] }
    const pushed = await bridge<Record<string, unknown>>('pushGameDesign', { design: cap.design })
    projectDir = gameDir(root)
    return { content: [{ type: 'text', text: JSON.stringify({ captured: cap.report, fonts: cap.fonts, pushed, recipe: recipeFile, hint: 'render_frame {frame} để xem app dựng lại; get_game_changes {root} để xem thứ còn lệch so với thiết kế.' }, null, 2) }, { type: 'text', text: trees }] }
  }
)

server.registerTool(
  'push_game_design',
  {
    description: 'Đẩy UI của game lên UIForge từ một JSON "uiforge-game-design" tự dựng (khi capture_game không đọc được, vd UI vẽ hết bằng canvas): screens[] (elements với rect tuyệt đối, asset = file art tương đối root, snapshot, code) + flows[]. Tạo/cập nhật project <root>/uiforge. Định dạng: xem game_guide.',
    inputSchema: { file: z.string().optional().describe('đường dẫn file JSON'), design: z.record(z.string(), z.unknown()).optional().describe('hoặc truyền thẳng object') }
  },
  async ({ file, design }) => {
    if (!(await appAvailable())) throw new Error('App UIForge chưa chạy và không tự mở được.')
    const d = (design ?? (file ? JSON.parse(await readFile(resolve(file), 'utf8')) : null)) as GameDesign | null
    if (!d) throw new Error('cần file hoặc design')
    const r = await bridge<Record<string, unknown>>('pushGameDesign', { design: d })
    if (d.game?.root) projectDir = gameDir(d.game.root)
    return text(r)
  }
)

server.registerTool(
  'get_game_changes',
  { description: 'Những thay đổi UI artist đã làm trong UIForge mà game chưa có (so với lần push gần nhất): art thay, dời/đổi cỡ, chữ, ẩn/hiện, thêm/xoá, flow — kèm `code` (chỗ trong source) của từng element. Không ghi gì. Agent của game đọc cái này (hoặc uiforge/CHANGES.md sau khi sync) để sửa code.', inputSchema: { root: z.string().describe('thư mục game') } },
  async ({ root }) => {
    await openGame(root)
    if (await appUp()) {
      const r = await bridge<{ changes: unknown; markdown: string }>('gameChanges')
      return { content: [{ type: 'text', text: r.markdown }, { type: 'text', text: JSON.stringify(r.changes, null, 2) }] }
    }
    const { doc } = await loadDoc()
    const c = diffGame(doc)
    return { content: [{ type: 'text', text: buildChangesMarkdown(c) }, { type: 'text', text: JSON.stringify(c, null, 2) }] }
  }
)

server.registerTool(
  'sync_game',
  {
    description: 'Ghi thay đổi từ UIForge về thư mục game (giống nút "Sync → Game"): ghi đè file art đã thay (bản cũ vào uiforge/backup), art mới chưa có file vào uiforge/incoming, và uiforge/CHANGES.md + changes.json + layout/<màn>.json + preview/<màn>.png. Cần app đang chạy.',
    inputSchema: { root: z.string(), resample: z.boolean().optional().describe('mặc định true: art cùng tỉ lệ khác kích thước pixel được thu về kích thước cũ để game không cần sửa code'), runAgent: z.boolean().optional().describe('true: sau khi ghi, chạy Claude Code headless trong thư mục game để tự áp dụng CHANGES.md (KHÔNG dùng khi chính bạn là agent của game — tự áp dụng đi)') }
  },
  async ({ root, resample, runAgent }) => {
    if (!(await appAvailable())) throw new Error('App UIForge chưa chạy.')
    await openGame(root)
    const r = await bridge<{ markdown: string; written: string[]; unchanged: string[]; backups: string[]; dir: string; changes: { total: number }; agent?: unknown }>('syncGame', { resample, runAgent })
    return { content: [{ type: 'text', text: JSON.stringify({ dir: r.dir, written: r.written, unchanged: r.unchanged, backups: r.backups, uiChanges: r.changes.total, agent: r.agent }, null, 2) }, { type: 'text', text: r.markdown }] }
  }
)

server.registerTool(
  'ack_game_changes',
  { description: 'Báo cho UIForge rằng game đã áp dụng xong mọi thay đổi trong CHANGES.md: thiết kế hiện tại thành mốc mới, danh sách chờ về 0. Ưu tiên capture_game {root} (đo lại UI thật) — chỉ dùng tool này khi không capture được.', inputSchema: { root: z.string() } },
  async ({ root }) => {
    if (!(await appAvailable())) throw new Error('App UIForge chưa chạy.')
    await openGame(root)
    return text(await bridge('ackGame'))
  }
)

server.registerTool(
  'replace_game_art',
  {
    description: 'Thay art trong project game trên UIForge (giống kéo-thả ảnh trong tab Game): source = file art của game (mọi element dùng file đó đổi theo) hoặc node = một element; file = ảnh mới. Hoặc folder = thư mục art mới, khớp theo tên file / id element. Sau đó sync_game để ghi về game.',
    inputSchema: { root: z.string(), source: z.string().optional().describe('file art tương đối root, vd public/assets/ui/ui_btn_primary.png'), node: z.string().optional(), file: z.string().optional(), folder: z.string().optional() }
  },
  async ({ root, source, node, file, folder }) => {
    if (!(await appAvailable())) throw new Error('App UIForge chưa chạy.')
    const info = await openGame(root)
    const r = await bridge('replaceGameArt', { source, node, file: file ? posix(resolve(file)) : undefined, folder: folder ? posix(resolve(folder)) : undefined })
    await bridge('save', {})
    return text({ result: r, game: (info as { game?: unknown })?.game })
  }
)

// keep isContainer referenced for bundlers that tree-shake types-only modules
void isContainer

const transport = new StdioServerTransport()
await server.connect(transport)
