import { getCurrentPage, useEditor } from '@/store/editor'
import { fitViewToRect, zoomAt, zoomToLevel } from '@/canvas/viewMath'
import { absRect, unionRects, type Rect } from '@/model/nodes'

export function zoomToFitAll(): void {
  const s = useEditor.getState()
  const page = getCurrentPage()
  const rects = page.children.map((n) => absRect(page, n.id)).filter((r): r is Rect => !!r)
  const u = unionRects(rects)
  if (u) s.setView(fitViewToRect(u, s.canvasSize.width, s.canvasSize.height))
}

export function zoomToSelection(): void {
  const s = useEditor.getState()
  const page = getCurrentPage()
  const rects = s.selection.map((id) => absRect(page, id)).filter((r): r is Rect => !!r)
  const u = unionRects(rects)
  if (u) s.setView(fitViewToRect(u, s.canvasSize.width, s.canvasSize.height))
  else zoomToFitAll()
}

export function zoomBy(factor: number): void {
  const s = useEditor.getState()
  s.setView(zoomAt(s.view, s.canvasSize.width / 2, s.canvasSize.height / 2, factor))
}

export function zoomTo(level: number): void {
  const s = useEditor.getState()
  s.setView(zoomToLevel(s.view, s.canvasSize.width, s.canvasSize.height, level))
}
