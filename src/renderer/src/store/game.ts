// Game link, renderer side: loads the art a game pushes, replaces art, and writes changes back into the
// game folder. The rules (merge / diff / baseline) are pure and live in model/game.ts.
import type { Asset, DesignDocument, NodeId, SceneNode } from '@/model/types'
import { indexPage } from '@/model/nodes'
import { createDocument } from '@/model/create'
import { safeFileName } from '@/model/naming'
import { fitViewToRect } from '@/canvas/viewMath'
import { renderFramePng } from '@/canvas/render'
import { GAME_DIR, priorComponents, buildChangesMarkdown, currentLayout, diffGame, gameFrames, gameIdOf, gameSources, mergeGameDesign, rebaselineGame, replaceGameSource, revertGameSource, setNodeArt, type GameChanges, type GameDesign, type GameElement, type MergeReport } from '@/model/game'
import { useEditor } from './editor'
import { clearAssetCache, getAssetBytes, pngFromCanvas, putAssetBytes, setAssetProjectDir, sha256Hex } from './assets'
import { openProject, saveProject } from './project'
import { loadProjectFonts } from './fonts'
import { COMPONENTS_SCREEN, prepareComponents, type PreparedComponent } from '@/model/gameComponents'

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp']

function status(s: string): void {
  useEditor.getState().setStatus(s)
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function samePath(a: string | null, b: string): boolean {
  return !!a && norm(a).toLowerCase() === norm(b).toLowerCase()
}

function isAbsolute(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
}

function isPng(b: Uint8Array): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
}

interface Crop {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Registers image bytes as a project asset. A whole PNG is stored byte for byte (so writing it back into the
 * game changes nothing); other formats and crops are re-encoded as PNG.
 */
export async function assetFromBytes(bytes: Uint8Array, name: string, source: string, crop?: Crop, resizeTo?: { width: number; height: number }): Promise<Asset> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]))
  let png = bytes
  let width = bmp.width
  let height = bmp.height
  if (crop || resizeTo || !isPng(bytes)) {
    const r = crop ? { x: Math.max(0, Math.round(crop.x)), y: Math.max(0, Math.round(crop.y)), width: Math.max(1, Math.round(crop.width)), height: Math.max(1, Math.round(crop.height)) } : { x: 0, y: 0, width: bmp.width, height: bmp.height }
    const c = document.createElement('canvas')
    c.width = resizeTo?.width ?? r.width
    c.height = resizeTo?.height ?? r.height
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, r.x, r.y, r.width, r.height, 0, 0, c.width, c.height)
    png = await pngFromCanvas(c)
    width = c.width
    height = c.height
  }
  bmp.close()
  const id = (await sha256Hex(png)).slice(0, 16)
  const asset: Asset = { id, file: `${safeFileName(name)}_${id.slice(0, 8)}.png`, width, height, source }
  const existing = useEditor.getState().doc.assets[id]
  if (existing) return existing
  useEditor.getState().update((d) => {
    if (!d.assets[id]) d.assets[id] = asset
  }, { history: false })
  putAssetBytes(id, png)
  return asset
}

function baseName(p: string): string {
  return p.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
}

// ----------------------------------------------------------------- project of a game
/** Opens (or creates) `<game root>/uiforge` as the current project. */
export async function ensureGameProject(root: string, name: string): Promise<string> {
  const dir = `${norm(root)}/${GAME_DIR}`
  const s = useEditor.getState()
  if (samePath(s.projectDir, dir)) return dir
  if (s.dirty) {
    if (s.projectDir) await saveProject()
    else if (s.doc.pages.some((p) => p.children.length)) throw new Error('App đang có project chưa lưu. Lưu (Ctrl+S) hoặc tạo project mới rồi thử lại.')
  }
  if (await window.api.exists(`${dir}/project.json`)) {
    await openProject(dir)
    if (!samePath(useEditor.getState().projectDir, dir)) throw new Error(`Không mở được ${dir}`)
    return dir
  }
  clearAssetCache()
  setAssetProjectDir(null)
  useEditor.getState().setDoc(createDocument(name), null)
  if (!(await saveProject(false, dir))) throw new Error(`Không tạo được project ở ${dir}`)
  await window.api.writeFile(`${dir}/.gitignore`, 'backup/\ncapture/\nexport/\n.autosave/\n')
  return dir
}

