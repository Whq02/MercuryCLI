import type { SettingSource } from 'src/utils/settings/constants.js'
import { unbuilt } from '../../pi/holes.js'

export class BootConfigOwner {
  flagSettingsPath: string | undefined = unbuilt('src/bootstrap/runtime/boot-config.ts:4')
  flagSettingsInline: Record<string, unknown> | null = unbuilt('src/bootstrap/runtime/boot-config.ts:5')
  allowedSettingSources: SettingSource[] = unbuilt('src/bootstrap/runtime/boot-config.ts:6')
  sessionExtensions: Array<string> = unbuilt('src/bootstrap/runtime/boot-config.ts:13')
  mainThreadAgentType: string | undefined = unbuilt('src/bootstrap/runtime/boot-config.ts:14')
  directConnectServerUrl: string | undefined = unbuilt('src/bootstrap/runtime/boot-config.ts:15')
}
