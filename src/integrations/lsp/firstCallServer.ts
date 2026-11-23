import { readdirSync, type Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import type { LSPServerInstance } from './LSPServerInstance.js'
import type { LSPServerManager } from './LSPServerManager.js'
import { currentLspAbortSignal } from './lspAbort.js'
import { withDeadline } from '../../platform/async/deadline.js'
import { abortedError } from '../../platform/async/sleep.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export const LSP_FIRST_CALL_START_WAIT_MS = 10_000
const MAIN_LANGUAGE_WALK_DEPTH = 3
const MAIN_LANGUAGE_WALK_ENTRIES = 5_000
const MAIN_LANGUAGE_SKIP = new Set(['node_modules', 'bower_components', 'jspm_packages', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'venv', '__pycache__'])

type WorkspaceSymbolServer = { server: LSPServerInstance; path: string }

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
    } catch (error) {
      passedOver(error)
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
  const signal = currentLspAbortSignal()
  if (signal?.aborted) throw abortedError(signal)
  if (server.state === 'stopping') await server.stop()
  if (signal?.aborted) throw abortedError(signal)
  const start = server.start()
  start.catch(passedOver)
  return withDeadline(start.then(() => true), ms, () => false, { signal })
}
