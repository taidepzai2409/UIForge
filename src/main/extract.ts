// Runs INSIDE the game's page (serialized with Function#toString and executed by the capture window), so it
// must stay self-contained: no imports, no references to anything outside the function body.
//
// It reads the UI the game is showing right now and returns it as a tree of elements (rects in CSS px of the
// viewport): Phaser 3 display lists, or the DOM. Art is reported as the URL the game loaded it from; the
// main process maps URLs to files of the game project.

export interface ExtractOptions {
  engine?: 'phaser' | 'dom' | 'auto'
  /** dotted path of the Phaser.Game instance, e.g. "window.__sdi.game" (auto-detected when omitted) */
  game?: string
  /** DOM: CSS selector(s) of the element(s) that make up this screen (default: body) */
  root?: string
  /** Phaser: scene keys to read (default: every active, visible scene) */
  scenes?: string[]
  /** regular expressions tested against element ids / names / texture keys */
  exclude?: string[]
  /** keep only the elements whose id matches one of these (with everything inside them) — e.g. one popup */
  only?: string[]
  max?: number
}

export interface RawElement {
  id: string
  name: string
  type: 'image' | 'nineslice' | 'text' | 'rect' | 'group'
  x: number
  y: number
  width: number
  height: number
  assetUrl?: string
  crop?: { x: number; y: number; width: number; height: number }
  snapshot?: boolean
  /** the element's own pixels as a data: URL (a <canvas> read directly) */
  assetData?: string
  insets?: { left: number; top: number; right: number; bottom: number }
  text?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  color?: string
  align?: 'left' | 'center' | 'right'
  fill?: string | null
  cornerRadius?: number
  stroke?: string
  strokeWidth?: number
  shape?: 'rect' | 'ellipse'
  opacity?: number
  interactive?: boolean
  code?: string
  note?: string
  children?: RawElement[]
}

/** a webfont face of the page (@font-face rule or a FontFace loaded by script) */
export interface WebFont {
  family: string
  weight: string
  style: string
  /** absolute URLs from `src`, in the rule's order */
  urls: string[]
}

