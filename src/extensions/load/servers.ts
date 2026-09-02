import { mkdirSync } from 'node:fs'
import type { McpServerConfig, ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { activeFor } from '../active.js'
import { optionEnv, substituteOptionsInCommand, substituteRootAndData } from '../options.js'
import { getExtensionDataDir } from '../paths.js'

let memo: Record<string, ScopedMcpServerConfig> | null = null

export function getExtensionMcpServers(): Record<string, ScopedMcpServerConfig> {
  if (memo) return memo
  const out: Record<string, ScopedMcpServerConfig> = {}
  for (const ext of activeFor('servers')) {
    const id = ext.entry.id
    const root = ext.root
    const resolve = (text: string): string => substituteOptionsInCommand(substituteRootAndData(text, root, id), ext.options)
    for (const server of ext.resolution.servers) {
      let config: McpServerConfig
      if (server.transport === 'stdio') {
        const declared = server.config as { command: string; args?: string[]; env?: Record<string, string> }
        const dataDir = getExtensionDataDir(id)
        try {
          mkdirSync(dataDir, { recursive: true })
        } catch {
        }
        const declaredEnv: Record<string, string> = {}
        for (const [key, value] of Object.entries(declared.env ?? {})) declaredEnv[key] = resolve(value)
        config = {
          type: 'stdio',
          command: resolve(declared.command),
          args: (declared.args ?? []).map(resolve),
          env: { 'MERCURY_EXTENSION_ROOT': root, 'MERCURY_EXTENSION_DATA': dataDir, ...optionEnv(ext.options), ...declaredEnv },
        }
      } else {
        const declared = server.config as { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(declared.headers ?? {})) headers[key] = resolve(value)
        config = { type: declared.type, url: resolve(declared.url), ...(Object.keys(headers).length ? { headers } : {}) } as McpServerConfig
      }
      out[server.runtimeName] = { ...config, scope: 'dynamic', extensionSource: id }
    }
  }
  memo = out
  return out
}

export function clearExtensionMcpServerCache(): void {
  memo = null
}
