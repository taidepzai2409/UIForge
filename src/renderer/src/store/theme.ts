import { create } from 'zustand'

export type ThemePref = 'auto' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'uiforge.theme'
const mq = window.matchMedia('(prefers-color-scheme: dark)')

function readPref(): ThemePref {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'auto'
}

function resolve(pref: ThemePref): Theme {
  if (pref === 'auto') return mq.matches ? 'dark' : 'light'
  return pref
}

interface ThemeState {
  pref: ThemePref
  theme: Theme
  setPref: (p: ThemePref) => void
}

export const useTheme = create<ThemeState>((set, get) => ({
  pref: readPref(),
  theme: resolve(readPref()),
  setPref: (pref) => {
    localStorage.setItem(KEY, pref)
    set({ pref, theme: resolve(pref) })
    applyTheme(get().theme)
  }
}))

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t
}

/** Colours the Pixi canvas + overlay need (kept in sync with the CSS variables). */
export function canvasPalette(t: Theme = useTheme.getState().theme): { bg: number; ruler: number; rulerLine: number; rulerText: number; label: number; frameShadow: number } {
  return t === 'dark'
    ? { bg: 0x1e1e1e, ruler: 0x2c2c2c, rulerLine: 0x444444, rulerText: 0x8c8c8c, label: 0x9a9a9a, frameShadow: 0x000000 }
    : { bg: 0xf5f5f5, ruler: 0xffffff, rulerLine: 0xe0e0e0, rulerText: 0x8c8c8c, label: 0x7a7a7a, frameShadow: 0x000000 }
}

export function initTheme(): void {
  applyTheme(useTheme.getState().theme)
  mq.addEventListener('change', () => {
    const s = useTheme.getState()
    if (s.pref === 'auto') {
      useTheme.setState({ theme: resolve('auto') })
      applyTheme(resolve('auto'))
    }
  })
}
