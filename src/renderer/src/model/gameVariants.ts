// Art options: several generated versions of one asset (v1 / v2 / v3…) waiting for the board to pick one,
// shown on the real screens. Previewing an option puts its art everywhere the asset is used; choosing one
// keeps it and records the decision (the art agent reads it back to learn the board's taste).
// Pure module (no DOM / Pixi): rules used by the store, the bridge and the MCP server.
import type { DesignDocument, NodeId } from './types'
import { replaceGameSource, setNodeArt } from './game'

export type VariantTarget = { kind: 'file'; source: string } | { kind: 'node'; nodeId: NodeId }

export interface VariantOption {
  id: string
  /** v1 / v2 / A… (from the file name) */
  label: string
  assetId: string
  /** file it came from */
  file: string
}

export interface VariantSet {
  /** stage name of the asset (file base name, or the drawn element's name) */
  name: string
  target: VariantTarget
  /** art before any option was previewed: "Gốc" */
  originalAssetId: string
  options: VariantOption[]
  /** option on screen now; undefined = the original */
  active?: string
  createdAt: string
}

export interface VariantDecision {
  name: string
  target: VariantTarget
  /** label of the chosen option, or null when all were dropped */
  chosen: string | null
  rejected: string[]
  files: { label: string; file: string }[]
  at: string
}

export function variantKey(t: VariantTarget): string {
  return t.kind === 'file' ? `file:${t.source}` : `node:${t.nodeId}`
}

/** v1 / v2 / A … from "btn_v2.png", "btn-3.png", "btn_b.png"; null when the name has no option suffix */
export function variantLabel(fileName: string): string | null {
  const stem = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  const m = /[_\-. ](v?\d{1,2}|[a-e])$/i.exec(stem)
  if (!m) return null
  const s = m[1].toLowerCase()
  return /^\d+$/.test(s) ? `v${Number(s)}` : s.startsWith('v') ? `v${Number(s.slice(1))}` : s.toUpperCase()
}

/** "btn_primary_v2" → "btn_primary" */
export function stripVariant(stem: string): string {
  return stem.replace(/[_\-. ](v?\d{1,2}|[a-e])$/i, '')
}

/** Puts an option's art (or the original) on screen. Call on an immer draft. */
export function showVariant(doc: DesignDocument, key: string, optionId: string | null): boolean {
  const set = doc.game?.variants?.[key]
  if (!set) return false
  const opt = optionId ? set.options.find((o) => o.id === optionId) : undefined
  if (optionId && !opt) return false
  const assetId = opt ? opt.assetId : set.originalAssetId
  if (set.target.kind === 'file') replaceGameSource(doc, set.target.source, assetId)
  else setNodeArt(doc, set.target.nodeId, assetId)
  if (opt) set.active = opt.id
  else delete set.active
  return true
}

/** Keeps an option (or, with null, the original) and records the decision. Call on an immer draft. */
export function decideVariant(doc: DesignDocument, key: string, optionId: string | null): VariantDecision | null {
  const link = doc.game
  const set = link?.variants?.[key]
  if (!link || !set) return null
  showVariant(doc, key, optionId)
  const chosen = optionId ? (set.options.find((o) => o.id === optionId)?.label ?? null) : null
  const d: VariantDecision = {
    name: set.name,
    target: set.target,
    chosen,
    rejected: set.options.filter((o) => o.id !== optionId).map((o) => o.label),
    files: set.options.map((o) => ({ label: o.label, file: o.file })),
    at: new Date().toISOString()
  }
  ;(link.variantLog ??= []).push(d)
  delete link.variants![key]
  return d
}

/** Labels that appear in more than one pending set (to preview a whole direction at once). */
export function variantLabels(doc: DesignDocument): string[] {
  const n = new Map<string, number>()
  for (const s of Object.values(doc.game?.variants ?? {})) for (const o of s.options) n.set(o.label, (n.get(o.label) ?? 0) + 1)
  return Array.from(n.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** Pending sets whose screen shows an option that is not chosen yet (Sync must not write those). */
export function unresolvedPreviews(doc: DesignDocument): VariantSet[] {
  return Object.values(doc.game?.variants ?? {}).filter((s) => !!s.active)
}
