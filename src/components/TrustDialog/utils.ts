// Trust-dialog settings probes: each answers "which settings files
// declare this risky configuration?" with RELATIVE paths, project settings
// first, local second. These run BEFORE the user has trusted the folder, so
// they only read JSON — never execute helpers.

import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { SAFE_ENV_VARS } from '../../utils/managedEnvConstants.js'
import {
  getRelativeSettingsFilePathForSource,
  getSettingsForSource,
} from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

type ProbedSource = 'projectSettings' | 'localSettings'
const PROBED_SOURCES: ProbedSource[] = ['projectSettings', 'localSettings']

function sourcesWhere(
  predicate: (settings: SettingsJson) => boolean,
): string[] {
  const paths: string[] = []
  for (const source of PROBED_SOURCES) {
    const settings = getSettingsForSource(source)
    if (settings !== null && predicate(settings)) {
      paths.push(getRelativeSettingsFilePathForSource(source))
    }
  }
  return paths
}

export function getHooksSources(): string[] {
  return sourcesWhere(settings => {
    if (settings.disableAllHooks) return false
    if (settings.fileSuggestion) return true
    const hooks = settings.hooks
    if (!hooks) return false
    return Object.values(hooks).some(
      matchers => Array.isArray(matchers) && matchers.length > 0,
    )
  })
}

export function getBashPermissionSources(): string[] {
  return sourcesWhere(settings => {
    const allow = settings.permissions?.allow
    if (!allow) return false
    return allow.some(
      rule =>
        rule === BASH_TOOL_NAME || rule.startsWith(`${BASH_TOOL_NAME}(`),
    )
  })
}

export function getProxyAuthHelperSources(): string[] {
  return sourcesWhere(settings => Boolean(settings.proxyAuthHelper))
}

export function getAutoMemoryDirectorySources(): string[] {
  return sourcesWhere(settings => Boolean(settings.autoMemoryDirectory))
}

export function getApiKeyHelperSources(): string[] {
  return sourcesWhere(settings => Boolean(settings.apiKeyHelper))
}

export function getDangerousEnvVarsSources(): string[] {
  return sourcesWhere(settings => {
    const env = settings.env
    if (!env) return false
    return Object.keys(env).some(
      name => !SAFE_ENV_VARS.has(name.toUpperCase()),
    )
  })
}

// The caller-less list formatter (`formatListWithAnd`) is ruled NOT built
// green-tree rule; receipt-recorded.
