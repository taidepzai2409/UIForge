#!/usr/bin/env node
// uiforge CLI — the art side of a game link, for agents that run tools from a terminal (Agent Studio):
//
//   list-assets --root <game>                      what UI art the game shows → uiforge/ASSETS.{json,md,csv,png}
//   fit-art --in <img> --root <game> --target <x>  a generated image → exact-size transparent PNG for that asset
//   stage-art --root <game> --folder <dir>         new art into the UIForge project (not the game) for review;
//                                                  several versions of one asset (x_v1, x_v2…) become options
//   variants --root <game>                         options waiting for the board + what it chose / dropped
//   capture --root <game> [--only a,b]             re-capture the game's UI with its saved recipe (dev server must run)
//   changes --root <game>                          what the design changed that the game does not have yet
//   ack --root <game>                              the game now matches the design (when capture is impossible)
//
// Output: ONE JSON line on stdout. Exit 0 = ok, 1 = error, 3 = a human must look (needs_review / app closed).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { DesignDocument } from '@/model/types'
import { assetsCsv, assetsMarkdown, listGameAssets, type AssetEntry } from '@/model/gameAssets'
import { GAME_DIR } from '@/model/game'
import { stripVariant, variantLabel } from '@/model/gameVariants'
import { alphaBox, blank, blit, checkNineSlice, contactSheet, crop, cutWhiteBackground, isOpaque, readImage, removeSpecks, resize, writePng, type Img } from './art'

// ---------------------------------------------------------------- output
function done(result: Record<string, unknown>, code = 0): never {
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(code)
}

function fail(error: string, message: string, code = 1): never {
  done({ ok: false, error, message }, code)
}

function args(argv: string[]): { cmd: string; opt: Record<string, string | true> } {
  const [cmd, ...rest] = argv
  const opt: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) continue
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) opt[a.slice(2)] = true
    else {
      opt[a.slice(2)] = next
      i++
    }
  }
  return { cmd: cmd ?? '', opt }
}

const posix = (p: string): string => p.replace(/\\/g, '/')

function loadProject(root: string): DesignDocument {
  const file = join(root, GAME_DIR, 'project.json')
  if (!existsSync(file)) fail('no_project', `Chưa có project UIForge cho game này: ${posix(file)} (chạy capture_game trước)`)
  return JSON.parse(readFileSync(file, 'utf8')) as DesignDocument
}

function findEntry(list: AssetEntry[], target: string): AssetEntry | undefined {
  const t = posix(target).toLowerCase()
  const byIndex = /^#?(\d+)$/.exec(t)
  if (byIndex) return list.find((e) => e.index === Number(byIndex[1]))
  const stem = basename(t).replace(/\.[^.]+$/, '')
  return (
    list.find((e) => e.file.toLowerCase() === t) ??
    list.find((e) => e.stageName.toLowerCase() === stem) ??
    list.find((e) => basename(e.file).toLowerCase() === basename(t)) ??
    // an option of the asset: "btn_primary_v2" → "btn_primary"
    list.find((e) => e.stageName.toLowerCase() === stripVariant(stem))
  )
}

