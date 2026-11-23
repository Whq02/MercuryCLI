import type { SettingSource } from 'src/utils/settings/constants.js'

export class BootConfigOwner {
  flagSettingsPath: string | undefined = undefined
  flagSettingsInline: Record<string, unknown> | null = null
  allowedSettingSources: SettingSource[] = [
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ]
  sessionExtensions: Array<string> = []
  mainThreadAgentType: string | undefined = undefined
  directConnectServerUrl: string | undefined = undefined
}
