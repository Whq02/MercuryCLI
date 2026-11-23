import { type ApiKeySource, getAnthropicApiKeyWithSource, isClaudeAISubscriber, isAnthropicOAuthSignInExpired } from '../../sign-in/credentials/auth.js'
import type { AccountSlotReads, AccountSlot } from './shapes.js'
import { scanAccountScopes, type AccountScope } from '../../sign-in/account-ledger/scopeScan.js'
import { anthropicSignInEmail } from '../providerUsage.js'
import { label } from './keyLane.js'
import { maskedKeyTail } from '../../sign-in/account-ledger/credentialIdentity.js'

function readAnthropicApiKey(): { key: string | null; source: ApiKeySource } {
  try {
    return getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
  } catch {
    return { key: null, source: 'none' }
  }
}

export function anthropicSlots(reads: AccountSlotReads): AccountSlot[] {
  const scopes = (reads.scanScopes ?? scanAccountScopes)()
  const subscriberSeat = reads.familyReads?.claudeSubscriber?.() ?? isClaudeAISubscriber()
  const signInEmail = (scope: AccountScope): string | undefined =>
    scope.isCurrent ? anthropicSignInEmail(reads.familyReads) : undefined
  const signInExpired = (scope: AccountScope): boolean =>
    scope.isCurrent && scope.authed && !scope.foreignHarness && (reads.anthropicSignInExpired ?? isAnthropicOAuthSignInExpired)()
  const slots: AccountSlot[] = scopes
    .filter(
      scope =>
        scope.authed ||
        scope.unreadError !== undefined ||
        scope.email !== undefined ||
        scope.uuid !== undefined ||
        scope.foreignHarness,
    )
    .map((scope): AccountSlot => {
      const own = scope.authed && !scope.foreignHarness ? signInEmail(scope) : undefined
      const expired = signInExpired(scope)
      const unreadNote =
        !scope.authed && !scope.foreignHarness && scope.unreadError !== undefined
          ? `credentials could not be read (${scope.unreadError})`
          : undefined
      return {
        family: 'anthropic',
        id: scope.dir,
        name: 'claude',
        kind: 'oauth' as const,
        kindLabel: 'OAuth',
        identity: scope.foreignHarness
          ? "another tool's credential scope"
          : scope.authed
            ? (own ?? 'signed in')
            : unreadNote !== undefined
              ? (scope.email ?? 'unverified')
              : (scope.email ?? 'not signed in'),
        ...(own !== undefined ? { signInEmail: own } : {}),
        active: scope.foreignHarness ? scope.isCurrent : scope.isCurrent && subscriberSeat,
        envPinned: false,
        signedIn: scope.authed && !expired,
        ...(expired ? { expired: true } : {}),
        ...(unreadNote !== undefined ? { stateNote: unreadNote } : {}),
        scope,
        removal: scope.foreignHarness
          ? {
              route: 'excluded' as const,
              note: "another tool's credential scope is not a Mercury slot — nothing to remove here",
            }
          : { route: 'anthropic-oauth' as const, dir: scope.dir },
      }
    })
  const apiKey = reads.anthropicApiKey ? reads.anthropicApiKey() : readAnthropicApiKey()
  if (apiKey.key !== null || apiKey.source === 'credentials.keyCommand') {
    const subscriber = subscriberSeat
    const env = apiKey.source === 'ANTHROPIC_API_KEY'
    const helper = apiKey.source === 'credentials.keyCommand'
    slots.push({
      family: 'anthropic',
      id: 'anthropic:api-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: env ? 'API key · env' : helper ? 'API key · helper' : 'API key',
      identity: label([
        env ? 'ANTHROPIC_API_KEY (env)' : helper ? 'credentials.keyCommand (settings)' : apiKey.source,
        maskedKeyTail(apiKey.key ?? undefined),
      ]),
      active: !subscriber,
      envPinned: env,
      signedIn: true,
      removal: env
        ? { route: 'env', envVar: 'ANTHROPIC_API_KEY' }
        : helper
          ? {
              route: 'settings',
              note: 'the credentials.keyCommand setting owns this key — remove the helper from settings to remove it',
            }
          : { route: 'anthropic-managed-key' },
    })
  }
  return slots
}
