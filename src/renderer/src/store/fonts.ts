// Font discovery: installed system fonts (window.queryLocalFonts, allowed by main) plus
// project-local fonts in <project>/fonts/*.ttf|otf (loaded through the FontFace API so
// designers can ship game fonts with the project).

export interface LocalFont {
  family: string
  fullName: string
  postscriptName: string
  style: string
  source: 'system' | 'project'
}

export interface ResolvedFont {
  family: string
  weight: number
  italic: boolean
  found: boolean
  /** what we tried to match, for warnings */
  requested: string
}

let systemFonts: LocalFont[] | null = null
let projectFonts: LocalFont[] = []
let loading: Promise<LocalFont[]> | null = null

interface FontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
  blob?: () => Promise<Blob>
}

const fontHandles = new Map<string, FontData>()

export function loadSystemFonts(): Promise<LocalFont[]> {
  if (systemFonts) return Promise.resolve(systemFonts)
  if (loading) return loading
  loading = (async () => {
    try {
      const q = (window as unknown as { queryLocalFonts?: () => Promise<FontData[]> }).queryLocalFonts
      if (!q) throw new Error('queryLocalFonts not available')
      const list = await q.call(window)
      systemFonts = list.map((f) => ({ family: f.family, fullName: f.fullName, postscriptName: f.postscriptName, style: f.style, source: 'system' as const }))
      for (const f of list) fontHandles.set(f.postscriptName, f)
    } catch (e) {
      console.warn('queryLocalFonts failed', e)
      systemFonts = []
    }
    return systemFonts
  })()
  return loading
}

export function allFonts(): LocalFont[] {
  return [...projectFonts, ...(systemFonts ?? [])]
}

export function fontFamilies(): string[] {
  const set = new Set<string>()
  for (const f of allFonts()) set.add(f.family)
  return Array.from(set).sort((a, b) => a.localeCompare(b))
}

/** Loads <dir>/fonts/*.ttf|otf|woff|woff2 into the document so Pixi/Canvas can use them. */
export async function loadProjectFonts(dir: string | null): Promise<LocalFont[]> {
  for (const f of projectFonts) {
    const face = (f as LocalFont & { face?: FontFace }).face
    if (face) document.fonts.delete(face)
  }
  projectFonts = []
  if (!dir) return projectFonts
  const folder = `${dir}/fonts`
  if (!(await window.api.exists(folder))) return projectFonts
  const entries = await window.api.listDir(folder)
  for (const e of entries) {
    if (e.dir || !/\.(ttf|otf|woff2?)$/i.test(e.name)) continue
    const family = e.name.replace(/\.[^.]+$/, '')
    try {
      const data = await window.api.readFile(`${folder}/${e.name}`)
      const face = new FontFace(family, data as BufferSource)
      await face.load()
      document.fonts.add(face)
      const lf: LocalFont & { face?: FontFace } = { family, fullName: family, postscriptName: family, style: 'Regular', source: 'project', face }
      projectFonts.push(lf)
    } catch (err) {
      console.warn('project font failed', e.name, err)
    }
  }
  return projectFonts
}

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700]
]

export function weightFromStyle(style: string): number {
  for (const [re, w] of WEIGHTS) if (re.test(style)) return w
  return 400
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '')

/**
 * Maps a Photoshop font PostScript name (e.g. "Nunito-Black", "Alphakind") to an installed
 * font family + weight/italic. Falls back to the parsed family name when not installed.
 */
