import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { flagPair } from '../../../platform/substrate/flagRegistry.js'
import type { McpServerConfig, ScopedMcpServerConfig } from '../../mcp-shapes/mcpServerRecords.js'
import { activeFor } from '../active.js'
import { optionEnv, substituteOptionsInCommand, substituteRootAndData } from '../options.js'
import { getExtensionDataDir } from '../paths.js'
import { mediaEnvironment, readMediaSettings, MEDIA_EXTENSION_ID } from '../../media/settings.js'

import { registerBundledAppInstall, clearBundledAppInstalls } from '../installConsent.js'
import { bundledMetadata } from '../bundled/content.generated.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
let memo: { servers: Record<string, ScopedMcpServerConfig>; warnings: string[] } | null = null

export function loadExtensionMcpServers(): { servers: Record<string, ScopedMcpServerConfig>; warnings: string[] } {
  if (memo) return memo
  const out: Record<string, ScopedMcpServerConfig> = {}
  const warnings: string[] = []
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
        } catch (error) {
          passedOver(error)
          warnings.push(`${ext.manifest.name}: its data folder ${dataDir} could not be made (${error instanceof Error ? error.message : String(error)})`)
        }
        const declaredEnv: Record<string, string> = {}
        for (const [key, value] of Object.entries(declared.env ?? {})) declaredEnv[key] = resolve(value)
        const bundledApp = ext.entry.home === 'bundled' && ['filmcraft', 'photocraft', 'lightcraft'].includes(ext.manifest.name)
        const runtimeCommand = declared.command === '${MERCURY_NODE}' ? process.execPath : resolve(declared.command)
        const installKey = bundledApp ? registerBundledAppInstall(server.runtimeName, root, dataDir) : null
        config = {
          type: 'stdio',
          command: runtimeCommand,
          args: (declared.args ?? []).map(resolve),
          env: { ...flagPair('MERCURY_EXTENSION_ROOT', root), ...flagPair('MERCURY_EXTENSION_DATA', dataDir), ...optionEnv(ext.options), ...declaredEnv, ...(installKey ? { ...flagPair('MERCURY_CRAFT_INSTALL_KEY', installKey) } : {}) },
        }
      } else {
        const declared = server.config as { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(declared.headers ?? {})) headers[key] = resolve(value)
        config = { type: declared.type, url: resolve(declared.url), ...(Object.keys(headers).length ? { headers } : {}) } as McpServerConfig
      }
      if (id === MEDIA_EXTENSION_ID && config.type === 'stdio') {
        const media = readMediaSettings()
        if (!media.enabled) continue
        try {
          const server = media.serverPath ?? config.args?.[0]
          config = { ...config, ...(server ? { args: [media.host ? join(dirname(server), 'remote-client.js') : server] } : {}), env: { ...config.env, ...mediaEnvironment(media) } }
        } catch (error) {
          passedOver(error)
          warnings.push(`${ext.manifest.name}: its media server was not loaded (${error instanceof Error ? error.message : String(error)})`)
          continue
        }
      }
      const bootstrap = ext.entry.home === 'bundled' ? bundledMetadata[ext.manifest.name]?.bootstrap : undefined
      out[server.runtimeName] = { ...config, scope: 'dynamic', extensionSource: id, ...(bootstrap ? { bundledBootstrap: bootstrap } : {}) }
    }
  }
  memo = { servers: out, warnings }
  return memo
}

export function getExtensionMcpServers(): Record<string, ScopedMcpServerConfig> {
  return loadExtensionMcpServers().servers
}

export function clearExtensionMcpServerCache(): void {
  memo = null
  clearBundledAppInstalls()
}
