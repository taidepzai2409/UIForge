// Rasterizes Photoshop layer styles (effects) onto a layer canvas using Canvas2D.
// Supported: drop shadow, outer glow, inner shadow, inner glow, color overlay,
// gradient overlay (linear/radial), stroke (outside/inside/center, solid color).
// Approximations: gaussian blur via CSS filter, dilation via iterative max, no contours/noise.
import type { LayerEffectsInfo, PatternInfo } from 'ag-psd'

export interface RenderedLayer {
  canvas: HTMLCanvasElement
  left: number
  top: number
}

type RGB = { r: number; g: number; b: number }
type Units = { value: number; units?: string } | undefined

const px = (u: Units, def = 0): number => (u && typeof u.value === 'number' ? u.value : def)
const css = (c: RGB | undefined, a: number): string =>
  `rgba(${Math.round(c?.r ?? 0)},${Math.round(c?.g ?? 0)},${Math.round(c?.b ?? 0)},${Math.max(0, Math.min(1, a))})`

const BLEND_OPS: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'hard light': 'hard-light',
  'soft light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  'linear dodge': 'lighter'
}

function mk(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w))
  c.height = Math.max(1, Math.ceil(h))
  return c
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext('2d')!
}

/** Returns true if the layer has any enabled effect. */
export function hasEnabledEffects(fx: LayerEffectsInfo | undefined): boolean {
  if (!fx || fx.disabled) return false
  return listEnabled(fx).length > 0
}

type Enabled = { kind: string; e: Record<string, unknown> }

function listEnabled(fx: LayerEffectsInfo): Enabled[] {
  const out: Enabled[] = []
  for (const [kind, v] of Object.entries(fx)) {
    if (kind === 'disabled' || kind === 'scale') continue
    const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []
    for (const e of arr as Record<string, unknown>[]) if (e && e.enabled) out.push({ kind, e })
  }
  return out
}

/** Copies only the alpha of src as a solid color (source-in). */
function tint(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const c = mk(src.width, src.height)
  const g = ctx2d(c)
  g.drawImage(src, 0, 0)
  g.globalCompositeOperation = 'source-in'
  g.fillStyle = color
  g.fillRect(0, 0, c.width, c.height)
  return c
}

function invert(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = mk(src.width, src.height)
  const g = ctx2d(c)
  g.fillStyle = '#000'
  g.fillRect(0, 0, c.width, c.height)
  g.globalCompositeOperation = 'destination-out'
  g.drawImage(src, 0, 0)
  return c
}

