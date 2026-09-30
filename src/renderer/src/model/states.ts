// Component states: inside a component master, direct children named normal / hover / pressed /
// disabled / selected (optionally "state=pressed" or "state_pressed") are state layers. Only one
// is visible at a time in the design; the exporter lists them so Unity can build a Button
// with SpriteState / an Animator. Pure module (used by MCP + export).
import type { ContainerNode, NodeId, SceneNode } from './types'
import { isContainer } from './types'

export const STATE_NAMES = ['normal', 'hover', 'pressed', 'disabled', 'selected'] as const
export type StateName = (typeof STATE_NAMES)[number]

export function stateNameOf(nodeName: string): StateName | null {
  const n = nodeName
    .trim()
    .toLowerCase()
    .replace(/^state[=_\-\s]*/, '')
    .replace(/^(btn|button)[_\-\s]+/, '')
  return (STATE_NAMES as readonly string[]).includes(n) ? (n as StateName) : null
}

/** state → direct child of the master (only when the master has a "normal" state or ≥ 2 states). */
export function stateChildren(master: ContainerNode): Partial<Record<StateName, SceneNode>> {
  const out: Partial<Record<StateName, SceneNode>> = {}
  for (const c of master.children) {
    const s = stateNameOf(c.name)
    if (s && !out[s]) out[s] = c
  }
  const n = Object.keys(out).length
  if (n === 0 || (n === 1 && !out.normal)) return {}
  return out
}

export function hasStates(master: ContainerNode): boolean {
  return Object.keys(stateChildren(master)).length > 0
}

/** Ids of state layers → state name, for export. */
export function stateMap(master: ContainerNode): Record<string, NodeId> | undefined {
  const sc = stateChildren(master)
  const keys = Object.keys(sc) as StateName[]
  if (!keys.length) return undefined
  const m: Record<string, NodeId> = {}
  for (const k of keys) m[k] = sc[k]!.id
  return m
}

/** First image/nineslice inside a state layer (the sprite Unity swaps to). */
export function stateSprite(layer: SceneNode): SceneNode | null {
  if (layer.type === 'image' || layer.type === 'nineslice') return layer
  if (!isContainer(layer)) return null
  for (const c of layer.children) {
    const r = stateSprite(c)
    if (r) return r
  }
  return null
}
