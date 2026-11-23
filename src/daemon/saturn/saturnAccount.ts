import { declaredRouteOf } from '../../models/roads/routeLaw.js'
import { anthropicCredentialPresence } from '../../models/roads/providerUsage.js'
import { buildProviderSnapshot } from '../../models/roads/modelRegistry.js'
import { compatModelEndpoint, resolveCompatAccount } from '../../models/roads/openaicompat/compatAccounts.js'
import { getClaudeAIOAuthTokens, isAnthropicOAuthSignInExpired, isClaudeAISubscriber } from '../../models/sign-in/credentials/auth.js'
import { credentialStoreUnread } from '../../platform/secure-storage/index.js'
import { getAuthConfigHomeDir } from '../../platform/environment/envUtils.js'
import { readScopeIdentity, scopeIdentityFile } from '../../models/sign-in/account-ledger/scopeScan.js'
import { LOCAL_UNREACHABLE_REMEDY } from '../../models/roads/local/localAccounts.js'
import type { AnthropicWindowFactV1, LaneWindowFactV1, OpenaiWindowFactV1 } from '../../engine/connector/types.js'
import type { ScheduleAccountV1, ScheduleAccountVerdictV1 } from './saturn.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'


export interface FamilyCredentialPresenceV1 {
  credentialed: boolean
  kind: 'oauth' | 'api-key' | 'keyless' | 'none'
  unread?: string
}

export interface AnthropicOauthDetailV1 {
  subscriber: boolean
  scopeDir: string
  identity?: string
  knownExpiresAt: number | null
  refreshable: boolean
}

export interface SaturnAccountReads {
  familyOf?: (modelKey: string) => string
  presenceOf?: (family: string, modelKey?: string) => FamilyCredentialPresenceV1
  anthropicDetail?: () => AnthropicOauthDetailV1 | null
}

function productionPresenceOf(family: string, modelKey?: string): FamilyCredentialPresenceV1 {
  if (family === 'openai-compat' && modelKey !== undefined) {
    try {
      const resolved = compatModelEndpoint(modelKey)
      const account = resolved === undefined ? undefined : resolveCompatAccount(hostEnv(), resolved.endpoint.name)
      return account === undefined ? { credentialed: false, kind: 'none' } : { credentialed: true, kind: account.kind }
    } catch (error) {
      return { credentialed: false, kind: 'none', unread: errorMessage(error) }
    }
  }
  if (family === 'anthropic') {
    try {
      const presence = anthropicCredentialPresence()
      if (!presence.credentialed) {
        const unread = credentialStoreUnread()
        return unread !== null
          ? { credentialed: false, kind: 'none', unread: unread.message ?? unread.code }
          : { credentialed: false, kind: 'none' }
      }
      const detail = productionAnthropicDetail()
      return { credentialed: true, kind: detail !== null && detail.subscriber ? 'oauth' : 'api-key' }
    } catch (error) {
      return { credentialed: false, kind: 'none', unread: errorMessage(error) }
    }
  }
  try {
    const provider = buildProviderSnapshot().providers.find(p => p.id === family)
    const account = (provider?.description as { account?: { kind?: string } } | undefined)?.account
    if (!account || account.kind === 'none' || account.kind === undefined) {
      return { credentialed: false, kind: 'none' }
    }
    if (account.kind === 'keyless') return { credentialed: true, kind: 'keyless' }
    return { credentialed: true, kind: account.kind === 'api-key' ? 'api-key' : 'oauth' }
  } catch (error) {
    return { credentialed: false, kind: 'none', unread: errorMessage(error) }
  }
}

function productionAnthropicDetail(): AnthropicOauthDetailV1 | null {
  try {
    const subscriber = ((): boolean => {
      try {
        return isClaudeAISubscriber()
      } catch (error) {
        passedOver(error)
        return false
      }
    })()
    const tokens = ((): { expiresAt: number | null; refreshToken: string | null } | null => {
      try {
        return getClaudeAIOAuthTokens()
      } catch (error) {
        passedOver(error)
        return null
      }
    })()
    const scopeDir = getAuthConfigHomeDir()
    const identity = ((): string | undefined => {
      try {
        return readScopeIdentity(scopeIdentityFile(scopeDir)).email
      } catch (error) {
        passedOver(error)
        return undefined
      }
    })()
    return {
      subscriber,
      scopeDir,
      ...(identity !== undefined ? { identity } : {}),
      knownExpiresAt: tokens?.expiresAt ?? null,
      refreshable: typeof tokens?.refreshToken === 'string' && tokens.refreshToken.length > 0,
    }
  } catch (error) {
    passedOver(error)
    return null
  }
}

export type ScheduleAccountDerivation =
  | { ok: true; account: ScheduleAccountV1 }
  | { ok: false; reason: string; code?: 'unreachable' }

export function noCredentialRefusal(family: string): string {
  return `no-credential:${family} — /logins ${family} connects an account or an API key`
}

export function localUnreachableRefusal(): string {
  return `unreachable:local — ${LOCAL_UNREACHABLE_REMEDY}`
}

