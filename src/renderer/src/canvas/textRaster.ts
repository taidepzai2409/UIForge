// Rasterizes a TextNode with Canvas2D using the same metrics/placement rules as the Pixi
// text renderer (baseline = ascent + (lineHeight - fontHeight)/2), so text with Photoshop
// layer styles can go through the exact same effects pipeline as image layers.
import { CanvasTextMetrics } from 'pixi.js'
import type { TextNode } from '@/model/types'
import { rgbaToCss } from '@/model/color'

export interface TextRaster {
  canvas: HTMLCanvasElement
  /** offset of the canvas relative to the node's top-left, in node px */
  left: number
  top: number
}

export function textFontString(n: TextNode, scale = 1): string {
  return `${n.italic ? 'italic ' : ''}${n.fontWeight} ${n.fontSize * scale}px "${n.fontFamily}", Arial, sans-serif`
}

export function rasterizeText(n: TextNode, scale = 1): TextRaster {
  const font = textFontString(n, scale)
  const fp = CanvasTextMetrics.measureFont(font)
  const text = n.uppercase ? n.text.toUpperCase() : n.text
  const lines = text.split('\n')
  const lh = n.fontSize * n.lineHeight * scale
  const ls = (n.letterSpacing ?? 0) * scale
  const pad = Math.ceil(n.fontSize * scale * 0.6) + 2
  const meas = document.createElement('canvas').getContext('2d')!
  meas.font = font
  ;(meas as unknown as { letterSpacing: string }).letterSpacing = `${ls}px`
  const widths = lines.map((l) => meas.measureText(l).width + Math.max(0, l.length - 1) * 0)
  const boxW = Math.max(n.width * scale, ...widths)
  const w = Math.ceil(boxW + pad * 2)
  const h = Math.ceil(lh * lines.length + pad * 2)
  const c = document.createElement('canvas')
  c.width = Math.max(1, w)
  c.height = Math.max(1, h)
  const g = c.getContext('2d')!
  g.font = font
  ;(g as unknown as { letterSpacing: string }).letterSpacing = `${ls}px`
  g.textBaseline = 'alphabetic'
  g.fillStyle = rgbaToCss(n.color)
  lines.forEach((line, i) => {
    const lw = widths[i]
    let x = pad
    if (n.align === 'center') x = pad + (n.width * scale - lw) / 2
    else if (n.align === 'right') x = pad + n.width * scale - lw
    const y = pad + i * lh + fp.ascent + (lh - fp.fontSize) / 2
    g.fillText(line, x, y)
  })
  return { canvas: c, left: -pad / scale, top: -pad / scale }
}