// ----------------------------------------------------------------- game → app
export interface PushResult extends MergeReport {
  projectDir: string
  pending: number
  /** components made from the game's shared widgets (declared or detected) */
  componentsFound: PreparedComponent[]
}

interface AssetCache {
  [key: string]: { mtimeMs: number; size: number; assetId: string; width: number; height: number }
}

async function readCache(dir: string): Promise<AssetCache> {
  try {
    return JSON.parse(await window.api.readText(`${dir}/asset-cache.json`)) as AssetCache
  } catch {
    return {}
  }
}

export async function pushGameDesign(design: GameDesign): Promise<PushResult> {
  if (!design || design.schema !== 'uiforge-game-design' || !Array.isArray(design.screens)) throw new Error('design không đúng schema "uiforge-game-design"')
  if (!design.game?.root || !design.game?.name) throw new Error('design.game cần name và root (đường dẫn tuyệt đối tới thư mục game)')
  const root = norm(design.game.root)
  design = { ...design, game: { ...design.game, root } }
  const T0 = performance.now()
  const lap = (what: string): void => console.log(`[push] ${what} ${Math.round(performance.now() - T0)}ms`)
  const dir = await ensureGameProject(root, design.game.name)
  // capture may just have written webfonts into <dir>/fonts
  await loadProjectFonts(dir)
  // shared widgets → component masters (pseudo-screen __components) + instances; earlier pushes' choices stay
  const prepared = prepareComponents(design, priorComponents(useEditor.getState().doc))
  design = prepared.design
  lap('project')
  const abs = (p: string): string => (isAbsolute(p) ? p : `${root}/${p}`)
  const warnings: string[] = []
  const byFile = new Map<string, Promise<Asset | undefined>>()
  const elementAsset = new Map<string, string>()
  const shotAsset = new Map<string, string>()
  const sourceAsset = new Map<string, Asset>()
  // files the previous push already turned into assets (same mtime + size ⇒ same pixels): no read, no decode, no hash
  const cache = await readCache(dir)
  const cacheHits = { hit: 0, miss: 0 }

  const load = (key: string, fn: () => Promise<Asset>): Promise<Asset | undefined> => {
    let p = byFile.get(key)
    if (!p) {
      p = fn().catch((e) => {
        warnings.push(`${key}: ${String((e as Error)?.message ?? e)}`)
        return undefined
      })
      byFile.set(key, p)
    }
    return p
  }
  /** a game file (or a crop of it) as an asset, through the mtime/size cache */
  const loadFile = (file: string, name: string, crop?: Crop): Promise<Asset | undefined> => {
    const key = `${file}${crop ? `#${crop.x},${crop.y},${crop.width},${crop.height}` : ''}`
    return load(key, async () => {
      const st = await window.api.stat(abs(file))
      if (!st) throw new Error('không thấy file')
      const c = cache[key]
      const known = c && c.mtimeMs === st.mtimeMs && c.size === st.size ? useEditor.getState().doc.assets[c.assetId] : undefined
      if (known && (await window.api.exists(`${dir}/assets/${known.file}`))) {
        cacheHits.hit++
        return known
      }
      cacheHits.miss++
      const a = await assetFromBytes(await window.api.readFile(abs(file)), name, `game:${file}`, crop)
      cache[key] = { mtimeMs: st.mtimeMs, size: st.size, assetId: a.id, width: a.width, height: a.height }
      return a
    })
  }

  for (const screen of design.screens) {
    // master copies take their art from the occurrence they were copied from (loaded with its screen)
    if (screen.id === COMPONENTS_SCREEN) continue
    status(`Nạp màn ${screen.name ?? screen.id}…`)
    let shot: { bytes: Uint8Array; scale: number; width: number; height: number } | null = null
    if (screen.screenshot) {
      try {
        const bytes = await window.api.readFile(abs(screen.screenshot))
        const a = await assetFromBytes(bytes, `${screen.id}_screen`, `game-screen:${screen.id}`)
        shotAsset.set(screen.id, a.id)
        shot = { bytes, scale: a.width / screen.width, width: a.width, height: a.height }
        // cut-outs come from the text-free shot when the game gave one
        if (screen.snapshotFrom) shot.bytes = await window.api.readFile(abs(screen.snapshotFrom))
      } catch (e) {
        warnings.push(`${screen.id}: không đọc được screenshot ${screen.screenshot} (${String((e as Error)?.message ?? e)})`)
      }
    }
    // every element's art loads concurrently (decoding runs off the main thread)
    const jobs: Promise<void>[] = []
    const visit = (els: GameElement[]): void => {
      for (const el of els) {
        if (el.type === 'image' || el.type === 'nineslice') jobs.push(loadElement(el))
        if (el.children) visit(el.children)
      }
    }
    const loadElement = async (el: GameElement): Promise<void> => {
      let asset: Asset | undefined
      if (el.asset) {
        const file = el.asset
        asset = await loadFile(file, baseName(file), el.crop)
        if (asset && !el.crop) sourceAsset.set(file, asset)
      }
      if (!asset && el.image) {
        const file = el.image
        asset = await load(`own:${file}`, async () => assetFromBytes(await window.api.readFile(abs(file)), `${screen.id}_${el.name || el.id}`, `game-snapshot:${screen.id}/${el.id}`))
      }
      if (!asset && shot) {
        // drawn by code / CSS, or the file is gone: cut it out of the game's own rendering
        const s = shot
        const c = { x: el.x * s.scale, y: el.y * s.scale, width: el.width * s.scale, height: el.height * s.scale }
        const x0 = Math.max(0, Math.min(s.width - 1, c.x))
        const y0 = Math.max(0, Math.min(s.height - 1, c.y))
        const clipped = { x: x0, y: y0, width: Math.max(1, Math.min(s.width - x0, c.width - (x0 - c.x))), height: Math.max(1, Math.min(s.height - y0, c.height - (y0 - c.y))) }
        asset = await load(`shot:${screen.id}:${Math.round(clipped.x)},${Math.round(clipped.y)},${Math.round(clipped.width)},${Math.round(clipped.height)}`, () => assetFromBytes(s.bytes, `${screen.id}_${el.name || el.id}`, `game-snapshot:${screen.id}/${el.id}`, clipped))
      }
      if (asset) elementAsset.set(`${screen.id}\n${el.id}`, asset.id)
    }
    visit(screen.elements)
    await Promise.all(jobs)
  }
  await window.api.writeFile(`${dir}/asset-cache.json`, JSON.stringify(cache))
  lap(`assets (${cacheHits.hit} cache, ${cacheHits.miss} new)`)
  if (cacheHits.hit) status(`Art: ${cacheHits.hit} file lấy từ cache, ${cacheHits.miss} file đọc mới`)

  let report: MergeReport = { screens: [], flows: 0, warnings: [] }
  const hadSync = !!useEditor.getState().doc.game?.syncedAt
  useEditor.getState().update((d) => {
    report = mergeGameDesign(d, design, { element: (sid, el) => (el.origin ? elementAsset.get(`${el.origin.screenId}\n${el.origin.elementId}`) : elementAsset.get(`${sid}\n${el.id}`)), screenshot: (sid) => shotAsset.get(sid) })
    const link = d.game!
    if (Object.keys(prepared.signatures).length) link.componentSignatures = { ...(link.componentSignatures ?? {}), ...prepared.signatures }
    for (const [file, a] of sourceAsset) link.assets[file] = { assetId: a.id, width: a.width, height: a.height }
    // a push after a sync means the game picked the changes up: start the next revision
    if (hadSync) {
      link.revision++
      delete link.syncedAt
    }
  })
  const st = useEditor.getState()
  const page = st.doc.pages.find((p) => p.children.some((c) => c.id === report.screens[0]?.frameId))
  if (page) {
    if (st.pageId !== page.id) st.setPage(page.id)
    const frames = page.children.filter((c) => c.type === 'frame')
    if (frames.length && report.screens.some((s) => s.created)) {
      const x0 = Math.min(...frames.map((f) => f.x))
      const y0 = Math.min(...frames.map((f) => f.y))
      const x1 = Math.max(...frames.map((f) => f.x + f.width))
      const y1 = Math.max(...frames.map((f) => f.y + f.height))
      st.setView(fitViewToRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, st.canvasSize.width, st.canvasSize.height))
    }
  }
  lap('merge')
  await saveProject(false, dir)
  lap('save')
  const pending = diffGame(useEditor.getState().doc).total
  status(`Đã nhận ${report.screens.length} màn từ ${design.game.name}${pending ? ` · ${pending} thay đổi chờ sync` : ''}`)
  return { ...report, warnings: [...warnings, ...prepared.notes, ...report.warnings], projectDir: dir, pending, componentsFound: prepared.components }
}

