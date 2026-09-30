import { useEffect } from 'react'
import { useEditor } from '@/store/editor'
import { autoOpenLast, importPsdFiles, openProject } from '@/store/project'
import { Viewport } from '@/canvas/Viewport'
import { StatusBar, TopBar } from '@/ui/TopBar'
import { PagesPanel } from '@/ui/PagesPanel'
import { LayersPanel } from '@/ui/LayersPanel'
import { PropertiesPanel } from '@/ui/PropertiesPanel'
import { Present } from '@/ui/Present'
import { installShortcuts } from '@/ui/shortcuts'
import { installDebugApi } from '@/debug'
import { installBridge } from '@/bridge'
import { startAutosave } from '@/store/autosave'
import { ContextMenu } from '@/ui/ContextMenu'
import { NoticePanel } from '@/ui/NoticePanel'
import { ImportPsdDialog } from '@/ui/ImportPsdDialog'
import { ShortcutsDialog } from '@/ui/ShortcutsDialog'
import { LayerStyleDialog } from '@/ui/LayerStyleDialog'
import { AssetsPanel } from '@/ui/AssetsPanel'
import { GamePanel, GameSyncDialog } from '@/ui/GamePanel'
import { DevicePreview } from '@/ui/DevicePreview'
import { ImageEditDialog } from '@/ui/ImageEditDialog'
import { useState } from 'react'
import { loadSystemFonts } from '@/store/fonts'
import { initTheme } from '@/store/theme'

export default function App(): React.JSX.Element {
  const presenting = useEditor((s) => s.presenting)
  const [leftTab, setLeftTab] = useState<'layers' | 'assets' | 'game'>('layers')
  const hasGame = useEditor((s) => !!s.doc.game)
  useEffect(() => {
    const un = installShortcuts()
    installDebugApi()
    installBridge()
    const stopAutosave = startAutosave()
    initTheme()
    void loadSystemFonts()
    // files dropped outside a drop target must not navigate the window away from the app
    const noNav = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', noNav)
    window.addEventListener('drop', noNav)
    // automation hooks (env vars in main) run sequentially
    let chain: Promise<unknown> = Promise.resolve()
    let autoProject = false
    window.api.onAuto('auto:openProject', (dir) => {
      autoProject = true
      chain = chain.then(() => openProject(dir))
    })
    window.api.onAuto('auto:importPsd', (p) => {
      let req: { path: string; split?: boolean } = { path: p }
      try {
        req = JSON.parse(p) as { path: string; split?: boolean }
      } catch {
        /* plain path */
      }
      chain = chain.then(() => importPsdFiles([req.path], req.split ? { mode: 'split' } : {}))
    })
    setTimeout(() => {
      if (!autoProject) chain = chain.then(() => autoOpenLast())
    }, 50)
    return () => {
      un()
      stopAutosave()
      window.removeEventListener('dragover', noNav)
      window.removeEventListener('drop', noNav)
    }
  }, [])
  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <aside className="left">
          <div className="rp-tabs">
            <button className={leftTab === 'layers' ? 'active' : ''} onClick={() => setLeftTab('layers')}>
              Layers
            </button>
            <button className={leftTab === 'assets' ? 'active' : ''} onClick={() => setLeftTab('assets')}>
              Assets
            </button>
            <button className={leftTab === 'game' ? 'active' : ''} onClick={() => setLeftTab('game')} title="Art + thay đổi của game đang nối với project này">
              Game{hasGame ? ' •' : ''}
            </button>
          </div>
          {leftTab === 'layers' ? (
            <>
              <PagesPanel />
              <LayersPanel />
            </>
          ) : leftTab === 'assets' ? (
            <AssetsPanel />
          ) : (
            <GamePanel />
          )}
        </aside>
        <Viewport />
        <aside className="right">
          <PropertiesPanel />
        </aside>
      </div>
      <StatusBar />
      <ContextMenu />
      <NoticePanel />
      <ImportPsdDialog />
      <ShortcutsDialog />
      <LayerStyleDialog />
      <DevicePreview />
      <ImageEditDialog />
      <GameSyncDialog />
      {presenting && <Present />}
    </div>
  )
}
