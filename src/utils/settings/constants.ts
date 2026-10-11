import { getAllowedSettingSources } from '../../bootstrap/state.js'

export const SETTING_SOURCES = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'] as const
export type SettingSource = (typeof SETTING_SOURCES)[number]
export type EditableSettingSource = 'userSettings' | 'projectSettings' | 'localSettings'
export const SOURCES: EditableSettingSource[] = ['localSettings', 'projectSettings', 'userSettings']

type RuleOrigin = 'cliArg' | 'command' | 'session'
type LowercaseNameDomain = SettingSource | RuleOrigin | 'toolsNarrowing' | 'mcpServerPolicy'

const labels = new Map<SettingSource, readonly [string, string, string]>([
  ['userSettings', ['user', 'User', 'user settings']],
  ['projectSettings', ['project', 'Project', 'shared project settings']],
  ['localSettings', ['project, gitignored', 'Local', 'project local settings']],
  ['flagSettings', ['cli flag', 'Flag', 'command line arguments']],
  ['policySettings', ['managed', 'Managed', 'managed settings']],
])
const originLabels = new Map<LowercaseNameDomain, string>([
  ['cliArg', 'CLI argument'], ['command', 'command configuration'], ['session', 'current session'],
  ['toolsNarrowing', 'tools narrowing'], ['mcpServerPolicy', 'MCP server policy'],
])
const providerLabels = new Map<string, string>([['extension', 'Extension'], ['built-in', 'Built-in']])
const flagSources: Record<string, SettingSource> = { user: 'userSettings', project: 'projectSettings', local: 'localSettings' }

export function parseSettingSourcesFlag(flag: string): SettingSource[] {
  return flag.split(',').flatMap(part => {
    const word = part.trim()
    if (!word) return []
    const source = flagSources[word]
    if (source !== undefined) return [source]
    throw new Error(`Unknown setting source "${word}". Valid options are: user, project, local`)
  })
}

export function getEnabledSettingSources(): SettingSource[] {
  const allowed = getAllowedSettingSources()
  return SETTING_SOURCES.filter(source => source === 'flagSettings' || source === 'policySettings' || allowed.includes(source))
}

export function isSettingSourceEnabled(source: SettingSource): boolean {
  return getEnabledSettingSources().includes(source)
}

export function getSettingSourceName(source: SettingSource): string {
  return labels.get(source)?.[0]!
}

export function getSourceDisplayName(source: SettingSource | 'extension' | 'built-in'): string {
  return (labels.get(source as SettingSource)?.[1] ?? providerLabels.get(source))!
}

export function getSettingSourceDisplayNameLowercase(source: LowercaseNameDomain): string {
  return (labels.get(source as SettingSource)?.[2] ?? originLabels.get(source))!
}

export function getSettingSourceDisplayNameCapitalized(source: SettingSource | RuleOrigin): string {
  const words = labels.get(source as SettingSource)?.[2] ??
    (source === 'cliArg' || source === 'command' || source === 'session' ? originLabels.get(source) : undefined)
  return (words && words[0]!.toUpperCase() + words.slice(1))!
}
