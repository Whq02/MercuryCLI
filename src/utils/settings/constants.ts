import { getAllowedSettingSources } from '../../bootstrap/state.js'
import { untrustedWorkspaceHeadless } from '../config/trust.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'

export const SETTING_SOURCES = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'] as const
export type SettingSource = (typeof SETTING_SOURCES)[number]
export type EditableSettingSource = 'userSettings' | 'projectSettings' | 'localSettings'
export const SOURCES: EditableSettingSource[] = ['localSettings', 'projectSettings', 'userSettings']

type RuleOrigin = 'cliArg' | 'command' | 'session'
type LowercaseNameDomain = SettingSource | RuleOrigin | 'toolsNarrowing' | 'mcpServerPolicy'

const labels: Map<SettingSource, readonly [string, string, string]> = unbuilt('src/utils/settings/constants.ts:12')
const originLabels = new Map<LowercaseNameDomain, string>([
  ['cliArg', 'CLI argument'], ['command', 'command configuration'], ['session', 'current session'],
  ['toolsNarrowing', 'tools narrowing'], ['mcpServerPolicy', 'MCP server policy'],
])
const providerLabels = new Map<string, string>([['extension', 'Extension'], ['built-in', 'Built-in']])
const flagSources: Record<string, SettingSource> = { user: 'userSettings', project: 'projectSettings', local: 'localSettings' }

export function parseSettingSourcesFlag(flag: string): SettingSource[] {
  return notBuilt('src/utils/settings/constants.ts:26')
}

const CHECKOUT_SOURCES: ReadonlySet<SettingSource> = unbuilt('src/utils/settings/constants.ts:36')

export function getLaunchSettingSources(): SettingSource[] {
  return notBuilt('src/utils/settings/constants.ts:38')
}

export function isCheckoutSourceHeldForTrust(source: SettingSource): boolean {
  return CHECKOUT_SOURCES.has(source) && untrustedWorkspaceHeadless()
}

export function getEnabledSettingSources(): SettingSource[] {
  return notBuilt('src/utils/settings/constants.ts:47')
}

export function isSettingSourceEnabled(source: SettingSource): boolean {
  return notBuilt('src/utils/settings/constants.ts:52')
}

export function isSettingSourceAllowedAtLaunch(source: SettingSource): boolean {
  return getLaunchSettingSources().includes(source)
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