// ----------------------------------------------------------------- replacing art
function linked(): DesignDocument {
  const doc = useEditor.getState().doc
  if (!doc.game) throw new Error('Project này chưa liên kết với game nào.')
  return doc
}

/** The game source file a node shows (undefined for code-drawn / cropped elements). */
function sourceOfNode(doc: DesignDocument, nodeId: NodeId): string | undefined {
  for (const s of gameSources(doc)) if (s.usedBy.some((u) => u.nodeId === nodeId)) return s.source
  return undefined
}

/** New art for one source file of the game: every element using it changes. */
export async function replaceSource(source: string, bytes: Uint8Array, fileName: string): Promise<number> {
  linked()
  const asset = await assetFromBytes(bytes, baseName(source), `replace:${fileName}`)
  let n = 0
  useEditor.getState().update((d) => {
    n = replaceGameSource(d, source, asset.id)
  })
  status(`Đã thay ${source} (${asset.width}×${asset.height}) ở ${n} chỗ`)
  return n
}

/** New art for a node. If the node shows a game source file, every element using that file changes too. */
export async function replaceNodeArt(nodeId: NodeId, bytes: Uint8Array, fileName: string): Promise<number> {
  const doc = useEditor.getState().doc
  const source = doc.game ? sourceOfNode(doc, nodeId) : undefined
  if (source) return replaceSource(source, bytes, fileName)
  const asset = await assetFromBytes(bytes, baseName(fileName), `replace:${fileName}`)
  let ok = false
  useEditor.getState().update((d) => {
    ok = setNodeArt(d, nodeId, asset.id)
  })
  if (!ok) throw new Error('Node này không thay ảnh được (chỉ image, 9-slice, rect, text).')
  status(`Đã thay ảnh (${asset.width}×${asset.height})`)
  return 1
}

