// Photoshop adjustment layers applied per pixel to a rendered layer canvas.
// The importer applies an adjustment to every layer below it (or to its clipping base),
// optionally weighted by the adjustment layer's own mask.
import type { AdjustmentLayer } from 'ag-psd'

type RGB = { r: number; g: number; b: number }

function mk(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, w)
  c.height = Math.max(1, h)
  return c
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

/** Builds a 256-entry LUT from Photoshop curve points (input/output 0..255), linear interpolation. */
function curveLut(points: { input: number; output: number }[] | undefined): Uint8ClampedArray | null {
  if (!points || points.length < 2) return null
  const pts = points.slice().sort((a, b) => a.input - b.input)
  const lut = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    if (i <= pts[0].input) {
      lut[i] = pts[0].output
      continue
    }
    if (i >= pts[pts.length - 1].input) {
      lut[i] = pts[pts.length - 1].output
      continue
    }
    for (let k = 1; k < pts.length; k++) {
      if (i <= pts[k].input) {
        const a = pts[k - 1]
        const b = pts[k]
        const t = (i - a.input) / Math.max(1, b.input - a.input)
        lut[i] = a.output + (b.output - a.output) * t
        break
      }
    }
  }
  return lut
}

function levelsLut(ch: { shadowInput: number; highlightInput: number; shadowOutput: number; highlightOutput: number; midtoneInput: number } | undefined): Uint8ClampedArray | null {
  if (!ch) return null
  const lut = new Uint8ClampedArray(256)
  const gamma = ch.midtoneInput || 1
  for (let i = 0; i < 256; i++) {
    let v = (i - ch.shadowInput) / Math.max(1, ch.highlightInput - ch.shadowInput)
    v = Math.max(0, Math.min(1, v))
    v = Math.pow(v, 1 / gamma)
    lut[i] = ch.shadowOutput + v * (ch.highlightOutput - ch.shadowOutput)
  }
  return lut
}

function gradientLut(adj: { colorStops?: { color: RGB; location: number }[]; reverse?: boolean }): [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] | null {
  const stops = (adj.colorStops ?? []).slice().sort((a, b) => a.location - b.location)
  if (!stops.length) return null
  const R = new Uint8ClampedArray(256)
  const G = new Uint8ClampedArray(256)
  const B = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    let t = i / 255
    if (adj.reverse) t = 1 - t
    const loc = t * 4096
    let c: RGB
    if (loc <= stops[0].location) c = stops[0].color
    else if (loc >= stops[stops.length - 1].location) c = stops[stops.length - 1].color
    else {
      c = stops[stops.length - 1].color
      for (let k = 1; k < stops.length; k++) {
        if (loc <= stops[k].location) {
          const a = stops[k - 1]
          const b = stops[k]
          const f = (loc - a.location) / Math.max(1, b.location - a.location)
          c = { r: a.color.r + (b.color.r - a.color.r) * f, g: a.color.g + (b.color.g - a.color.g) * f, b: a.color.b + (b.color.b - a.color.b) * f }
          break
        }
      }
    }
    R[i] = c.r
    G[i] = c.g
    B[i] = c.b
  }
  return [R, G, B]
}

export function supportedAdjustment(adj: AdjustmentLayer): boolean {
  return ['hue/saturation', 'gradient map', 'brightness/contrast', 'levels', 'curves', 'invert', 'posterize', 'threshold', 'black & white', 'photo filter', 'exposure', 'vibrance', 'color balance', 'channel mixer'].includes(adj.type)
}

/**
 * Returns a new canvas = adjustment applied to `src`. `weight` (optional, same size as src)
 * is an alpha canvas: 255 = full effect, 0 = untouched (from the adjustment layer's mask).
 */
