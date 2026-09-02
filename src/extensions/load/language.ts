// ============================================================================
//  src/extensions/load/language.ts — an extension's language servers,
//  resolved and scoped `ext:<name>:<server>` with the extension's name as
//  the source. Root/data/options substitute into the command, args and
//  env; the two folders and the options ride the env like any server.
// ============================================================================
import type { ScopedLspServerConfig } from '../../services/lsp/types.js'
import { activeFor } from '../active.js'
import { optionEnv, substituteOptionsInCommand, substituteRootAndData } from '../options.js'
import { getExtensionDataDir } from '../paths.js'

let memo: Record<string, ScopedLspServerConfig> | null = null

export function getExtensionLspServers(): Record<string, ScopedLspServerConfig> {
  if (memo) return memo
  const out: Record<string, ScopedLspServerConfig> = {}
  for (const ext of activeFor('language')) {
    const id = ext.entry.id
    const root = ext.root
    const resolve = (text: string): string => substituteOptionsInCommand(substituteRootAndData(text, root, id), ext.options)
    for (const language of ext.resolution.language) {
      const config = language.config
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(config.env ?? {})) env[key] = resolve(value)
      out[language.runtimeName] = {
        ...config,
        command: resolve(config.command),
        ...(config.args ? { args: config.args.map(resolve) } : {}),
        env: { 'MERCURY_EXTENSION_ROOT': root, 'MERCURY_EXTENSION_DATA': getExtensionDataDir(id), ...optionEnv(ext.options), ...env },
        scope: 'dynamic',
        source: ext.manifest.name,
      }
    }
  }
  memo = out
  return out
}

export function clearExtensionLspServerCache(): void {
  memo = null
}
