import { readPsd, type Layer, type Psd } from 'ag-psd'
import { CanvasTextMetrics, TextStyle } from 'pixi.js'
import type { Asset, BlendMode, FrameNode, GroupNode, PatternDef, SceneNode, TextNode } from '@/model/types'
import { createFrame, createGroup, createImage, createText } from '@/model/create'
import { fitGroup } from '@/model/nodes'
import { pngFromCanvas, putAssetBytes, safeFileName, sha256Hex } from '@/store/assets'
import { resolvePsdFont } from '@/store/fonts'
import { applyLayerEffects, hasEnabledEffects, type RenderedLayer } from './effects'
import type { LayerEffectsInfo } from 'ag-psd'
import { applyAdjustment, supportedAdjustment } from './adjustments'
import type { AdjustmentLayer } from 'ag-psd'

export interface PsdImportResult {
  frames: FrameNode[]
  assets: Asset[]
  /** patterns referenced by layer styles, saved as PNG assets */
  patterns: Record<string, PatternDef>
  globalAngle?: number
  warnings: string[]
  /** informational lines (skipped empty layers etc.) */
  infos: string[]
  missingFonts: string[]
  layerCount: number
}

export type TextMode = 'live' | 'raster' | 'both'

export interface BuildOptions {
  /** single: whole PSD = 1 frame. split: each selected top-level group = 1 frame */
  mode: 'single' | 'split'
  /** indexes into psd.children (top-level) to turn into frames (split mode) */
  groupIndexes?: number[]
  /** split mode: copy top-level loose layers (not in a group, e.g. shared background) into every frame */
  includeLooseLayers?: boolean
  /** also include hidden loose layers (default false) */
  includeHiddenLoose?: boolean
  textMode?: TextMode
  applyMasks?: boolean
  applyClipping?: boolean
  applyEffects?: boolean
  flattenStyledGroups?: boolean
  /** after import: rule-based anchors + safe area for top-level nodes of each new frame (default true) */
  autoAnchor?: boolean
  onProgress?: (done: number, total: number, name: string) => void
}

export interface TopLevelInfo {
  index: number
  name: string
  isGroup: boolean
  hidden: boolean
  layerCount: number
}

export interface ParsedPsd {
  psd: Psd
  fileName: string
  baseName: string
  width: number
  height: number
  topLevel: TopLevelInfo[]
  layerCount: number
  textLayers: number
}

const BLEND_MAP: Record<string, BlendMode> = {
  normal: 'normal',
  'pass through': 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'linear dodge': 'add',
  'linear dodge (add)': 'add'
}

const CANVAS_BLEND: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over',
  'pass through': 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'linear dodge': 'lighter',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'hard light': 'hard-light',
  'soft light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity'
}

function countLayers(layers: Layer[] | undefined): number {
  if (!layers) return 0
  let n = 0
  for (const l of layers) {
    n++
    n += countLayers(l.children)
  }
  return n
}

function countText(layers: Layer[] | undefined): number {
  if (!layers) return 0
  let n = 0
  for (const l of layers) {
    if (l.text) n++
    n += countText(l.children)
  }
  return n
}

function isBlank(c: HTMLCanvasElement): boolean {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
  for (let i = 3; i < d.length; i += 4) if (d[i] > 2) return false
  return true
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w))
  c.height = Math.max(1, Math.ceil(h))
  return c
}

function grayToAlpha(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height)
  const img = src.getContext('2d')!.getImageData(0, 0, src.width, src.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i]
    d[i] = 0
    d[i + 1] = 0
    d[i + 2] = 0
  }
  out.getContext('2d')!.putImageData(img, 0, 0)
  return out
}

function applyLayerMask(layer: Layer, canvas: HTMLCanvasElement, left: number, top: number): HTMLCanvasElement {
  const m = layer.mask
  if (!m || m.disabled || !m.canvas) return canvas
  const lw = canvas.width
  const lh = canvas.height
  const mLeft = (m.left ?? 0) + (m.positionRelativeToLayer ? left : 0)
  const mTop = (m.top ?? 0) + (m.positionRelativeToLayer ? top : 0)
  const gray = makeCanvas(lw, lh)
  const gctx = gray.getContext('2d')!
  const def = m.defaultColor ?? 255
  gctx.fillStyle = `rgb(${def},${def},${def})`
  gctx.fillRect(0, 0, lw, lh)
  gctx.drawImage(m.canvas, mLeft - left, mTop - top)
  const alpha = grayToAlpha(gray)
  const out = makeCanvas(lw, lh)
  const octx = out.getContext('2d')!
  octx.drawImage(canvas, 0, 0)
  octx.globalCompositeOperation = 'destination-in'
  octx.drawImage(alpha, 0, 0)
  return out
}

