import { getAllowedSettingSources } from '../../bootstrap/state.js'

/**
 * Setting-source enumeration, display names, `--setting-sources` parsing,
 * and enabled-source computation.
 */

/** Canonical order, LOWEST priority first — these identifiers appear in settings, telemetry, and UI. */
export const SETTING_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const

export type SettingSource = (typeof SETTING_SOURCES)[number]

/** The three user-owned, writable sources. */
export type EditableSettingSource = 'userSettings' | 'projectSettings' | 'localSettings'

/** Display-ordered save targets. */
export const SOURCES: EditableSettingSource[] = ['localSettings', 'projectSettings', 'userSettings']

/** Short plain names. */
export function getSettingSourceName(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return 'user'
    case 'projectSettings':
      return 'project'
    case 'localSettings':
      return 'project, gitignored'
    case 'flagSettings':
      return 'cli flag'
    case 'policySettings':
      return 'managed'
  }
}

/** Capitalized short names; the domain also covers extension and built-in providers. */
export function getSourceDisplayName(source: SettingSource | 'extension' | 'built-in'): string {
  switch (source) {
    case 'userSettings':
      return 'User'
    case 'projectSettings':
      return 'Project'
    case 'localSettings':
      return 'Local'
    case 'flagSettings':
      return 'Flag'
    case 'policySettings':
      return 'Managed'
    case 'extension':
      return 'Extension'
    case 'built-in':
      return 'Built-in'
  }
}

type LowercaseNameDomain =
  | SettingSource
  | 'cliArg'
  | 'command'
  | 'session'
  | 'toolsNarrowing'
  | 'mcpServerPolicy'

/** Lowercase inline phrases over the wide domain (includes the non-file rule origins). */
export function getSettingSourceDisplayNameLowercase(source: LowercaseNameDomain): string {
  switch (source) {
    case 'userSettings':
      return 'user settings'
    case 'projectSettings':
      return 'shared project settings'
    case 'localSettings':
      return 'project local settings'
    case 'flagSettings':
      return 'command line arguments'
    case 'policySettings':
      return 'enterprise managed settings'
    case 'cliArg':
      return 'CLI argument'
    case 'command':
      return 'command configuration'
    case 'session':
      return 'current session'
    case 'toolsNarrowing':
      return 'tools narrowing'
    case 'mcpServerPolicy':
      return 'MCP server policy'
  }
}

/**
 * Sentence-cased phrases over the NARROWER domain — deliberately without
 * `toolsNarrowing`/`mcpServerPolicy`; widening it is a change, not a tidy.
 */
export function getSettingSourceDisplayNameCapitalized(
  source: SettingSource | 'cliArg' | 'command' | 'session',
): string {
  switch (source) {
    case 'userSettings':
      return 'User settings'
    case 'projectSettings':
      return 'Shared project settings'
    case 'localSettings':
      return 'Project local settings'
    case 'flagSettings':
      return 'Command line arguments'
    case 'policySettings':
      return 'Enterprise managed settings'
    case 'cliArg':
      return 'CLI argument'
    case 'command':
      return 'Command configuration'
    case 'session':
      return 'Current session'
  }
}

const FLAG_SOURCE_SPELLINGS: Record<string, SettingSource> = {
  user: 'userSettings',
  project: 'projectSettings',
  local: 'localSettings',
}

/** Parses `--setting-sources`; throws on an unknown token. The empty string yields an empty list. */
export function parseSettingSourcesFlag(flag: string): SettingSource[] {
  if (flag === '') return []
  const sources: SettingSource[] = []
  for (const rawToken of flag.split(',')) {
    const token = rawToken.trim()
    if (token === '') continue
    const mapped = FLAG_SOURCE_SPELLINGS[token]
    if (mapped === undefined) {
      throw new Error(`Unknown setting source "${token}". Valid options are: user, project, local`)
    }
    sources.push(mapped)
  }
  return sources
}

/**
 * The enabled sources IN CANONICAL ORDER, with policy and flag settings
 * always added. The order never depends on how the allowed subset was
 * spelled — appending the always-on sources after a restricted subset once
 * let a `--settings` file override enterprise policy.
 */
export function getEnabledSettingSources(): SettingSource[] {
  const enabled = new Set<SettingSource>(getAllowedSettingSources())
  enabled.add('policySettings')
  enabled.add('flagSettings')
  return SETTING_SOURCES.filter(source => enabled.has(source))
}

export function isSettingSourceEnabled(source: SettingSource): boolean {
  return getEnabledSettingSources().includes(source)
}
