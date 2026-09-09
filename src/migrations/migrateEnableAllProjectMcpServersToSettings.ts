import { getCurrentProjectConfig, saveCurrentProjectConfigDeferred } from '../utils/config/projectConfig.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { logError } from '../utils/log.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

function mergeLists(existing: string[] | undefined, incoming: string[]): string[] {
  const out: string[] = []
  for (const entry of [...(existing ?? []), ...incoming]) {
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

export function migrateEnableAllProjectMcpServersToSettings(): boolean {
  try {
    const project = getCurrentProjectConfig()
    const hasEnableAll = 'enableAllProjectMcpServers' in project
    const enabledList = project.enabledMcpjsonServers ?? []
    const disabledList = project.disabledMcpjsonServers ?? []
    if (!hasEnableAll && enabledList.length === 0 && disabledList.length === 0) return true

    const local = getSettingsForSource('localSettings') ?? {}
    const update: {
      enableAllProjectMcpServers?: boolean
      enabledMcpjsonServers?: string[]
      disabledMcpjsonServers?: string[]
    } = {}
    if (hasEnableAll && local.enableAllProjectMcpServers === undefined) {
      update.enableAllProjectMcpServers = project.enableAllProjectMcpServers
    }
    if (enabledList.length > 0) {
      update.enabledMcpjsonServers = mergeLists(local.enabledMcpjsonServers, enabledList)
    }
    if (disabledList.length > 0) {
      update.disabledMcpjsonServers = mergeLists(local.disabledMcpjsonServers, disabledList)
    }
    if (Object.keys(update).length > 0) {
      if (!settingsWriteLanded('A.3 project MCP approvals', updateSettingsForSource('localSettings', update))) {
        return false
      }
    }

    saveCurrentProjectConfigDeferred(current => {
      const next = { ...current }
      delete next.enableAllProjectMcpServers
      delete next.enabledMcpjsonServers
      delete next.disabledMcpjsonServers
      return next
    })
    return true
  } catch (error) {
    logError(error)
    return false
  }
}