function applyClipBase(canvas: HTMLCanvasElement, left: number, top: number, base: RenderedLayer): HTMLCanvasElement {
  const out = makeCanvas(canvas.width, canvas.height)
  const ctx = out.getContext('2d')!
  ctx.drawImage(canvas, 0, 0)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(base.canvas, base.left - left, base.top - top)
  return out
}

function extractTextMeta(layer: Layer): Record<string, unknown> | undefined {
  const t = layer.text
  if (!t) return undefined
  const style = t.style ?? {}
  const color = style.fillColor as { r?: number; g?: number; b?: number } | undefined
  return {
    text: t.text,
    font: style.font?.name,
    fontSize: style.fontSize,
    color:
      color && color.r !== undefined
        ? `#${[color.r, color.g, color.b].map((v) => Math.round(v ?? 0).toString(16).padStart(2, '0')).join('')}`
        : undefined,
    justification: t.paragraphStyle?.justification,
    transform: t.transform
  }
}

/** Phase 1: parse the file (expensive) and describe its top-level structure for the import dialog. */
export function parsePsd(fileName: string, data: Uint8Array): ParsedPsd {
  let psd: Psd
  try {
    psd = readPsd(data, { skipThumbnail: true, skipCompositeImageData: true, skipLinkedFilesData: true })
  } catch (e) {
    throw new Error(`Không đọc được PSD: ${(e as Error).message}`)
  }
  const baseName = fileName.replace(/^.*[\\/]/, '').replace(/\.psd$/i, '')
  const topLevel: TopLevelInfo[] = (psd.children ?? []).map((l, index) => ({
    index,
    name: l.name || 'Layer',
    isGroup: !!l.children,
    hidden: !!l.hidden,
    layerCount: l.children ? countLayers(l.children) : 1
  }))
  return { psd, fileName, baseName, width: psd.width, height: psd.height, topLevel, layerCount: countLayers(psd.children), textLayers: countText(psd.children) }
}