export function applyAdjustment(src: HTMLCanvasElement, adj: AdjustmentLayer, weight: HTMLCanvasElement | null): HTMLCanvasElement {
  const w = src.width
  const h = src.height
  const out = mk(w, h)
  const ctx = out.getContext('2d')!
  ctx.drawImage(src, 0, 0)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const wd = weight ? weight.getContext('2d')!.getImageData(0, 0, w, h).data : null

  // precompute per-type tables
  let lutR: Uint8ClampedArray | null = null
  let lutG: Uint8ClampedArray | null = null
  let lutB: Uint8ClampedArray | null = null
  let perPixel: ((r: number, g: number, b: number) => [number, number, number]) | null = null

  switch (adj.type) {
    case 'levels': {
      const master = levelsLut(adj.rgb)
      const r = levelsLut(adj.red)
      const g = levelsLut(adj.green)
      const b = levelsLut(adj.blue)
      const combine = (ch: Uint8ClampedArray | null): Uint8ClampedArray | null => {
        if (!master && !ch) return null
        const lut = new Uint8ClampedArray(256)
        for (let i = 0; i < 256; i++) {
          let v = i
          if (ch) v = ch[v]
          if (master) v = master[v]
          lut[i] = v
        }
        return lut
      }
      lutR = combine(r)
      lutG = combine(g)
      lutB = combine(b)
      break
    }
    case 'curves': {
      const master = curveLut(adj.rgb)
      const r = curveLut(adj.red)
      const g = curveLut(adj.green)
      const b = curveLut(adj.blue)
      const combine = (ch: Uint8ClampedArray | null): Uint8ClampedArray | null => {
        if (!master && !ch) return null
        const lut = new Uint8ClampedArray(256)
        for (let i = 0; i < 256; i++) {
          let v = i
          if (ch) v = ch[v]
          if (master) v = master[v]
          lut[i] = v
        }
        return lut
      }
      lutR = combine(r)
      lutG = combine(g)
      lutB = combine(b)
      break
    }
    case 'brightness/contrast': {
      const br = adj.brightness ?? 0
      const ct = adj.contrast ?? 0
      const lut = new Uint8ClampedArray(256)
      const f = ct >= 0 ? 1 + ct / 100 : 1 + ct / 100
      for (let i = 0; i < 256; i++) {
        let v = i + br
        v = (v - 128) * (ct >= 0 ? 1 + ct / 50 : f) + 128
        lut[i] = clamp(v)
      }
      lutR = lutG = lutB = lut
      break
    }
    case 'exposure': {
      const ex = adj.exposure ?? 0
      const off = adj.offset ?? 0
      const gm = adj.gamma ?? 1
      const lut = new Uint8ClampedArray(256)
      for (let i = 0; i < 256; i++) {
        let v = (i / 255) * Math.pow(2, ex) + off
        v = Math.pow(Math.max(0, v), 1 / (gm || 1))
        lut[i] = clamp(v * 255)
      }
      lutR = lutG = lutB = lut
      break
    }
    case 'invert': {
      const lut = new Uint8ClampedArray(256)
      for (let i = 0; i < 256; i++) lut[i] = 255 - i
      lutR = lutG = lutB = lut
      break
    }
    case 'posterize': {
      const levels = Math.max(2, adj.levels ?? 4)
      const lut = new Uint8ClampedArray(256)
      for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.floor((i / 255) * levels) / (levels - 1) * 255)
      lutR = lutG = lutB = lut
      break
    }
    case 'threshold': {
      const level = adj.level ?? 128
      perPixel = (r, g, b) => {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b
        const v = lum >= level ? 255 : 0
        return [v, v, v]
      }
      break
    }
    case 'gradient map': {
      const lut = gradientLut(adj as { colorStops?: { color: RGB; location: number }[]; reverse?: boolean })
      if (lut) {
        perPixel = (r, g, b) => {
          const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
          return [lut[0][lum], lut[1][lum], lut[2][lum]]
        }
      }
      break
    }
    case 'hue/saturation': {
      const m = adj.master
      if (m) {
        const hueShift = (m.hue ?? 0) / 360
        const sat = (m.saturation ?? 0) / 100
        const light = (m.lightness ?? 0) / 100
        const colorize = 'colorize' in adj && !!(adj as { colorize?: boolean }).colorize
        perPixel = (r, g, b) => {
          const [hh, ss, ll] = rgbToHsl(r, g, b)
          let h2 = hh
          let s2 = ss
          let l2 = ll
          if (colorize) {
            h2 = (((m.hue ?? 0) % 360) + 360) / 360
            s2 = Math.abs(sat)
          } else {
            h2 = (hh + hueShift + 1) % 1
            s2 = sat >= 0 ? ss + (1 - ss) * sat : ss * (1 + sat)
          }
          l2 = light >= 0 ? ll + (1 - ll) * light : ll * (1 + light)
          return hslToRgb(h2, Math.max(0, Math.min(1, s2)), Math.max(0, Math.min(1, l2)))
        }
      }
      break
    }
    case 'vibrance': {
      const vib = (adj.vibrance ?? 0) / 100
      const sat = (adj.saturation ?? 0) / 100
      perPixel = (r, g, b) => {
        const [hh, ss, ll] = rgbToHsl(r, g, b)
        let s2 = ss + (1 - ss) * vib * (1 - ss) + (sat >= 0 ? (1 - ss) * sat : ss * sat)
        s2 = Math.max(0, Math.min(1, s2))
        return hslToRgb(hh, s2, ll)
      }
      break
    }
    case 'black & white': {
      const wR = (adj.reds ?? 40) / 100
      const wY = (adj.yellows ?? 60) / 100
      const wG = (adj.greens ?? 40) / 100
      const wC = (adj.cyans ?? 60) / 100
      const wB = (adj.blues ?? 20) / 100
      const wM = (adj.magentas ?? 80) / 100
      const tint = adj.useTint && adj.tintColor ? (adj.tintColor as RGB) : null
      perPixel = (r, g, b) => {
        // Photoshop-like: weight by hue sectors (approximation)
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        let v: number
        if (max === min) v = max
        else {
          const [hh] = rgbToHsl(r, g, b)
          const sector = hh * 6
          const weights = [wR, wY, wG, wC, wB, wM]
          const i0 = Math.floor(sector) % 6
          const i1 = (i0 + 1) % 6
          const t = sector - Math.floor(sector)
          const wgt = weights[i0] * (1 - t) + weights[i1] * t
          v = min + (max - min) * wgt
        }
        v = clamp(v)
        if (tint) return [(v * tint.r) / 255 + (255 - v) * 0, (v * tint.g) / 255, (v * tint.b) / 255].map((x) => clamp(x + v * 0.0)) as [number, number, number]
        return [v, v, v]
      }
      break
    }
    case 'photo filter': {
      const c = (adj.color as RGB | undefined) ?? { r: 236, g: 138, b: 0 }
      const dens = (adj.density ?? 25) / 100
      const preserve = adj.preserveLuminosity !== false
      perPixel = (r, g, b) => {
        let r2 = r + (c.r - r) * dens * (r / 255)
        let g2 = g + (c.g - g) * dens * (g / 255)
        let b2 = b + (c.b - b) * dens * (b / 255)
        // multiply-style filter
        r2 = r * (1 - dens) + (r * c.r) / 255 * dens
        g2 = g * (1 - dens) + (g * c.g) / 255 * dens
        b2 = b * (1 - dens) + (b * c.b) / 255 * dens
        if (preserve) {
          const l0 = 0.299 * r + 0.587 * g + 0.114 * b
          const l1 = 0.299 * r2 + 0.587 * g2 + 0.114 * b2 || 1
          const k = l0 / l1
          r2 *= k
          g2 *= k
          b2 *= k
        }
        return [clamp(r2), clamp(g2), clamp(b2)]
      }
      break
    }
    case 'color balance': {
      const mid = adj.midtones ?? { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }
      const sh = adj.shadows ?? { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }
      const hi = adj.highlights ?? { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }
      perPixel = (r, g, b) => {
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        const ws = Math.max(0, 1 - lum * 2)
        const wh = Math.max(0, lum * 2 - 1)
        const wm = 1 - ws - wh
        const k = 0.6
        const dr = (sh.cyanRed * ws + mid.cyanRed * wm + hi.cyanRed * wh) * k
        const dg = (sh.magentaGreen * ws + mid.magentaGreen * wm + hi.magentaGreen * wh) * k
        const db = (sh.yellowBlue * ws + mid.yellowBlue * wm + hi.yellowBlue * wh) * k
        return [clamp(r + dr), clamp(g + dg), clamp(b + db)]
      }
      break
    }
    case 'channel mixer': {
      const cm = adj as { red?: { red: number; green: number; blue: number; constant: number }; green?: { red: number; green: number; blue: number; constant: number }; blue?: { red: number; green: number; blue: number; constant: number }; monochrome?: boolean; gray?: { red: number; green: number; blue: number; constant: number } }
      const mix = (ch: { red: number; green: number; blue: number; constant: number } | undefined, r: number, g: number, b: number, def: number): number =>
        ch ? clamp((r * ch.red + g * ch.green + b * ch.blue) / 100 + (ch.constant / 100) * 255) : def
      perPixel = (r, g, b) => {
        if (cm.monochrome && cm.gray) {
          const v = mix(cm.gray, r, g, b, r)
          return [v, v, v]
        }
        return [mix(cm.red, r, g, b, r), mix(cm.green, r, g, b, g), mix(cm.blue, r, g, b, b)]
      }
      break
    }
    default:
      return src
  }

  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]
    if (a === 0) continue
    const r = d[i]
    const g = d[i + 1]
    const b = d[i + 2]
    let nr = r
    let ng = g
    let nb = b
    if (perPixel) {
      const o = perPixel(r, g, b)
      nr = o[0]
      ng = o[1]
      nb = o[2]
    } else {
      if (lutR) nr = lutR[r]
      if (lutG) ng = lutG[g]
      if (lutB) nb = lutB[b]
    }
    if (wd) {
      const t = wd[i + 3] / 255
      nr = r + (nr - r) * t
      ng = g + (ng - g) * t
      nb = b + (nb - b) * t
    }
    d[i] = nr
    d[i + 1] = ng
    d[i + 2] = nb
  }
  ctx.putImageData(img, 0, 0)
  return out
}
