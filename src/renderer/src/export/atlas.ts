// Simple shelf packer for sprite atlases (pure: usable by the MCP server too).
import type { DesignDocument, FrameNode, Insets, SceneNode } from '@/model/types'
import { isContainer } from '@/model/types'
export interface AtlasInput {
  name: string
  width: number
  height: number
}

export interface AtlasRect {
  name: string
  x: number
  y: number
  width: number
  height: number
  atlas: number
}

export interface AtlasSheet {
  index: number
  width: number
  height: number
  rects: AtlasRect[]
}

/**
 * Packs sprites into power-of-two-ish sheets (max size `maxSize`) with `padding` px between them.
 * Sprites taller/wider than maxSize get their own sheet.
 */
export function packAtlas(inputs: AtlasInput[], maxSize = 2048, padding = 2): AtlasSheet[] {
  const items = inputs.slice().sort((a, b) => b.height - a.height || b.width - a.width)
  const sheets: AtlasSheet[] = []
  let remaining = items
  while (remaining.length) {
    const sheet: AtlasSheet = { index: sheets.length, width: 0, height: 0, rects: [] }
    const size = Math.max(maxSize, ...remaining.map((i) => Math.max(i.width, i.height) + padding * 2))
    let x = padding
    let y = padding
    let shelfH = 0
    const next: AtlasInput[] = []
    for (const it of remaining) {
      if (x + it.width + padding > size) {
        x = padding
        y += shelfH + padding
        shelfH = 0
      }
      if (y + it.height + padding > size) {
        next.push(it)
        continue
      }
      sheet.rects.push({ name: it.name, x, y, width: it.width, height: it.height, atlas: sheet.index })
      x += it.width + padding
      shelfH = Math.max(shelfH, it.height)
      sheet.width = Math.max(sheet.width, x)
      sheet.height = Math.max(sheet.height, y + it.height + padding)
    }
    // round up to a multiple of 4 (mobile texture compression friendly)
    sheet.width = Math.ceil(sheet.width / 4) * 4
    sheet.height = Math.ceil(sheet.height / 4) * 4
    if (!sheet.rects.length) break
    sheets.push(sheet)
    remaining = next
  }
  return sheets
}

const STATE_RE = /^(state[=_-]*)?(normal|hover|pressed|disabled|selected)$/i

/** screen_element_state style names: lowercase, ascii, underscores, unique. */
export function atlasSpriteName(frameName: string, path: string, used: Set<string>): string {
  const clean = (s: string): string =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\(style (below|above)\)/g, 'style_$1')
      .replace(/\(raster\)/g, 'raster')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
  // "btn_play/pressed/bg" → btn_play_pressed ; "btn_play/bg" → btn_play_bg (generic leaf names take their parent)
  const segs = path.split('/').filter(Boolean)
  const GENERIC = /^(bg|background|base|icon|label|text|txt|hl|highlight|img|image|sprite|layer|fill|shape)$/i
  const stateOf = (x: string): string | null => (STATE_RE.test(x) ? x.replace(/^state[=_-]*/i, '').toLowerCase() : null)
  const n = segs.length
  let leaf = segs[n - 1] || 'layer'
  const st0 = stateOf(leaf)
  const st1 = n >= 2 ? stateOf(segs[n - 2]) : null
  const stripPrefix = (name: string, owner: string): string => {
    const a = clean(name)
    const b = clean(owner)
    return a.startsWith(b + '_') ? a.slice(b.length + 1) : a === b ? '' : a
  }
  if (st0 && n >= 2) leaf = `${segs[n - 2]}_${st0}`
  else if (st1 && n >= 3) {
    // "btn_play/pressed/btn_play_bg" → btn_play_pressed (+ _<rest> when the layer is not the generic one)
    const rest = stripPrefix(leaf, segs[n - 3])
    leaf = `${segs[n - 3]}_${st1}${rest && !/^(bg|background|base|sprite|image|img)$/i.test(rest) ? `_${rest}` : ''}`
  } else if (GENERIC.test(leaf) && n >= 2) leaf = `${segs[n - 2]}_${leaf}`
  const base = `${clean(frameName)}_${clean(leaf)}`.replace(/_+/g, '_')
  let name = base || 'sprite'
  let i = 2
  while (used.has(name)) name = `${base}_${i++}`
  used.add(name)
  return name
}

export interface AtlasSpriteRef {
  assetId: string
  /** screen_element_state style sprite name (unique per page) */
  name: string
  sheet: number
  x: number
  y: number
  width: number
  height: number
  nineSlice: Insets | null
  /** "Frame/Group/layer" paths that use this sprite */
  usedBy: string[]
}

export interface AtlasPlan {
  sheets: AtlasSheet[]
  sprites: Record<string, AtlasSpriteRef>
}

/** Decides sprite names + sheet placement for every image used by `frames` (drawing happens in the app). */
export function planAtlas(doc: DesignDocument, frames: FrameNode[], maxSize = 2048, padding = 2): AtlasPlan {
  const used = new Set<string>()
  const refs: Record<string, AtlasSpriteRef> = {}
  const inputs: AtlasInput[] = []
  for (const f of frames) {
    const walk = (n: SceneNode, path: string): void => {
      const p = path ? `${path}/${n.name}` : n.name
      if ((n.type === 'image' || n.type === 'nineslice') && n.visible) {
        const a = doc.assets[n.assetId]
        if (a) {
          let r = refs[n.assetId]
          if (!r) {
            r = { assetId: n.assetId, name: atlasSpriteName(f.name, p, used), sheet: 0, x: 0, y: 0, width: a.width, height: a.height, nineSlice: null, usedBy: [] }
            refs[n.assetId] = r
            inputs.push({ name: n.assetId, width: a.width, height: a.height })
          }
          if (!r.nineSlice && n.type === 'nineslice') r.nineSlice = n.insets
          r.usedBy.push(`${f.name}/${p}`)
        }
      }
      if (isContainer(n)) n.children.forEach((c) => walk(c, p))
    }
    f.children.forEach((c) => walk(c, ''))
  }
  const sheets = packAtlas(inputs, maxSize, padding)
  for (const sh of sheets)
    for (const r of sh.rects) {
      const ref = refs[r.name]
      ref.sheet = sh.index
      ref.x = r.x
      ref.y = r.y
    }
  return { sheets, sprites: refs }
}
