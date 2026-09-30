// Maps Photoshop layer effects of a text layer to TextEffects that the live text renderer
// (Pixi TextStyle) and the Unity/TMP side can reproduce: stroke, drop shadow, outer glow,
// gradient overlay, color overlay. Everything else is listed in `unsupported`.
import type { LayerEffectsInfo } from 'ag-psd'
import type { RGBA, TextEffects } from '@/model/types'

type RGB = { r: number; g: number; b: number }
type Units = { value: number; units?: string } | undefined
const px = (u: Units, def = 0): number => (u && typeof u.value === 'number' ? u.value : def)
const rgba = (c: RGB | undefined, a: number): RGBA => ({ r: c?.r ?? 0, g: c?.g ?? 0, b: c?.b ?? 0, a: Math.max(0, Math.min(1, a)) })

function firstEnabled<T extends { enabled?: boolean }>(v: T | T[] | undefined): T | undefined {
  if (!v) return undefined
  const arr = Array.isArray(v) ? v : [v]
  return arr.find((e) => e && e.enabled)
}

export function textEffectsFromPsd(fx: LayerEffectsInfo | undefined, globalAngle: number | undefined): TextEffects | undefined {
  if (!fx || fx.disabled) return undefined
  const scale = typeof fx.scale === 'number' ? fx.scale : 1
  const out: TextEffects = {}
  const unsupported: string[] = []

  const stroke = firstEnabled(fx.stroke)
  if (stroke) {
    const fillType = (stroke.fillType as string | undefined) ?? 'color'
    let color: RGB | undefined = stroke.color as RGB | undefined
    if (fillType === 'gradient') {
      const stops = (stroke.gradient as { colorStops?: { color: RGB }[] } | undefined)?.colorStops
      color = stops?.[0]?.color ?? color
      unsupported.push('stroke-gradient')
    }
    out.stroke = { color: rgba(color, stroke.opacity ?? 1), width: Math.round(px(stroke.size as Units, 1) * scale * 100) / 100, position: ((stroke.position as string) ?? 'outside') as 'outside' | 'center' | 'inside' }
  }
  const shadow = firstEnabled(fx.dropShadow)
  if (shadow) {
    const angle = (shadow.useGlobalLight && typeof globalAngle === 'number' ? globalAngle : shadow.angle) ?? 120
    out.shadow = { color: rgba(shadow.color as RGB, shadow.opacity ?? 0.75), distance: px(shadow.distance as Units) * scale, angle, blur: px(shadow.size as Units) * scale }
  }
  const glow = firstEnabled(fx.outerGlow)
  if (glow) out.glow = { color: rgba(glow.color as RGB, glow.opacity ?? 0.75), size: px(glow.size as Units) * scale }

  const grad = firstEnabled(fx.gradientOverlay)
  if (grad) {
    const g = grad.gradient as { colorStops?: { color: RGB; location: number }[]; opacityStops?: { opacity: number; location: number }[] } | undefined
    const stops = (g?.colorStops ?? []).slice().sort((a, b) => a.location - b.location)
    const opStops = (g?.opacityStops ?? []).slice().sort((a, b) => a.location - b.location)
    const opacityAt = (loc: number): number => {
      if (!opStops.length) return 1
      if (loc <= opStops[0].location) return opStops[0].opacity
      for (let i = 1; i < opStops.length; i++) {
        if (loc <= opStops[i].location) {
          const a = opStops[i - 1]
          const b = opStops[i]
          const t = (loc - a.location) / Math.max(1, b.location - a.location)
          return a.opacity + (b.opacity - a.opacity) * t
        }
      }
      return opStops[opStops.length - 1].opacity
    }
    const overlayOpacity = grad.opacity ?? 1
    if (stops.length) {
      let list = stops.map((s) => ({ color: rgba(s.color, opacityAt(s.location) * overlayOpacity), pos: Math.max(0, Math.min(1, s.location / 4096)) }))
      if (grad.reverse) list = list.map((s) => ({ ...s, pos: 1 - s.pos })).reverse()
      out.gradient = { stops: list, angle: (grad.angle as number | undefined) ?? 90 }
      if ((grad.type as string | undefined) && grad.type !== 'linear') unsupported.push(`gradient-${grad.type}`)
    }
  }
  const solid = firstEnabled(fx.solidFill)
  if (solid) out.colorOverlay = rgba(solid.color as RGB, solid.opacity ?? 1)

  if (firstEnabled(fx.innerShadow)) unsupported.push('innerShadow')
  if (firstEnabled(fx.innerGlow)) unsupported.push('innerGlow')
  if (firstEnabled(fx.bevel)) unsupported.push('bevel')
  if (firstEnabled(fx.satin)) unsupported.push('satin')
  if (firstEnabled(fx.patternOverlay)) unsupported.push('patternOverlay')
  if (unsupported.length) out.unsupported = unsupported
  return Object.keys(out).length ? out : undefined
}
