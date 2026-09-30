import { create } from 'zustand'
import type { BuildOptions, ParsedPsd } from '@/psd/importPsd'

export interface ImportChoice {
  mode: 'single' | 'split'
  groupIndexes: number[]
  includeLooseLayers: boolean
  includeHiddenLoose: boolean
  textMode: BuildOptions['textMode']
  autoAnchor?: boolean
}

interface ImportDialogState {
  pending: { parsed: ParsedPsd; resolve: (choice: ImportChoice | null) => void } | null
  ask: (parsed: ParsedPsd) => Promise<ImportChoice | null>
  answer: (choice: ImportChoice | null) => void
}

export const useImportDialog = create<ImportDialogState>((set, get) => ({
  pending: null,
  ask: (parsed) =>
    new Promise<ImportChoice | null>((resolve) => {
      set({ pending: { parsed, resolve } })
    }),
  answer: (choice) => {
    const p = get().pending
    set({ pending: null })
    p?.resolve(choice)
  }
}))

const PREF_KEY = 'uiforge.importPrefs'

export function loadImportPrefs(): Partial<ImportChoice> {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<ImportChoice>
  } catch {
    return {}
  }
}

export function saveImportPrefs(c: ImportChoice): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ includeLooseLayers: c.includeLooseLayers, includeHiddenLoose: c.includeHiddenLoose, textMode: c.textMode }))
  } catch {
    /* ignore */
  }
}
