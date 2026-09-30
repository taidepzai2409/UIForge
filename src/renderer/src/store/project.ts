import type { DesignDocument, FrameNode, Page } from '@/model/types'
import { createDocument } from '@/model/create'
import { useEditor } from './editor'
import { clearAssetCache, flushAssetsToDisk, getAssetBytes, safeFileName, setAssetProjectDir } from './assets'
import type { FrameNode as FrameNodeT } from '@/model/types'
import { buildFromPsd, parsePsd, type BuildOptions } from '@/psd/importPsd'
import { useImportDialog } from './importDialog'
import { loadProjectFonts } from './fonts'
import { buildFlowsMarkdown, buildFrameLayout, buildPageManifest, collectFontFaces, collectUsedAssets, fontKey, frameFileName, previewFileName, type DevicePreviewInfo } from '@/export/layout'
import { exportFontFiles } from './fonts'
import { planAtlas } from '@/export/atlas'
import { DEFAULT_PREVIEW_DEVICES, DEVICE_PRESETS, frameForSim, scalerOf, simulateFrame } from '@/model/simulate'
import { pngFromCanvas } from './assets'
import { renderFramePng } from '@/canvas/render'
import specMarkdown from '../../../../docs/LAYOUT_SPEC.md?raw'
import { fitViewToRect } from '@/canvas/viewMath'
import { discardDraft, offerRecovery } from './autosave'

const LAST_PROJECT_KEY = 'uiforge.lastProject'
const LAST_PSD_DIR_KEY = 'uiforge.lastPsdDir'
const LAST_FOLDER_KEY = 'uiforge.lastFolder'

const PSD_FILTERS = [{ name: 'Photoshop', extensions: ['psd', 'psb'] }]

function status(s: string): void {
  useEditor.getState().setStatus(s)
}

async function confirmDiscard(): Promise<boolean> {
  const s = useEditor.getState()
  if (!s.dirty) return true
  const r = await window.api.message({
    type: 'question',
    message: 'Project có thay đổi chưa lưu. Bỏ thay đổi?',
    buttons: ['Bỏ thay đổi', 'Huỷ'],
    defaultId: 1,
    cancelId: 1
  })
  return r === 0
}

export async function newProject(): Promise<void> {
  if (!(await confirmDiscard())) return
  clearAssetCache()
  setAssetProjectDir(null)
  useEditor.getState().setDoc(createDocument(), null)
  void window.api.setTitle('UIForge — Untitled')
}

function migrate(raw: unknown): DesignDocument {
  const d = raw as DesignDocument
  // 'dmobin-design' is the schema name from before the rename; accept and rewrite it.
  if (d && (d.schema as string) === 'dmobin-design') d.schema = 'uiforge-design'
  if (!d || d.schema !== 'uiforge-design') throw new Error('Không phải file project của UIForge')
  for (const p of d.pages) {
    p.connections ??= []
    p.children ??= []
  }
  d.assets ??= {}
  return d
}

export async function openProject(dir?: string): Promise<void> {
  if (!(await confirmDiscard())) return
  const folder = dir ?? (await window.api.openFolder({ title: 'Chọn thư mục project (chứa project.json)', defaultPath: localStorage.getItem(LAST_FOLDER_KEY) ?? undefined }))
  if (folder && !dir) localStorage.setItem(LAST_FOLDER_KEY, folder)
  if (!folder) return
  const file = `${folder}/project.json`
  if (!(await window.api.exists(file))) {
    await window.api.message({ type: 'error', message: 'Thư mục không có project.json' })
    return
  }
  try {
    const text = await window.api.readText(file)
    const doc = migrate(JSON.parse(text))
    clearAssetCache()
    setAssetProjectDir(folder)
    await loadProjectFonts(folder)
    useEditor.getState().setDoc(doc, folder)
    localStorage.setItem(LAST_PROJECT_KEY, folder)
    void window.api.setTitle(`UIForge — ${doc.name}`)
    status(`Đã mở ${folder}`)
    await offerRecovery(folder)
  } catch (e) {
    await window.api.message({ type: 'error', message: 'Mở project thất bại', detail: String(e) })
  }
}

