// Runs Claude Code headless inside a game project so the game's own agent applies the UI changes that
// UIForge synced (uiforge/CHANGES.md). Progress lines are sent to the renderer as 'agent:event'.
import { app, type BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'

const ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash(npm run *),Bash(npm test *),Bash(npx *),Bash(node *),Bash(git status *),Bash(git diff *),mcp__uiforge'

let running: ChildProcess | null = null

function describe(name: string, input: Record<string, unknown>): string {
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.root ?? ''
  return `▸ ${name.replace(/^mcp__/, '')} ${String(v).slice(0, 140)}`
}

export function stopAgent(): void {
  running?.kill()
}

export async function runAgent(getWin: () => BrowserWindow | null, opts: { cwd: string; prompt: string }): Promise<number | null> {
  if (running) throw new Error('Agent đang chạy.')
  if (!existsSync(opts.cwd)) throw new Error(`Không thấy thư mục: ${opts.cwd}`)
  const send = (text: string): void => getWin()?.webContents.send('agent:event', { type: 'line', text })
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', `"${ALLOWED_TOOLS}"`]
  // give the agent the UIForge MCP tools (capture_game / ack_game_changes) without relying on project approval
  const server = join(app.getAppPath(), 'out', 'mcp', 'server.js')
  if (existsSync(server)) {
    const cfg = join(app.getPath('userData'), 'agent-mcp.json')
    await fs.writeFile(cfg, JSON.stringify({ mcpServers: { uiforge: { command: 'node', args: [server, '--port', String(process.env.DM_BRIDGE_PORT ?? 47821)] } } }))
    args.push('--mcp-config', `"${cfg}"`)
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  const cmd = process.env.UIFORGE_AGENT_CMD || 'claude'
  send(`$ ${cmd} -p (trong ${opts.cwd})`)
  return new Promise((resolvePromise) => {
    const child = spawn(`${cmd} ${args.join(' ')}`, { cwd: opts.cwd, env, shell: true, windowsHide: true })
    running = child
    let buf = ''
    const onLine = (line: string): void => {
      if (!line.trim()) return
      try {
        const j = JSON.parse(line) as { type?: string; subtype?: string; result?: string; is_error?: boolean; message?: { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] } }
        if (j.type === 'assistant') {
          for (const c of j.message?.content ?? []) {
            if (c.type === 'text' && c.text?.trim()) send(c.text.trim())
            else if (c.type === 'tool_use' && c.name) send(describe(c.name, c.input ?? {}))
          }
        } else if (j.type === 'result') send(j.is_error ? `✖ ${j.result ?? j.subtype ?? ''}` : '✔ agent xong')
      } catch {
        send(line.slice(0, 400))
      }
    }
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    child.stderr?.on('data', (d: Buffer) => send(d.toString('utf8').trim().slice(0, 400)))
    child.on('error', (e) => {
      send(`✖ không chạy được "${cmd}": ${e.message}`)
      running = null
      resolvePromise(null)
    })
    child.on('close', (code) => {
      if (buf) onLine(buf)
      running = null
      getWin()?.webContents.send('agent:event', { type: 'exit', text: String(code) })
      resolvePromise(code)
    })
    child.stdin?.write(opts.prompt)
    child.stdin?.end()
  })
}