// ---------------------------------------------------------------- list-assets
function listAssets(opt: Record<string, string | true>): never {
  if (typeof opt.root !== 'string') fail('bad_args', 'cần --root <thư mục game>')
  const root = resolve(opt.root)
  const doc = loadProject(root)
  let list: AssetEntry[]
  try {
    list = listGameAssets(doc)
  } catch (e) {
    fail('no_game_link', String((e as Error).message))
  }
  const outDir = typeof opt['out-dir'] === 'string' ? resolve(opt['out-dir']) : join(root, GAME_DIR)
  mkdirSync(outDir, { recursive: true })
  const sheetFile = join(outDir, 'ASSETS.png')
  if (opt['no-sheet'] !== true) {
    const thumbs = list.map((e) => {
      try {
        return e.preview ? readImage(join(root, e.preview)) : null
      } catch {
        return null
      }
    })
    writePng(sheetFile, contactSheet(thumbs))
  }
  const json = {
    schema: 'uiforge-game-assets',
    version: 1,
    game: doc.game!.name,
    root: posix(root),
    generatedAt: new Date().toISOString(),
    rules: {
      format: 'PNG RGBA, nền trong suốt',
      size: 'đúng width×height (hoặc cùng tỉ lệ — fit-art đưa về đúng px)',
      naming: '<stageName>.png (hoặc bất kỳ đuôi ảnh nào) → stage-art',
      nineSlice: '4 góc nằm trong insets (left, top, right, bottom theo px của file), phần giữa vẽ phẳng để giãn không nhoè'
    },
    sheet: opt['no-sheet'] === true ? undefined : posix(sheetFile),
    assets: list.map((e) => ({ ...e, preview: e.preview ? posix(join(root, e.preview)) : undefined, gameFile: e.kind === 'file' ? posix(join(root, e.file)) : undefined }))
  }
  writeFileSync(join(outDir, 'ASSETS.json'), JSON.stringify(json, null, 2))
  writeFileSync(join(outDir, 'ASSETS.md'), assetsMarkdown(doc.game!.name, list, opt['no-sheet'] === true ? undefined : 'ASSETS.png'))
  writeFileSync(join(outDir, 'assets.csv'), '﻿' + assetsCsv(list))
  done({
    ok: true,
    game: doc.game!.name,
    count: list.length,
    files: list.filter((e) => e.kind === 'file').length,
    drawn: list.filter((e) => e.kind === 'drawn').length,
    nineSlice: list.filter((e) => e.nineSlice).length,
    out: { json: posix(join(outDir, 'ASSETS.json')), md: posix(join(outDir, 'ASSETS.md')), csv: posix(join(outDir, 'assets.csv')), sheet: opt['no-sheet'] === true ? undefined : posix(sheetFile) }
  })
}

// ---------------------------------------------------------------- fit-art
function fitArt(opt: Record<string, string | true>): never {
  if (typeof opt.in !== 'string') fail('bad_args', 'cần --in <ảnh gen ra (png/jpg)>')
  const input = resolve(opt.in)
  if (!existsSync(input)) fail('not_found', `không thấy ${posix(input)}`)
  let W: number
  let H: number
  let insets: { left: number; top: number; right: number; bottom: number } | undefined
  let name = basename(input).replace(/\.[^.]+$/, '')
  let entry: AssetEntry | undefined
  if (typeof opt.size === 'string') {
    const m = /^(\d+)x(\d+)$/i.exec(opt.size)
    if (!m) fail('bad_args', '--size phải là WxH, vd 300x100')
    W = Number(m[1])
    H = Number(m[2])
  } else {
    if (typeof opt.root !== 'string' || typeof opt.target !== 'string') fail('bad_args', 'cần --root + --target <file game | stage name | #số> (hoặc --size WxH)')
    entry = findEntry(listGameAssets(loadProject(resolve(opt.root))), opt.target)
    if (!entry) fail('target_not_found', `không có asset "${opt.target}" (xem uiforge/ASSETS.md)`)
    W = entry.width
    H = entry.height
    insets = entry.nineSlice
    name = entry.stageName
  }
  if (typeof opt.insets === 'string') {
    const v = opt.insets.split(/[ ,]+/).map(Number)
    if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) fail('bad_args', '--insets L,T,R,B')
    insets = { left: v[0], top: v[1], right: v[2], bottom: v[3] }
  }
  const out = typeof opt.out === 'string' ? resolve(opt.out) : join(dirname(input), 'fit', `${name}.png`)
  if (existsSync(out) && opt.force !== true) fail('out_exists', `đã có ${posix(out)} (không ghi đè; dùng --out khác hoặc --force)`)

  const img = readImage(input)
  const warnings: string[] = []
  let cut: { cut: number; tolerance: number } | null = null
  if (isOpaque(img) && opt['keep-bg'] !== true) cut = cutWhiteBackground(img)
  const specks = opt['keep-specks'] === true ? 0 : removeSpecks(img)
  const box = alphaBox(img)
  if (!box) fail('empty', 'sau khi cắt nền không còn gì (ảnh trắng hoặc vật thể quá nhạt) — cần người xem', 3)
  let art = crop(img, box)
  const mode = typeof opt.mode === 'string' ? opt.mode : 'contain'
  const pad = typeof opt.pad === 'string' ? Math.max(0, Number(opt.pad)) : 0
  const aspectIn = art.width / art.height
  const aspectOut = W / H
  const aspectOff = Math.abs(Math.log(aspectIn / aspectOut))
  let result: Img
  if (mode === 'stretch' || (insets && typeof opt.mode !== 'string')) {
    // a 9-slice frame fills its exact box by default (it is drawn to be stretched); --mode contain keeps the ratio
    result = resize(art, W, H)
    if (!insets && aspectOff > 0.05) warnings.push(`ảnh bị kéo giãn: tỉ lệ ${aspectIn.toFixed(2)} → ${aspectOut.toFixed(2)}`)
  } else {
    const k = mode === 'cover' ? Math.max((W - 2 * pad) / art.width, (H - 2 * pad) / art.height) : Math.min((W - 2 * pad) / art.width, (H - 2 * pad) / art.height)
    const tw = Math.max(1, Math.round(art.width * k))
    const th = Math.max(1, Math.round(art.height * k))
    art = resize(art, tw, th)
    result = blank(W, H)
    blit(result, art, Math.round((W - tw) / 2), Math.round((H - th) / 2))
    if (aspectOff > 0.15) warnings.push(`tỉ lệ ảnh gen (${aspectIn.toFixed(2)}) khác asset (${aspectOut.toFixed(2)}): ${mode === 'cover' ? 'bị cắt mép' : 'có khoảng trống hai bên'}`)
  }
  const nine = insets ? checkNineSlice(result, insets) : undefined
  if (nine && !nine.ok) warnings.push(nine.note)
  mkdirSync(dirname(out), { recursive: true })
  writePng(out, result)
  const needsReview = (nine && !nine.ok) || aspectOff > 0.35
  done(
    {
      ok: true,
      out: posix(out),
      size: [W, H],
      target: entry ? { index: entry.index, file: entry.file, stageName: entry.stageName, kind: entry.kind } : undefined,
      source: { file: posix(input), width: img.width, height: img.height, content: [box.width, box.height] },
      background: cut ? { cut: cut.cut, tolerance: cut.tolerance } : 'kept',
      specksRemoved: specks,
      nineSlice: nine,
      warnings,
      needs_review: !!needsReview
    },
    needsReview ? 3 : 0
  )
}

