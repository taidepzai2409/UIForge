import { Texture } from 'pixi.js'
import type { Asset } from '@/model/types'

/**
 * Asset byte store. Assets live in memory until the project is saved,
 * then in `<projectDir>/assets/<file>`. Textures/blob URLs are cached per asset id.
 */
const bytes = new Map<string, Uint8Array>()
const persisted = new Set<string>()
const blobUrls = new Map<string, string>()
const textures = new Map<string, Texture>()
const pendingTex = new Map<string, Promise<Texture>>()
let projectDir: string | null = null

export function setAssetProjectDir(dir: string | null): void {
  projectDir = dir
  persisted.clear()
}

export function assetPath(dir: string, asset: Asset): string {
  return `${dir}/assets/${asset.file}`
}

export function putAssetBytes(id: string, data: Uint8Array, isPersisted = false): void {
  // ids are content hashes: same id ⇒ same bytes, keep the live texture (it may be on screen)
  if (bytes.has(id)) {
    if (isPersisted) persisted.add(id)
    return
  }
  bytes.set(id, data)
  if (isPersisted) persisted.add(id)
  else persisted.delete(id)
  // invalidate caches
  const url = blobUrls.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    blobUrls.delete(id)
  }
  const t = textures.get(id)
  if (t) {
    t.destroy(true)
    textures.delete(id)
  }
  pendingTex.delete(id)
}

/** Copies every in-memory asset into <dir>/assets without touching the project/persisted state (autosave drafts). */
export async function flushDraftAssets(dir: string, assets: Record<string, Asset>): Promise<number> {
  let n = 0
  await window.api.mkdir(`${dir}/assets`)
  for (const asset of Object.values(assets)) {
    const data = bytes.get(asset.id)
    if (!data) continue
    const p = assetPath(dir, asset)
    if (await window.api.exists(p)) continue
    await window.api.writeFile(p, data)
    n++
  }
  return n
}

export function hasAssetBytes(id: string): boolean {
  return bytes.has(id)
}

export async function getAssetBytes(asset: Asset): Promise<Uint8Array | null> {
  const cached = bytes.get(asset.id)
  if (cached) return cached
  if (!projectDir) return null
  try {
    const data = await window.api.readFile(assetPath(projectDir, asset))
    bytes.set(asset.id, data)
    persisted.add(asset.id)
    return data
  } catch (e) {
    console.warn('asset missing', asset, e)
    return null
  }
}

export async function getBlobUrl(asset: Asset): Promise<string | null> {
  const u = blobUrls.get(asset.id)
  if (u) return u
  const data = await getAssetBytes(asset)
  if (!data) return null
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'image/png' }))
  blobUrls.set(asset.id, url)
  return url
}

export function getTextureSync(id: string): Texture | undefined {
  return textures.get(id)
}

export function getTexture(asset: Asset): Promise<Texture> {
  const t = textures.get(asset.id)
  if (t) return Promise.resolve(t)
  const p = pendingTex.get(asset.id)
  if (p) return p
  const promise = (async () => {
    const data = await getAssetBytes(asset)
    if (!data) throw new Error(`asset ${asset.id} not found`)
    const blob = new Blob([data as BlobPart], { type: 'image/png' })
    const bitmap = await createImageBitmap(blob)
    const tex = Texture.from(bitmap)
    tex.source.scaleMode = 'linear'
    textures.set(asset.id, tex)
    pendingTex.delete(asset.id)
    return tex
  })()
  pendingTex.set(asset.id, promise)
  return promise
}

/** Writes every in-memory asset that is not yet on disk in `dir`. */
export async function flushAssetsToDisk(dir: string, assets: Record<string, Asset>): Promise<number> {
  let n = 0
  await window.api.mkdir(`${dir}/assets`)
  for (const asset of Object.values(assets)) {
    if (persisted.has(asset.id) && dir === projectDir) continue
    const data = bytes.get(asset.id)
    if (!data) {
      // not loaded in memory: copy the file from the current project / draft folder (Save As, recovery)
      if (projectDir && dir !== projectDir) {
        try {
          await window.api.copyFile(assetPath(projectDir, asset), assetPath(dir, asset))
          n++
        } catch (e) {
          console.warn('asset copy failed', asset.file, e)
        }
      }
      continue
    }
    await window.api.writeFile(assetPath(dir, asset), data)
    n++
  }
  projectDir = dir
  for (const id of bytes.keys()) persisted.add(id)
  return n
}

export function clearAssetCache(): void {
  for (const u of blobUrls.values()) URL.revokeObjectURL(u)
  blobUrls.clear()
  // Do NOT destroy the textures here: sprites of the previous document (main viewport, Present, device
  // preview) may still reference them until the next sync, and rendering a destroyed texture crashes Pixi
  // ("Cannot read properties of null (reading 'alphaMode')"). Pixi's TextureGC unloads unused ones from the GPU.
  textures.clear()
  pendingTex.clear()
  bytes.clear()
  persisted.clear()
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function pngFromCanvas(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) throw new Error('toBlob failed')
  return new Uint8Array(await blob.arrayBuffer())
}

export { safeFileName } from '@/model/naming'