/** Builds a TextNode from a PSD text layer, placed so the first baseline matches Photoshop. */
function buildTextNode(layer: Layer, name: string, missingFonts: Set<string>, warn: (m: string) => void): TextNode | null {
  const t = layer.text
  if (!t) return null
  if (t.orientation === 'vertical') {
    warn('text dọc chưa hỗ trợ, giữ ảnh')
    return null
  }
  if (t.warp && t.warp.style && t.warp.style !== 'none') warn(`text warp "${t.warp.style}" không tái tạo được, text sống sẽ thẳng`)
  const style = t.style ?? {}
  const tr = t.transform ?? [1, 0, 0, 1, layer.left ?? 0, layer.bottom ?? 0]
  const sx = Math.hypot(tr[0], tr[1]) || 1
  const sy = Math.hypot(tr[2], tr[3]) || 1
  const fontSizePt = style.fontSize ?? 12
  const fontSize = Math.round(fontSizePt * sy * 100) / 100
  const res = resolvePsdFont(style.font?.name)
  if (!res.found && res.requested) missingFonts.add(res.requested)
  const text = (t.text ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '')
  const uppercase = style.fontCaps === 2
  let lineHeight = 1.2
  const para = t.paragraphStyle ?? {}
  if (style.autoLeading === false && style.leading && style.leading > 1) lineHeight = style.leading / fontSizePt
  else if (typeof para.autoLeading === 'number' && para.autoLeading > 0.5) lineHeight = para.autoLeading
  // a leading below the glyph height would clip the glyphs in our renderer; Photoshop ignores it for single lines
  if (lineHeight < 1) lineHeight = 1
  const just = (para.justification ?? 'left') as string
  const align: TextNode['align'] = just.includes('center') ? 'center' : just.includes('right') ? 'right' : 'left'
  const fc = style.fillColor as { r?: number; g?: number; b?: number } | undefined
  const color = fc && fc.r !== undefined ? { r: fc.r, g: fc.g ?? 0, b: fc.b ?? 0, a: 1 } : { r: 0, g: 0, b: 0, a: 1 }
  const letterSpacing = style.tracking ? Math.round(((style.tracking / 1000) * fontSize) * 100) / 100 : 0

  const tx = tr[4]
  const ty = tr[5]
  const lh = fontSize * lineHeight
  const fontString = `${res.italic ? 'italic ' : ''}${res.weight} ${fontSize}px "${res.family}", Arial`
  const fp = CanvasTextMetrics.measureFont(fontString)
  const baselineOffset = fp.ascent + (lh - fp.fontSize) / 2
  const lines = text.split('\n').length

  let x: number
  let y: number
  let width: number
  const b = t.bounds
  if (t.shapeType === 'box' && t.boxBounds && t.boxBounds.length === 4) {
    const bb = t.boxBounds
    x = tx + bb[0] * sx
    width = (bb[2] - bb[0]) * sx
    y = (layer.top ?? ty) - (lh - fontSize) / 2
  } else if (b) {
    x = tx + b.left.value * sx
    width = (b.right.value - b.left.value) * sx
    y = ty - baselineOffset
  } else {
    x = layer.left ?? 0
    width = (layer.right ?? 0) - (layer.left ?? 0)
    y = ty - baselineOffset
  }
  // never narrower than what our renderer needs for the longest line (avoids unexpected wrapping)
  const measured = CanvasTextMetrics.measureText(
    uppercase ? text.toUpperCase() : text,
    new TextStyle({ fontFamily: [res.family, 'Arial'], fontSize, fontWeight: String(res.weight) as '400', fontStyle: res.italic ? 'italic' : 'normal', letterSpacing })
  )
  width = Math.max(width, measured.width) + 2
  if (align === 'center') x -= (width - (b ? (b.right.value - b.left.value) * sx : width)) / 2
  else if (align === 'right') x -= width - (b ? (b.right.value - b.left.value) * sx : width)

  const node = createText(name, Math.round(x * 100) / 100, Math.round(y * 100) / 100, text)
  node.fontFamily = res.family
  node.fontSize = fontSize
  node.fontWeight = res.weight
  node.italic = res.italic || undefined
  node.letterSpacing = letterSpacing || undefined
  node.uppercase = uppercase || undefined
  node.color = color
  node.align = align
  node.lineHeight = Math.round(lineHeight * 1000) / 1000
  node.autoSize = false
  node.width = Math.round(width * 100) / 100
  node.height = Math.round(lh * lines * 100) / 100
  node.visible = !layer.hidden
  node.opacity = layer.opacity ?? 1
  return node
}