// ---------------------------------------------------------------- stage-art (needs the app)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = Number(process.env.DM_BRIDGE_PORT ?? 47821)

async function health(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) })
    return r.ok
  } catch {
    return false
  }
}

async function bridge<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
  const j = (await r.json()) as { result?: T; error?: string }
  if (j.error) throw new Error(j.error)
  return j.result as T
}

async function ensureApp(): Promise<boolean> {
  if (await health()) return true
  if (process.env.DM_NO_AUTOLAUNCH) return false
  const electron = join(repoRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  const exe = existsSync(join(repoRoot, 'out', 'main')) && existsSync(electron) ? electron : null
  if (!exe) return false
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(exe, ['.'], { cwd: repoRoot, detached: true, stdio: 'ignore', env }).unref()
  for (let t = Date.now(); Date.now() - t < 25000; ) {
    await new Promise((r) => setTimeout(r, 500))
    if (await health()) {
      await new Promise((r) => setTimeout(r, 2500))
      return true
    }
  }
  return false
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

async function stageArt(opt: Record<string, string | true>): Promise<never> {
  if (typeof opt.root !== 'string') fail('bad_args', 'cần --root <thư mục game>')
  const root = resolve(opt.root)
  const list = listGameAssets(loadProject(root))
  const files: { file: string; entry?: AssetEntry }[] = []
  if (typeof opt.file === 'string') {
    const f = resolve(opt.file)
    if (!existsSync(f)) fail('not_found', `không thấy ${posix(f)}`)
    files.push({ file: f, entry: findEntry(list, typeof opt.target === 'string' ? opt.target : basename(f)) })
  } else if (typeof opt.folder === 'string') {
    const dir = resolve(opt.folder)
    if (!existsSync(dir)) fail('not_found', `không thấy ${posix(dir)}`)
    for (const n of readdirSync(dir)) if (IMAGE_EXT.has(extname(n).toLowerCase())) files.push({ file: join(dir, n), entry: findEntry(list, n) })
  } else fail('bad_args', 'cần --folder <thư mục art> hoặc --file <ảnh> [--target …]')
  const matched = files.filter((f) => f.entry)
  const unmatched = files.filter((f) => !f.entry).map((f) => basename(f.file))
  if (!matched.length) fail('nothing_matched', `không file nào khớp stage name trong ASSETS (${unmatched.slice(0, 5).join(', ')})`)
  // one file per asset = new art; several (x_v1, x_v2…) or an option-named file = options for the board
  const groups = new Map<number, { entry: AssetEntry; files: string[] }>()
  for (const f of matched) {
    const g = groups.get(f.entry!.index) ?? { entry: f.entry!, files: [] }
    g.files.push(f.file)
    groups.set(f.entry!.index, g)
  }
  const plan = Array.from(groups.values()).map((g) => {
    const asOptions = g.files.length > 1 || g.files.some((f) => basename(f).replace(/\.[^.]+$/, '').toLowerCase() !== g.entry.stageName.toLowerCase())
    return { ...g, asOptions }
  })
  if (opt['dry-run'] === true)
    done({ ok: true, dryRun: true, staged: plan.map((g) => ({ asset: g.entry.stageName, index: g.entry.index, mode: g.asOptions ? 'options' : 'replace', files: g.files.map((f) => basename(f)) })), unmatched })
  if (!(await ensureApp())) fail('app_not_running', 'Không mở được app UIForge — mở app rồi chạy lại', 3)
  await bridge('openGame', { root: posix(root), name: basename(root) })
  const staged: { asset: string; mode: string; files: string[]; result: unknown }[] = []
  const failed: { asset: string; error: string }[] = []
  for (const g of plan) {
    const e = g.entry
    const where = e.kind === 'file' ? { source: e.file } : { node: e.nodeId }
    try {
      const r = g.asOptions
        ? await bridge<unknown>('addArtVariants', { ...where, name: e.stageName, files: g.files.map((f) => ({ file: posix(f), label: variantLabel(basename(f)) ?? undefined })) })
        : await bridge<unknown>('replaceGameArt', { ...where, file: posix(g.files[0]) })
      staged.push({ asset: e.stageName, mode: g.asOptions ? 'options' : 'replace', files: g.files.map((f) => basename(f)), result: (r as { replaced?: unknown })?.replaced ?? r })
    } catch (err) {
      failed.push({ asset: e.stageName, error: String((err as Error).message ?? err) })
    }
  }
  await bridge('save', {})
  const options = staged.filter((s) => s.mode === 'options').length
  done(
    {
      ok: failed.length === 0,
      staged,
      unmatched,
      failed,
      next: options
        ? `Board mở UIForge → tab Game → "Phương án chờ chọn" (${options} asset): xem từng bản trên màn thật, Chọn → rồi Sync → Game. Đọc kết quả: uiforge variants --root <game>`
        : 'Xem trong app UIForge (tab Game) → ưng thì bấm Sync → Game; art chưa ghi vào game'
    },
    failed.length ? 1 : 0
  )
}

// ---------------------------------------------------------------- variants (file mode)
function variants(opt: Record<string, string | true>): never {
  if (typeof opt.root !== 'string') fail('bad_args', 'cần --root <thư mục game>')
  const doc = loadProject(resolve(opt.root))
  const g = doc.game
  if (!g) fail('no_game_link', 'Project này chưa nối với game')
  const pending = Object.entries(g.variants ?? {}).map(([key, s]) => ({ key, asset: s.name, options: s.options.map((o) => ({ label: o.label, file: posix(o.file) })), showing: s.options.find((o) => o.id === s.active)?.label ?? null }))
  const since = typeof opt.since === 'string' ? Date.parse(opt.since) : 0
  const decisions = (g.variantLog ?? []).filter((d) => !since || Date.parse(d.at) >= since).map((d) => ({ asset: d.name, chosen: d.chosen, rejected: d.rejected, files: d.files.map((f) => ({ label: f.label, file: posix(f.file) })), at: d.at }))
  done({ ok: true, pending, decisions })
}

// ---------------------------------------------------------------- capture / changes / ack (dev side)
async function capture(opt: Record<string, string | true>): Promise<never> {
  if (typeof opt.root !== 'string') fail('bad_args', 'cần --root <thư mục game>')
  const root = resolve(opt.root)
  const recipeFile = join(root, GAME_DIR, 'capture.json')
  if (!existsSync(recipeFile)) fail('no_recipe', `Chưa có recipe ${posix(recipeFile)}: lần capture đầu cần dựng recipe (MCP capture_game, xem game_guide) — cần người`, 3)
  const recipe = JSON.parse(readFileSync(recipeFile, 'utf8')) as { url?: string; screens?: { id: string }[] }
  if (recipe.url) {
    try {
      await fetch(recipe.url, { signal: AbortSignal.timeout(3000) })
    } catch {
      fail('dev_server_down', `Dev server của game không chạy (${recipe.url}) — chạy dev server rồi thử lại`)
    }
  }
  const only = typeof opt.only === 'string' ? opt.only.split(',').map((s) => s.trim()).filter(Boolean) : null
  const run = { ...recipe, root: posix(root), ...(only ? { screens: (recipe.screens ?? []).filter((s) => only.includes(s.id)) } : {}) }
  if (!(await ensureApp())) fail('app_not_running', 'Không mở được app UIForge — mở app rồi chạy lại', 3)
  const cap = await bridge<{ design: unknown; report: { id: string; elements: number; warnings: string[] }[]; fonts?: unknown }>('captureGame', run)
  writeFileSync(join(root, GAME_DIR, 'design.json'), JSON.stringify(cap.design, null, 2))
  const pushed = await bridge<{ pending?: number; warnings?: string[]; componentsFound?: { name: string }[] }>('pushGameDesign', { design: cap.design })
  const warnings = [...cap.report.flatMap((r) => r.warnings.map((w) => `${r.id}: ${w}`)), ...(pushed.warnings ?? [])]
  done({ ok: true, screens: cap.report.map((r) => ({ id: r.id, elements: r.elements })), components: (pushed.componentsFound ?? []).length, pending: pushed.pending ?? 0, warnings: warnings.slice(0, 20) })
}

async function changes(opt: Record<string, string | true>): Promise<never> {
  if (typeof opt.root !== 'string') fail('bad_args', 'cần --root <thư mục game>')
  const root = resolve(opt.root)
  const doc = loadProject(root)
  const { diffGame, buildChangesMarkdown } = await import('@/model/game')
  const c = diffGame(doc)
  done({ ok: true, total: c.total, assets: c.assets.length, screens: c.screens.map((s) => ({ id: s.id, changes: s.changes.length })), markdown: buildChangesMarkdown(c), changesFile: existsSync(join(root, GAME_DIR, 'CHANGES.md')) ? posix(join(root, GAME_DIR, 'CHANGES.md')) : undefined })
}

async function ack(opt: Record<string, string | true>): Promise<never> {
  if (typeof opt.root !== 'string') fail('bad_args', 'cần --root <thư mục game>')
  const root = resolve(opt.root)
  if (!(await ensureApp())) fail('app_not_running', 'Không mở được app UIForge — mở app rồi chạy lại', 3)
  await bridge('openGame', { root: posix(root), name: basename(root) })
  done({ ok: true, ...(await bridge<Record<string, unknown>>('ackGame', {})) })
}

// ---------------------------------------------------------------- main
const HELP = `uiforge <lệnh> [tuỳ chọn]   (1 dòng JSON ra stdout; exit 0 ok · 1 lỗi · 3 cần người xem)
  list-assets --root <game> [--out-dir <dir>] [--no-sheet]
  fit-art --in <ảnh> (--root <game> --target <file game|stage name|#số> | --size WxH [--insets L,T,R,B])
          [--out <png>] [--mode contain|cover|stretch] [--pad <px>] [--keep-bg] [--keep-specks] [--force]
  stage-art --root <game> (--folder <dir> | --file <ảnh> [--target …]) [--dry-run]
            (nhiều bản một asset: <stageName>_v1.png, _v2… → phương án để board chọn trong app)
  variants --root <game> [--since <ISO date>]   phương án đang chờ + board đã chọn / loại gì
  capture --root <game> [--only <màn,màn>]      capture lại UI game bằng recipe đã lưu (dev server phải chạy)
  changes --root <game>                         thay đổi UI thiết kế có mà game chưa có (như CHANGES.md)
  ack --root <game>                             báo game đã khớp thiết kế (khi không capture được)`

const { cmd, opt } = args(process.argv.slice(2))
try {
  if (cmd === 'list-assets') listAssets(opt)
  else if (cmd === 'fit-art') fitArt(opt)
  else if (cmd === 'stage-art') await stageArt(opt)
  else if (cmd === 'variants') variants(opt)
  else if (cmd === 'capture') await capture(opt)
  else if (cmd === 'changes') await changes(opt)
  else if (cmd === 'ack') await ack(opt)
  else done({ ok: false, error: 'bad_args', message: HELP }, cmd === 'help' || cmd === '--help' || !cmd ? 0 : 1)
} catch (e) {
  fail('error', String((e as Error)?.stack ?? e))
}
