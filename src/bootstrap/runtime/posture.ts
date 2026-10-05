import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { SessionPermissionModeResolution } from '../../utils/permissions/permissionSetup.js'

function isPostureEnvTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export class PostureOwner {
  isInteractive = false
  headlessOneShot = false
  askChannel: 'operator' | 'sdk' | 'none' = 'operator'
  assistantSessionActive = false
  strictToolResultPairing = false
  sdkAgentProgressSummariesEnabled = false
  clientType = 'cli'
  sessionSource: string | undefined = undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined = undefined
  isRemoteMode = false
  sessionBypassPermissionsMode = false
  permissionModeResolution: Readonly<SessionPermissionModeResolution> | null = null
  sessionTrustAccepted = false
  sessionPersistenceDisabled = false
  private assistantDefaultCache: boolean | null = null

  isAssistantFamilyAvailable(): boolean {
    if (this.assistantSessionActive) return true
    return this.isAssistantDefaultOn()
  }

  isAssistantSessionActive(): boolean {
    return this.assistantSessionActive
  }

  private isAssistantDefaultOn(): boolean {
    if (this.assistantDefaultCache !== null) return this.assistantDefaultCache
    const optOut = isPostureEnvTruthy(flagEnv('MERCURY_ASSISTANT_DISABLE'))
    this.assistantDefaultCache = !optOut
    return this.assistantDefaultCache
  }

  preferThirdPartyAuthentication(): boolean {
    return !this.isInteractive && this.clientType !== 'mercury-editor'
  }
}
