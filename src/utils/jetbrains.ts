import { homedir } from 'node:os'
import { join } from 'node:path'

import { KNOWN_AGENT_CLIS } from './knownAgentClis.js'
import { getFsImplementation } from './fsOperations.js'
import type { IdeType } from './ide.js'

const PLUGIN_DIR_NAME = KNOWN_AGENT_CLIS.find(tool => tool.id === 'claude-code')?.jetbrainsPluginDir ?? null

const IDE_DIR_PREFIXES: Partial<Record<IdeType, string[]>> = {
  pycharm: ['PyCharm'],
  intellij: ['IntelliJIdea', 'IdeaIC'],
  webstorm: ['WebStorm'],
  phpstorm: ['PhpStorm'],
  rubymine: ['RubyMine'],
  clion: ['CLion'],
  goland: ['GoLand'],
  rider: ['Rider'],
  datagrip: ['DataGrip'],
  appcode: ['AppCode'],
  dataspell: ['DataSpell'],
  aqua: ['Aqua'],
  gateway: ['Gateway'],
  fleet: ['Fleet'],
  androidstudio: ['AndroidStudio'],
}

function configurationRoots(ideType: IdeType): string[] {
  const home = homedir()
  switch (process.platform) {
    case 'darwin': {
      const roots = [join(home, 'Library', 'Application Support', 'JetBrains'), join(home, 'Library', 'Application Support')]
      if (ideType === 'androidstudio') roots.push(join(home, 'Library', 'Application Support', 'Google'))
      return roots
    }
    case 'win32': {
      const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
      const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      const roots = [join(appData, 'JetBrains'), join(localAppData, 'JetBrains'), appData]
      if (ideType === 'androidstudio') roots.push(join(localAppData, 'Google'))
      return roots
    }
    case 'linux': {
      const roots = [join(home, '.config', 'JetBrains'), join(home, '.local', 'share', 'JetBrains')]
      for (const prefix of IDE_DIR_PREFIXES[ideType] ?? []) roots.push(join(home, `.${prefix}`))
      if (ideType === 'androidstudio') roots.push(join(home, '.config', 'Google'))
      return roots
    }
    default:
      return []
  }
}

function discoverPluginLocations(ideType: IdeType): string[] {
  const fs = getFsImplementation()
  const prefixes = IDE_DIR_PREFIXES[ideType] ?? []
  const locations: string[] = []
  for (const root of configurationRoots(ideType)) {
    let entries
    try {
      entries = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!prefixes.some(prefix => entry.name.startsWith(prefix))) continue
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const matched = join(root, entry.name)
      if (process.platform === 'linux') {
        locations.push(matched)
        continue
      }
      const pluginsDir = join(matched, 'plugins')
      try {
        if (fs.statSync(pluginsDir).isDirectory()) locations.push(pluginsDir)
      } catch {
      }
    }
  }
  return [...new Set(locations)]
}

export async function isJetBrainsPluginInstalled(ideType: IdeType): Promise<boolean> {
  if (PLUGIN_DIR_NAME === null) return false
  const fs = getFsImplementation()
  for (const location of discoverPluginLocations(ideType)) {
    try {
      if (fs.existsSync(join(location, PLUGIN_DIR_NAME))) return true
    } catch {
    }
  }
  return false
}

const inFlight = new Map<IdeType, Promise<boolean>>()
const resolved = new Map<IdeType, boolean>()

export async function isJetBrainsPluginInstalledCached(ideType: IdeType, forceRefresh?: boolean): Promise<boolean> {
  if (forceRefresh) {
    inFlight.delete(ideType)
    resolved.delete(ideType)
  }
  const pending = inFlight.get(ideType)
  if (pending) return pending
  if (resolved.has(ideType)) return resolved.get(ideType) as boolean
  const promise = isJetBrainsPluginInstalled(ideType).then(answer => {
    resolved.set(ideType, answer)
    return answer
  })
  inFlight.set(ideType, promise)
  return promise
}