/** Morphological dilation by `r` px (alternating 4/8-neighbourhood → roughly circular). */
function dilate(src: HTMLCanvasElement, r: number): HTMLCanvasElement {
  let cur = src
  const steps = Math.round(r)
  for (let i = 0; i < steps; i++) {
    const c = mk(cur.width, cur.height)
    const g = ctx2d(c)
    const offs = i % 2 === 0 ? [[1, 0], [-1, 0], [0, 1], [0, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
    g.drawImage(cur, 0, 0)
    for (const [dx, dy] of offs) g.drawImage(cur, dx, dy)
    cur = c
  }
  return cur
}

function erode(src: HTMLCanvasElement, r: number): HTMLCanvasElement {
  if (r <= 0) return src
  const inv = dilate(invert(src), r)
  const c = mk(src.width, src.height)
  const g = ctx2d(c)
  g.drawImage(src, 0, 0)
  g.globalCompositeOperation = 'destination-out'
  g.drawImage(inv, 0, 0)
  return c
}

function blur(src: HTMLCanvasElement, sigma: number): HTMLCanvasElement {
  if (sigma <= 0.3) return src
  const c = mk(src.width, src.height)
  const g = ctx2d(c)
  g.filter = `blur(${sigma.toFixed(2)}px)`
  g.drawImage(src, 0, 0)
  g.filter = 'none'
  return c
}

function subtract(a: HTMLCanvasElement, b: HTMLCanvasElement): HTMLCanvasElement {
  const c = mk(a.width, a.height)
  const g = ctx2d(c)
  g.drawImage(a, 0, 0)
  g.globalCompositeOperation = 'destination-out'
  g.drawImage(b, 0, 0)
  return c
}

function intersect(a: HTMLCanvasElement, b: HTMLCanvasElement): HTMLCanvasElement {
  const c = mk(a.width, a.height)
  const g = ctx2d(c)
  g.drawImage(a, 0, 0)
  g.globalCompositeOperation = 'destination-in'
  g.drawImage(b, 0, 0)
  return c
}

/** Maps alpha through a Photoshop contour curve (points 0..255). */
function applyContour(src: HTMLCanvasElement, contour: { curve?: { x: number; y: number }[] } | undefined): HTMLCanvasElement {
  const pts = contour?.curve
  if (!pts || pts.length < 2) return src
  // linear contour = identity
  if (pts.length === 2 && pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 255 && pts[1].y === 255) return src
  const sorted = pts.slice().sort((a, b) => a.x - b.x)
  const lut = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    if (i <= sorted[0].x) lut[i] = sorted[0].y
    else if (i >= sorted[sorted.length - 1].x) lut[i] = sorted[sorted.length - 1].y
    else
      for (let k = 1; k < sorted.length; k++) {
        if (i <= sorted[k].x) {
          const a = sorted[k - 1]
          const b = sorted[k]
          lut[i] = a.y + ((b.y - a.y) * (i - a.x)) / Math.max(1, b.x - a.x)
          break
        }
      }
  }
  const c = mk(src.width, src.height)
  const g = ctx2d(c)
  g.drawImage(src, 0, 0)
  const img = g.getImageData(0, 0, c.width, c.height)
  const d = img.data
  for (let i = 3; i < d.length; i += 4) d[i] = lut[d[i]]
  g.putImageData(img, 0, 0)
  return c
}

function patternCanvas(e: Record<string, unknown>, patterns: PatternInfo[] | undefined): HTMLCanvasElement | null {
  const ref = e.pattern as { id?: string; name?: string } | undefined
  const p = patterns?.find((x) => x.id === ref?.id) ?? patterns?.find((x) => x.name === ref?.name)
  if (!p || !p.data || !p.bounds?.w || !p.bounds?.h) return null
  const pw = p.bounds.w
  const ph = p.bounds.h
  if (p.data.length < pw * ph * 4) return null
  const tile = mk(pw, ph)
  const img = ctx2d(tile).createImageData(pw, ph)
  img.data.set(p.data.subarray(0, pw * ph * 4))
  ctx2d(tile).putImageData(img, 0, 0)
  const sc = ((e.scale as number | undefined) ?? 100) / 100
  const scaled = mk(Math.max(1, pw * sc), Math.max(1, ph * sc))
  ctx2d(scaled).drawImage(tile, 0, 0, scaled.width, scaled.height)
  return scaled
}

function shadowOffset(e: Record<string, unknown>, globalAngle: number | undefined): { dx: number; dy: number } {
  const useGlobal = e.useGlobalLight as boolean | undefined
  const angle = (useGlobal && typeof globalAngle === 'number' ? globalAngle : (e.angle as number | undefined)) ?? 120
  const dist = px(e.distance as Units)
  const rad = (angle * Math.PI) / 180
  return { dx: -Math.cos(rad) * dist, dy: Math.sin(rad) * dist }
}

function gradientFill(e: Record<string, unknown>, w: number, h: number): HTMLCanvasElement {
  const c = mk(w, h)
  const g = ctx2d(c)
  const grad = e.gradient as { colorStops?: { color: RGB; location: number }[]; opacityStops?: { opacity: number; location: number }[] } | undefined
  const angle = ((e.angle as number | undefined) ?? 90) * (Math.PI / 180)
  const reverse = !!e.reverse
  const type = (e.type as string | undefined) ?? 'linear'
  let fill: CanvasGradient
  if (type === 'radial') {
    fill = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2)
  } else {
    const cx = w / 2
    const cy = h / 2
    const len = (Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * h) / 2
    const dx = Math.cos(angle) * len
    const dy = -Math.sin(angle) * len
    fill = g.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy)
  }
  const stops = (grad?.colorStops ?? []).slice().sort((a, b) => a.location - b.location)
  const opStops = grad?.opacityStops ?? []
  const opacityAt = (loc: number): number => {
    if (!opStops.length) return 1
    const sorted = opStops.slice().sort((a, b) => a.location - b.location)
    if (loc <= sorted[0].location) return sorted[0].opacity
    for (let i = 1; i < sorted.length; i++) {
      if (loc <= sorted[i].location) {
        const a = sorted[i - 1]
        const b = sorted[i]
        const t = (loc - a.location) / Math.max(1, b.location - a.location)
        return a.opacity + (b.opacity - a.opacity) * t
      }
    }
    return sorted[sorted.length - 1].opacity
  }
  if (!stops.length) {
    fill.addColorStop(0, '#000')
    fill.addColorStop(1, '#fff')
  }
  for (const s of stops) {
    let t = Math.max(0, Math.min(1, s.location / 4096))
    if (reverse) t = 1 - t
    fill.addColorStop(t, css(s.color, opacityAt(s.location)))
  }
  g.fillStyle = fill
  g.fillRect(0, 0, w, h)
  return c
}

