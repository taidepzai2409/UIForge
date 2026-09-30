// Auto-save + crash recovery. Every AUTOSAVE_MS while the document is dirty a full draft
// (project.json + assets) is written to:
//   <project>/.autosave/           for saved projects
//   <userData>/autosave/untitled/  for unsaved documents
// On start / open, a newer draft than the real project.json is offered for recovery.
import type { DesignDocument } from '@/model/types'
import { useEditor } from './editor'
import { flushDraftAssets, clearAssetCache, setAssetProjectDir } from './assets'
import { loadProjectFonts } from './fonts'

export const AUTOSAVE_MS = 30_000
let timer: number | null = null
let saving = false
let lastSavedDoc: DesignDocument | null = null
let userData: string | null = null

async function userDataDir(): Promise<string> {
  if (!userData) userData = (await window.api.appInfo()).userData
  return userData
}

export async function draftDirFor(projectDir: string | null): Promise<string> {
  return projectDir ? `${projectDir}/.autosave` : `${await userDataDir()}/autosave/untitled`
}

/** Writes the draft now (no-op when nothing changed since the last draft/save). */
export async function autosaveNow(force = false): Promise<string | null> {
  const s = useEditor.getState()
  if (saving) return null
  if (!force && (!s.dirty || s.doc === lastSavedDoc)) return null
  saving = true
  try {
    const dir = await draftDirFor(s.projectDir)
    await window.api.mkdir(dir)
    const doc = s.doc
    // assets: saved projects already have them on disk (flushAssetsToDisk skips persisted ones);
    // untitled drafts get a full copy in the draft folder
    if (!s.projectDir) await flushDraftAssets(dir, doc.assets)
    await window.api.writeFile(`${dir}/project.json`, JSON.stringify({ ...doc, autosavedAt: new Date().toISOString() }))
    lastSavedDoc = s.doc
    return dir
  } catch (e) {
    console.warn('autosave failed', e)
    return null
  } finally {
    saving = false
  }
}

/** Called after a real save: the draft is stale now. */
export async function discardDraft(projectDir: string | null): Promise<void> {
  try {
    const dir = await draftDirFor(projectDir)
    if (await window.api.exists(`${dir}/project.json`)) await window.api.remove(dir)
  } catch (e) {
    console.warn('discard draft failed', e)
  }
  lastSavedDoc = useEditor.getState().doc
}

export function startAutosave(): () => void {
  if (timer) window.clearInterval(timer)
  void window.api.appInfo().then((i) => {
    if (i.noRecovery && timer) {
      window.clearInterval(timer)
      timer = null
    }
  })
  timer = window.setInterval(() => void autosaveNow(), AUTOSAVE_MS)
  const onHide = (): void => {
    if (document.visibilityState === 'hidden') void autosaveNow()
  }
  document.addEventListener('visibilitychange', onHide)
  return () => {
    if (timer) window.clearInterval(timer)
    timer = null
    document.removeEventListener('visibilitychange', onHide)
  }
}

interface Draft {
  dir: string
  savedAt: string
  doc: DesignDocument & { autosavedAt?: string }
}

/** Newer draft than the project's own file (or any untitled draft). */
export async function findDraft(projectDir: string | null): Promise<Draft | null> {
  try {
    const dir = await draftDirFor(projectDir)
    const file = `${dir}/project.json`
    if (!(await window.api.exists(file))) return null
    const doc = JSON.parse(await window.api.readText(file)) as Draft['doc']
    const savedAt = doc.autosavedAt ?? ''
    if (projectDir) {
      const real = await window.api.stat(`${projectDir}/project.json`)
      // drafts are deleted on every save, so one that survives is newer unless it is clearly older than the file
      if (real && savedAt && new Date(savedAt).getTime() < real.mtimeMs - 2000) return null
    }
    return { dir, savedAt, doc }
  } catch (e) {
    console.warn('findDraft failed', e)
    return null
  }
}

/** Offers to restore a draft; returns true when restored. */
export async function offerRecovery(projectDir: string | null): Promise<boolean> {
  if ((await window.api.appInfo()).noRecovery) return false
  const d = await findDraft(projectDir)
  if (!d) return false
  const when = d.savedAt ? new Date(d.savedAt).toLocaleString() : '?'
  const r = await window.api.message({
    type: 'question',
    message: projectDir ? `Có bản nháp tự lưu mới hơn (${when}) của project này.` : `Có bản nháp chưa lưu (${when}) từ lần trước.`,
    detail: projectDir ? 'Khôi phục bản nháp? (Chọn "Bỏ" để giữ file đã lưu; bản nháp sẽ bị xoá)' : 'Khôi phục bản nháp?',
    buttons: ['Khôi phục', 'Bỏ'],
    defaultId: 0,
    cancelId: 1
  })
  if (r !== 0) {
    await discardDraft(projectDir)
    return false
  }
  const s = useEditor.getState()
  const { autosavedAt: _a, ...doc } = d.doc
  void _a
  if (!projectDir) {
    // untitled: assets live in the draft folder
    clearAssetCache()
    setAssetProjectDir(d.dir)
    await loadProjectFonts(null)
  }
  s.setDoc(doc as DesignDocument, projectDir)
  useEditor.setState({ dirty: true })
  lastSavedDoc = null
  s.setStatus(`Đã khôi phục bản nháp ${when} — nhớ Ctrl+S để lưu`)
  return true
}
