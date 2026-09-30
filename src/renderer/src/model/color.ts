import type { RGBA } from './types'

export function rgbaToHex(c: RGBA): string {
  const h = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

export function hexToRgba(hex: string, a = 1): RGBA | null {
  const m = hex.trim().replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(m) && !/^[0-9a-fA-F]{3}$/.test(m)) return null
  const full = m.length === 3 ? m.split('').map((ch) => ch + ch).join('') : m
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a
  }
}

export function rgbaToNumber(c: RGBA): number {
  return (Math.round(c.r) << 16) | (Math.round(c.g) << 8) | Math.round(c.b)
}

export function rgbaToCss(c: RGBA): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${c.a})`
}
