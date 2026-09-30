// Local automation bridge: HTTP on 127.0.0.1 → IPC → renderer handlers (src/renderer/src/bridge.ts).
// Used by the MCP server (mcp/server.ts) and by test scripts. Never binds to non-loopback addresses.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()

ipcMain.on('bridge:response', (_e, msg: { id: string; result?: unknown; error?: string }) => {
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  clearTimeout(p.timer)
  if (msg.error) p.reject(new Error(msg.error))
  else p.resolve(msg.result)
})

export function rpc(win: BrowserWindow | null, method: string, params: unknown, timeoutMs = 300000): Promise<unknown> {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('app window not available'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`bridge timeout: ${method}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    win.webContents.send('bridge:request', { id, method, params })
  })
}

export type MainHandler = (params: Record<string, unknown>) => Promise<unknown>

export function startBridge(getWin: () => BrowserWindow | null, port: number, mainHandlers: Record<string, MainHandler> = {}): void {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ ok: true, app: 'uiforge', pid: process.pid }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.statusCode = 404
      res.end('{"error":"not found"}')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { method: string; params?: unknown }
        const own = mainHandlers[body.method]
        const result = own ? await own((body.params ?? {}) as Record<string, unknown>) : await rpc(getWin(), body.method, body.params, body.method === 'syncGame' ? 3600000 : undefined)
        res.end(JSON.stringify({ result }))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String((e as Error).message ?? e) }))
      }
    })
  })
  server.on('error', (e) => console.warn('[bridge] cannot listen:', e.message))
  server.listen(port, '127.0.0.1', () => console.log(`[bridge] listening on http://127.0.0.1:${port}`))
}
