/** Pure helpers shared by the renderer and the MCP server (no DOM / Pixi imports here). */

export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-.]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'asset'
}