const ART_DIR_KEY = 'uiforge.lastArtDir'

function findNodeAnywhere(doc: DesignDocument, id: NodeId): SceneNode | undefined {
  for (const p of doc.pages) {
    const e = indexPage(p).byId.get(id)
    if (e) return e.node
  }
  return undefined
}

/** Every drawn image (instance parts included) that shows this asset. */
function countAssetUses(doc: DesignDocument, assetId: string): number {
  let n = 0
  for (const p of doc.pages) for (const e of indexPage(p).byId.values()) if ((e.node.type === 'image' || e.node.type === 'nineslice') && e.node.assetId === assetId) n++
  return n
}

export interface ArtUsage {
  /** places that change with "replace everywhere" */
  count: number
  /** the game file behind this image, when there is one */
  source?: string
  /** a part of a component instance: "everywhere" = the master (every instance) */
  instancePart: boolean
}

export function artUsage(doc: DesignDocument, nodeId: NodeId): ArtUsage | null {
  const n = findNodeAnywhere(doc, nodeId)
  if (!n || (n.type !== 'image' && n.type !== 'nineslice')) return null
  const masterId = n.meta?.fromInstance ? (n.meta.instanceOf as NodeId | undefined) : undefined
  const target = masterId ?? nodeId
  return { count: countAssetUses(doc, n.assetId), source: doc.game ? sourceOfNode(doc, target) : undefined, instancePart: !!masterId }
}