export async function saveProject(saveAs = false, targetDir?: string): Promise<boolean> {
  const s = useEditor.getState()
  let dir = targetDir ?? s.projectDir
  if (!dir || (saveAs && !targetDir)) {
    dir = await window.api.openFolder({ title: 'Chọn thư mục để lưu project (sẽ tạo project.json + assets/)', defaultPath: localStorage.getItem(LAST_FOLDER_KEY) ?? undefined })
    if (!dir) return false
    localStorage.setItem(LAST_FOLDER_KEY, dir)
  }
  try {
    status('Đang lưu...')
    const doc = useEditor.getState().doc
    const folderName = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? doc.name
    const named: DesignDocument = doc.name === 'Untitled' ? { ...doc, name: folderName } : doc
    const n = await flushAssetsToDisk(dir, named.assets)
    await window.api.writeFile(`${dir}/project.json`, JSON.stringify(named, null, 2))
    if (named !== doc) useEditor.getState().update((d) => void (d.name = named.name), { history: false })
    useEditor.getState().setProjectDir(dir)
    useEditor.getState().markSaved()
    void discardDraft(dir)
    if (!s.projectDir) void discardDraft(null)
    localStorage.setItem(LAST_PROJECT_KEY, dir)
    void window.api.setTitle(`UIForge — ${named.name}`)
    status(`Đã lưu ${dir}${n ? ` (+${n} assets)` : ''}`)
    return true
  } catch (e) {
    await window.api.message({ type: 'error', message: 'Lưu thất bại', detail: String(e) })
    return false
  }
}

export async function autoOpenLast(): Promise<void> {
  // an unsaved draft from a crashed session wins over the last project
  if (await offerRecovery(null)) return
  const last = localStorage.getItem(LAST_PROJECT_KEY)
  if (!last) return
  if (await window.api.exists(`${last}/project.json`)) await openProject(last)
}

function nextFramePosition(page: Page): { x: number; y: number } {
  let right = 0
  let top = Infinity
  for (const c of page.children) {
    right = Math.max(right, c.x + c.width)
    top = Math.min(top, c.y)
  }
  return { x: page.children.length ? right + 120 : 0, y: Number.isFinite(top) ? top : 0 }
}

export type ImportMode = 'ask' | Partial<BuildOptions>

export async function importPsdFiles(paths?: string[], mode: ImportMode = 'ask'): Promise<FrameNode[]> {
  const files = paths ?? (await window.api.openFiles({ filters: PSD_FILTERS, multi: true, title: 'Import PSD', defaultPath: localStorage.getItem(LAST_PSD_DIR_KEY) ?? undefined }))
  if (!files.length) return []
  if (!paths) localStorage.setItem(LAST_PSD_DIR_KEY, files[0].replace(/[\\/][^\\/]*$/, ''))
  const allWarnings: string[] = []
  const allInfos: string[] = []
  const created: FrameNode[] = []
  for (const file of files) {
    try {
      status(`Đang đọc ${file}...`)
      const data = await window.api.readFile(file)
      const t0 = performance.now()
      const parsed = parsePsd(file, data)
      let opts: BuildOptions
      if (mode === 'ask') {
        const choice = await useImportDialog.getState().ask(parsed)
        if (!choice) {
          status('Đã huỷ import')
          continue
        }
        opts = { ...choice }
      } else {
        opts = { mode: 'single', textMode: 'both', ...mode }
      }
      let lastStatus = 0
      opts.onProgress = (done, total, name) => {
        const now = performance.now()
        if (now - lastStatus > 80 || done === total) {
          lastStatus = now
          status(`Import PSD ${done}/${total}: ${name}`)
        }
      }
      const res = await buildFromPsd(parsed, opts)
      const ed = useEditor.getState()
      const page = ed.doc.pages.find((p) => p.id === ed.pageId) ?? ed.doc.pages[0]
      const pos = nextFramePosition(page)
      // grid: up to 5 frames per row, rows below each other
      const perRow = 5
      let x = pos.x
      let y = pos.y
      let rowH = 0
      res.frames.forEach((f, i) => {
        if (i > 0 && i % perRow === 0) {
          x = pos.x
          y += rowH + 160
          rowH = 0
        }
        f.x = x
        f.y = y
        x += f.width + 120
        rowH = Math.max(rowH, f.height)
      })
      ed.update((doc) => {
        for (const a of res.assets) if (!doc.assets[a.id]) doc.assets[a.id] = a
        if (Object.keys(res.patterns).length) doc.patterns = { ...(doc.patterns ?? {}), ...res.patterns }
        if (typeof res.globalAngle === 'number' && !doc.globalLight) doc.globalLight = { angle: res.globalAngle, altitude: 30 }
        const pg = doc.pages.find((p) => p.id === ed.pageId) ?? doc.pages[0]
        pg.children.push(...res.frames)
      })
      if (res.frames.length) ed.select(res.frames.map((f) => f.id))
      if (opts.autoAnchor !== false && res.frames.length) ed.autoAnchor(res.frames.map((f) => f.id))
      created.push(...res.frames)
      allWarnings.push(...res.warnings.map((w) => `${parsed.baseName}: ${w}`))
      allInfos.push(...res.infos.map((w) => `${parsed.baseName}: ${w}`))
      status(`Import xong ${parsed.baseName}: ${res.frames.length} frame, ${res.layerCount} layer, ${res.assets.length} ảnh (${((performance.now() - t0) / 1000).toFixed(1)}s)`)
    } catch (e) {
      console.error(e)
      await window.api.message({ type: 'error', message: `Import thất bại: ${file}`, detail: String(e) })
    }
  }
  if (created.length) {
    const ed = useEditor.getState()
    const x0 = Math.min(...created.map((f) => f.x))
    const y0 = Math.min(...created.map((f) => f.y))
    const x1 = Math.max(...created.map((f) => f.x + f.width))
    const y1 = Math.max(...created.map((f) => f.y + f.height))
    ed.setView(fitViewToRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, ed.canvasSize.width, ed.canvasSize.height))
  }
  if (allWarnings.length || allInfos.length) {
    console.warn('PSD import warnings:\n' + allWarnings.join('\n'))
    const lines = [...allWarnings.map((w) => `⚠ ${w}`), ...allInfos.map((w) => `ℹ ${w}`)]
    useEditor.getState().setNotice({
      kind: allWarnings.length ? 'warning' : 'info',
      title: allWarnings.length ? `Import xong, ${allWarnings.length} lưu ý` + (allInfos.length ? `, ${allInfos.length} thông tin` : '') : `Import xong, ${allInfos.length} thông tin`,
      lines
    })
  }
  return created
}

