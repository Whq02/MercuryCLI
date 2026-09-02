import type { SettingSource } from 'src/utils/settings/constants.js'

export type ChannelEntry =
  | { kind: 'extension'; name: string; label?: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

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
  sessionIngressToken: string | null | undefined = undefined
  oauthTokenFromFd: string | null | undefined = undefined
  apiKeyFromFd: string | null | undefined = undefined
  sessionExtensions: Array<string> = []
  allowedChannels: ChannelEntry[] = []
  hasDevChannels = false
  addedDirectories: string[] = []
  mainThreadAgentType: string | undefined = undefined
  directConnectServerUrl: string | undefined = undefined
}
