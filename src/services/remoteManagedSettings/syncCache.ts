import {
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
} from '../../utils/auth.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import {
  getEligibility,
  resetSyncCache as resetLeafState,
  setEligibility,
} from './syncCacheState.js'

let computed: boolean | null = null

function computeEligibility(): boolean {
  if (!isFirstPartyAnthropicBaseUrl()) return false
  if (process.env.MERCURY_ENTRYPOINT === 'local-agent') return false

  const tokens = getClaudeAIOAuthTokens()
  if (tokens?.accessToken) {
    if (tokens.subscriptionType === null) return true
    if (
      tokens.scopes.includes('user:inference') &&
      (tokens.subscriptionType === 'enterprise' || tokens.subscriptionType === 'team')
    ) {
      return true
    }
  }

  try {
    const { key } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (key) return true
  } catch {
  }
  return false
}

export function isRemoteManagedSettingsEligible(): boolean {
  if (computed !== null) return computed
  const mirrored = getEligibility()
  if (mirrored !== undefined) {
    computed = mirrored
    return mirrored
  }
  computed = setEligibility(computeEligibility())
  return computed
}

export function resetSyncCache(): void {
  computed = null
  resetLeafState()
}