/**
 * New art for an image. scope 'all': everywhere the same art is shown (the game file's users, or every
 * layer with the same image; a part of an instance changes its master). scope 'one': this layer only (a part
 * of an instance gets an override).
 */
export async function replaceNodeArtScoped(nodeId: NodeId, bytes: Uint8Array, fileName: string, scope: 'all' | 'one'): Promise<number> {
  const doc = useEditor.getState().doc
  const n = findNodeAnywhere(doc, nodeId)
  if (!n) throw new Error('Không thấy layer.')
  if (scope === 'one') {
    const asset = await assetFromBytes(bytes, baseName(fileName), `replace:${fileName}`)
    let ok = false
    useEditor.getState().update((d) => {
      ok = setNodeArt(d, nodeId, asset.id)
    })
    if (!ok) throw new Error('Layer này không thay ảnh được (chỉ image, 9-slice, rect, text).')
    status(`Đã thay ảnh riêng cho ${n.name} (${asset.width}×${asset.height})`)
    return 1
  }
  const target = (n.meta?.fromInstance ? (n.meta.instanceOf as NodeId | undefined) : undefined) ?? nodeId
  const source = doc.game ? sourceOfNode(doc, target) : undefined
  if (source) return replaceSource(source, bytes, fileName)
  const old = n.type === 'image' || n.type === 'nineslice' ? n.assetId : undefined
  const asset = await assetFromBytes(bytes, baseName(fileName), `replace:${fileName}`)
  let count = 0
  useEditor.getState().update((d) => {
    const ids = new Set<NodeId>([target])
    if (old)
      for (const p of d.pages)
        for (const e of indexPage(p).byId.values()) {
          const x = e.node
          if ((x.type === 'image' || x.type === 'nineslice') && x.assetId === old && !x.meta?.fromInstance) ids.add(x.id)
        }
    for (const id of ids) if (setNodeArt(d, id, asset.id)) count++
  })
  if (!count) throw new Error('Layer này không thay ảnh được (chỉ image, 9-slice, rect, text).')
  status(`Đã thay ảnh ở ${count} layer (${asset.width}×${asset.height})`)
  return count
}

export async function pickAndReplaceNode(nodeId: NodeId, scope: 'all' | 'one' = 'all'): Promise<void> {
  let dir: string | undefined
  try {
    dir = localStorage.getItem(ART_DIR_KEY) ?? undefined
  } catch {
    /* ignore */
  }
  const files = await window.api.openFiles({ title: 'Chọn ảnh thay thế', filters: [{ name: 'Ảnh', extensions: IMAGE_EXT }], defaultPath: dir })
  if (!files.length) return
  try {
    localStorage.setItem(ART_DIR_KEY, files[0].replace(/[\\/][^\\/]*$/, ''))
  } catch {
    /* ignore */
  }
  await replaceNodeArtScoped(nodeId, await window.api.readFile(files[0]), files[0], scope)
}

export async function pickAndReplaceSource(source: string): Promise<void> {
  const files = await window.api.openFiles({ title: `Chọn ảnh thay cho ${source}`, filters: [{ name: 'Ảnh', extensions: IMAGE_EXT }] })
  if (!files.length) return
  await replaceSource(source, await window.api.readFile(files[0]), files[0])
}

export function revertSource(source: string): void {
  useEditor.getState().update((d) => void revertGameSource(d, source))
}

export interface BulkReplaceResult {
  replaced: { file: string; target: string; count: number }[]
  unmatched: string[]
}

/**
 * Replaces art from a set of files by name: a file matches the game source with the same base name
 * (ui_btn_primary.png → …/ui_btn_primary.webp), else a game element with that id or node name.
 */
