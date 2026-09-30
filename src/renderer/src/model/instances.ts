import type { ContainerNode, DesignDocument, InstanceNode, NodeId, Page, SceneNode } from './types'
import { isContainer } from './types'

/** Finds a component master (frame/group with `component`) by id anywhere in the document. */
export function findMaster(doc: DesignDocument, id: NodeId): { node: ContainerNode; page: Page } | null {
  for (const page of doc.pages) {
    const hit = findIn(page.children, id)
    if (hit) return { node: hit, page }
  }
  return null
}

function findIn(list: SceneNode[], id: NodeId): ContainerNode | null {
  for (const n of list) {
    if (!isContainer(n)) continue
    if (n.id === id && n.type !== 'instance' && n.component) return n
    if (n.type !== 'instance') {
      const r = findIn(n.children, id)
      if (r) return r
    }
  }
  return null
}

/** Instance child ids are deterministic: `<instanceId>:<masterChildId>` (nested masters keep chaining). */
export const instanceChildId = (instanceId: NodeId, masterChildId: NodeId): NodeId => `${instanceId}:${masterChildId}`

function cloneForInstance(n: SceneNode, inst: InstanceNode, depth: number): SceneNode {
  const copy = JSON.parse(JSON.stringify(n)) as SceneNode
  const masterId = n.id
  copy.id = instanceChildId(inst.id, masterId)
  copy.locked = true
  copy.meta = { ...(copy.meta ?? {}), instanceOf: masterId, fromInstance: inst.id }
  const ov = inst.overrides[masterId]
  if (ov) {
    if (ov.visible !== undefined) copy.visible = ov.visible
    if (ov.text !== undefined && copy.type === 'text') copy.text = ov.text
    if (ov.assetId !== undefined && (copy.type === 'image' || copy.type === 'nineslice')) copy.assetId = ov.assetId
  }
  if (isContainer(copy)) {
    if ('component' in copy) delete (copy as { component?: unknown }).component
    copy.children = (isContainer(n) ? n.children : []).map((c) => cloneForInstance(c, inst, depth + 1))
  }
  return copy
}

/**
 * Regenerates the derived `children` of every instance from its master (masters first so nested
 * instances inside masters are expanded before being copied). Called in the store's post-mutation pass.
 */
export function expandInstances(doc: DesignDocument): void {
  const visit = (list: SceneNode[], guard: Set<NodeId>): void => {
    for (const n of list) {
      if (!isContainer(n)) continue
      if (n.type === 'instance') {
        if (guard.has(n.componentId)) {
          n.children = []
          continue
        }
        const m = findMaster(doc, n.componentId)
        if (!m) {
          n.children = []
          continue
        }
        // make sure the master's own instances are expanded first
        visit(m.node.children, new Set([...guard, n.componentId]))
        n.children = m.node.children.map((c) => cloneForInstance(c, n, 0))
        n.width = m.node.width
        n.height = m.node.height
      } else visit(n.children, guard)
    }
  }
  for (const page of doc.pages) visit(page.children, new Set())
}

/** Component ids used by an instance subtree (for cycle checks). */
export function usesComponent(n: SceneNode, componentId: NodeId): boolean {
  if (n.type === 'instance' && n.componentId === componentId) return true
  return isContainer(n) && n.children.some((c) => usesComponent(c, componentId))
}
