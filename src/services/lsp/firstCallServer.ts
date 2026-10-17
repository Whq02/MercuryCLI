import { readdirSync, type Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import type { LSPServerInstance } from './LSPServerInstance.js'
import type { LSPServerManager } from './LSPServerManager.js'

export const LSP_FIRST_CALL_START_WAIT_MS = 10_000
const MAIN_LANGUAGE_WALK_DEPTH = 3
const MAIN_LANGUAGE_WALK_ENTRIES = 5_000
const MAIN_LANGUAGE_SKIP = new Set(['node_modules', 'bower_components', 'jspm_packages', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'venv', '__pycache__'])

export type WorkspaceSymbolServer = { server: LSPServerInstance; path: string }

export function workspaceSymbolServer(manager: LSPServerManager, query: string, cwd: string): WorkspaceSymbolServer | undefined {
  const servers = [...manager.getAllServers().values()]
  const running = servers.find(server => server.state === 'running' && server.config.diagnosticsOnly !== true) ?? servers.find(server => server.state === 'running')
  if (running) return { server: running, path: '' }
  const spelled = query.trim()
  const implied = extname(spelled) === '' ? undefined : manager.getServerForFile(spelled)
  if (implied) return { server: implied, path: spelled }
  const counts = new Map<LSPServerInstance, { count: number; path: string }>()
  let entries = 0
  const walk = (dir: string, depth: number): void => {
    let names: Dirent[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      if (++entries > MAIN_LANGUAGE_WALK_ENTRIES) return
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (depth < MAIN_LANGUAGE_WALK_DEPTH && !MAIN_LANGUAGE_SKIP.has(entry.name)) walk(join(dir, entry.name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const server = manager.getServerForFile(entry.name)
      if (!server) continue
      const seen = counts.get(server)
      if (seen) seen.count++
      else counts.set(server, { count: 1, path: entry.name })
    }
  }
  walk(cwd, 0)
  let best: WorkspaceSymbolServer & { count: number } | undefined
  for (const server of servers) {
    const seen = counts.get(server)
    if (seen && (best === undefined || seen.count > best.count)) best = { server, count: seen.count, path: seen.path }
  }
  if (best) return { server: best.server, path: best.path }
  const first = servers.find(server => server.config.diagnosticsOnly !== true) ?? servers[0]
  return first ? { server: first, path: '' } : undefined
}

export async function startedWithin(server: LSPServerInstance, ms: number): Promise<boolean> {
  if (server.state === 'running') return true
  if (server.state === 'stopping') await server.stop()
  const start = server.start()
  start.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      start.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
