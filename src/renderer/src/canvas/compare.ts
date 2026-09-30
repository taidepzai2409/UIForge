// Automated diff between the tool's own render of a frame and a capture from Unity (or any
// screenshot of the same reference resolution). Reports per-node mismatches so an agent can fix
// exactly the RectTransforms that are wrong instead of eyeballing two screenshots.
import type { DesignDocument, FrameNode, Page } from '@/model/types'
import { renderFrameToCanvas } from '@/canvas/render'
import { pngFromCanvas } from '@/store/assets'
import { buildFrameLayout, type LayoutNode } from '@/export/layout'

export interface CompareNode {
  id: string
  path: string
  type: string
  rect: { x: number; y: number; width: number; height: number }
  /** mean difference of the node's region, 0..100 (%) */
  diff: number
  /** best offset (px) found for the capture content, when the node is simply shifted */
  shift: { dx: number; dy: number; diff: number } | null
  status: 'ok' | 'shifted' | 'mismatch' | 'missing'
}

export interface CompareReport {
  frame: string
  frameId: string
  width: number
  height: number
  captureSize: { width: number; height: number }
  /** mean difference of the whole image, 0..100 (%) */
  overallDiff: number
  threshold: number
  checked: number
  mismatched: number
  nodes: CompareNode[]
  /** human readable summary lines (Vietnamese) */
  summary: string[]
}

export interface CompareOptions {
  /** % difference above which a node is reported as mismatch (default 3); shifts are detected from 0.5% */
  threshold?: number
  /** max shift searched in px (default 16) */
  maxShift?: number
  /** also produce a diff heat-map PNG */
  diffPng?: boolean
}

export async function decodePng(bytes: Uint8Array): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }))
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  return c
}

function imageData(c: HTMLCanvasElement): ImageData {
  return c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height)
}

/** mean per-pixel difference (0..1) of region r of `a` vs region r shifted by (dx,dy) in `b` */
function regionDiff(a: ImageData, b: ImageData, r: { x: number; y: number; width: number; height: number }, dx: number, dy: number, stride: number): number {
  const W = a.width
  const H = a.height
  let sum = 0
  let n = 0
  let skipped = 0
  const x0 = Math.max(0, Math.floor(r.x))
  const y0 = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(W, Math.ceil(r.x + r.width))
  const y1 = Math.min(H, Math.ceil(r.y + r.height))
  for (let y = y0; y < y1; y += stride) {
    const by = y + dy
    for (let x = x0; x < x1; x += stride) {
      const bx = x + dx
      if (bx < 0 || by < 0 || bx >= W || by >= H) {
        // shifted sample falls outside the capture (node clipped by the frame edge): ignore it
        skipped++
        continue
      }
      const ia = (y * W + x) * 4
      const ib = (by * W + bx) * 4
      const aa = a.data[ia + 3] / 255
      const ab = b.data[ib + 3] / 255
      // colour difference weighted by coverage + alpha difference
      const dr = Math.abs(a.data[ia] - b.data[ib])
      const dg = Math.abs(a.data[ia + 1] - b.data[ib + 1])
      const db = Math.abs(a.data[ia + 2] - b.data[ib + 2])
      sum += Math.max(Math.abs(aa - ab), (Math.max(aa, ab) * (dr + dg + db)) / (3 * 255))
      n++
    }
  }
  if (!n || skipped > n) return 1
  return sum / n
}

function coverage(img: ImageData, r: { x: number; y: number; width: number; height: number }, stride: number): number {
  const W = img.width
  const H = img.height
  let sum = 0
  let n = 0
  const x0 = Math.max(0, Math.floor(r.x))
  const y0 = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(W, Math.ceil(r.x + r.width))
  const y1 = Math.min(H, Math.ceil(r.y + r.height))
  for (let y = y0; y < y1; y += stride) for (let x = x0; x < x1; x += stride) {
    sum += img.data[(y * W + x) * 4 + 3] / 255
    n++
  }
  return n ? sum / n : 0
}