export async function replaceFromFiles(files: { name: string; bytes: () => Promise<Uint8Array> }[]): Promise<BulkReplaceResult> {
  const doc = linked()
  const out: BulkReplaceResult = { replaced: [], unmatched: [] }
  const sources = new Map<string, string>()
  for (const s of gameSources(doc)) sources.set(baseName(s.source).toLowerCase(), s.source)
  const nodes = new Map<string, NodeId>()
  for (const { frame } of gameFrames(doc)) {
    const visit = (list: typeof frame.children): void => {
      for (const n of list) {
        if (n.meta?.gameRef) continue
        if (n.type === 'image' || n.type === 'rect' || n.type === 'nineslice') {
          const id = gameIdOf(n)
          for (const k of [id, n.name]) if (k && !nodes.has(k.toLowerCase())) nodes.set(k.toLowerCase(), n.id)
        }
        if ('children' in n && n.type !== 'instance') visit(n.children)
      }
    }
    visit(frame.children)
  }
  for (const f of files) {
    const key = baseName(f.name).toLowerCase()
    const source = sources.get(key)
    const nodeId = nodes.get(key)
    try {
      if (source) out.replaced.push({ file: f.name, target: source, count: await replaceSource(source, await f.bytes(), f.name) })
      else if (nodeId) out.replaced.push({ file: f.name, target: key, count: await replaceNodeArt(nodeId, await f.bytes(), f.name) })
      else out.unmatched.push(f.name)
    } catch (e) {
      out.unmatched.push(`${f.name} (${String((e as Error)?.message ?? e)})`)
    }
  }
  status(`Thay art: ${out.replaced.length} file khớp${out.unmatched.length ? `, ${out.unmatched.length} không khớp tên` : ''}`)
  return out
}

async function listImages(dir: string, depth = 0): Promise<string[]> {
  const out: string[] = []
  for (const e of await window.api.listDir(dir)) {
    const p = `${dir}/${e.name}`
    if (e.dir) {
      if (depth < 4) out.push(...(await listImages(p, depth + 1)))
    } else if (IMAGE_EXT.includes(e.name.split('.').pop()?.toLowerCase() ?? '')) out.push(p)
  }
  return out
}

export async function replaceFromFolder(dir?: string): Promise<BulkReplaceResult | null> {
  linked()
  const folder = dir ?? (await window.api.openFolder({ title: 'Chọn thư mục art mới (khớp theo tên file)' }))
  if (!folder) return null
  const paths = await listImages(norm(folder))
  return replaceFromFiles(paths.map((p) => ({ name: p, bytes: () => window.api.readFile(p) })))
}

// ----------------------------------------------------------------- app → game
export interface SyncOptions {
  /** same aspect, different pixel size: write the art at the old pixel size so the game needs no code change */
  resample?: boolean
}

export interface SyncResult {
  changes: GameChanges
  dir: string
  written: string[]
  unchanged: string[]
  backups: string[]
  files: { changes: string; markdown: string }
}

function mimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
}

async function encode(png: Uint8Array, mime: string, size?: { width: number; height: number }): Promise<Uint8Array> {
  if (mime === 'image/png' && !size) return png
  const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }))
  const c = document.createElement('canvas')
  c.width = size?.width ?? bmp.width
  c.height = size?.height ?? bmp.height
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, mime, 0.95))
  if (!blob) throw new Error(`không mã hoá được ${mime}`)
  return new Uint8Array(await blob.arrayBuffer())
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function pendingChanges(): GameChanges | null {
  const doc = useEditor.getState().doc
  return doc.game ? diffGame(doc) : null
}

/**
 * Writes the replaced art into the game (originals are backed up) plus the change list its agent applies:
 * uiforge/changes.json, CHANGES.md, layout/<screen>.json, preview/<screen>.png.
 */