/**
 * Exports layout JSON for every frame of every page + used assets into `<project>/export/`.
 * Layout: export/index.json, export/<page>/manifest.json, export/<page>/<frame>.json, preview PNGs,
 * export/assets/*.png, FLOWS.md, SPEC.md
 */
export async function exportLayout(): Promise<string | null> {
  let s = useEditor.getState()
  if (!s.projectDir) {
    const ok = await saveProject()
    if (!ok) return null
    s = useEditor.getState()
  }
  const dir = s.projectDir!
  const outDir = `${dir}/export`
  const doc = s.doc
  try {
    status('Đang export layout...')
    await window.api.mkdir(`${outDir}/assets`)
    const index: { pages: { name: string; folder: string; manifest: string }[]; project: string; exportedAt: string; schema: string } = {
      schema: 'uiforge-export-index',
      project: doc.name,
      exportedAt: new Date().toISOString(),
      pages: []
    }
    const copied = new Set<string>()
    for (const page of doc.pages) {
      const folder = safeFileName(page.name)
      const pageDir = `${outDir}/${folder}`
      await window.api.mkdir(pageDir)
      index.pages.push({ name: page.name, folder, manifest: `${folder}/manifest.json` })
      const frames = page.children.filter((c): c is FrameNodeT => c.type === 'frame')

      // sprite atlas of the page (screen_element_state names)
      const plan = planAtlas(doc, frames)
      const atlasFiles: string[] = []
      let atlasInfo: { file: string; sheets: { index: number; file: string; width: number; height: number }[] } | undefined
      if (plan.sheets.length) {
        status(`Đóng gói atlas ${page.name}...`)
        await window.api.mkdir(`${outDir}/atlas`)
        for (const sheet of plan.sheets) {
          const c = document.createElement('canvas')
          c.width = sheet.width
          c.height = sheet.height
          const ctx = c.getContext('2d')!
          for (const r of sheet.rects) {
            const a = doc.assets[r.name]
            const bytes = a ? await getAssetBytes(a) : null
            if (!bytes) continue
            try {
              const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }))
              ctx.drawImage(bmp, r.x, r.y)
              bmp.close()
            } catch (e) {
              console.warn('atlas: decode failed', a?.file, e)
            }
          }
          const file = `atlas/${folder}_${sheet.index}.png`
          await window.api.writeFile(`${outDir}/${file}`, await pngFromCanvas(c))
          atlasFiles.push(file)
        }
        const atlasJson = {
          schema: 'uiforge-atlas',
          version: 1,
          page: page.name,
          naming: 'screen_element_state (lowercase ascii, underscores)',
          sheets: plan.sheets.map((sh) => ({ index: sh.index, file: atlasFiles[sh.index], width: sh.width, height: sh.height })),
          sprites: Object.values(plan.sprites)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => ({ name: r.name, sheet: r.sheet, x: r.x, y: r.y, width: r.width, height: r.height, nineSlice: r.nineSlice, assetId: r.assetId, file: `assets/${doc.assets[r.assetId]?.file ?? ''}`, usedBy: r.usedBy }))
        }
        await window.api.writeFile(`${outDir}/atlas/${folder}.json`, JSON.stringify(atlasJson, null, 2))
        atlasInfo = { file: `atlas/${folder}.json`, sheets: atlasJson.sheets }
      }

      // fonts used by live text → export/fonts (Unity: TextMeshPro font assets)
      status(`Xuất font ${page.name}...`)
      const exportedFonts = await exportFontFiles(collectFontFaces(page.children), outDir, dir)
      const fontMap: Record<string, { file: string; postscriptName: string }> = {}
      for (const f of exportedFonts) fontMap[fontKey(f.family, f.weight, f.italic)] = { file: f.file, postscriptName: f.postscriptName }

      const deviceIds = doc.previewDevices ?? DEFAULT_PREVIEW_DEVICES
      const devices: Record<string, DevicePreviewInfo[]> = {}
      for (const child of frames) {
        const layout = buildFrameLayout(doc, page, child, { atlas: plan, atlasFiles, fonts: fontMap })
        await window.api.writeFile(`${pageDir}/${frameFileName(child)}`, JSON.stringify(layout, null, 2))
        try {
          status(`Render preview ${child.name}...`)
          const png = await renderFramePng(page, child, doc.assets, 1)
          await window.api.writeFile(`${pageDir}/${previewFileName(child)}`, png)
        } catch (e) {
          console.warn('preview render failed', child.name, e)
        }
        // responsive previews + safe-area report per device
        const sims: unknown[] = []
        for (const did of deviceIds) {
          const preset = DEVICE_PRESETS.find((d) => d.id === did)
          if (!preset || preset.id === 'ref') continue
          try {
            const sim = simulateFrame(child, preset, scalerOf(doc))
            const simFrame = frameForSim(child, sim)
            const scale = Math.min(1, 1080 / Math.max(sim.canvas.width, sim.canvas.height))
            const file = `${safeFileName(child.name)}_${child.id}_${preset.id}.png`
            status(`Preview ${child.name} @ ${preset.name}...`)
            await window.api.writeFile(`${pageDir}/${file}`, await renderFramePng(page, simFrame, doc.assets, scale))
            ;(devices[child.id] ??= []).push({ id: preset.id, name: preset.name, width: Math.round(sim.canvas.width), height: Math.round(sim.canvas.height), preview: file, issues: sim.issues })
            sims.push({ device: { id: preset.id, name: preset.name, width: preset.width, height: preset.height }, canvas: sim.canvas, safe: sim.safe, scale: sim.scale, issues: sim.issues, nodes: sim.nodes.map((n) => ({ id: n.id, path: n.path, rect: n.rect, safeArea: n.safeArea, issues: n.issues })) })
          } catch (e) {
            console.warn('device preview failed', child.name, did, e)
          }
        }
        if (sims.length) await window.api.writeFile(`${pageDir}/${safeFileName(child.name)}_${child.id}_devices.json`, JSON.stringify({ schema: 'uiforge-devices', version: 1, frame: { id: child.id, name: child.name, width: child.width, height: child.height }, devices: sims }, null, 2))
      }
      const manifest = buildPageManifest(doc, page, { devices, atlas: atlasInfo, fonts: exportedFonts })
      await window.api.writeFile(`${pageDir}/manifest.json`, JSON.stringify(manifest, null, 2))
      for (const asset of collectUsedAssets(page.children, doc.assets)) {
        if (copied.has(asset.id)) continue
        copied.add(asset.id)
        const bytes = await getAssetBytes(asset)
        if (bytes) await window.api.writeFile(`${outDir}/assets/${asset.file}`, bytes)
      }
    }
    await window.api.writeFile(`${outDir}/index.json`, JSON.stringify(index, null, 2))
    await window.api.writeFile(`${outDir}/FLOWS.md`, buildFlowsMarkdown(doc))
    await window.api.writeFile(`${outDir}/SPEC.md`, specMarkdown)
    status(`Export xong: ${outDir}`)
    return outDir
  } catch (e) {
    await window.api.message({ type: 'error', message: 'Export thất bại', detail: String(e) })
    return null
  }
}
