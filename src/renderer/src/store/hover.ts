import { create } from 'zustand'
import type { NodeId } from '@/model/types'

/**
 * Hover state lives outside the editor store: it changes on every mouse move and must not
 * re-render the panels. Only the canvas overlay and the hovered layer row subscribe to it.
 */
interface HoverState {
  hoverId: NodeId | null
  setHover: (id: NodeId | null) => void
}

export const useHover = create<HoverState>((set, get) => ({
  hoverId: null,
  setHover: (hoverId) => {
    if (get().hoverId !== hoverId) set({ hoverId })
  }
}))