/**
 * Applies enabled effects. Returns a new canvas (possibly larger) and its new left/top.
 */
function shift(src: HTMLCanvasElement, dx: number, dy: number): HTMLCanvasElement {
  const c = mk(src.width, src.height)
  ctx2d(c).drawImage(src, dx, dy)
  return c
}

function union(a: HTMLCanvasElement, b: HTMLCanvasElement): HTMLCanvasElement {
  const c = mk(a.width, a.height)
  const g = ctx2d(c)
  g.drawImage(a, 0, 0)
  g.drawImage(b, 0, 0)
  return c
}

function lightVector(e: Record<string, unknown>, globalAngle: number | undefined): { x: number; y: number } {
  const useGlobal = e.useGlobalLight as boolean | undefined
  const angle = (useGlobal && typeof globalAngle === 'number' ? globalAngle : (e.angle as number | undefined)) ?? 120
  const rad = (angle * Math.PI) / 180
  // unit vector pointing TOWARD the light (y down): 120° = upper-left
  return { x: Math.cos(rad), y: -Math.sin(rad) }
}

/** Bevel & Emboss approximation: highlight band on the lit side, shadow band on the far side. */
function drawBevel(og: CanvasRenderingContext2D, mask: HTMLCanvasElement, e: Record<string, unknown>, globalAngle: number | undefined, scale: number): void {
  const size = Math.max(1, px(e.size as Units, 5) * scale)
  const soften = px(e.soften as Units) * scale
  const depth = Math.max(0.1, ((e.strength as number | undefined) ?? 100) / 100)
  const style = ((e.style as string | undefined) ?? 'inner bevel').toLowerCase()
  const down = (e.direction as string | undefined) === 'down'
  const lv = lightVector(e, globalAngle)
  const dx = lv.x * size
  const dy = lv.y * size
  const hiColor = css(e.highlightColor as RGB | undefined ?? { r: 255, g: 255, b: 255 }, 1)
  const shColor = css(e.shadowColor as RGB | undefined ?? { r: 0, g: 0, b: 0 }, 1)
  const hiA = ((e.highlightOpacity as number | undefined) ?? 0.75) * Math.min(1, depth)
  const shA = ((e.shadowOpacity as number | undefined) ?? 0.75) * Math.min(1, depth)
  const inv = invert(mask)
  const blurR = Math.max(0.5, soften + size / 3)
  const inner = style.includes('inner') || style.includes('emboss') || style.includes('stroke')
  const outer = style.includes('outer') || style.includes('emboss')
  const bands: { c: HTMLCanvasElement; color: string; a: number; op: GlobalCompositeOperation }[] = []
  if (inner) {
    // inside the shape: highlight where the shifted outside (toward the far side) overlaps the lit edge
    const hi = intersect(blur(tint(shift(inv, -dx, -dy), '#000'), blurR), mask)
    const sh = intersect(blur(tint(shift(inv, dx, dy), '#000'), blurR), mask)
    bands.push({ c: down ? sh : hi, color: hiColor, a: hiA, op: 'screen' }, { c: down ? hi : sh, color: shColor, a: shA, op: 'multiply' })
  }
  if (outer) {
    const ring = subtract(dilate(mask, size), mask)
    const hi = intersect(blur(tint(shift(mask, dx, dy), '#000'), blurR), ring)
    const sh = intersect(blur(tint(shift(mask, -dx, -dy), '#000'), blurR), ring)
    bands.push({ c: down ? sh : hi, color: hiColor, a: hiA, op: 'source-over' }, { c: down ? hi : sh, color: shColor, a: shA, op: 'source-over' })
  }
  for (const b of bands) {
    og.globalAlpha = b.a
    og.globalCompositeOperation = b.op
    og.drawImage(tint(b.c, b.color), 0, 0)
  }
  og.globalAlpha = 1
  og.globalCompositeOperation = 'source-over'
}

