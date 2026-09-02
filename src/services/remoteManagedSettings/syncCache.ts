/**
 * Remote managed-settings ELIGIBILITY — the only auth-touching module of the
 * remote-settings family. Computed at most once per process, then mirrored
 * into the dependency-leaf state module so later reads are free.
 *
 * MUST NOT call the merged settings reader, directly or transitively — this
 * runs inside settings loading (the environment-application step triggers it
 * just before the policy layer is read) and would deadlock or poison the
 * settings cache. It may reach only the base-URL predicate and the two
 * credential readers.
 */
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

/** Memo: at most one computation per process. */
let computed: boolean | null = null

function computeEligibility(): boolean {
  // Order matters — each rung is cheaper than the next.
  if (!isFirstPartyAnthropicBaseUrl()) return false
  // The sandboxed-VM surface has its own permission model; file/MDM-based
  // managed settings still apply through the normal settings pipeline.
  if (process.env.MERCURY_ENTRYPOINT === 'local-agent') return false

  // OAuth BEFORE any API-key probe: the key probe may spawn a platform
  // keychain subprocess and most subscription users have no key.
  const tokens = getClaudeAIOAuthTokens()
  if (tokens?.accessToken) {
    // Strictly null (absent/undefined does not take this arm): externally
    // injected tokens are synthesised with a null subscription type, and
    // admitting an account with no policy document costs one request.
    if (tokens.subscriptionType === null) return true
    if (
      tokens.scopes.includes('user:inference') &&
      (tokens.subscriptionType === 'enterprise' || tokens.subscriptionType === 'team')
    ) {
      return true
    }
  }

  // Console/API-key customers all qualify — but never execute a key helper
  // here, and swallow the CI/test throw (treated as "no key").
  try {
    const { key } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (key) return true
  } catch {
    // No credential anywhere (CI/test) — not eligible via this rung.
  }
  return false
}

/** The public eligibility read; memoized and mirrored into the leaf state. */
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

/**
 * Clear the eligibility memo (local and the leaf mirror) and the session
 * cache, so the next read recomputes from scratch — this is how the
 * login/logout refresh picks up an account change.
 */
export function resetSyncCache(): void {
  computed = null
  resetLeafState()
}