export function deriveScheduleAccountForModel(
  modelKey: string,
  reads: SaturnAccountReads = {},
): ScheduleAccountDerivation {
  const familyOf = reads.familyOf ?? ((key: string) => declaredRouteOf(key) ?? '')
  const family = familyOf(modelKey)
  if (typeof family !== 'string' || family.length === 0) {
    return { ok: false, reason: `unknown-family: no provider family answers for '${modelKey}'` }
  }
  const presenceOf = reads.presenceOf ?? productionPresenceOf
  const presence = presenceOf(family, modelKey)
  const scope = family === 'openai-compat' ? { modelKey } : {}
  if (!presence.credentialed || presence.kind === 'none') {
    if (family === 'local') return { ok: false, reason: localUnreachableRefusal(), code: 'unreachable' }
    let door = family
    if (family === 'openai-compat') {
      try {
        const endpoint = compatModelEndpoint(modelKey)?.endpoint
        if (endpoint !== undefined) door = `compat/${endpoint.name}`
      } catch (error) { passedOver(error) }
    }
    return { ok: false, reason: presence.unread !== undefined ? `unread:${door} — the sign-in could not be read (${presence.unread})` : noCredentialRefusal(door) }
  }
  if (presence.kind === 'keyless') {
    return { ok: true, account: { family, source: 'keyless', ...scope } }
  }
  if (family === 'anthropic' && presence.kind === 'oauth') {
    const detail = (reads.anthropicDetail ?? productionAnthropicDetail)()
    if (detail === null) {
      return { ok: true, account: { family, source: 'oauth' } }
    }
    return {
      ok: true,
      account: {
        family,
        source: 'oauth',
        scopeDir: detail.scopeDir,
        ...(detail.identity !== undefined ? { identity: detail.identity } : {}),
        knownExpiresAt: detail.knownExpiresAt,
        refreshable: detail.refreshable,
      },
    }
  }
  return { ok: true, account: { family, source: presence.kind === 'oauth' ? 'oauth' : 'api-key', ...scope } }
}


export interface LiveAccountFactsV1 {
  credentialed: boolean
  stranded: boolean
  expiresAt: number | null
  refreshable: boolean
  rateLimitedUntil?: number
}

export function scheduleAccountVerdict(args: {
  account: Pick<ScheduleAccountV1, 'source'>
  nextFireMs: number | null
  nowMs: number
  live: LiveAccountFactsV1
}): ScheduleAccountVerdictV1 {
  const { account, nextFireMs, nowMs, live } = args
  if (!live.credentialed) return account.source === 'keyless' ? { state: 'unreachable' } : { state: 'signed-out' }
  if (live.stranded && account.source !== 'keyless') return { state: 'expired' }
  if (live.rateLimitedUntil !== undefined && live.rateLimitedUntil > nowMs) {
    return { state: 'rate-limited', retryAt: live.rateLimitedUntil }
  }
  if (
    account.source === 'oauth' &&
    !live.refreshable &&
    live.expiresAt !== null &&
    nextFireMs !== null &&
    live.expiresAt <= nextFireMs
  ) {
    return { state: 'expiring', expiresAt: live.expiresAt, beforeFire: true }
  }
  return { state: 'ready' }
}

export interface LiveFactsReads {
  presenceOf?: (family: string, modelKey?: string) => FamilyCredentialPresenceV1
  strandedNow?: () => boolean
  anthropicDetail?: () => AnthropicOauthDetailV1 | null
  rateLimitedUntilOf?: (family: string) => number | undefined
}

export function readLiveAccountFacts(
  account: Pick<ScheduleAccountV1, 'family' | 'source' | 'modelKey'>,
  reads: LiveFactsReads = {},
): LiveAccountFactsV1 {
  const presence = (reads.presenceOf ?? productionPresenceOf)(account.family, account.modelKey)
  const stranded =
    account.family === 'anthropic' && account.source === 'oauth'
      ? (reads.strandedNow ??
          ((): boolean => {
            try {
              return isAnthropicOAuthSignInExpired()
            } catch (error) {
              passedOver(error)
              return false
            }
          }))()
      : false
  const detail =
    account.family === 'anthropic' && account.source === 'oauth'
      ? (reads.anthropicDetail ?? productionAnthropicDetail)()
      : null
  const rateLimitedUntil = reads.rateLimitedUntilOf?.(account.family)
  return {
    credentialed: presence.credentialed && presence.kind !== 'none',
    stranded,
    expiresAt: detail?.knownExpiresAt ?? null,
    refreshable: detail?.refreshable ?? false,
    ...(rateLimitedUntil !== undefined ? { rateLimitedUntil } : {}),
  }
}

export type SessionWindowFactsV1 = {
  usage?: {
    anthropicWindow?: AnthropicWindowFactV1
    openaiWindow?: OpenaiWindowFactV1
    geminiWindow?: LaneWindowFactV1
    openrouterWindow?: LaneWindowFactV1
    huggingfaceWindow?: LaneWindowFactV1
  }
} | null

export interface SessionFireReads extends LiveFactsReads {
  factsOf?: (sessionId: string) => SessionWindowFactsV1
  now?: () => number
}

export function liveFactsForSessionFire(
  account: Pick<ScheduleAccountV1, 'family' | 'source' | 'modelKey'>,
  sessionId: string | undefined,
  reads: SessionFireReads = {},
): LiveAccountFactsV1 {
  return readLiveAccountFacts(account, reads)
}
