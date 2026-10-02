
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
    if (settings.events?.disabled) return false
    if (settings.files?.suggester) return true
    const hooks = settings.events?.hooks
    if (!hooks) return false
    return Object.values(hooks).some(
      matchers => Array.isArray(matchers) && matchers.length > 0,
    )
  })
}

export function getBashPermissionSources(): string[] {
  return sourcesWhere(settings => {
    const allow = settings.guardrails?.allow
    if (!allow) return false
    return allow.some(
      rule =>
        rule === BASH_TOOL_NAME || rule.startsWith(`${BASH_TOOL_NAME}(`),
    )
  })
}

export function getProxyAuthHelperSources(): string[] {
  return sourcesWhere(settings => Boolean(settings.credentials?.proxyCommand))
}

export function getAutoMemoryDirectorySources(): string[] {
  return sourcesWhere(settings => Boolean(settings.memory?.directory))
}

export function getApiKeyHelperSources(): string[] {
  return sourcesWhere(settings => Boolean(settings.credentials?.keyCommand))
}

export function getDangerousEnvVarsSources(): string[] {
  return sourcesWhere(settings => {
    const env = settings.environment?.values
    if (!env) return false
    return Object.keys(env).some(
      name => !SAFE_ENV_VARS.has(name.toUpperCase()),
    )
  })
}
