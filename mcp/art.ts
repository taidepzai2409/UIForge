// Image operations for the art CLI (Node only, no DOM): decode PNG/JPG, cut a flat white background,
// drop specks (the ✦ watermark of Google Flow), trim, resample to exact pixels, check 9-slice frames,
// contact sheets. Pixels are RGBA with straight (non-premultiplied) alpha.
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'

export interface Img {
  width: number
  height: number
  data: Uint8Array
}

export function blank(width: number, height: number): Img {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

export function readImage(path: string): Img {
  const buf = readFileSync(path)
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const p = PNG.sync.read(buf)
    return { width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength) }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 })
    return { width: j.width, height: j.height, data: j.data }
  }
  throw new Error(`không đọc được ảnh (chỉ PNG / JPG): ${path}`)
}

export function writePng(path: string, img: Img): void {
  const p = new PNG({ width: img.width, height: img.height })
  p.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength)
  writeFileSync(path, PNG.sync.write(p))
}

export function isOpaque(img: Img): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 250) return false
  return true
}

/** distance from white: 0 = white, 255 = a fully saturated / dark colour */
const whiteness = (d: Uint8Array, i: number): number => 255 - Math.min(d[i], d[i + 1], d[i + 2])

/**
 * Cuts the background connected to the image border when it is (near) white or a light vignette: the
 * threshold follows the border's own colours. Edge pixels become partly transparent and lose the white
 * they were blended with.
 */
export function cutWhiteBackground(img: Img): { cut: number; tolerance: number } {
  const { width: w, height: h, data: d } = img
  const border: number[] = []
  for (let x = 0; x < w; x++) border.push(whiteness(d, x * 4), whiteness(d, ((h - 1) * w + x) * 4))
  for (let y = 0; y < h; y++) border.push(whiteness(d, y * w * 4), whiteness(d, (y * w + w - 1) * 4))
  border.sort((a, b) => a - b)
  const p95 = border[Math.floor(border.length * 0.95)]
  const tol = Math.min(60, Math.max(14, p95 + 8))
  const soft = 40
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (p: number): void => {
    if (seen[p]) return
    if (whiteness(d, p * 4) > tol + soft) return
    seen[p] = 1
    stack.push(p)
  }
  for (let x = 0; x < w; x++) push(x), push((h - 1) * w + x)
  for (let y = 0; y < h; y++) push(y * w), push(y * w + w - 1)
  let cut = 0
  while (stack.length) {
    const p = stack.pop()!
    const i = p * 4
    const dist = whiteness(d, i)
    const a = dist <= tol ? 0 : Math.min(1, (dist - tol) / soft)
    if (a === 0) {
      d[i + 3] = 0
      cut++
    } else {
      // un-blend from white so edges keep their colour instead of a light fringe
      for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, Math.round((d[i + k] - 255 * (1 - a)) / a)))
      d[i + 3] = Math.round(a * d[i + 3])
    }
    // only grow through background-ish pixels (keep going past a soft edge, stop at the object)
    if (dist > tol) continue
    const x = p % w
    if (x > 0) push(p - 1)
    if (x < w - 1) push(p + 1)
    if (p >= w) push(p - w)
    if (p < w * (h - 1)) push(p + w)
  }
  return { cut, tolerance: tol }
}

