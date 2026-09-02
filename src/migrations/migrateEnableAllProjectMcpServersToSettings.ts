// ============================================================================
//  Startup migration A.3 — relocate project-config MCP approvals into local
//  settings (union-merged), then strip the three keys from project config.
//  Returns false (and keeps the project-config keys) when the settings
//  write did not land — the runner then withholds the version stamp.
// ============================================================================
import { getCurrentProjectConfig, saveCurrentProjectConfig } from '../utils/config/projectConfig.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { logError } from '../utils/log.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

/** Existing entries first, then project entries, de-duplicated. */
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
      // The destructive half below runs ONLY once the approvals are on
      // disk in their new home — otherwise they would live in neither.
      if (!settingsWriteLanded('A.3 project MCP approvals', updateSettingsForSource('localSettings', update))) {
        return false
      }
    }

    // The trigger guarantees at least one key existed; removing absent
    // keys is harmless.
    saveCurrentProjectConfig(current => {
      const next = { ...current }
      delete next.enableAllProjectMcpServers
      delete next.enabledMcpjsonServers
      delete next.disabledMcpjsonServers
      return next
    })
    return true
  } catch (error) {
    // Handed to the logger AS-IS (unlike A.1/A.2), never rethrown. A throw
    // (the write-path alias refusal) means the relocation did not land:
    // incomplete, retried next boot.
    logError(error)
    return false
  }
}