export async function syncGame(opts: SyncOptions = {}): Promise<SyncResult> {
  const link = linked().game!
  const root = norm(link.root)
  if (!(await window.api.exists(root))) throw new Error(`Không thấy thư mục game: ${root}`)
  const dir = `${root}/${GAME_DIR}`
  const resample = opts.resample !== false
  const written: string[] = []
  const unchanged: string[] = []
  const backups: string[] = []
  const notes = new Map<string, string>()
  let changes = diffGame(useEditor.getState().doc)

  for (const a of changes.assets) {
    status(`Ghi ${a.target}…`)
    const doc = useEditor.getState().doc
    const asset = doc.assets[a.assetId]
    const png = asset ? await getAssetBytes(asset) : null
    if (!png) throw new Error(`Thiếu dữ liệu ảnh cho ${a.target}`)
    const target = `${root}/${a.target}`
    const o = a.oldSize
    const shrink = resample && a.mode === 'overwrite' && !!o && o.width > 0 && o.height > 0 && (o.width !== a.newSize.width || o.height !== a.newSize.height) && Math.abs(o.width / o.height - a.newSize.width / a.newSize.height) < 0.01
    const bytes = await encode(png, mimeOf(a.target), shrink ? o : undefined)
    if (shrink) notes.set(a.target, `art mới ${a.newSize.width}×${a.newSize.height} đã được thu về kích thước cũ ${o!.width}×${o!.height} (cùng tỉ lệ) nên không cần sửa code`)
    const existing = (await window.api.exists(target)) ? await window.api.readFile(target) : null
    if (existing && sameBytes(existing, bytes)) unchanged.push(a.target)
    else {
      if (existing && a.mode === 'overwrite') {
        const bak = `${dir}/backup/rev${changes.revision}/${a.target}`
        if (!(await window.api.exists(bak))) {
          await window.api.writeFile(bak, existing)
          backups.push(`${GAME_DIR}/backup/rev${changes.revision}/${a.target}`)
        }
      }
      await window.api.writeFile(target, bytes)
      written.push(a.target)
    }
    // show exactly what the game now has, so its next push matches the design
    if (bytes !== png && a.mode === 'overwrite' && a.source) {
      const now = await assetFromBytes(bytes, baseName(a.target), `game:${a.source}`)
      if (now.id !== a.assetId) {
        const from = a.assetId
        const source = a.source
        useEditor.getState().update((d) => {
          for (const s of gameSources(d)) if (s.source === source) for (const u of s.usedBy) swapAsset(d, u.nodeId, from, now.id)
        }, { history: false })
      }
    }
  }

  changes = diffGame(useEditor.getState().doc)
  changes.synced = true
  for (const a of changes.assets) {
    const n = notes.get(a.target)
    if (n) a.note = [a.note, n].filter(Boolean).join('; ')
  }
  const doc = useEditor.getState().doc
  await window.api.writeFile(`${dir}/changes.json`, JSON.stringify(changes, null, 2))
  await window.api.writeFile(`${dir}/CHANGES.md`, buildChangesMarkdown(changes))
  for (const s of currentLayout(doc)) await window.api.writeFile(`${dir}/layout/${safeFileName(s.id)}.json`, JSON.stringify(s, null, 2))
  const changed = new Set(changes.screens.map((s) => s.frameId))
  for (const a of changes.assets) for (const u of a.usedBy) changed.add(gameFrames(doc).find((f) => f.screenId === u.split('/')[0])?.frame.id ?? '')
  for (const { page, frame, screenId } of gameFrames(doc)) {
    if (!changed.has(frame.id)) continue
    try {
      status(`Render ${frame.name}…`)
      await window.api.writeFile(`${dir}/preview/${safeFileName(screenId)}.png`, await renderFramePng(page, frame, doc.assets, 0.5))
    } catch (e) {
      console.warn('preview failed', screenId, e)
    }
  }
  useEditor.getState().update((d) => void (d.game!.syncedAt = new Date().toISOString()), { history: false })
  await saveProject()
  // the game's files changed: the next capture must load the game afresh, not reuse the live page
  if (written.length) await window.api.captureReset()
  status(`Sync xong → ${root}: ${written.length} file art, ${changes.total} thay đổi UI`)
  return { changes, dir, written, unchanged, backups, files: { changes: `${dir}/changes.json`, markdown: `${dir}/CHANGES.md` } }
}

function swapAsset(d: DesignDocument, nodeId: NodeId, from: string, to: string): void {
  const visit = (list: DesignDocument['pages'][number]['children']): boolean => {
    for (const n of list) {
      if (n.id === nodeId) {
        if ((n.type === 'image' || n.type === 'nineslice') && n.assetId === from) n.assetId = to
        return true
      }
      if ('children' in n && visit(n.children)) return true
    }
    return false
  }
  for (const p of d.pages) if (visit(p.children)) return
}