/** Removes small separate blobs (watermark, dust): keeps components ≥ 1 % of the biggest one. */
export function removeSpecks(img: Img, alphaMin = 24): number {
  const { width: w, height: h, data: d } = img
  const label = new Int32Array(w * h).fill(-1)
  const sizes: number[] = []
  const stack: number[] = []
  for (let p = 0; p < w * h; p++) {
    if (label[p] >= 0 || d[p * 4 + 3] < alphaMin) continue
    const id = sizes.length
    let n = 0
    label[p] = id
    stack.push(p)
    while (stack.length) {
      const q = stack.pop()!
      n++
      const x = q % w
      const y = (q - x) / w
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const r = ny * w + nx
          if (label[r] >= 0 || d[r * 4 + 3] < alphaMin) continue
          label[r] = id
          stack.push(r)
        }
    }
    sizes.push(n)
  }
  if (sizes.length < 2) return 0
  const keepMin = Math.max(30, Math.max(...sizes) * 0.01)
  for (let p = 0; p < w * h; p++) {
    const l = label[p]
    if (l >= 0 && sizes[l] < keepMin) d[p * 4 + 3] = 0
  }
  return sizes.filter((s) => s < keepMin).length
}

export function alphaBox(img: Img, min = 8): { x: number; y: number; width: number; height: number } | null {
  const { width: w, height: h, data: d } = img
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3] >= min) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

export function crop(img: Img, r: { x: number; y: number; width: number; height: number }): Img {
  const out = blank(r.width, r.height)
  for (let y = 0; y < r.height; y++) {
    const src = ((r.y + y) * img.width + r.x) * 4
    out.data.set(img.data.subarray(src, src + r.width * 4), y * r.width * 4)
  }
  return out
}

/**
 * Resamples to exactly W×H with an area average (downscale) or bilinear (upscale), in premultiplied
 * alpha so transparent pixels never bleed a colour into the edges.
 */