/** Phase 2: build frames + assets from a parsed PSD. */
export async function buildFromPsd(parsed: ParsedPsd, opts: BuildOptions): Promise<PsdImportResult> {
  const { psd, baseName } = parsed
  const applyMasks = opts.applyMasks ?? true
  const applyClipping = opts.applyClipping ?? true
  const applyEffects = opts.applyEffects ?? true
  const flattenStyledGroups = opts.flattenStyledGroups ?? false
  const textMode: TextMode = opts.textMode ?? 'both'
  const warnings: string[] = []
  const infos: string[] = []
  const missingFonts = new Set<string>()
  const assets: Asset[] = []
  const assetById = new Map<string, Asset>()
  const total = parsed.layerCount
  let done = 0
  const globalAngle = (psd as unknown as { globalAngle?: number }).globalAngle
  const renderCache = new WeakMap<Layer, RenderedLayer | null>()
  // png + hash per rendered canvas (loose layers are reused by every frame in split mode)
  const pngCache = new WeakMap<HTMLCanvasElement, { png: Uint8Array; id: string }>()

  /** adjustment layers that apply to each pixel layer (lowest first) */
  const adjustmentsFor = new WeakMap<Layer, { adj: AdjustmentLayer; mask: Layer['mask'] }[]>()
  const collectAdjustments = (layers: Layer[]): void => {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i]
      if (l.children) {
        collectAdjustments(l.children)
        continue
      }
      if (!l.adjustment || l.hidden) continue
      const entry = { adj: l.adjustment, mask: l.mask }
      const targets: Layer[] = []
      if (l.clipping) {
        for (let k = i - 1; k >= 0; k--) {
          if (!layers[k].clipping) {
            targets.push(layers[k])
            break
          }
        }
      } else {
        const addAll = (list: Layer[]): void => {
          for (const t of list) {
            if (t.children) addAll(t.children)
            else if (!t.adjustment) targets.push(t)
          }
        }
        addAll(layers.slice(0, i))
      }
      for (const t of targets) {
        const arr = adjustmentsFor.get(t) ?? []
        arr.push(entry)
        adjustmentsFor.set(t, arr)
      }
    }
  }
  collectAdjustments(psd.children ?? [])

  const maskWeight = (mask: Layer['mask'], left: number, top: number, w: number, h: number): HTMLCanvasElement | null => {
    if (!mask || mask.disabled || !mask.canvas) return null
    const mLeft = mask.left ?? 0
    const mTop = mask.top ?? 0
    const gray = makeCanvas(w, h)
    const g = gray.getContext('2d')!
    const def = mask.defaultColor ?? 255
    g.fillStyle = `rgb(${def},${def},${def})`
    g.fillRect(0, 0, w, h)
    g.drawImage(mask.canvas, mLeft - left, mTop - top)
    return grayToAlpha(gray)
  }

  const rawOf = new WeakMap<Layer, RenderedLayer>()
  const patternDefs: Record<string, PatternDef> = {}
  const savePatterns = async (fx: LayerEffectsInfo): Promise<void> => {
    const refs: { id?: string; name?: string }[] = []
    const po = fx.patternOverlay as { enabled?: boolean; pattern?: { id?: string; name?: string } } | undefined
    if (po?.enabled && po.pattern) refs.push(po.pattern)
    for (const st of Array.isArray(fx.stroke) ? fx.stroke : fx.stroke ? [fx.stroke] : []) {
      const so = st as { enabled?: boolean; fillType?: string; pattern?: { id?: string; name?: string } }
      if (so.enabled && so.fillType === 'pattern' && so.pattern) refs.push(so.pattern)
    }
    for (const ref of refs) {
      const p = psd.patterns?.find((x) => x.id === ref.id) ?? psd.patterns?.find((x) => x.name === ref.name)
      if (!p || !p.data || !p.bounds?.w || !p.bounds?.h || patternDefs[p.id]) continue
      const c = makeCanvas(p.bounds.w, p.bounds.h)
      const img = c.getContext('2d')!.createImageData(p.bounds.w, p.bounds.h)
      if (p.data.length < img.data.length) continue
      img.data.set(p.data.subarray(0, img.data.length))
      c.getContext('2d')!.putImageData(img, 0, 0)
      const png = await pngFromCanvas(c)
      const id = (await sha256Hex(png)).slice(0, 16)
      if (!assetById.has(id)) {
        const asset: Asset = { id, file: `pattern_${safeFileName(p.name)}_${id.slice(0, 8)}.png`, width: c.width, height: c.height, source: `psd:${baseName}.psd/pattern/${p.name}` }
        assetById.set(id, asset)
        assets.push(asset)
        putAssetBytes(id, png)
      }
      patternDefs[p.id] = { name: p.name, assetId: id, width: c.width, height: c.height }
    }
  }

  const renderLayer = (layer: Layer, clipBase: RenderedLayer | null, path: string): RenderedLayer | null => {
    if (renderCache.has(layer)) return renderCache.get(layer)!
    let result: RenderedLayer | null = null
    const w = (layer.right ?? 0) - (layer.left ?? 0)
    const h = (layer.bottom ?? 0) - (layer.top ?? 0)
    let canvas = layer.canvas as HTMLCanvasElement | undefined
    if (canvas && w > 0 && h > 0) {
      const left = layer.left ?? 0
      const top = layer.top ?? 0
      if (applyMasks && layer.mask?.canvas) canvas = applyLayerMask(layer, canvas, left, top)
      if (layer.clipping && applyClipping && clipBase) canvas = applyClipBase(canvas, left, top, clipBase)
      result = { canvas, left, top }
      const adjs = adjustmentsFor.get(layer)
      if (adjs) {
        for (const { adj, mask } of adjs) {
          if (!supportedAdjustment(adj)) continue
          const weight = maskWeight(mask, result.left, result.top, result.canvas.width, result.canvas.height)
          result = { ...result, canvas: applyAdjustment(result.canvas, adj, weight) }
        }
      }
      rawOf.set(layer, result)
      const fillOp = layer.fillOpacity ?? 1
      if (applyEffects && layer.effects && hasEnabledEffects(layer.effects)) {
        result = applyLayerEffects(result, layer.effects, globalAngle, (m) => warnings.push(`${path}: ${m}`), psd.patterns, { fillOpacity: fillOp })
      } else if (fillOp < 1) {
        // Photoshop "Fill" opacity affects the pixels only (effects would stay opaque)
        const faded = makeCanvas(canvas.width, canvas.height)
        const fctx = faded.getContext('2d')!
        fctx.globalAlpha = fillOp
        fctx.drawImage(canvas, 0, 0)
        result = { canvas: faded, left, top }
      }
    }
    renderCache.set(layer, result)
    return result
  }

  const compositeGroup = (group: Layer, path: string): RenderedLayer | null => {
    const items: { r: RenderedLayer; opacity: number; blend: GlobalCompositeOperation }[] = []
    const collect = (layers: Layer[], p: string): void => {
      let clipBase: RenderedLayer | null = null
      for (const l of layers) {
        if (l.hidden) continue
        const lp = `${p}/${l.name || 'Layer'}`
        if (l.children) {
          const r = compositeGroup(l, lp)
          if (r) items.push({ r, opacity: l.opacity ?? 1, blend: CANVAS_BLEND[(l.blendMode ?? 'normal').toLowerCase()] ?? 'source-over' })
          clipBase = null
          continue
        }
        const r = renderLayer(l, clipBase, lp)
        if (!l.clipping) clipBase = r
        if (r) items.push({ r, opacity: l.opacity ?? 1, blend: CANVAS_BLEND[(l.blendMode ?? 'normal').toLowerCase()] ?? 'source-over' })
      }
    }
    collect(group.children ?? [], path)
    if (!items.length) return null
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity
    for (const it of items) {
      x0 = Math.min(x0, it.r.left)
      y0 = Math.min(y0, it.r.top)
      x1 = Math.max(x1, it.r.left + it.r.canvas.width)
      y1 = Math.max(y1, it.r.top + it.r.canvas.height)
    }
    const canvas = makeCanvas(x1 - x0, y1 - y0)
    const ctx = canvas.getContext('2d')!
    for (const it of items) {
      ctx.globalAlpha = it.opacity
      ctx.globalCompositeOperation = it.blend
      ctx.drawImage(it.r.canvas, it.r.left - x0, it.r.top - y0)
    }
    let result: RenderedLayer = { canvas, left: x0, top: y0 }
    if (applyMasks && group.mask?.canvas) result = { ...result, canvas: applyLayerMask(group, canvas, x0, y0) }
    if (applyEffects && group.effects && hasEnabledEffects(group.effects)) {
      result = applyLayerEffects(result, group.effects, globalAngle, (m) => warnings.push(`${path}: ${m}`), psd.patterns)
    }
    return result
  }

  const addImageNode = async (
    name: string,
    r: RenderedLayer,
    layer: Layer,
    path: string,
    out: SceneNode[],
    extraMeta: Record<string, unknown> = {},
    forceHidden = false
  ): Promise<void> => {
    let cached = pngCache.get(r.canvas)
    if (!cached) {
      const png = await pngFromCanvas(r.canvas)
      cached = { png, id: (await sha256Hex(png)).slice(0, 16) }
      pngCache.set(r.canvas, cached)
    }
    const { png, id } = cached
    let asset = assetById.get(id)
    if (!asset) {
      asset = { id, file: `${safeFileName(name)}_${id.slice(0, 8)}.png`, width: r.canvas.width, height: r.canvas.height, source: `psd:${baseName}.psd/${path}` }
      assetById.set(id, asset)
      assets.push(asset)
      putAssetBytes(id, png)
    }
    const img = createImage(name, r.left, r.top, r.canvas.width, r.canvas.height, id)
    // editable layer style: keep the raw pixels + the PSD effect parameters
    const raw = rawOf.get(layer)
    const styled = !!(layer.effects && hasEnabledEffects(layer.effects)) || (layer.fillOpacity ?? 1) < 1
    if (raw && styled && !extraMeta.psdGroupStyle && !extraMeta.psdFlattenedGroup) {
      let rid: string
      if (raw.canvas === r.canvas) rid = id
      else {
        const rpng = await pngFromCanvas(raw.canvas)
        rid = (await sha256Hex(rpng)).slice(0, 16)
        if (!assetById.has(rid)) {
          const ra: Asset = { id: rid, file: `${safeFileName(name)}_raw_${rid.slice(0, 8)}.png`, width: raw.canvas.width, height: raw.canvas.height, source: `psd:${baseName}.psd/${path} (raw)` }
          assetById.set(rid, ra)
          assets.push(ra)
          putAssetBytes(rid, rpng)
        }
      }
      img.sourceAssetId = rid
      img.contentOffset = { x: raw.left - r.left, y: raw.top - r.top }
      if ((layer.fillOpacity ?? 1) < 1) img.fillOpacity = layer.fillOpacity
      if (layer.effects && hasEnabledEffects(layer.effects)) {
        img.effects = JSON.parse(JSON.stringify(layer.effects)) as LayerEffectsInfo
        await savePatterns(layer.effects)
      }
    }
    img.visible = !layer.hidden && !forceHidden
    img.opacity = layer.opacity ?? 1
    const bm = BLEND_MAP[(layer.blendMode ?? 'normal').toLowerCase()]
    if (bm && bm !== 'normal') img.blendMode = bm
    const meta: Record<string, unknown> = { psdPath: path, ...extraMeta }
    const textMeta = extractTextMeta(layer)
    if (textMeta) meta.psdText = textMeta
    if (layer.clipping) meta.psdClipping = true
    if (layer.effects && hasEnabledEffects(layer.effects))
      meta.psdEffects = Object.keys(layer.effects).filter((k) => {
        const v = (layer.effects as Record<string, unknown>)[k]
        const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []
        return (arr as { enabled?: boolean }[]).some((e) => e?.enabled)
      })
    img.meta = meta
    out.push(img)
  }

  const processList = async (layers: Layer[], out: SceneNode[], pathPrefix: string): Promise<void> => {
    let clipBase: RenderedLayer | null = null
    for (const layer of layers) {
      const name = layer.name || 'Layer'
      const path = pathPrefix ? `${pathPrefix}/${name}` : name
      done++
      opts.onProgress?.(done, total, name)
      if (layer.children) {
        const styled = applyEffects && layer.effects && hasEnabledEffects(layer.effects)
        if (styled && flattenStyledGroups) {
          done += countLayers(layer.children)
          const r = compositeGroup(layer, path)
          if (r) {
            await addImageNode(name, r, layer, path, out, { psdFlattenedGroup: true })
            infos.push(`Group có layer style, gộp thành 1 ảnh: ${path}`)
          }
          clipBase = null
          continue
        }
        const g: GroupNode = createGroup(name, 0, 0, 0, 0)
        if (styled) {
          g.effects = JSON.parse(JSON.stringify(layer.effects)) as LayerEffectsInfo
          await savePatterns(layer.effects!)
        }
        g.visible = !layer.hidden
        g.opacity = layer.opacity ?? 1
        g.meta = { psdPath: path }
        const bm = BLEND_MAP[(layer.blendMode ?? 'normal').toLowerCase()]
        if (bm && bm !== 'normal') g.blendMode = bm
        await processList(layer.children, g.children, path)
        if (styled) {
          // keep children editable; the group's layer style becomes two image layers (below / above)
          const comp = compositeGroup({ ...layer, effects: undefined, mask: undefined }, path)
          if (comp) {
            const below = applyLayerEffects(comp, layer.effects!, globalAngle, (m) => warnings.push(`${path}: ${m}`), psd.patterns, { part: 'below' })
            const above = applyLayerEffects(comp, layer.effects!, globalAngle, (m) => warnings.push(`${path}: ${m}`), psd.patterns, { part: 'above' })
            const fake = { ...layer, hidden: layer.hidden, opacity: 1 } as Layer
            if (!isBlank(below.canvas)) {
              await addImageNode(`${name} (style below)`, below, fake, `${path} (style below)`, g.children, { psdGroupStyle: 'below' })
              g.children.unshift(g.children.pop()!)
            }
            if (!isBlank(above.canvas)) await addImageNode(`${name} (style above)`, above, fake, `${path} (style above)`, g.children, { psdGroupStyle: 'above' })
          }
        }
        if (g.children.length === 0) {
          infos.push(`Group rỗng bỏ qua: ${path}`)
          continue
        }
        fitGroup(g)
        out.push(g)
        clipBase = null
        continue
      }
      if (layer.adjustment) {
        if (!supportedAdjustment(layer.adjustment)) warnings.push(`Adjustment "${layer.adjustment.type}" chưa hỗ trợ, bỏ qua: ${path}`)
        else if (!layer.hidden) infos.push(`Adjustment ${layer.adjustment.type} đã áp vào layer bên dưới: ${path}`)
        continue
      }
      const r = renderLayer(layer, clipBase, path)
      if (!layer.clipping) clipBase = r
      // live text
      if (layer.text && textMode !== 'raster') {
        const tn = buildTextNode(layer, name, missingFonts, (m) => warnings.push(`${path}: ${m}`))
        if (tn) {
          tn.meta = { psdPath: path, psdText: extractTextMeta(layer) }
          if (layer.effects && hasEnabledEffects(layer.effects)) {
            tn.effects = JSON.parse(JSON.stringify(layer.effects)) as LayerEffectsInfo
            await savePatterns(layer.effects)
          }
          if (r && textMode === 'both') {
            await addImageNode(`${name} (raster)`, r, layer, path, out, { psdTextRaster: true }, true)
          }
          out.push(tn)
          continue
        }
      }
      if (!r) {
        infos.push(`Layer trống bỏ qua: ${path}`)
        continue
      }
      await addImageNode(name, r, layer, path, out)
    }
  }

  const frames: FrameNode[] = []
  const children = psd.children ?? []

  if (opts.mode === 'split' && children.length) {
    const wanted = new Set(opts.groupIndexes ?? children.map((c, i) => (c.children ? i : -1)).filter((i) => i >= 0))
    const loose = opts.includeLooseLayers ?? true
    for (const gi of Array.from(wanted).sort((a, b) => a - b)) {
      const group = children[gi]
      if (!group) continue
      const frame = createFrame(group.name || `Screen ${gi + 1}`, 0, 0, psd.width, psd.height)
      frame.meta = { source: `psd:${baseName}.psd/${group.name}`, psdWidth: psd.width, psdHeight: psd.height, psdGroupIndex: gi }
      // synthetic layer list: loose layers stay in z-order, the chosen group's children are hoisted
      const list: Layer[] = []
      for (const c of children) {
        if (c === group) {
          if (group.children) list.push(...group.children)
          else list.push(c)
        } else if (loose && !c.children && (!c.hidden || opts.includeHiddenLoose)) list.push(c)
      }
      await processList(list, frame.children, '')
      frames.push(frame)
    }
    if (!frames.length) warnings.push('Không có group nào được chọn, không tạo frame nào.')
  } else {
    const frame = createFrame(baseName, 0, 0, psd.width, psd.height)
    frame.meta = { source: `psd:${baseName}.psd`, psdWidth: psd.width, psdHeight: psd.height }
    if (children.length) {
      await processList(children, frame.children, '')
    } else if (psd.canvas) {
      warnings.push('PSD không có layer (có thể đã flatten). Import dưới dạng 1 ảnh.')
      const png = await pngFromCanvas(psd.canvas as HTMLCanvasElement)
      const hash = await sha256Hex(png)
      const id = hash.slice(0, 16)
      const asset: Asset = { id, file: `${safeFileName(baseName)}_${id.slice(0, 8)}.png`, width: psd.width, height: psd.height, source: `psd:${baseName}.psd` }
      assets.push(asset)
      putAssetBytes(id, png)
      frame.children.push(createImage(baseName, 0, 0, psd.width, psd.height, id))
    }
    frames.push(frame)
  }

  // dedupe (split mode repeats loose-layer warnings per frame)
  const seen = new Set<string>()
  const unique = warnings.filter((w) => (seen.has(w) ? false : (seen.add(w), true)))
  warnings.length = 0
  warnings.push(...unique)
  if (missingFonts.size) warnings.unshift(`Font chưa cài trên máy (text sẽ hiện bằng Arial): ${Array.from(missingFonts).join(', ')}`)
  const seenI = new Set<string>()
  return { frames, assets, patterns: patternDefs, globalAngle, warnings, infos: infos.filter((w) => (seenI.has(w) ? false : (seenI.add(w), true))), missingFonts: Array.from(missingFonts), layerCount: total }
}

/** Convenience: parse + build with default options (whole PSD → one frame). */
export async function importPsd(fileName: string, data: Uint8Array, opts: Partial<BuildOptions> = {}): Promise<PsdImportResult> {
  const parsed = parsePsd(fileName, data)
  return buildFromPsd(parsed, { mode: 'single', ...opts })
}