/** The game now matches the design: the current state becomes the baseline. */
export async function ackGame(): Promise<{ elements: number; revision: number }> {
  const link = linked().game!
  const dir = `${norm(link.root)}/${GAME_DIR}`
  let elements = 0
  useEditor.getState().update((d) => {
    elements = rebaselineGame(d)
    d.game!.revision++
    delete d.game!.syncedAt
  }, { history: false })
  for (const f of ['changes.json', 'CHANGES.md']) {
    if (!(await window.api.exists(`${dir}/${f}`))) continue
    await window.api.writeFile(`${dir}/history/rev${link.revision + 1}-${f}`, await window.api.readText(`${dir}/${f}`))
    await window.api.remove(`${dir}/${f}`)
  }
  await saveProject()
  status('Đã ghi nhận: game khớp với thiết kế')
  return { elements, revision: useEditor.getState().doc.game!.revision }
}

// ----------------------------------------------------------------- the game's agent
export const AGENT_PROMPT = `Thiết kế UI của game này vừa được chỉnh trong UIForge và đã sync về thư mục ${GAME_DIR}/.
Đọc ${GAME_DIR}/CHANGES.md (chi tiết máy đọc: ${GAME_DIR}/changes.json; trạng thái đích: ${GAME_DIR}/layout/<screen>.json; ảnh đích: ${GAME_DIR}/preview/<screen>.png) rồi sửa code/CSS của game cho UI khớp với thiết kế:
- Art "ĐÃ GHI ĐÈ": file đã nằm đúng chỗ; chỉ sửa code nếu kích thước ảnh đổi làm lệch layout.
- Art "ẢNH MỚI" trong ${GAME_DIR}/incoming/: chép vào thư mục asset của game, nạp và dùng cho đúng element.
- Mục "Component dùng chung": sửa trong widget factory ghi ở "code" (toạ độ tính từ góc trên-trái component) — một chỗ, mọi nơi dùng đổi theo; không sửa từng màn. Mục "<element> › <phần>" là override của riêng một instance: sửa tham số truyền vào widget ở chỗ đó.
- Thay đổi vị trí/kích thước/chữ/ẩn-hiện/thêm/xoá: sửa đúng chỗ ghi ở "code" (nếu có), giữ nguyên cơ chế responsive sẵn có của game.
- Không đổi gameplay, không đụng thứ không có trong danh sách.
Xong thì chạy build/test sẵn có của game nếu có. Cuối cùng: nếu có MCP uiforge, gọi capture_game {root} để đẩy lại UI mới (hoặc ack_game_changes nếu không capture được); nếu không có MCP, ghi ${GAME_DIR}/applied.json dạng {"revision": <revision trong changes.json>, "applied": [...], "skipped": [{"element": "...", "reason": "..."}]}.
Trả lời ngắn gọn bằng tiếng Việt: đã áp dụng gì, bỏ qua gì và vì sao.`

export interface AgentRun {
  code: number | null
  applied: boolean
  remaining: number
}

/** Runs Claude Code headless in the game folder to apply the synced changes; `onLine` receives progress lines. */
export async function runGameAgent(onLine: (line: string) => void): Promise<AgentRun> {
  const link = linked().game!
  const root = norm(link.root)
  const revision = link.revision + 1
  const off = window.api.onAgentEvent((ev) => {
    if (ev.type === 'line') onLine(ev.text)
  })
  let code: number | null = null
  try {
    code = await window.api.runAgent({ cwd: root, prompt: AGENT_PROMPT })
  } finally {
    off()
  }
  // the agent either pushed the game again (baseline already moved) or left applied.json
  let applied = false
  const file = `${root}/${GAME_DIR}/applied.json`
  if (await window.api.exists(file)) {
    try {
      const j = JSON.parse(await window.api.readText(file)) as { revision?: number }
      if (j.revision === revision && useEditor.getState().doc.game?.revision === link.revision) {
        await ackGame()
        applied = true
      }
    } catch {
      /* not valid JSON: leave the changes pending */
    }
  }
  const now = useEditor.getState().doc.game
  if (now && now.revision > link.revision) applied = true
  return { code, applied, remaining: pendingChanges()?.total ?? 0 }
}