/** Satin approximation: blurred XOR of two offset copies of the shape, clipped to the shape. */
function drawSatin(og: CanvasRenderingContext2D, mask: HTMLCanvasElement, e: Record<string, unknown>, scale: number): void {
  const size = Math.max(1, px(e.size as Units, 14) * scale)
  const dist = px(e.distance as Units, 11) * scale
  const angle = (((e.angle as number | undefined) ?? 19) * Math.PI) / 180
  const dx = Math.cos(angle) * dist
  const dy = -Math.sin(angle) * dist
  const a = shift(mask, dx, dy)
  const b = shift(mask, -dx, -dy)
  let sat = subtract(union(a, b), intersect(a, b))
  sat = blur(sat, size / 2)
  if (e.invert) sat = subtract(mask, sat)
  sat = intersect(sat, mask)
  og.globalAlpha = (e.opacity as number | undefined) ?? 0.5
  og.globalCompositeOperation = ((e.blendMode as string | undefined) ?? 'multiply') === 'multiply' ? 'multiply' : 'source-over'
  og.drawImage(tint(sat, css(e.color as RGB | undefined, 1)), 0, 0)
  og.globalAlpha = 1
  og.globalCompositeOperation = 'source-over'
}

/** Pattern overlay: tiles the PSD pattern (RGBA) across the shape. */
function drawPattern(bg: CanvasRenderingContext2D, w: number, h: number, e: Record<string, unknown>, patterns: PatternInfo[] | undefined, warn: (m: string) => void): void {
  const scaled = patternCanvas(e, patterns)
  if (!scaled) {
    warn('Pattern Overlay: không tìm thấy dữ liệu pattern trong PSD')
    return
  }
  const pat = bg.createPattern(scaled, 'repeat')
  if (!pat) return
  bg.globalAlpha = (e.opacity as number | undefined) ?? 1
  bg.globalCompositeOperation = 'source-atop'
  bg.fillStyle = pat
  bg.fillRect(0, 0, w, h)
  bg.globalAlpha = 1
  bg.globalCompositeOperation = 'source-over'
}

