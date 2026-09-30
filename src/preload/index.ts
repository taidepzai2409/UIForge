import { contextBridge, ipcRenderer } from 'electron'

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface MessageOpts {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  title?: string
  message: string
  detail?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
}

const api = {
  openFiles: (opts: { filters?: FileFilter[]; multi?: boolean; title?: string; defaultPath?: string }): Promise<string[]> =>
    ipcRenderer.invoke('dialog:openFiles', opts),
  openFolder: (opts?: { title?: string; defaultPath?: string }): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder', opts ?? {}),
  saveFile: (opts: { defaultPath?: string; filters?: FileFilter[]; title?: string }): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', opts),
  message: (opts: MessageOpts): Promise<number> => ipcRenderer.invoke('dialog:message', opts),
  readFile: (p: string): Promise<Uint8Array> => ipcRenderer.invoke('fs:readFile', p),
  readText: (p: string): Promise<string> => ipcRenderer.invoke('fs:readText', p),
  writeFile: (p: string, data: Uint8Array | string): Promise<void> => ipcRenderer.invoke('fs:writeFile', p, data),
  exists: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:exists', p),
  mkdir: (p: string): Promise<void> => ipcRenderer.invoke('fs:mkdir', p),
  listDir: (p: string): Promise<{ name: string; dir: boolean }[]> => ipcRenderer.invoke('fs:listDir', p),
  copyFile: (from: string, to: string): Promise<void> => ipcRenderer.invoke('fs:copyFile', from, to),
  remove: (p: string): Promise<void> => ipcRenderer.invoke('fs:remove', p),
  stat: (p: string): Promise<{ mtimeMs: number; size: number; dir: boolean } | null> => ipcRenderer.invoke('fs:stat', p),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p: string): Promise<void> => ipcRenderer.invoke('shell:showItem', p),
  appInfo: (): Promise<{ documents: string; userData: string; version: string; platform: string; noRecovery?: boolean }> =>
    ipcRenderer.invoke('app:info'),
  setTitle: (t: string): Promise<void> => ipcRenderer.invoke('win:setTitle', t),
  copyText: (t: string): Promise<void> => ipcRenderer.invoke('clipboard:writeText', t),
  readClipboardText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText'),
  onAuto: (channel: 'auto:openProject' | 'auto:importPsd' | 'auto:script', cb: (arg: string) => void): void => {
    ipcRenderer.on(channel, (_e, arg) => cb(arg))
  },
  onBridgeRequest: (cb: (msg: { id: string; method: string; params?: Record<string, unknown> }) => void): void => {
    ipcRenderer.on('bridge:request', (_e, msg) => cb(msg))
  },
  sendBridgeResponse: (msg: { id: string; result?: unknown; error?: string }): void => {
    ipcRenderer.send('bridge:response', msg)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