export async function compareFrame(doc: DesignDocument, page: Page, frame: FrameNode, capture: Uint8Array, opts: CompareOptions = {}): Promise<{ report: CompareReport; diffPng?: Uint8Array }> {
  const threshold = opts.threshold ?? 3
  const maxShift = Math.max(0, Math.min(64, Math.round(opts.maxShift ?? 16)))
  const W = Math.round(frame.width)
  const H = Math.round(frame.height)
  const refCanvas = await renderFrameToCanvas(page, frame, doc.assets, 1)
  const capSrc = await decodePng(capture)
  const captureSize = { width: capSrc.width, height: capSrc.height }
  let capCanvas = capSrc
  if (capSrc.width !== W || capSrc.height !== H) {
    capCanvas = document.createElement('canvas')
    capCanvas.width = W
    capCanvas.height = H
    capCanvas.getContext('2d')!.drawImage(capSrc, 0, 0, W, H)
  }
  const ref = imageData(refCanvas)
  const cap = imageData(capCanvas)

  const layout = buildFrameLayout(doc, page, frame)
  const byId = new Map(layout.nodes.map((n) => [n.id, n]))
  const effVisible = (n: LayoutNode): boolean => {
    let cur: LayoutNode | undefined = n
    while (cur) {
      if (!cur.visible) return false
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return true
  }
  const leaves = layout.nodes.filter((n) => (n.type === 'image' || n.type === 'nineslice' || n.type === 'text' || n.type === 'rect') && n.rect.width >= 1 && n.rect.height >= 1 && effVisible(n))

  const nodes: CompareNode[] = []
  for (const n of leaves) {
    const r = n.rect
    const area = r.width * r.height
    const stride = Math.max(1, Math.floor(Math.sqrt(area / 4096)))
    const d0 = regionDiff(ref, cap, r, 0, 0, stride)
    const cn: CompareNode = { id: n.id, path: n.path, type: n.type, rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, diff: Math.round(d0 * 1000) / 10, shift: null, status: 'ok' }
    if (d0 > 0.005) {
      // is the capture region empty while the design has content? → missing
      const cRef = coverage(ref, r, stride)
      const cCap = coverage(cap, r, stride)
      if (d0 * 100 > threshold && cRef > 0.05 && cCap < cRef * 0.15) cn.status = 'missing'
      else {
        // search a translation that explains the difference (a shifted node changes few pixels
        // when it is a flat shape, so this runs for every node that differs at all)
        let best = { dx: 0, dy: 0, diff: d0 }
        if (maxShift > 0) {
          const step = maxShift > 8 ? 2 : 1
          for (let dy = -maxShift; dy <= maxShift; dy += step)
            for (let dx = -maxShift; dx <= maxShift; dx += step) {
              if (!dx && !dy) continue
              const d = regionDiff(ref, cap, r, dx, dy, stride)
              if (d < best.diff) best = { dx, dy, diff: d }
            }
          if (step > 1) {
            const c = { ...best }
            for (let dy = c.dy - 1; dy <= c.dy + 1; dy++)
              for (let dx = c.dx - 1; dx <= c.dx + 1; dx++) {
                const d = regionDiff(ref, cap, r, dx, dy, stride)
                if (d < best.diff) best = { dx, dy, diff: d }
              }
          }
        }
        const explained = (best.dx || best.dy) && best.diff < d0 * 0.5 && best.diff * 100 <= threshold
        if (explained) {
          cn.status = 'shifted'
          cn.shift = { dx: best.dx, dy: best.dy, diff: Math.round(best.diff * 1000) / 10 }
        } else if (d0 * 100 > threshold) {
          cn.status = 'mismatch'
          if (best.dx || best.dy) cn.shift = { dx: best.dx, dy: best.dy, diff: Math.round(best.diff * 1000) / 10 }
        }
      }
    }
    nodes.push(cn)
  }
  const overall = regionDiff(ref, cap, { x: 0, y: 0, width: W, height: H }, 0, 0, Math.max(1, Math.floor(Math.sqrt((W * H) / 65536))))
  const bad = nodes.filter((n) => n.status !== 'ok')
  bad.sort((a, b) => b.diff - a.diff)
  const summary: string[] = [`Frame ${frame.name} ${W}×${H}: sai lệch tổng ${(overall * 100).toFixed(2)}%, ${bad.length}/${nodes.length} node lệch (ngưỡng ${threshold}%)`]
  if (captureSize.width !== W || captureSize.height !== H) summary.push(`Ảnh capture ${captureSize.width}×${captureSize.height} đã được scale về ${W}×${H} — nên capture đúng reference resolution.`)
  for (const n of bad.slice(0, 40)) {
    if (n.status === 'shifted' && n.shift) summary.push(`↔ ${n.path}: lệch vị trí ${n.shift.dx >= 0 ? '+' : ''}${n.shift.dx}, ${n.shift.dy >= 0 ? '+' : ''}${n.shift.dy} px (Unity đang đặt sai anchoredPosition; đúng: x=${n.rect.x}, y=${n.rect.y})`)
    else if (n.status === 'missing') summary.push(`✕ ${n.path}: không thấy trong capture (thiếu sprite/ẩn/không render)`)
    else summary.push(`≠ ${n.path}: khác ${n.diff}% (${n.type === 'text' ? 'font/kích cỡ chữ khác?' : 'sprite/màu/kích thước khác'})`)
  }
  const report: CompareReport = { frame: frame.name, frameId: frame.id, width: W, height: H, captureSize, overallDiff: Math.round(overall * 10000) / 100, threshold, checked: nodes.length, mismatched: bad.length, nodes: [...bad, ...nodes.filter((n) => n.status === 'ok')], summary }

  let diffPng: Uint8Array | undefined
  if (opts.diffPng) {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')!
    const out = ctx.createImageData(W, H)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      const aa = ref.data[o + 3] / 255
      const ab = cap.data[o + 3] / 255
      const dr = Math.abs(ref.data[o] - cap.data[o])
      const dg = Math.abs(ref.data[o + 1] - cap.data[o + 1])
      const db = Math.abs(ref.data[o + 2] - cap.data[o + 2])
      const d = Math.max(Math.abs(aa - ab), (Math.max(aa, ab) * (dr + dg + db)) / (3 * 255))
      // dimmed grey of the reference + red where different
      const g = (ref.data[o] * 0.299 + ref.data[o + 1] * 0.587 + ref.data[o + 2] * 0.114) * aa * 0.35
      out.data[o] = Math.min(255, g + d * 255)
      out.data[o + 1] = g
      out.data[o + 2] = g
      out.data[o + 3] = 255
    }
    ctx.putImageData(out, 0, 0)
    ctx.lineWidth = 2
    ctx.font = '12px sans-serif'
    for (const n of bad) {
      ctx.strokeStyle = n.status === 'shifted' ? '#ffb020' : n.status === 'missing' ? '#a259ff' : '#ff3355'
      ctx.strokeRect(n.rect.x + 1, n.rect.y + 1, n.rect.width - 2, n.rect.height - 2)
      ctx.fillStyle = ctx.strokeStyle
      ctx.fillText(n.path.split('/').pop() ?? n.id, n.rect.x + 3, n.rect.y + 13)
    }
    diffPng = await pngFromCanvas(c)
  }
  return { report, diffPng }
}