export function resolvePsdFont(psName: string | undefined): ResolvedFont {
  const requested = psName ?? ''
  const fonts = allFonts()
  const n = norm(requested)
  if (n) {
    const exact = fonts.find((f) => norm(f.postscriptName) === n || norm(f.fullName) === n)
    if (exact) return { family: exact.family, weight: weightFromStyle(exact.style), italic: /italic|oblique/i.test(exact.style), found: true, requested }
  }
  // split "Family-StyleWords"
  const dash = requested.indexOf('-')
  const base = dash > 0 ? requested.slice(0, dash) : requested
  const suffix = dash > 0 ? requested.slice(dash + 1) : ''
  const weight = weightFromStyle(suffix)
  const italic = /italic|oblique/i.test(suffix)
  const fam = fonts.find((f) => norm(f.family) === norm(base))
  if (fam) return { family: fam.family, weight, italic, found: true, requested }
  // family name may contain spaces in the system but not in the PS name: try prefix match
  const pref = fonts.find((f) => norm(requested).startsWith(norm(f.family)) && f.family.length >= 4)
  if (pref) {
    const rest = requested.slice(pref.family.replace(/\s/g, '').length)
    return { family: pref.family, weight: weightFromStyle(rest), italic: /italic|oblique/i.test(rest), found: true, requested }
  }
  return { family: base.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Arial', weight, italic, found: false, requested }
}

export interface ExportedFont {
  family: string
  weight: number
  italic: boolean
  /** file name inside export/fonts/ */
  file: string
  postscriptName: string
  source: 'system' | 'project'
}

function fontExt(bytes: Uint8Array): string {
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (tag === 'OTTO') return 'otf'
  if (tag === 'ttcf') return 'ttc'
  if (tag === 'wOFF') return 'woff'
  if (tag === 'wOF2') return 'woff2'
  return 'ttf'
}

/** Picks the installed / project font face closest to family + weight + italic. */
export function pickFontFace(family: string, weight: number, italic: boolean): LocalFont | null {
  const fam = family.toLowerCase()
  const cands = allFonts().filter((f) => f.family.toLowerCase() === fam)
  if (!cands.length) return null
  let best: LocalFont | null = null
  let bestScore = Infinity
  for (const c of cands) {
    const w = weightFromStyle(c.style)
    const it = /italic|oblique/i.test(c.style)
    const score = Math.abs(w - weight) + (it === italic ? 0 : 1000)
    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

/**
 * Writes the font files used by `faces` into <outDir>/fonts and returns their descriptors.
 * System fonts come from queryLocalFonts().blob(); project fonts are copied from <project>/fonts.
 */
export async function exportFontFiles(faces: { family: string; weight: number; italic: boolean }[], outDir: string, projectDir: string | null): Promise<ExportedFont[]> {
  await loadSystemFonts()
  const out: ExportedFont[] = []
  const done = new Set<string>()
  for (const req of faces) {
    const key = `${req.family}|${req.weight}|${req.italic}`
    if (done.has(key)) continue
    done.add(key)
    const face = pickFontFace(req.family, req.weight, req.italic)
    if (!face) continue
    try {
      await window.api.mkdir(`${outDir}/fonts`)
      if (face.source === 'project' && projectDir) {
        const entries = await window.api.listDir(`${projectDir}/fonts`)
        const e = entries.find((x) => x.name.replace(/\.[^.]+$/, '') === face.family)
        if (!e) continue
        await window.api.copyFile(`${projectDir}/fonts/${e.name}`, `${outDir}/fonts/${e.name}`)
        out.push({ family: req.family, weight: req.weight, italic: req.italic, file: `fonts/${e.name}`, postscriptName: face.postscriptName, source: 'project' })
        continue
      }
      const h = fontHandles.get(face.postscriptName)
      if (!h?.blob) continue
      const bytes = new Uint8Array(await (await h.blob()).arrayBuffer())
      const file = `fonts/${face.postscriptName.replace(/[^A-Za-z0-9_-]+/g, '_')}.${fontExt(bytes)}`
      await window.api.writeFile(`${outDir}/${file}`, bytes)
      out.push({ family: req.family, weight: req.weight, italic: req.italic, file, postscriptName: face.postscriptName, source: 'system' })
    } catch (e) {
      console.warn('font export failed', req.family, e)
    }
  }
  return out
}
