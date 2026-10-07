// Captures the UI of a running HTML5 game: loads its URL in an offscreen window, drives it to each screen
// with the recipe's JS snippets, screenshots it and reads its elements (extract.ts). The result is a
// "uiforge-game-design" document the renderer merges into the game's project (model/game.ts).
import { BrowserWindow, nativeImage } from 'electron'
import { promises as fs, existsSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { extractInPage, type ExtractOptions, type ExtractResult, type RawElement, type WebFont } from './extract'

export interface CaptureScreen {
  id: string
  name?: string
  kind?: 'screen' | 'popup'
  /** JS run in the page to get to this screen (may use await) */
  enter?: string
  /** reload the page before `enter` (default: only for the first screen) */
  reload?: boolean
  /** JS expression polled until truthy (max 15 s) before capturing */
  waitFor?: string
  /** extra wait after enter / waitFor, ms (default: recipe.settleMs) */
  waitMs?: number
  engine?: 'phaser' | 'dom' | 'auto'
  /** DOM: selector(s) of this screen's root element(s) */
  root?: string
  /** Phaser: scene keys to read */
  scenes?: string[]
  exclude?: string[]
  /** keep only elements whose id / name matches (regex) — e.g. one popup container of a Phaser scene */
  only?: string[]
  /** 'elements' = frame shrinks to the extracted elements (popups); default = whole viewport */
  clip?: 'elements' | { x: number; y: number; width: number; height: number }
  /** only the screenshot, no elements */
  screenshotOnly?: boolean
  code?: string
}

export interface CaptureRecipe {
  name: string
  root: string
  url: string
  engine?: 'phaser' | 'dom' | 'auto'
  viewport: { width: number; height: number }
  /** dotted path of the Phaser.Game instance */
  game?: string
  /** folders (relative to root) that the dev server serves from "/" — default: '', public, static, src, dist */
  assetRoots?: string[]
  settleMs?: number
  exclude?: string[]
  /** true: open a fresh window even if one with the same URL is still alive from the previous capture */
  fresh?: boolean
  screens: CaptureScreen[]
  flows?: unknown[]
  start?: string
}

interface OutElement extends Omit<RawElement, 'assetUrl' | 'assetData' | 'children'> {
  asset?: string
  /** PNG with this element's own pixels (no game source file) */
  image?: string
  children?: OutElement[]
}

export interface CaptureOutput {
  design: {
    schema: 'uiforge-game-design'
    version: 1
    game: { name: string; root: string; engine?: string; devUrl: string }
    screens: { id: string; name?: string; width: number; height: number; kind?: string; screenshot: string; snapshotFrom?: string; code?: string; elements: OutElement[] }[]
    flows?: unknown[]
    start?: string
  }
  report: { id: string; engine: string; elements: number; sources: number; snapshots: number; warnings: string[] }[]
  /** webfonts copied into <root>/uiforge/fonts (file name = family, as the app's project fonts expect) */
  fonts: { written: string[]; unchanged: string[]; warnings: string[] }
}

const FONT_EXT_ORDER = ['ttf', 'otf', 'woff', 'woff2']

function fontExtOf(url: string): string | null {
  try {
    const m = /\.(ttf|otf|woff2?)$/i.exec(new URL(url).pathname)
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Copies the webfonts the captured texts use into <root>/uiforge/fonts/<family>.<ext>: one file per family
 * (the regular face when there are several), taken from the game folder when the URL maps to a file,
 * else downloaded from the dev server.
 */
async function copyWebFonts(faces: WebFont[], root: string, assetRoots: string[]): Promise<CaptureOutput['fonts']> {
  const res: CaptureOutput['fonts'] = { written: [], unchanged: [], warnings: [] }
  const byFamily = new Map<string, WebFont[]>()
  for (const f of faces) {
    const k = f.family.toLowerCase()
    const list = byFamily.get(k) ?? []
    if (!list.some((x) => x.weight === f.weight && x.style === f.style && x.urls.join() === f.urls.join())) list.push(f)
    byFamily.set(k, list)
  }
  const dir = join(root, 'uiforge', 'fonts')
  for (const list of byFamily.values()) {
    const family = list[0].family
    if (/[<>:"/\\|?*]/.test(family)) {
      res.warnings.push(`font "${family}": tên có ký tự không dùng được làm tên file, bỏ qua`)
      continue
    }
    const regular = list.find((f) => /^(400|normal)$/.test(f.weight) && f.style === 'normal') ?? list[0]
    if (list.length > 1) res.warnings.push(`font "${family}" có ${list.length} kiểu (weight/style); chỉ lấy một file (${regular.weight} ${regular.style}), kiểu còn lại app tự giả lập`)
    const urls = regular.urls.filter((u) => fontExtOf(u)).sort((a, b) => FONT_EXT_ORDER.indexOf(fontExtOf(a)!) - FONT_EXT_ORDER.indexOf(fontExtOf(b)!))
    let bytes: Buffer | null = null
    let ext = ''
    for (const u of urls) {
      try {
        const local = resolveAsset(u, u, root, assetRoots)
        if (local) bytes = await fs.readFile(join(root, local))
        else if (/^https?:/.test(u)) {
          const r = await fetch(u)
          if (r.ok) bytes = Buffer.from(await r.arrayBuffer())
        }
        if (bytes) {
          ext = fontExtOf(u)!
          break
        }
      } catch {
        /* next url */
      }
    }
    if (!bytes) {
      res.warnings.push(`font "${family}": không lấy được file${urls.length ? ` (${urls[0]})` : ' (không có URL nguồn)'} — chép tay vào uiforge/fonts/${family}.ttf`)
      continue
    }
    await fs.mkdir(dir, { recursive: true })
    // the family name is the file name: drop other files of the same family first
    for (const e of await fs.readdir(dir)) if (e.replace(/\.[^.]+$/, '').toLowerCase() === family.toLowerCase() && e !== `${family}.${ext}`) await fs.rm(join(dir, e), { force: true })
    const file = join(dir, `${family}.${ext}`)
    const old = existsSync(file) ? await fs.readFile(file) : null
    if (old && old.equals(bytes)) res.unchanged.push(`${family}.${ext}`)
    else {
      await fs.writeFile(file, bytes)
      res.written.push(`${family}.${ext}`)
    }
  }
  return res
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Runs before the game's own scripts. Loaders (Phaser) fetch images as blobs and show them through blob: URLs;
 * this remembers which URL every blob came from so art can be traced back to a file of the game.
 */
const TRACK_BLOBS = `(() => {
  if (window.__uiforgeBlobSrc) return
  const urls = (window.__uiforgeBlobSrc = new Map())
  const origin = new WeakMap()
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    this.addEventListener('load', () => {
      try {
        if (this.response instanceof Blob) origin.set(this.response, new URL(String(url), location.href).href)
      } catch {}
    })
    return open.apply(this, arguments)
  }
  const blob = Response.prototype.blob
  Response.prototype.blob = function () {
    const from = this.url
    return blob.call(this).then((b) => {
      if (from) origin.set(b, from)
      return b
    })
  }
  const create = URL.createObjectURL
  URL.createObjectURL = function (obj) {
    const u = create.call(URL, obj)
    const from = origin.get(obj)
    if (from) urls.set(u, from)
    return u
  }
})()`

const HIDE_EXCLUDED = `(() => {
  for (const o of window.__uiforgeExcluded || []) {
    if (o instanceof Element) { o.__uiforgeVis = o.style.visibility; o.style.visibility = 'hidden' }
    else if (o && 'visible' in o) { o.__uiforgeVisible = o.visible; o.visible = false }
  }
})()`
const SHOW_EXCLUDED = `(() => {
  for (const o of window.__uiforgeExcluded || []) {
    if (o instanceof Element) { o.style.visibility = o.__uiforgeVis || ''; delete o.__uiforgeVis }
    else if (o && '__uiforgeVisible' in o) { o.visible = o.__uiforgeVisible; delete o.__uiforgeVisible }
  }
})()`

const HIDE_TEXT = `(() => {
  for (const t of window.__uiforgeTexts || []) { t.__uiforgeVisible = t.visible; t.visible = false }
  const s = document.createElement('style')
  s.id = '__uiforge_notext'
  s.textContent = '*{color:transparent!important;text-shadow:none!important;-webkit-text-stroke-color:transparent!important;caret-color:transparent!important}'
  document.head.appendChild(s)
})()`
const SHOW_TEXT = `(() => {
  for (const t of window.__uiforgeTexts || []) if ('__uiforgeVisible' in t) { t.visible = t.__uiforgeVisible; delete t.__uiforgeVisible }
  document.getElementById('__uiforge_notext')?.remove()
})()`


function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Maps the URL an image was loaded from to a file of the game project (relative to root), or null. */
function resolveAsset(url: string | undefined, pageUrl: string, root: string, assetRoots: string[]): string | null {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return null
  let u: URL
  try {
    u = new URL(url, pageUrl)
  } catch {
    return null
  }
  let p = decodeURIComponent(u.pathname)
  if (/\.svg$/i.test(p)) return null
  const inside = (abs: string): string | null => {
    const rel = relative(root, abs)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(abs) ? toPosix(rel) : null
  }
  if (u.protocol === 'file:') return inside(resolve(p.replace(/^\/([a-zA-Z]:)/, '$1')))
  if (p.startsWith('/@fs/')) return inside(resolve(p.slice(5).replace(/^\/?([a-zA-Z]:)/, '$1')))
  p = p.replace(/^\/+/, '')
  for (const r of assetRoots) {
    const hit = inside(join(root, r, p))
    if (hit) return hit
  }
  return null
}

/** a code-drawn cut-out that overlaps a text needs the text-free shot; nothing else does */
function needsCleanShot(els: RawElement[]): boolean {
  const texts: RawElement[] = []
  const cuts: RawElement[] = []
  const walk = (list: RawElement[]): void => {
    for (const e of list) {
      if (e.type === 'text') texts.push(e)
      else if ((e.type === 'image' || e.type === 'nineslice') && !e.assetUrl && !e.assetData) cuts.push(e)
      if (e.children) walk(e.children)
    }
  }
  walk(els)
  return cuts.some((c) => texts.some((t) => t.x < c.x + c.width && t.x + t.width > c.x && t.y < c.y + c.height && t.y + t.height > c.y))
}

// The capture window stays open between calls (same URL + size): re-capturing one screen then costs the
// screen's own `enter` instead of a full game load. Closed after a few minutes without use.
interface LiveWindow {
  win: BrowserWindow
  url: string
  width: number
  height: number
  cdp: boolean
  timer: NodeJS.Timeout | null
}
let live: LiveWindow | null = null
const LIVE_TTL = 4 * 60 * 1000

export function closeCaptureWindow(): void {
  if (live) {
    if (live.timer) clearTimeout(live.timer)
    if (!live.win.isDestroyed()) live.win.destroy()
    live = null
  }
}

function countElements(els: OutElement[], acc = { elements: 0, sources: 0, snapshots: 0 }): { elements: number; sources: number; snapshots: number } {
  for (const e of els) {
    acc.elements++
    if (e.asset) acc.sources++
    if (e.snapshot) acc.snapshots++
    if (e.children) countElements(e.children, acc)
  }
  return acc
}

export async function captureGame(recipe: CaptureRecipe, onProgress?: (msg: string) => void): Promise<CaptureOutput> {
  if (!recipe?.url || !recipe.root || !recipe.viewport?.width || !Array.isArray(recipe.screens) || !recipe.screens.length) throw new Error('recipe cần url, root, viewport {width,height} và screens[]')
  const root = resolve(recipe.root)
  if (!existsSync(root)) throw new Error(`không thấy thư mục game: ${root}`)
  const outDir = join(root, 'uiforge', 'capture')
  await fs.mkdir(outDir, { recursive: true })
  const assetRoots = ['', 'public', 'static', 'src', 'dist', ...(recipe.assetRoots ?? [])]
  const { width, height } = recipe.viewport
  const reuse = !recipe.fresh && live && !live.win.isDestroyed() && live.url === recipe.url && live.width === width && live.height === height
  if (!reuse) closeCaptureWindow()
  if (live?.timer) clearTimeout(live.timer)
  let win: BrowserWindow
  let cdp = false
  if (reuse && live) {
    win = live.win
    cdp = live.cdp
  } else {
    win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      frame: false,
      enableLargerThanScreen: true,
      webPreferences: { contextIsolation: true, sandbox: true, partition: 'persist:game-capture', backgroundThrottling: false }
    })
    win.webContents.setAudioMuted(true)
    // art may just have been replaced on disk: never show a cached copy
    await win.webContents.session.clearCache()
    // DevTools protocol: a viewport of exactly the design size (the window itself cannot be larger than the
    // screen) and screenshots of that viewport
    try {
      // (emulation commands crash Electron when no document has been loaded yet)
      await win.webContents.loadURL('about:blank')
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await win.webContents.debugger.sendCommand('Page.enable')
      await win.webContents.debugger.sendCommand('Network.enable')
      await win.webContents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true })
      await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: TRACK_BLOBS })
      cdp = true
    } catch (e) {
      console.warn('[capture] devtools protocol unavailable', e)
    }
    live = { win, url: recipe.url, width, height, cdp, timer: null }
  }
  const wc = win.webContents
  const shoot = async (): Promise<Electron.NativeImage> => {
    // capturePage honours the emulated viewport and takes ~30 ms; Page.captureScreenshot on a hidden window
    // takes ~3 s, so it is only the fallback
    let image: Electron.NativeImage | null = null
    try {
      const quick = await wc.capturePage()
      const qs = quick.getSize()
      if (qs.width === width && qs.height === height && !quick.isEmpty()) image = quick
    } catch {
      /* fall back to the protocol */
    }
    if (!image && cdp) {
      try {
        const r = (await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })) as { data: string }
        image = nativeImage.createFromBuffer(Buffer.from(r.data, 'base64'))
      } catch (e) {
        console.warn('[capture] Page.captureScreenshot failed', e)
      }
    }
    image ??= await wc.capturePage()
    const size = image.getSize()
    return size.width !== width || size.height !== height ? image.resize({ width, height, quality: 'best' }) : image
  }
  const consoleErrors: string[] = []
  wc.on('console-message', (ev) => {
    if (ev.level === 'error' && consoleErrors.length < 5) consoleErrors.push(ev.message.slice(0, 200))
  })
  const faces: WebFont[] = []
  const out: CaptureOutput = { fonts: { written: [], unchanged: [], warnings: [] }, design: { schema: 'uiforge-game-design', version: 1, game: { name: recipe.name, root: toPosix(root), engine: recipe.engine, devUrl: recipe.url }, screens: [], flows: recipe.flows, start: recipe.start }, report: [] }
  try {
    let loaded = !!reuse
    for (const screen of recipe.screens) {
      onProgress?.(`capture ${screen.id}`)
      const warnings: string[] = []
      const t0 = Date.now()
      const lap: string[] = []
      const mark = (what: string): void => void lap.push(`${what} ${Date.now() - t0}ms`)
      if (!loaded || screen.reload) {
        try {
          await wc.loadURL(recipe.url)
        } catch (e) {
          throw new Error(`không mở được ${recipe.url} — dev server của game đã chạy chưa? (${String((e as Error).message ?? e)})`)
        }
        loaded = true
        await sleep(recipe.settleMs ?? 1500)
      }
      if (screen.enter) {
        try {
          await wc.executeJavaScript(`(async () => { ${screen.enter}\n })()`, true)
        } catch (e) {
          warnings.push(`enter lỗi: ${String((e as Error).message ?? e)}`)
        }
      }
      if (screen.waitFor) {
        const t0 = Date.now()
        let ok = false
        while (Date.now() - t0 < 15000) {
          try {
            if (await wc.executeJavaScript(`!!(${screen.waitFor})`, true)) {
              ok = true
              break
            }
          } catch {
            /* not ready yet */
          }
          await sleep(150)
        }
        if (!ok) warnings.push(`waitFor không thành true sau 15 s: ${screen.waitFor}`)
      }
      await sleep(screen.waitMs ?? (screen.enter ? (recipe.settleMs ?? 1500) / 2 : 100))
      mark('ready')

      let extracted: ExtractResult = { engine: 'dom', width, height, elements: [], warnings: [] }
      if (!screen.screenshotOnly) {
        const opts: ExtractOptions = { engine: screen.engine ?? recipe.engine ?? 'auto', game: recipe.game, root: screen.root, scenes: screen.scenes, exclude: [...(recipe.exclude ?? []), ...(screen.exclude ?? [])], only: screen.only }
        try {
          extracted = (await wc.executeJavaScript(`(${extractInPage.toString()})(${JSON.stringify(opts)})`, true)) as ExtractResult
        } catch (e) {
          warnings.push(`đọc element lỗi: ${String((e as Error).message ?? e)}`)
        }
      }
      warnings.push(...extracted.warnings)
      faces.push(...(extracted.fonts ?? []))
      mark('extract')

      // excluded things (a popup left open, the game world…) stay out of the shots
      const hasExcluded = !screen.screenshotOnly && (await wc.executeJavaScript('(window.__uiforgeExcluded || []).length', true).catch(() => 0))
      if (hasExcluded) {
        await wc.executeJavaScript(HIDE_EXCLUDED, true).catch(() => {})
        await sleep(120)
      }
      let image = await shoot()
      // second shot without any text: cut-outs of code-drawn elements must not have their labels baked in
      let clean: Electron.NativeImage | null = null
      if (needsCleanShot(extracted.elements)) {
        try {
          await wc.executeJavaScript(HIDE_TEXT, true)
          await sleep(120)
          clean = await shoot()
        } catch (e) {
          warnings.push(`không chụp được bản không chữ: ${String((e as Error).message ?? e)}`)
        } finally {
          await wc.executeJavaScript(SHOW_TEXT, true).catch(() => {})
        }
      }
      if (hasExcluded) await wc.executeJavaScript(SHOW_EXCLUDED, true).catch(() => {})

      // clip (popups): frame = the elements' bounds
      let clip = { x: 0, y: 0, width, height }
      if (screen.clip === 'elements' && extracted.elements.length) {
        const x0 = Math.max(0, Math.floor(Math.min(...extracted.elements.map((e) => e.x))))
        const y0 = Math.max(0, Math.floor(Math.min(...extracted.elements.map((e) => e.y))))
        const x1 = Math.min(width, Math.ceil(Math.max(...extracted.elements.map((e) => e.x + e.width))))
        const y1 = Math.min(height, Math.ceil(Math.max(...extracted.elements.map((e) => e.y + e.height))))
        if (x1 > x0 && y1 > y0) clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      } else if (screen.clip && typeof screen.clip === 'object') clip = screen.clip
      const clipped = clip.x || clip.y || clip.width !== width || clip.height !== height
      if (clipped) image = image.crop(clip)
      if (clean && clipped) clean = clean.crop(clip)

      mark('shots')
      const stem = screen.id.replace(/[^a-zA-Z0-9_\-.]+/g, '_')
      const file = join(outDir, `${stem}.png`)
      await fs.writeFile(file, image.toPNG())
      const cleanFile = clean ? join(outDir, `${stem}.clean.png`) : null
      if (clean && cleanFile) await fs.writeFile(cleanFile, clean.toPNG())

      const pageUrl = wc.getURL()
      const unresolved = new Set<string>()
      const own: Promise<void>[] = []
      const convert = (els: RawElement[]): OutElement[] =>
        els.map((e) => {
          const { assetUrl, assetData, children, ...rest } = e
          const o: OutElement = { ...rest, x: Math.round((e.x - clip.x) * 100) / 100, y: Math.round((e.y - clip.y) * 100) / 100 }
          if (e.type === 'image' || e.type === 'nineslice') {
            const asset = resolveAsset(assetUrl, pageUrl, root, assetRoots)
            if (asset) o.asset = asset
            else if (assetData?.startsWith('data:image/png;base64,')) {
              const f = join(outDir, `${stem}__${e.id.replace(/[^a-zA-Z0-9_\-.]+/g, '_')}.png`)
              own.push(fs.writeFile(f, Buffer.from(assetData.slice(assetData.indexOf(',') + 1), 'base64')))
              o.image = toPosix(relative(root, f))
              delete o.snapshot
            } else {
              if (assetUrl && !assetUrl.startsWith('data:') && !assetUrl.startsWith('blob:')) unresolved.add(assetUrl)
              o.snapshot = true
              delete o.crop
            }
          }
          if (children) o.children = convert(children)
          return o
        })
      const elements = convert(extracted.elements)
      await Promise.all(own)
      if (unresolved.size) warnings.push(`không tìm thấy file nguồn cho ${unresolved.size} ảnh (dùng ảnh cắt từ screenshot; thêm assetRoots nếu cần): ${Array.from(unresolved).slice(0, 5).join(', ')}`)
      out.design.screens.push({ id: screen.id, name: screen.name, width: clip.width, height: clip.height, kind: screen.kind, screenshot: toPosix(relative(root, file)), snapshotFrom: cleanFile ? toPosix(relative(root, cleanFile)) : undefined, code: screen.code, elements })
      mark('files')
      console.log(`[capture] ${screen.id}: ${lap.join(', ')}`)
      out.report.push({ id: screen.id, engine: extracted.engine, ...countElements(elements), warnings })
    }
    out.fonts = await copyWebFonts(faces, root, assetRoots)
    if (consoleErrors.length && out.report[0]) out.report[0].warnings.push(`console error của game: ${consoleErrors.join(' | ')}`)
  } finally {
    wc.removeAllListeners('console-message')
    if (live && live.win === win) live.timer = setTimeout(closeCaptureWindow, LIVE_TTL)
    else if (!win.isDestroyed()) win.destroy()
  }
  return out
}