export function resize(img: Img, W: number, H: number): Img {
  const { width: w, height: h, data: s } = img
  const out = blank(W, H)
  const o = out.data
  const sx = w / W
  const sy = h / H
  if (sx >= 1 && sy >= 1) {
    for (let Y = 0; Y < H; Y++) {
      const y0 = Y * sy
      const y1 = y0 + sy
      for (let X = 0; X < W; X++) {
        const x0 = X * sx
        const x1 = x0 + sx
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        let area = 0
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
          const wy = Math.min(y + 1, y1) - Math.max(y, y0)
          for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
            const wgt = wy * (Math.min(x + 1, x1) - Math.max(x, x0))
            const i = (Math.min(h - 1, y) * w + Math.min(w - 1, x)) * 4
            const al = (s[i + 3] / 255) * wgt
            r += s[i] * al
            g += s[i + 1] * al
            b += s[i + 2] * al
            a += al
            area += wgt
          }
        }
        const j = (Y * W + X) * 4
        if (a > 0) {
          o[j] = Math.round(r / a)
          o[j + 1] = Math.round(g / a)
          o[j + 2] = Math.round(b / a)
        }
        o[j + 3] = Math.round((a / area) * 255)
      }
    }
    return out
  }
  for (let Y = 0; Y < H; Y++) {
    const fy = Math.max(0, Math.min(h - 1, (Y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(h - 1, y0 + 1)
    const ty = fy - y0
    for (let X = 0; X < W; X++) {
      const fx = Math.max(0, Math.min(w - 1, (X + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(w - 1, x0 + 1)
      const tx = fx - x0
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (const [xx, yy, wgt] of [
        [x0, y0, (1 - tx) * (1 - ty)],
        [x1, y0, tx * (1 - ty)],
        [x0, y1, (1 - tx) * ty],
        [x1, y1, tx * ty]
      ]) {
        const i = (yy * w + xx) * 4
        const al = (s[i + 3] / 255) * wgt
        r += s[i] * al
        g += s[i + 1] * al
        b += s[i + 2] * al
        a += al
      }
      const j = (Y * W + X) * 4
      if (a > 0) {
        o[j] = Math.round(r / a)
        o[j + 1] = Math.round(g / a)
        o[j + 2] = Math.round(b / a)
      }
      o[j + 3] = Math.round(a * 255)
    }
  }
  return out
}

/** Draws `src` into `dst` at (x, y) (no blending: dst is transparent there). */
export function blit(dst: Img, src: Img, x: number, y: number): void {
  for (let yy = 0; yy < src.height; yy++) {
    const ty = y + yy
    if (ty < 0 || ty >= dst.height) continue
    for (let xx = 0; xx < src.width; xx++) {
      const tx = x + xx
      if (tx < 0 || tx >= dst.width) continue
      const i = (yy * src.width + xx) * 4
      const j = (ty * dst.width + tx) * 4
      const a = src.data[i + 3] / 255
      const b = dst.data[j + 3] / 255
      const oa = a + b * (1 - a)
      if (oa <= 0) continue
      for (let k = 0; k < 3; k++) dst.data[j + k] = Math.round((src.data[i + k] * a + dst.data[j + k] * b * (1 - a)) / oa)
      dst.data[j + 3] = Math.round(oa * 255)
    }
  }
}

export interface NineSliceCheck {
  ok: boolean
  /** mean colour change along the stretched direction in the centre bands (0 = perfectly flat) */
  horizontal: number
  vertical: number
  note: string
}

/**
 * A 9-slice frame stretches its centre bands: rows between top/bottom insets must look the same across
 * the centre columns and vice versa, or the art smears when the frame is resized.
 */
export function checkNineSlice(img: Img, ins: { left: number; top: number; right: number; bottom: number }): NineSliceCheck {
  const { width: w, height: h, data: d } = img
  const x0 = Math.max(0, Math.round(ins.left))
  const x1 = Math.min(w, Math.round(w - ins.right))
  const y0 = Math.max(0, Math.round(ins.top))
  const y1 = Math.min(h, Math.round(h - ins.bottom))
  if (x1 - x0 < 2 || y1 - y0 < 2) return { ok: false, horizontal: 0, vertical: 0, note: 'insets lớn hơn ảnh' }
  const px = (x: number, y: number): number[] => {
    const i = (y * w + x) * 4
    const a = d[i + 3] / 255
    return [d[i] * a, d[i + 1] * a, d[i + 2] * a, d[i + 3]]
  }
  const dev = (vals: number[][]): number => {
    const m = [0, 0, 0, 0]
    for (const v of vals) for (let k = 0; k < 4; k++) m[k] += v[k] / vals.length
    let s = 0
    for (const v of vals) s += Math.max(...v.map((c, k) => Math.abs(c - m[k])))
    return s / vals.length
  }
  let hs = 0
  let n = 0
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 48))) {
    const vals: number[][] = []
    for (let x = x0; x < x1; x += Math.max(1, Math.floor((x1 - x0) / 32))) vals.push(px(x, y))
    hs += dev(vals)
    n++
  }
  let vs = 0
  let m = 0
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 48))) {
    const vals: number[][] = []
    for (let y = y0; y < y1; y += Math.max(1, Math.floor((y1 - y0) / 32))) vals.push(px(x, y))
    vs += dev(vals)
    m++
  }
  // only the axes the frame stretches along (insets on that axis); a pill with top = bottom = 0 only
  // stretches horizontally, so its vertical gradient is fine
  const stretchX = ins.left + ins.right > 0
  const stretchY = ins.top + ins.bottom > 0
  const horizontal = stretchX ? Math.round((hs / n) * 10) / 10 : 0
  const vertical = stretchY ? Math.round((vs / m) * 10) / 10 : 0
  const ok = horizontal <= 14 && vertical <= 14
  return { ok, horizontal, vertical, note: ok ? 'phần giữa đủ phẳng để giãn' : 'phần giữa có hoạ tiết / gradient theo chiều giãn → kéo khung sẽ bị nhoè; vẽ phẳng phần giữa hoặc sửa insets' }
}

/**
 * Fit art to a box of another ratio by stretching only its middle band (like a 1-axis 9-slice): scale
 * uniformly to the box's short side, keep both caps (half that side each, so pill ends stay round) and
 * resample the middle along the long axis. Gen tools stop at 16:9, so a 3:1 button comes out too short.
 */
