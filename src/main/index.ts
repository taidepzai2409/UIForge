import { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, clipboard } from 'electron'
import { join, dirname } from 'node:path'
import { promises as fs } from 'node:fs'
import { startBridge } from './bridge'
import { captureGame, closeCaptureWindow, type CaptureRecipe } from './capture'
import { runAgent, stopAgent } from './agent'

if (process.env.DM_USER_DATA) app.setPath('userData', process.env.DM_USER_DATA)

const isDev = !app.isPackaged
let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    show: false,
    title: 'UIForge',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // keep requestAnimationFrame running when the window is covered (prototype player, headless tests)
      backgroundThrottling: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  // --- automation hooks for testing (env vars) ---
  win.webContents.on('did-finish-load', () => {
    const w = win!
    if (process.env.DM_PROJECT) w.webContents.send('auto:openProject', process.env.DM_PROJECT)
    if (process.env.DM_OPEN_PSD) w.webContents.send('auto:importPsd', JSON.stringify({ path: process.env.DM_OPEN_PSD, split: !!process.env.DM_IMPORT_SPLIT }))
    if (process.env.DM_SCRIPT) {
      const scriptPath = process.env.DM_SCRIPT
      setTimeout(async () => {
        try {
          const code = await fs.readFile(scriptPath, 'utf8')
          const result = await w.webContents.executeJavaScript(code, true)
          console.log('[script] result:', typeof result === 'string' ? result : JSON.stringify(result))
        } catch (e) {
          console.error('[script] failed:', e)
        }
      }, Number(process.env.DM_SCRIPT_DELAY ?? 1500))
    }
    if (process.env.DM_SCREENSHOT) {
      const delay = Number(process.env.DM_SCREENSHOT_DELAY ?? 3000)
      setTimeout(async () => {
        try {
          const img = await w.webContents.capturePage()
          await fs.writeFile(process.env.DM_SCREENSHOT!, img.toPNG())
        } catch (e) {
          console.error('screenshot failed', e)
        }
        if (process.env.DM_EXIT_AFTER) app.quit()
      }, delay)
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => logCrash(`renderer gone: ${details.reason} exit=${details.exitCode}`))
  win.webContents.on('unresponsive', () => logCrash('renderer unresponsive'))
  win.webContents.on('console-message', (ev) => {
    if (process.env.DM_LOG_CONSOLE) console.log(`[renderer:${ev.level}] ${ev.message}`)
  })
}

function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { role: 'toggleDevTools', accelerator: 'F12' },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: 'F11' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function setupIpc(): void {
  ipcMain.handle('dialog:openFiles', async (_e, opts: { filters?: Electron.FileFilter[]; multi?: boolean; title?: string; defaultPath?: string }) => {
    const r = await dialog.showOpenDialog(win!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
      properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile']
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('dialog:openFolder', async (_e, opts: { title?: string; defaultPath?: string }) => {
    const r = await dialog.showOpenDialog(win!, { title: opts?.title, defaultPath: opts?.defaultPath, properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:saveFile', async (_e, opts: { defaultPath?: string; filters?: Electron.FileFilter[]; title?: string }) => {
    const r = await dialog.showSaveDialog(win!, opts)
    return r.canceled ? null : r.filePath
  })
  ipcMain.handle('dialog:message', async (_e, opts: Electron.MessageBoxOptions) => {
    // headless tests: DM_AUTO_DIALOG=<button index> answers every dialog without showing it
    if (process.env.DM_AUTO_DIALOG !== undefined) {
      console.log('[dialog]', opts.message, '->', process.env.DM_AUTO_DIALOG)
      return Number(process.env.DM_AUTO_DIALOG)
    }
    const r = await dialog.showMessageBox(win!, opts)
    return r.response
  })
  ipcMain.handle('fs:readFile', async (_e, p: string) => {
    const buf = await fs.readFile(p)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  })
  ipcMain.handle('fs:readText', async (_e, p: string) => fs.readFile(p, 'utf8'))
  ipcMain.handle('fs:writeFile', async (_e, p: string, data: Uint8Array | string) => {
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, data)
  })
  ipcMain.handle('fs:exists', async (_e, p: string) => {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('fs:mkdir', async (_e, p: string) => {
    await fs.mkdir(p, { recursive: true })
  })
  ipcMain.handle('fs:listDir', async (_e, p: string) => {
    const entries = await fs.readdir(p, { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }))
  })
  ipcMain.handle('fs:copyFile', async (_e, from: string, to: string) => {
    await fs.mkdir(dirname(to), { recursive: true })
    await fs.copyFile(from, to)
  })
  ipcMain.handle('fs:remove', async (_e, p: string) => {
    await fs.rm(p, { recursive: true, force: true })
  })
  ipcMain.handle('fs:stat', async (_e, p: string) => {
    try {
      const st = await fs.stat(p)
      return { mtimeMs: st.mtimeMs, size: st.size, dir: st.isDirectory() }
    } catch {
      return null
    }
  })
  ipcMain.handle('shell:openPath', async (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:showItem', async (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('app:info', async () => ({
    documents: app.getPath('documents'),
    userData: app.getPath('userData'),
    version: app.getVersion(),
    platform: process.platform,
    noRecovery: !!process.env.DM_NO_RECOVERY
  }))
  ipcMain.handle('win:setTitle', async (_e, t: string) => win?.setTitle(t))
  ipcMain.handle('clipboard:writeText', async (_e, t: string) => clipboard.writeText(t))
  ipcMain.handle('clipboard:readText', async () => clipboard.readText())
  ipcMain.handle('agent:run', async (_e, opts: { cwd: string; prompt: string }) => runAgent(() => win, opts))
  ipcMain.handle('agent:stop', async () => stopAgent())
  ipcMain.handle('game:capture', async (_e, recipe: CaptureRecipe) => captureGame(recipe))
  ipcMain.handle('game:captureReset', async () => closeCaptureWindow())
}

function logCrash(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}
`
  console.error('[crash]', msg)
  fs.appendFile(join(app.getPath('userData'), 'crash.log'), line).catch(() => {})
}

app.on('child-process-gone', (_e, d) => logCrash(`child gone: ${d.type} ${d.reason}`))

// Windows marks a covered window as occluded and stops requestAnimationFrame → prototype animations and
// headless tests would freeze whenever another window overlaps the app. Disable occlusion tracking.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

app.whenReady().then(() => {
  // allow window.queryLocalFonts() so the renderer can list installed Windows/macOS fonts
  const allowed = new Set(['local-fonts', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  setupMenu()
  setupIpc()
  createWindow()
  // bridge methods answered by the main process itself (everything else goes to the renderer)
  startBridge(() => win, Number(process.env.DM_BRIDGE_PORT ?? 47821), {
    captureGame: (p) => captureGame(p as unknown as CaptureRecipe)
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => closeCaptureWindow())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