export interface ExtractResult {
  engine: 'phaser' | 'dom'
  width: number
  height: number
  elements: RawElement[]
  warnings: string[]
  /** every webfont face the page declares (the game's font kit, used or not on this screen) */
  fonts?: WebFont[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function extractInPage(opts: ExtractOptions): ExtractResult {
  const warnings: string[] = []
  const VW = window.innerWidth
  const VH = window.innerHeight
  const max = opts.max ?? 600
  let count = 0
  const excludes = (opts.exclude ?? []).map((s) => new RegExp(s, 'i'))
  const excluded = (...keys: (string | undefined)[]): boolean => excludes.some((re) => keys.some((k) => !!k && re.test(k)))
  const r2 = (n: number): number => Math.round(n * 100) / 100

  const colorCtx = document.createElement('canvas').getContext('2d')!
  /** any CSS colour → { hex, alpha } */
  const parseColor = (c: string | null | undefined): { hex: string; a: number } | null => {
    if (!c || c === 'transparent') return null
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/.exec(c.trim())
    const hex2 = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
      return { hex: `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}`, a }
    }
    colorCtx.fillStyle = '#000000'
    colorCtx.fillStyle = c
    const v = String(colorCtx.fillStyle)
    if (/^#[0-9a-f]{6}$/i.test(v)) return { hex: v.toLowerCase(), a: 1 }
    return v === c ? null : parseColor(v)
  }
  const numToHex = (n: number): string => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`

  const sibNames = new WeakMap<object, Map<string, number>>()
  const uniqueId = (scope: object, parentId: string, base: string): string => {
    let m = sibNames.get(scope)
    if (!m) sibNames.set(scope, (m = new Map()))
    const clean = base.replace(/[\s/|#]+/g, '_').slice(0, 48) || 'el'
    const n = (m.get(clean) ?? 0) + 1
    m.set(clean, n)
    const id = n === 1 ? clean : `${clean}~${n}`
    return parentId ? `${parentId}/${id}` : id
  }
  const onScreen = (x: number, y: number, w: number, h: number): boolean => w > 0.5 && h > 0.5 && x < VW && y < VH && x + w > 0 && y + h > 0

  // ------------------------------------------------------------------ Phaser 3
  const resolvePath = (path: string): any => {
    let cur: any = window
    for (const part of path.replace(/^window\./, '').split('.')) {
      if (cur == null) return null
      cur = cur[part]
    }
    return cur
  }
  const isGame = (v: any): boolean => !!v && typeof v === 'object' && !!v.canvas && !!v.scene && typeof v.scene.getScenes === 'function'
  const findGame = (): any => {
    if (opts.game) {
      const g = resolvePath(opts.game)
      if (isGame(g)) return g
      warnings.push(`không thấy Phaser.Game ở "${opts.game}"`)
    }
    const w = window as any
    if (w.Phaser?.GAMES?.length) return w.Phaser.GAMES[0]
    for (const k of Object.keys(w)) {
      let v: any
      try {
        v = w[k]
      } catch {
        continue
      }
      if (isGame(v)) return v
      if (v && typeof v === 'object' && !(v instanceof Node) && v !== w) {
        try {
          for (const kk of Object.keys(v).slice(0, 40)) if (isGame(v[kk])) return v[kk]
        } catch {
          /* cross-origin / getters */
        }
      }
    }
    return null
  }

  /** Learns the Graphics command ids of this Phaser build by probing a scratch Graphics, then measures one. */
  const graphicsBounds = (() => {
    let table: Map<number, { len: number; kind: string }> | null | undefined
    const learn = (scene: any): Map<number, { len: number; kind: string }> | null => {
      try {
        const g = scene.make.graphics({}, false)
        const t = new Map<number, { len: number; kind: string }>()
        const probe = (kind: string, fn: () => void): void => {
          g.commandBuffer.length = 0
          fn()
          const b = g.commandBuffer
          if (b.length && !t.has(b[0])) t.set(b[0], { len: b.length, kind })
        }
        // single commands first; a probe never redefines a known id (strokeRect & co are made of path commands)
        probe('style', () => g.fillStyle(0xffffff, 1))
        probe('style', () => g.lineStyle(1, 0xffffff, 1))
        probe('noop', () => g.beginPath())
        probe('noop', () => g.closePath())
        probe('noop', () => g.fillPath())
        probe('noop', () => g.strokePath())
        probe('point', () => g.moveTo(1, 2))
        probe('point', () => g.lineTo(1, 2))
        probe('arc', () => g.arc(1, 2, 3, 0, 1, false))
        probe('noop', () => g.save())
        probe('noop', () => g.restore())
        probe('xform', () => g.translateCanvas(1, 2))
        probe('xform', () => g.scaleCanvas(1, 2))
        probe('xform', () => g.rotateCanvas(1))
        probe('rect', () => g.fillRect(1, 2, 3, 4))
        probe('tri', () => g.fillTriangle(1, 2, 3, 4, 5, 6))
        probe('tri', () => g.strokeTriangle(1, 2, 3, 4, 5, 6))
        probe('style', () => g.fillGradientStyle(1, 1, 1, 1, 1, 1, 1, 1))
        probe('style', () => g.lineGradientStyle(1, 1, 1, 1, 1, 1))
        g.destroy()
        return t
      } catch (e) {
        warnings.push(`không đo được Graphics (${String((e as Error)?.message ?? e)})`)
        return null
      }
    }
    return (go: any): { x: number; y: number; w: number; h: number } | null => {
      if (table === undefined) table = learn(go.scene)
      if (!table) return null
      const b: number[] = go.commandBuffer
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      const add = (x: number, y: number): void => {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
      let i = 0
      let lineW = 0
      while (i < b.length) {
        const e = table.get(b[i])
        if (!e) {
          // unknown command: bounds would be a guess
          const w = `Graphics "${go.name || ''}": lệnh vẽ không rõ (id ${b[i]}), bỏ qua`
          if (!warnings.includes(w)) warnings.push(w)
          return null
        }
        if (e.kind === 'rect') {
          add(b[i + 1], b[i + 2])
          add(b[i + 1] + b[i + 3], b[i + 2] + b[i + 4])
        } else if (e.kind === 'tri') {
          add(b[i + 1], b[i + 2])
          add(b[i + 3], b[i + 4])
          add(b[i + 5], b[i + 6])
        } else if (e.kind === 'point') add(b[i + 1], b[i + 2])
        else if (e.kind === 'arc') {
          add(b[i + 1] - b[i + 3], b[i + 2] - b[i + 3])
          add(b[i + 1] + b[i + 3], b[i + 2] + b[i + 3])
        } else if (e.kind === 'xform') return null
        else if (e.kind === 'style' && e.len === 4) lineW = Math.max(lineW, b[i + 1])
        i += e.len
      }
      if (!Number.isFinite(x0)) return null
      const p = lineW / 2
      return { x: x0 - p, y: y0 - p, w: x1 - x0 + lineW, h: y1 - y0 + lineW }
    }
  })()

  /** last resort: a file the page fetched whose name (without extension) is the texture key */
  const byBaseName = (() => {
    let index: Map<string, string | null> | null = null
    return (key: string): string | undefined => {
      if (!index) {
        index = new Map()
        for (const e of performance.getEntriesByType('resource')) {
          const m = /([^/?#]+)\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.exec(e.name)
          if (!m) continue
          const k = m[1].toLowerCase()
          index.set(k, index.has(k) && index.get(k) !== e.name ? null : e.name)
        }
      }
      return index.get(key.toLowerCase()) ?? undefined
    }
  })()
  const texts: any[] = ((window as any).__uiforgeTexts = [])
  /** excluded / not-kept things are hidden while the screenshots are taken (cut-outs must not contain them) */
  const hidden: any[] = ((window as any).__uiforgeExcluded = [])

  const extractPhaser = (game: any): RawElement[] => {
    const cr = game.canvas.getBoundingClientRect()
    const gw = game.scale?.width ?? game.config.width
    const gh = game.scale?.height ?? game.config.height
    const sx = cr.width / gw
    const sy = cr.height / gh
    const out: RawElement[] = []
    let scenes: any[] = game.scene.getScenes(true).filter((s: any) => s.sys.settings.visible !== false)
    if (opts.scenes?.length) scenes = scenes.filter((s: any) => opts.scenes!.includes(s.sys.settings.key))

    const toPage = (cam: any, scrollX: number, scrollY: number, b: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } => {
      const zx = cam.zoomX ?? cam.zoom ?? 1
      const zy = cam.zoomY ?? cam.zoom ?? 1
      const ox = cam.width * (cam.originX ?? 0.5)
      const oy = cam.height * (cam.originY ?? 0.5)
      const x = (b.x - cam.scrollX * scrollX - ox) * zx + ox + cam.x
      const y = (b.y - cam.scrollY * scrollY - oy) * zy + oy + cam.y
      return { x: cr.left + x * sx, y: cr.top + y * sy, w: b.w * zx * sx, h: b.h * zy * sy }
    }
    /** world-space AABB of a local rect of a game object */
    const worldBox = (go: any, l: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } => {
      const m = go.getWorldTransformMatrix()
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [px, py] of [[l.x, l.y], [l.x + l.w, l.y], [l.x, l.y + l.h], [l.x + l.w, l.y + l.h]]) {
        const wx = m.a * px + m.c * py + m.tx
        const wy = m.b * px + m.d * py + m.ty
        x0 = Math.min(x0, wx)
        y0 = Math.min(y0, wy)
        x1 = Math.max(x1, wx)
        y1 = Math.max(y1, wy)
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
    const boundsOf = (go: any): { x: number; y: number; w: number; h: number } | null => {
      try {
        if (go.type === 'Graphics') {
          const l = graphicsBounds(go)
          return l ? worldBox(go, l) : null
        }
        if (typeof go.getBounds === 'function') {
          const b = go.getBounds()
          if (Number.isFinite(b.width) && Number.isFinite(b.x)) return { x: b.x, y: b.y, w: b.width, h: b.height }
        }
        if (typeof go.width === 'number' && typeof go.height === 'number' && go.getWorldTransformMatrix) {
          const oxr = go.originX ?? 0
          const oyr = go.originY ?? 0
          return worldBox(go, { x: -go.width * oxr, y: -go.height * oyr, w: go.width, h: go.height })
        }
      } catch {
        /* fall through */
      }
      return null
    }
    const sourceOf = (go: any): { url?: string; crop?: RawElement['crop']; key: string } => {
      const frame = go.frame
      const key = String(go.texture?.key ?? '')
      const img = frame?.source?.image ?? frame?.source?.source
      let url: string | undefined = img && typeof img.src === 'string' && img.src ? img.src : undefined
      // Phaser loads images as blobs: the capture window records which URL each blob came from
      if (url?.startsWith('blob:')) url = (window as any).__uiforgeBlobSrc?.get(url)
      if (!url && key) url = byBaseName(key)
      let crop: RawElement['crop']
      if (frame && img && (frame.cutX !== 0 || frame.cutY !== 0 || frame.cutWidth !== img.width || frame.cutHeight !== img.height)) crop = { x: frame.cutX, y: frame.cutY, width: frame.cutWidth, height: frame.cutHeight }
      return { url, crop, key }
    }

    const visit = (go: any, cam: any, scroll: { x: number; y: number }, alpha: number, parentId: string, scope: object, into: RawElement[]): void => {
      if (count >= max) return
      if (!go || go.visible === false) return
      const a = alpha * (typeof go.alpha === 'number' ? go.alpha : 1)
      if (a <= 0.01) return
      const type = String(go.type ?? go.constructor?.name ?? 'Object')
      if (/Particle/.test(type) || (type === 'Zone' && !go.input?.enabled)) return
      const key = String(go.texture?.key ?? '')
      if (excluded(go.name, key, type)) {
        hidden.push(go)
        return
      }
      const kids: any[] | null = type === 'Container' || type === 'Layer' ? (go.list ?? go.getChildren?.() ?? []) : null
      if (kids) {
        const id = uniqueId(scope, parentId, go.name || type.toLowerCase())
        if (excluded(id)) {
          hidden.push(go)
          return
        }
        const children: RawElement[] = []
        const sorted = type === 'Layer' ? [...kids].sort((p: any, q: any) => (p.depth ?? 0) - (q.depth ?? 0)) : kids
        for (const k of sorted) visit(k, cam, scroll, a, id, go, children)
        if (!children.length) return
        const x0 = Math.min(...children.map((c) => c.x))
        const y0 = Math.min(...children.map((c) => c.y))
        const el: RawElement = { id, name: go.name || type.toLowerCase(), type: 'group', x: r2(x0), y: r2(y0), width: r2(Math.max(...children.map((c) => c.x + c.width)) - x0), height: r2(Math.max(...children.map((c) => c.y + c.height)) - y0), children }
        if (go.input?.enabled) el.interactive = true
        into.push(el)
        return
      }
      const wb = boundsOf(go)
      if (!wb) return
      const p = toPage(cam, scroll.x, scroll.y, wb)
      if (!onScreen(p.x, p.y, p.w, p.h)) return
      const rotated = Math.abs(((go.getWorldTransformMatrix?.().rotation ?? go.rotation ?? 0) as number) % (Math.PI * 2)) > 0.01
      const base = { x: r2(p.x), y: r2(p.y), width: r2(p.w), height: r2(p.h) }
      const mk = (name: string, rest: Partial<RawElement>): RawElement => {
        const id = uniqueId(scope, parentId, go.name || name)
        const el: RawElement = { id, name: go.name || name, type: 'image', ...base, ...rest }
        if (a < 0.995) el.opacity = r2(a)
        if (go.input?.enabled) el.interactive = true
        return el
      }
      let el: RawElement | null = null
      if (type === 'Text' || type === 'BitmapText' || type === 'DynamicBitmapText') {
        const txt = Array.isArray(go.text) ? go.text.join('\n') : String(go.text ?? '')
        if (!txt.trim()) return
        const st = go.style ?? {}
        const scale = Math.abs(go.getWorldTransformMatrix?.().scaleY ?? go.scaleY ?? 1) * (cam.zoomY ?? cam.zoom ?? 1) * sy
        const size = type === 'Text' ? parseFloat(String(st.fontSize ?? '16')) : Number(go.fontSize ?? 16)
        const col = type === 'Text' ? parseColor(String(st.color ?? '#ffffff')) : null
        el = mk(`txt_${txt.slice(0, 24)}`, { type: 'text', text: txt, fontSize: r2(size * scale), fontFamily: String(st.fontFamily ?? go.font ?? 'Arial').split(',')[0].replace(/["']/g, '').trim(), color: col?.hex ?? '#ffffff', align: (['left', 'center', 'right'].includes(st.align) ? st.align : 'left') as RawElement['align'] })
        if (/bold|[6-9]00/.test(String(st.fontStyle ?? ''))) el.fontWeight = 700
        texts.push(go)
        if (rotated) el.note = 'xoay trong game'
      } else if (type === 'NineSlice') {
        const s = sourceOf(go)
        el = mk(s.key || 'nineslice', { type: 'nineslice', assetUrl: s.url, crop: s.crop, insets: { left: go.leftWidth ?? 0, top: go.topHeight ?? 0, right: go.rightWidth ?? 0, bottom: go.bottomHeight ?? 0 } })
        if (!s.url) el.snapshot = true
      } else if (type === 'Image' || type === 'Sprite' || type === 'TileSprite') {
        const s = sourceOf(go)
        const tinted = go.isTinted === true || (typeof go.tintTopLeft === 'number' && go.tintTopLeft !== 0xffffff)
        el = mk(s.key || type.toLowerCase(), { type: 'image', assetUrl: rotated || type === 'TileSprite' ? undefined : s.url, crop: s.crop })
        if (!el.assetUrl) {
          el.snapshot = true
          delete el.crop
        }
        const notes = [rotated ? 'xoay trong game' : '', tinted ? 'tint màu trong game' : '', go.flipX || go.flipY ? 'lật trong game' : ''].filter(Boolean)
        if (s.key) notes.unshift(`texture "${s.key}"${go.frame?.name && go.frame.name !== '__BASE' ? ` frame "${go.frame.name}"` : ''}`)
        if (notes.length) el.note = notes.join(', ')
      } else if (type === 'Zone') {
        // an invisible hit area: kept as an empty rect so flows have something to start from
        el = mk('zone', { type: 'rect', fill: null, note: 'vùng bấm (Zone)' })
      } else if (type === 'Rectangle' || type === 'Arc' || type === 'Ellipse') {
        const filled = go.isFilled !== false && (go.fillAlpha ?? 1) > 0
        el = mk(type.toLowerCase(), { type: 'rect', fill: filled ? numToHex(go.fillColor ?? 0xffffff) : null, shape: type === 'Rectangle' ? 'rect' : 'ellipse' })
        if (go.isStroked && go.lineWidth) {
          el.stroke = numToHex(go.strokeColor ?? 0)
          el.strokeWidth = go.lineWidth
        }
        if (filled && (go.fillAlpha ?? 1) < 1) el.opacity = r2(a * go.fillAlpha)
      } else {
        // Graphics, Spine, shapes, render textures…: drawn by code, shown as a cut-out of the game's rendering
        el = mk(type.toLowerCase(), { type: 'image', snapshot: true, note: `${type} vẽ bằng code` })
      }
      if (excluded(el.id)) {
        hidden.push(go)
        return
      }
      count++
      into.push(el)
    }

    for (const scene of scenes) {
      const cams: any[] = scene.cameras?.cameras ?? []
      const key = String(scene.sys.settings.key)
      const list: any[] = [...(scene.sys.displayList?.list ?? [])].map((go, i) => ({ go, i })).sort((p, q) => (p.go.depth ?? 0) - (q.go.depth ?? 0) || p.i - q.i).map((e) => e.go)
      const children: RawElement[] = []
      for (const go of list) {
        const cam = cams.find((c) => c.visible !== false && !((go.cameraFilter ?? 0) & c.id)) ?? cams[0]
        if (!cam) continue
        visit(go, cam, { x: go.scrollFactorX ?? 1, y: go.scrollFactorY ?? 1 }, 1, key, scene, children)
      }
      if (!children.length) continue
      const x0 = Math.min(...children.map((c) => c.x))
      const y0 = Math.min(...children.map((c) => c.y))
      out.push({ id: key, name: key, type: 'group', x: r2(x0), y: r2(y0), width: r2(Math.max(...children.map((c) => c.x + c.width)) - x0), height: r2(Math.max(...children.map((c) => c.y + c.height)) - y0), children, note: `Phaser scene "${key}"` })
    }
    if (count >= max) warnings.push(`quá ${max} element: phần còn lại bị bỏ (dùng exclude / scenes để lọc)`)
    return out
  }

  // ------------------------------------------------------------------ DOM
  const extractDom = (): RawElement[] => {
    const roots: Element[] = opts.root ? Array.from(document.querySelectorAll(opts.root)) : [document.body]
    if (opts.root && !roots.length) warnings.push(`không có element nào khớp "${opts.root}"`)
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'BR'])
    const urlOf = (v: string): string | undefined => /url\((['"]?)(.*?)\1\)/.exec(v)?.[2]
    const selectorOf = (el: Element): string => {
      if (el.id) return `#${el.id}`
      const cls = Array.from(el.classList).slice(0, 2).map((c) => `.${c}`).join('')
      const parent = el.parentElement
      return `${parent && parent !== document.body ? selectorOf(parent) + ' > ' : ''}${el.tagName.toLowerCase()}${cls}`
    }
    /** visible area left by ancestors with overflow other than visible (scroll lists, masks) */
    type Clip = { x0: number; y0: number; x1: number; y1: number }
    const visit = (el: Element, alpha: number, parentId: string, scope: object, into: RawElement[], clip: Clip): void => {
      if (count >= max || SKIP.has(el.tagName)) return
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return
      const a = alpha * parseFloat(cs.opacity || '1')
      if (a <= 0.01) return
      const html = el as HTMLElement
      const base = html.id || html.dataset?.ui || html.dataset?.asset || el.classList[0] || el.tagName.toLowerCase()
      if (excluded(html.id, base, el.className?.toString?.())) {
        hidden.push(el)
        return
      }
      const id = uniqueId(scope, parentId, base)
      if (excluded(id)) {
        hidden.push(el)
        return
      }
      const r = el.getBoundingClientRect()
      // fixed elements escape their ancestors' clipping; anything else wholly outside it is not seen
      const myClip: Clip = cs.position === 'fixed' ? { x0: 0, y0: 0, x1: VW, y1: VH } : clip
      const inClip = (x: number, y: number, w: number, h: number): boolean => x < myClip.x1 && y < myClip.y1 && x + w > myClip.x0 && y + h > myClip.y0
      if (r.width > 0 && r.height > 0 && !inClip(r.left, r.top, r.width, r.height)) return
      const clipsKids = cs.overflowX !== 'visible' || cs.overflowY !== 'visible'
      const kidClip: Clip = clipsKids ? { x0: Math.max(myClip.x0, r.left), y0: Math.max(myClip.y0, r.top), x1: Math.min(myClip.x1, r.right), y1: Math.min(myClip.y1, r.bottom) } : myClip
      const box = { x: r2(r.left), y: r2(r.top), width: r2(r.width), height: r2(r.height) }
      const visible = onScreen(r.left, r.top, r.width, r.height) && inClip(r.left, r.top, r.width, r.height)
      const code = `css: ${selectorOf(el)}`
      const interactive = el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || cs.cursor === 'pointer' || typeof html.onclick === 'function'
      const parts: RawElement[] = []
      let leafOnly = false

      if (visible) {
        const tag = el.tagName
        const bgUrl = cs.backgroundImage && cs.backgroundImage !== 'none' ? urlOf(cs.backgroundImage) : undefined
        const biUrl = cs.borderImageSource && cs.borderImageSource !== 'none' ? urlOf(cs.borderImageSource) : undefined
        const bg = parseColor(cs.backgroundColor)
        const bw = parseFloat(cs.borderTopWidth || '0')
        const bc = bw > 0 && cs.borderTopStyle !== 'none' ? parseColor(cs.borderTopColor) : null
        if (tag === 'IMG') {
          const img = el as HTMLImageElement
          parts.push({ id: '', name: base, type: 'image', ...box, assetUrl: img.currentSrc || img.src || undefined })
          leafOnly = true
        } else if (tag === 'CANVAS' || tag === 'svg' || tag === 'SVG' || tag === 'VIDEO') {
          const part: RawElement = { id: '', name: base, type: 'image', ...box, snapshot: true, note: `<${tag.toLowerCase()}>` }
          if (tag === 'CANVAS') {
            // the canvas' own pixels (without the DOM drawn over it), when the context still holds them
            try {
              const cv = el as HTMLCanvasElement
              const probe = document.createElement('canvas')
              probe.width = probe.height = 16
              const pc = probe.getContext('2d')!
              pc.drawImage(cv, 0, 0, 16, 16)
              if (pc.getImageData(0, 0, 16, 16).data.some((v, i) => i % 4 === 3 && v > 0)) part.assetData = cv.toDataURL('image/png')
            } catch {
              /* tainted canvas: keep the screenshot cut-out */
            }
          }
          parts.push(part)
          leafOnly = true
        } else if (biUrl) {
          const sl = cs.borderImageSlice.replace('fill', '').trim().split(/\s+/).map((v) => parseFloat(v))
          const t = sl[0] ?? 0
          const rr = sl[1] ?? t
          const b = sl[2] ?? t
          const l = sl[3] ?? rr
          parts.push({ id: '', name: base, type: 'nineslice', ...box, assetUrl: biUrl, insets: { left: l, top: t, right: rr, bottom: b } })
        } else if (bgUrl) {
          parts.push({ id: '', name: base, type: 'image', ...box, assetUrl: bgUrl })
        } else if (cs.backgroundImage && cs.backgroundImage !== 'none') {
          parts.push({ id: '', name: base, type: 'image', ...box, snapshot: true, note: 'gradient CSS' })
        } else if ((bg && bg.a > 0.01) || (bc && bc.a > 0.01)) {
          const rad = cs.borderTopLeftRadius || '0'
          const radius = rad.endsWith('%') ? (Math.min(r.width, r.height) * parseFloat(rad)) / 100 : parseFloat(rad)
          const round = radius >= Math.min(r.width, r.height) / 2 - 0.5 && Math.abs(r.width - r.height) < 1
          const part: RawElement = { id: '', name: base, type: 'rect', ...box, fill: bg && bg.a > 0.01 ? bg.hex : null, cornerRadius: round ? 0 : r2(Math.min(radius, Math.min(r.width, r.height) / 2)) }
          if (round) part.shape = 'ellipse'
          if (bg && bg.a > 0.01 && bg.a < 0.995) part.opacity = r2(bg.a)
          if (bc && bc.a > 0.01) {
            part.stroke = bc.hex
            part.strokeWidth = bw
          }
          parts.push(part)
        }
      }

      const kids: RawElement[] = []
      if (!leafOnly) {
        // paint order: siblings with a z-index (positioned) are stacked by it, then document order — the
        // order the browser draws them in, so a z-indexed bar stays above a later full-screen panel
        const zOf = (n: ChildNode): number => {
          if (n.nodeType !== 1) return 0
          const c = getComputedStyle(n as Element)
          const z = parseInt(c.zIndex, 10)
          return c.position !== 'static' && Number.isFinite(z) ? z : 0
        }
        const ordered = Array.from(el.childNodes)
          .map((n, i) => ({ n, i, z: zOf(n) }))
          .sort((p, q) => p.z - q.z || p.i - q.i)
          .map((x) => x.n)
        for (const node of ordered) {
          if (node.nodeType === 3) {
            const raw = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
            if (!raw) continue
            const range = document.createRange()
            range.selectNodeContents(node)
            const tr = range.getBoundingClientRect()
            if (!onScreen(tr.left, tr.top, tr.width, tr.height)) continue
            if (!(tr.left < kidClip.x1 && tr.top < kidClip.y1 && tr.right > kidClip.x0 && tr.bottom > kidClip.y0)) continue
            const col = parseColor(cs.color)
            const ta = cs.textAlign
            const text = cs.textTransform === 'uppercase' ? raw.toUpperCase() : raw
            kids.push({ id: '', name: `txt_${raw.slice(0, 24)}`, type: 'text', x: r2(tr.left), y: r2(tr.top), width: r2(tr.width), height: r2(tr.height), text, fontSize: r2(parseFloat(cs.fontSize)), fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), fontWeight: parseInt(cs.fontWeight, 10) || 400, color: col?.hex ?? '#000000', align: ta === 'center' ? 'center' : ta === 'right' || ta === 'end' ? 'right' : 'left' })
          } else if (node.nodeType === 1) visit(node as Element, a, id, el, kids, kidClip)
        }
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const v = (el as HTMLInputElement).value || (el as HTMLInputElement).placeholder
          if (v && visible) kids.push({ id: '', name: 'txt_value', type: 'text', ...box, text: v, fontSize: r2(parseFloat(cs.fontSize)), fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), color: parseColor(cs.color)?.hex ?? '#000000', align: 'left' })
        }
      }

      const all = [...parts, ...kids]
      if (!all.length) return
      const finish = (e: RawElement, own: boolean): RawElement => {
        if (a < 0.995) e.opacity = r2((e.opacity ?? 1) * (own ? a : 1))
        if (interactive) e.interactive = true
        e.code = code
        return e
      }
      if (all.length === 1 && parts.length === 1) {
        // the element is just its own box
        const e = parts[0]
        e.id = id
        count++
        into.push(finish(e, true))
        return
      }
      if (all.length === 1 && kids.length === 1 && !kids[0].id) {
        // an element that only holds one text: the text takes the element's name
        const e = kids[0]
        e.id = id
        e.name = base
        count++
        into.push(finish(e, true))
        return
      }
      const named = !!html.id || !!html.dataset?.ui || interactive || parts.length > 0
      if (!named && kids.every((k) => k.id)) {
        // anonymous wrapper: hoist its children
        into.push(...kids)
        return
      }
      const local = {}
      for (const e of all) {
        if (e.id) continue
        e.id = uniqueId(local, id, e === parts[0] ? 'bg' : e.name)
        if (e === parts[0]) e.name = `${base}_bg`
        if (a < 0.995) e.opacity = r2((e.opacity ?? 1) * a)
        count++
      }
      const x0 = Math.min(...all.map((c) => c.x))
      const y0 = Math.min(...all.map((c) => c.y))
      const g: RawElement = { id, name: base, type: 'group', x: r2(x0), y: r2(y0), width: r2(Math.max(...all.map((c) => c.x + c.width)) - x0), height: r2(Math.max(...all.map((c) => c.y + c.height)) - y0), children: all }
      if (interactive) g.interactive = true
      g.code = code
      into.push(g)
    }
    const out: RawElement[] = []
    const top = {}
    for (const root of roots) visit(root, 1, '', top, out, { x0: 0, y0: 0, x1: VW, y1: VH })
    if (count >= max) warnings.push(`quá ${max} element: phần còn lại bị bỏ (dùng root / exclude để lọc)`)
    return out
  }

  /** fills larger than the screen (dim layers) are cut to the screen; `only` keeps the matching subtrees */
  const tidy = (els: RawElement[]): RawElement[] => {
    const onlyRe = (opts.only ?? []).map((s) => new RegExp(s, 'i'))
    const clamp = (list: RawElement[]): void => {
      for (const e of list) {
        if (e.type === 'rect') {
          const x0 = Math.max(0, e.x)
          const y0 = Math.max(0, e.y)
          const x1 = Math.min(VW, e.x + e.width)
          const y1 = Math.min(VH, e.y + e.height)
          if (x1 > x0 && y1 > y0) Object.assign(e, { x: r2(x0), y: r2(y0), width: r2(x1 - x0), height: r2(y1 - y0) })
        }
        if (e.children) {
          clamp(e.children)
          const x0 = Math.min(...e.children.map((c) => c.x))
          const y0 = Math.min(...e.children.map((c) => c.y))
          Object.assign(e, { x: r2(x0), y: r2(y0), width: r2(Math.max(...e.children.map((c) => c.x + c.width)) - x0), height: r2(Math.max(...e.children.map((c) => c.y + c.height)) - y0) })
        }
      }
    }
    const pick = (list: RawElement[]): RawElement[] => {
      const out: RawElement[] = []
      for (const e of list) {
        if (onlyRe.some((re) => re.test(e.id) || re.test(e.name))) out.push(e)
        else if (e.children) out.push(...pick(e.children))
      }
      return out
    }
    const kept = onlyRe.length ? pick(els) : els
    if (onlyRe.length && !kept.length) warnings.push(`only ${JSON.stringify(opts.only)}: không element nào khớp`)
    clamp(kept)
    return kept
  }

  /**
   * @font-face rules and script-loaded FontFaces (matched to fetched font files by name). All of them, not only
   * the families on this screen: fallbacks (CJK) and other languages use them too, and the artist picks from them.
   */
  const webFonts = (): WebFont[] => {
    const clean = (f: string): string => f.trim().replace(/^["']|["']$/g, '')
    const out: WebFont[] = []
    const seen = new Set<string>()
    const add = (f: WebFont): void => {
      const k = `${f.family.toLowerCase()}|${f.weight}|${f.style}|${f.urls.join(',')}`
      if (!f.family || seen.has(k)) return
      seen.add(k)
      out.push(f)
    }
    const visitRules = (rules: CSSRuleList, base: string): void => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSFontFaceRule) {
          const st = r.style
          const urls: string[] = []
          const src = st.getPropertyValue('src')
          const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g
          let m: RegExpExecArray | null
          while ((m = re.exec(src))) {
            try {
              urls.push(new URL(m[2], base).href)
            } catch {
              /* bad url */
            }
          }
          add({ family: clean(st.getPropertyValue('font-family')), weight: st.getPropertyValue('font-weight') || '400', style: st.getPropertyValue('font-style') || 'normal', urls })
        } else if (r instanceof CSSImportRule && r.styleSheet) {
          try {
            visitRules(r.styleSheet.cssRules, r.styleSheet.href ?? base)
          } catch {
            /* cross-origin */
          }
        } else if ((r as CSSGroupingRule).cssRules) visitRules((r as CSSGroupingRule).cssRules, base)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visitRules(sheet.cssRules, sheet.href ?? location.href)
      } catch {
        warnings.push(`không đọc được stylesheet ${sheet.href ?? '(inline)'} (cross-origin) — font trong đó có thể bị thiếu`)
      }
    }
    // FontFaces created by script carry no URL: match a fetched font file by name
    const files = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.(ttf|otf|woff2?)(?:[?#]|$)/i.test(n))
    const key = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '')
    document.fonts.forEach((f) => {
      const fam = clean(f.family)
      if (out.some((o) => o.family.toLowerCase() === fam.toLowerCase())) return
      const file = files.find((n) => key(n.replace(/^.*\//, '').replace(/\.[^.]+(?:[?#].*)?$/, '')).startsWith(key(fam)))
      add({ family: fam, weight: String(f.weight), style: f.style, urls: file ? [file] : [] })
    })
    return out
  }

  const wanted = opts.engine ?? 'auto'
  if (wanted !== 'dom') {
    const game = findGame()
    if (game) {
      const elements = tidy(extractPhaser(game))
      return { engine: 'phaser', width: VW, height: VH, elements, warnings, fonts: webFonts() }
    }
    if (wanted === 'phaser') warnings.push('không tìm thấy Phaser.Game trên trang; đọc DOM thay thế')
  }
  const elements = tidy(extractDom())
  return { engine: 'dom', width: VW, height: VH, elements, warnings, fonts: webFonts() }
}
