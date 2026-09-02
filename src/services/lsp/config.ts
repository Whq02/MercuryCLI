import { getExtensionLspServers } from '../../extensions/load/language.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getMercuryLspServerSources } from './builtinServers.js'
import { catalogueServerConfigs } from './serverCatalogue.js'
import type { ScopedLspServerConfig } from './types.js'


function loadExtensionServers(): Record<string, ScopedLspServerConfig> {
  try {
    const servers = getExtensionLspServers()
    const count = Object.keys(servers).length
    if (count > 0) logForDebugging(`lsp/config: ${count} extension language server(s)`)
    return servers
  } catch (err) {
    logError(err)
    logForDebugging(`lsp/config: extension language-server loading failed; continuing without them: ${String(err)}`)
    return {}
  }
}

export async function getAllLspServers(): Promise<{ servers: Record<string, ScopedLspServerConfig> }> {
  const allServers = loadExtensionServers()

  let mercurySources: { env: Record<string, ScopedLspServerConfig>; builtin: Record<string, ScopedLspServerConfig> } = {
    env: {},
    builtin: {},
  }
  try {
    mercurySources = getMercuryLspServerSources()
  } catch (err) {
    logError(err)
    logForDebugging(`Error loading Mercury LSP server sources: ${String(err)}`)
  }

  let catalogue: Record<string, ScopedLspServerConfig> = {}
  try {
    catalogue = catalogueServerConfigs()
  } catch (err) {
    logError(err)
    logForDebugging(`Error probing the LSP server catalogue: ${String(err)}`)
  }

  const servers: Record<string, ScopedLspServerConfig> = {}
  for (const source of [mercurySources.env, allServers, mercurySources.builtin, catalogue]) {
    for (const [name, config] of Object.entries(source)) {
      if (config.disabled === true) continue
      if (!(name in servers)) servers[name] = config
    }
  }
  return { servers }
}