export function sliceFit(img: Img, W: number, H: number): { img: Img; insets: { left: number; top: number; right: number; bottom: number } } | null {
  const wide = W / H >= img.width / img.height
  // work along x; a tall target is the same problem transposed
  const k = wide ? H / img.height : W / img.width
  const sw = Math.max(1, Math.round(img.width * k))
  const sh = Math.max(1, Math.round(img.height * k))
  const scaled = resize(img, sw, sh)
  const out = blank(W, H)
  if (wide) {
    const cap = Math.min(Math.round(H / 2), Math.floor((sw - 2) / 2))
    const mid = W - 2 * cap
    if (cap < 1 || mid < 1) return null
    blit(out, crop(scaled, { x: 0, y: 0, width: cap, height: sh }), 0, 0)
    blit(out, resize(crop(scaled, { x: cap, y: 0, width: sw - 2 * cap, height: sh }), mid, sh), cap, 0)
    blit(out, crop(scaled, { x: sw - cap, y: 0, width: cap, height: sh }), W - cap, 0)
    return { img: out, insets: { left: cap, top: 0, right: cap, bottom: 0 } }
  }
  const cap = Math.min(Math.round(W / 2), Math.floor((sh - 2) / 2))
  const mid = H - 2 * cap
  if (cap < 1 || mid < 1) return null
  blit(out, crop(scaled, { x: 0, y: 0, width: sw, height: cap }), 0, 0)
  blit(out, resize(crop(scaled, { x: 0, y: cap, width: sw, height: sh - 2 * cap }), sw, mid), 0, cap)
  blit(out, crop(scaled, { x: 0, y: sh - cap, width: sw, height: cap }), 0, H - cap)
  return { img: out, insets: { left: 0, top: cap, right: 0, bottom: cap } }
}

// ---------------------------------------------------------------- contact sheet with index numbers
const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111']
}

function fillRect(img: Img, x: number, y: number, w: number, h: number, c: [number, number, number, number]): void {
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++)
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) img.data.set(c, (yy * img.width + xx) * 4)
}

function drawNumber(img: Img, n: number, x: number, y: number, scale = 3): void {
  const s = String(n)
  fillRect(img, x - 2, y - 2, s.length * 4 * scale + 3, 5 * scale + 4, [20, 20, 28, 255])
  s.split('').forEach((ch, k) => {
    const g = DIGITS[ch]
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r][c] === '1') fillRect(img, x + (k * 4 + c) * scale, y + r * scale, scale, scale, [255, 214, 64, 255])
  })
}

/** Grid of thumbnails on a checkerboard, each labelled with its index (1-based). */
export function contactSheet(images: (Img | null)[], cell = 160, cols = 8): Img {
  const pad = 10
  const rows = Math.max(1, Math.ceil(images.length / cols))
  const sheet = blank(cols * (cell + pad) + pad, rows * (cell + pad) + pad)
  fillRect(sheet, 0, 0, sheet.width, sheet.height, [44, 44, 52, 255])
  images.forEach((im, i) => {
    const cx = pad + (i % cols) * (cell + pad)
    const cy = pad + Math.floor(i / cols) * (cell + pad)
    for (let y = 0; y < cell; y += 10) for (let x = 0; x < cell; x += 10) fillRect(sheet, cx + x, cy + y, 10, 10, ((x + y) / 10) % 2 ? [92, 92, 100, 255] : [120, 120, 128, 255])
    if (im && im.width && im.height) {
      const k = Math.min((cell - 8) / im.width, (cell - 8) / im.height, 1)
      const t = resize(im, Math.max(1, Math.round(im.width * k)), Math.max(1, Math.round(im.height * k)))
      blit(sheet, t, cx + Math.round((cell - t.width) / 2), cy + Math.round((cell - t.height) / 2))
    }
    drawNumber(sheet, i + 1, cx + 4, cy + 4)
  })
  return sheet
}