export function applyLayerEffects(
  layer: RenderedLayer,
  fx: LayerEffectsInfo,
  globalAngle: number | undefined,
  warn: (msg: string) => void,
  patterns?: PatternInfo[],
  opts: { fillOpacity?: number; part?: 'all' | 'below' | 'above' } = {}
): RenderedLayer {
  const enabled = listEnabled(fx)
  if (!enabled.length) return layer
  const part = opts.part ?? 'all'
  const fillOpacity = opts.fillOpacity ?? 1
  const hasOverlay = enabled.some((x) => x.kind === 'gradientOverlay' || x.kind === 'solidFill' || x.kind === 'patternOverlay')
  const scale = typeof fx.scale === 'number' ? fx.scale : 1
  const S = (u: Units, def = 0): number => px(u, def) * scale

  // margin needed around the layer
  let margin = 0
  for (const { kind, e } of enabled) {
    if (kind === 'dropShadow') margin = Math.max(margin, px(e.distance as Units) * scale + S(e.size as Units) * 2 + 2)
    if (kind === 'outerGlow') margin = Math.max(margin, S(e.size as Units) * 2 + 2)
    if (kind === 'bevel') {
      const st = ((e.style as string | undefined) ?? 'inner bevel').toLowerCase()
      if (st.includes('outer') || st.includes('emboss')) margin = Math.max(margin, S(e.size as Units, 5) * 2 + 2)
    }
    if (kind === 'stroke') {
      const pos = (e.position as string) ?? 'outside'
      const sz = S(e.size as Units)
      margin = Math.max(margin, pos === 'inside' ? 0 : pos === 'center' ? sz / 2 + 1 : sz + 1)
    }
  }
  margin = Math.ceil(margin)
  const w = layer.canvas.width + margin * 2
  const h = layer.canvas.height + margin * 2

  // base content (padded)
  const content = mk(w, h)
  ctx2d(content).drawImage(layer.canvas, margin, margin)
  const mask = tint(content, '#000')

  const out = mk(w, h)
  const og = ctx2d(out)

  // --- below content: drop shadows, outer glow ---
  if (part !== 'above') {
    for (const { kind, e } of enabled) {
      if (kind !== 'dropShadow') continue
      const { dx, dy } = shadowOffset(e, globalAngle)
      const size = S(e.size as Units)
      const choke = ((e.choke as Units)?.value ?? 0) / 100
      let sh = tint(mask, css(e.color as RGB, 1))
      if (choke > 0 && size > 0) sh = dilate(sh, size * choke)
      sh = blur(sh, (size * (1 - choke)) / 2)
      sh = applyContour(sh, e.contour as { curve?: { x: number; y: number }[] } | undefined)
      og.globalAlpha = (e.opacity as number) ?? 0.75
      og.drawImage(sh, dx, dy)
    }
    for (const { kind, e } of enabled) {
      if (kind !== 'outerGlow') continue
      const size = S(e.size as Units)
      const choke = ((e.choke as Units)?.value ?? 0) / 100
      let gl = tint(mask, css(e.color as RGB, 1))
      if (choke > 0) gl = dilate(gl, size * choke)
      gl = blur(gl, Math.max(0.5, (size * (1 - choke)) / 2))
      gl = applyContour(gl, e.contour as { curve?: { x: number; y: number }[] } | undefined)
      og.globalAlpha = (e.opacity as number) ?? 0.75
      og.drawImage(gl, 0, 0)
      og.drawImage(gl, 0, 0) // softer glow needs two passes to reach PS intensity
    }
    og.globalAlpha = 1
  }
  if (part === 'below') return { canvas: out, left: layer.left - margin, top: layer.top - margin }

  // --- content with overlays ---
  const body = mk(w, h)
  const bg = ctx2d(body)
  // 'above' part of a group style: only draw the (recoloured) content when an overlay replaces its look
  if (part !== 'above' || hasOverlay) {
    bg.globalAlpha = fillOpacity
    bg.drawImage(content, 0, 0)
    bg.globalAlpha = 1
  }
  for (const { kind, e } of enabled) {
    if (kind === 'patternOverlay') drawPattern(bg, w, h, e, patterns, warn)
  }
  const overlayWithBlend = (paint: HTMLCanvasElement, alpha: number, blend: string | undefined): void => {
    const op = BLEND_OPS[(blend ?? 'normal').toLowerCase()] ?? 'source-over'
    if (op === 'source-over') {
      bg.globalAlpha = alpha
      bg.globalCompositeOperation = 'source-atop'
      bg.drawImage(paint, 0, 0)
    } else {
      // blend onto a copy of the body, then clip back to the body's alpha
      const tmp = mk(w, h)
      const tg = ctx2d(tmp)
      tg.drawImage(body, 0, 0)
      tg.globalAlpha = alpha
      tg.globalCompositeOperation = op
      tg.drawImage(paint, 0, 0)
      tg.globalAlpha = 1
      tg.globalCompositeOperation = 'destination-in'
      tg.drawImage(body, 0, 0)
      bg.globalAlpha = 1
      bg.globalCompositeOperation = 'source-over'
      bg.clearRect(0, 0, w, h)
      bg.drawImage(tmp, 0, 0)
    }
    bg.globalAlpha = 1
    bg.globalCompositeOperation = 'source-over'
  }
  for (const { kind, e } of enabled) {
    if (kind === 'gradientOverlay') overlayWithBlend(gradientFill(e, w, h), (e.opacity as number) ?? 1, e.blendMode as string | undefined)
  }
  for (const { kind, e } of enabled) {
    if (kind === 'solidFill') {
      const paint = mk(w, h)
      const pg = ctx2d(paint)
      pg.fillStyle = css(e.color as RGB, 1)
      pg.fillRect(0, 0, w, h)
      overlayWithBlend(paint, (e.opacity as number) ?? 1, e.blendMode as string | undefined)
    }
  }
  bg.globalAlpha = 1
  bg.globalCompositeOperation = 'source-over'
  og.drawImage(body, 0, 0)

  // --- inner glow / inner shadow (clipped to shape) ---
  for (const { kind, e } of enabled) {
    if (kind !== 'innerGlow') continue
    const size = S(e.size as Units)
    let ig = tint(invert(mask), css(e.color as RGB, 1))
    ig = blur(ig, Math.max(0.5, size / 2))
    ig = applyContour(ig, e.contour as { curve?: { x: number; y: number }[] } | undefined)
    ig = intersect(ig, mask)
    og.globalAlpha = (e.opacity as number) ?? 0.75
    og.drawImage(ig, 0, 0)
    og.drawImage(ig, 0, 0)
  }
  for (const { kind, e } of enabled) {
    if (kind !== 'innerShadow') continue
    const { dx, dy } = shadowOffset(e, globalAngle)
    const size = S(e.size as Units)
    const choke = ((e.choke as Units)?.value ?? 0) / 100
    const inv = invert(mask)
    const shifted = mk(w, h)
    ctx2d(shifted).drawImage(inv, dx, dy)
    let sh = tint(shifted, css(e.color as RGB, 1))
    if (choke > 0 && size > 0) sh = dilate(sh, size * choke)
    sh = blur(sh, (size * (1 - choke)) / 2)
    sh = applyContour(sh, e.contour as { curve?: { x: number; y: number }[] } | undefined)
    sh = intersect(sh, mask)
    og.globalAlpha = (e.opacity as number) ?? 0.75
    og.drawImage(sh, 0, 0)
  }
  og.globalAlpha = 1

  // --- satin, bevel (clipped to shape) ---
  for (const { kind, e } of enabled) if (kind === 'satin') drawSatin(og, mask, e, scale)
  for (const { kind, e } of enabled) if (kind === 'bevel') drawBevel(og, mask, e, globalAngle, scale)

  // --- strokes on top ---
  for (const { kind, e } of enabled) {
    if (kind !== 'stroke') continue
    const size = S(e.size as Units, 1)
    const pos = (e.position as string) ?? 'outside'
    let ring: HTMLCanvasElement
    if (pos === 'inside') ring = subtract(mask, erode(mask, size))
    else if (pos === 'center') ring = subtract(dilate(mask, size / 2), erode(mask, size / 2))
    else ring = subtract(dilate(mask, size), mask)
    const fillType = (e.fillType as string) ?? 'color'
    let colored: HTMLCanvasElement
    if (fillType === 'gradient') {
      colored = intersect(gradientFill(e, w, h), ring)
    } else if (fillType === 'pattern') {
      const tile = patternCanvas(e, patterns)
      if (tile) {
        const pc = mk(w, h)
        const pg = ctx2d(pc)
        const pat = pg.createPattern(tile, 'repeat')
        if (pat) {
          pg.fillStyle = pat
          pg.fillRect(0, 0, w, h)
        }
        colored = intersect(pc, ring)
      } else {
        warn('Stroke pattern: không tìm thấy pattern, dùng màu đơn')
        colored = tint(ring, css(e.color as RGB, 1))
      }
    } else {
      colored = tint(ring, css(e.color as RGB, 1))
    }
    og.globalAlpha = (e.opacity as number) ?? 1
    og.drawImage(colored, 0, 0)
  }
  og.globalAlpha = 1

  for (const { kind, e } of enabled) {
    if (kind === 'bevel' && e.useTexture) warn('Bevel: mục Texture chưa hỗ trợ')
  }

  return { canvas: out, left: layer.left - margin, top: layer.top - margin }
}
