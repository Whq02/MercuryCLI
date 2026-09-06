import { join } from 'node:path'
import { declaredRouteOf } from '../services/providers/routeLaw.js'
import { anthropicCredentialPresence } from '../services/providers/providerUsage.js'
import { buildRouterModelSnapshot } from '../utils/router/modelRegistry.js'
import { getClaudeAIOAuthTokens, isAnthropicOAuthSignInExpired, isClaudeAISubscriber } from '../utils/auth.js'
import { getAuthConfigHomeDir } from '../utils/envUtils.js'
import { readScopeIdentity, scopeIdentityFile } from '../utils/accounts/scopeScan.js'
import { LOCAL_UNREACHABLE_REMEDY } from '../services/providers/local/localAccounts.js'
import type { ScheduleAccountV1, ScheduleAccountVerdictV1 } from './saturn.js'


export interface FamilyCredentialPresenceV1 {
  credentialed: boolean
  kind: 'oauth' | 'api-key' | 'keyless' | 'none'
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
  presenceOf?: (family: string) => FamilyCredentialPresenceV1
  anthropicDetail?: () => AnthropicOauthDetailV1 | null
}

function productionPresenceOf(family: string): FamilyCredentialPresenceV1 {
  if (family === 'anthropic') {
    try {
      const presence = anthropicCredentialPresence()
      if (!presence.credentialed) return { credentialed: false, kind: 'none' }
      const detail = productionAnthropicDetail()
      return { credentialed: true, kind: detail !== null && detail.subscriber ? 'oauth' : 'api-key' }
    } catch {
      return { credentialed: false, kind: 'none' }
    }
  }
  try {
    const provider = buildRouterModelSnapshot().providers.find(p => p.id === family)
    const account = (provider?.description as { account?: { kind?: string } } | undefined)?.account
    if (!account || account.kind === 'none' || account.kind === undefined) {
      return { credentialed: false, kind: 'none' }
    }
    if (account.kind === 'keyless') return { credentialed: true, kind: 'keyless' }
    return { credentialed: true, kind: account.kind === 'oauth' ? 'oauth' : 'api-key' }
  } catch {
    return { credentialed: false, kind: 'none' }
  }
}

function productionAnthropicDetail(): AnthropicOauthDetailV1 | null {
  try {
    const subscriber = ((): boolean => {
      try {
        return isClaudeAISubscriber()
      } catch {
        return false
      }
    })()
    const tokens = ((): { expiresAt: number | null; refreshToken: string | null } | null => {
      try {
        return getClaudeAIOAuthTokens()
      } catch {
        return null
      }
    })()
    const scopeDir = getAuthConfigHomeDir()
    const identity = ((): string | undefined => {
      try {
        return readScopeIdentity(scopeIdentityFile(scopeDir)).email
      } catch {
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
  } catch {
    return null
  }
}

export type ScheduleAccountDerivation =
  | { ok: true; account: ScheduleAccountV1 }
  | { ok: false; reason: string; code?: 'unreachable' }

export function noCredentialRefusal(family: string): string {
  return `no-credential:${family} — /logins connects an account, or /router key ${family} connects an API key`
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
  const presence = presenceOf(family)
  if (!presence.credentialed || presence.kind === 'none') {
    if (family === 'local') return { ok: false, reason: localUnreachableRefusal(), code: 'unreachable' }
    return { ok: false, reason: noCredentialRefusal(family) }
  }
  if (presence.kind === 'keyless') {
    return { ok: true, account: { family, source: 'keyless' } }
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
  return { ok: true, account: { family, source: presence.kind === 'oauth' ? 'oauth' : 'api-key' } }
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
  presenceOf?: (family: string) => FamilyCredentialPresenceV1
  strandedNow?: () => boolean
  anthropicDetail?: () => AnthropicOauthDetailV1 | null
  rateLimitedUntilOf?: (family: string) => number | undefined
}

export function readLiveAccountFacts(
  account: Pick<ScheduleAccountV1, 'family' | 'source'>,
  reads: LiveFactsReads = {},
): LiveAccountFactsV1 {
  const presence = (reads.presenceOf ?? productionPresenceOf)(account.family)
  const stranded =
    account.family === 'anthropic' && account.source === 'oauth'
      ? (reads.strandedNow ??
          ((): boolean => {
            try {
              return isAnthropicOAuthSignInExpired()
            } catch {
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
