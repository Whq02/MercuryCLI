import { credentialFingerprint } from '../credentialIdentity.js'
import type { UsageWindowView } from '../providerUsage.js'
import { USAGE_POLL_TTL_MS, usageStaleAfterMs } from '../usageFreshness.js'
import {
  readMetaMuseCodeGrant,
  requestMuseCodeKey,
  resolveMetaAccount,
  writeMetaMuseCodeGrant,
  type MetaSubsUsageRecord,
} from './metaAccounts.js'

export const META_USAGE_ABSENCE = 'account credit balance and remaining plan allowance are not reported by the Meta Model API; API keys are billed pay-as-you-go'

export function metaObservedBalance(): null {
  return null
}

export interface MetaMuseCodeUsageView {
  email?: string
  tierId?: string
  tierName?: string
  usage?: MetaSubsUsageRecord
  observedAtMs: number
}

export type MetaMuseCodeUsageFailure =
  | { kind: 'refused'; status: number; message?: string; atMs: number }
  | { kind: 'inactive'; actionUrl?: string; message?: string; atMs: number }
  | { kind: 'unreachable'; message: string; atMs: number }

let lastFailure: MetaMuseCodeUsageFailure | null = null
let lastFailureIdentity = 'none'
let lastAttemptAtMs = 0
let inFlight: Promise<{ usage: MetaMuseCodeUsageView | null; failure: MetaMuseCodeUsageFailure | null }> | null = null

function currentGrantIdentity(): string {
  const grant = readMetaMuseCodeGrant()
  return grant ? credentialFingerprint(grant.accessToken) : 'none'
}

export function __resetMetaUsageForTest(): void {
  lastFailure = null
  lastFailureIdentity = 'none'
  lastAttemptAtMs = 0
  inFlight = null
}

export function metaObservedMuseCodeUsage(): {
  usage: MetaMuseCodeUsageView | null
  failure: MetaMuseCodeUsageFailure | null
} {
  const grant = readMetaMuseCodeGrant()
  const identity = grant ? credentialFingerprint(grant.accessToken) : 'none'
  if (lastFailureIdentity !== identity) {
    lastFailure = null
    lastFailureIdentity = identity
  }
  if (!grant) return { usage: null, failure: null }
  return {
    usage: {
      ...(grant.email ? { email: grant.email } : {}),
      ...(grant.tierId ? { tierId: grant.tierId } : {}),
      ...(grant.tierName ? { tierName: grant.tierName } : {}),
      ...(grant.usage ? { usage: grant.usage } : {}),
      observedAtMs: grant.observedAtMs,
    },
    failure: lastFailure,
  }
}

function windowDurationLabel(windowMinutes?: number): string {
  if (windowMinutes === undefined) return '5h'
  if (windowMinutes >= 6 * 24 * 60) return 'wk'
  if (windowMinutes >= 24 * 60) return `${Math.round(windowMinutes / (24 * 60))}d`
  if (windowMinutes >= 60) return `${Math.round(windowMinutes / 60)}h`
  return `${Math.round(windowMinutes)}m`
}

export function metaMuseCodeWindowViews(observed: MetaMuseCodeUsageView | null): UsageWindowView[] {
  if (!observed?.usage) return []
  const views: UsageWindowView[] = []
  const freshForMs = usageStaleAfterMs()
  const w = observed.usage.window
  if (w && w.usedPercent !== undefined) {
    const label = windowDurationLabel(w.windowDurationMins)
    views.push({
      key: label === 'wk' ? 'window' : label,
      label: label === 'wk' ? 'win' : label,
      state: 'live',
      usedPct: Math.min(100, Math.max(0, w.usedPercent)),
      ...(w.resetsAtMs !== undefined ? { resetsAtMs: w.resetsAtMs } : {}),
      observedAtMs: observed.observedAtMs,
      source: 'endpoint',
      freshForMs,
    })
  }
  const wk = observed.usage.weekly
  if (wk && wk.usedPercent !== undefined) {
    views.push({
      key: '7d',
      label: 'wk',
      state: 'live',
      usedPct: Math.min(100, Math.max(0, wk.usedPercent)),
      ...(wk.resetsAtMs !== undefined ? { resetsAtMs: wk.resetsAtMs } : {}),
      observedAtMs: observed.observedAtMs,
      source: 'endpoint',
      freshForMs,
    })
  }
  return views
}

export function metaMuseCodeFailureWords(failure: MetaMuseCodeUsageFailure): string {
  if (failure.kind === 'refused') {
    if (failure.status === 401 || failure.status === 403) {
      return `the Muse Code key was refused (HTTP ${failure.status}) — /logins signs in with Meta again`
    }
    return `Meta key endpoint returned HTTP ${failure.status} on usage read — retry /usage`
  }
  if (failure.kind === 'inactive') {
    return `Muse Code subscription is not active${failure.actionUrl ? ` — visit ${failure.actionUrl}` : ''} — /logins signs in with Meta again`
  }
  return 'Meta key endpoint could not be reached for usage read — retry /usage'
}

export function refreshMetaMuseCodeUsage(io?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
  reason?: 'open' | 'operator' | 'sign-in'
}): Promise<{ usage: MetaMuseCodeUsageView | null; failure: MetaMuseCodeUsageFailure | null }> {
  const env = io?.env ?? process.env
  const now = io?.now?.() ?? Date.now()
  if (resolveMetaAccount(env)?.kind !== 'muse-code') {
    return Promise.resolve(metaObservedMuseCodeUsage())
  }
  const grant = readMetaMuseCodeGrant()
  if (!grant) return Promise.resolve({ usage: null, failure: null })
  const force = io?.force === true || io?.reason === 'operator' || io?.reason === 'sign-in'
  const lastReadAt = Math.max(grant.observedAtMs, lastAttemptAtMs)
  if (!force && lastReadAt > 0 && now - lastReadAt < USAGE_POLL_TTL_MS) {
    return Promise.resolve(metaObservedMuseCodeUsage())
  }
  if (inFlight) return inFlight
  const work = (async () => {
    try {
      lastAttemptAtMs = now
      const identity = currentGrantIdentity()
      const res = await requestMuseCodeKey(grant.accessToken, {
        ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
        env,
        now: () => now,
        onboard: false,
      })
      if (currentGrantIdentity() !== identity) return metaObservedMuseCodeUsage()
      lastFailureIdentity = identity
      if (res.state === 'refused') {
        lastFailure = {
          kind: 'refused',
          status: res.status,
          ...(res.message ? { message: res.message } : {}),
          atMs: now,
        }
        return metaObservedMuseCodeUsage()
      }
      if (res.state === 'unreachable') {
        lastFailure = { kind: 'unreachable', message: res.message, atMs: now }
        return metaObservedMuseCodeUsage()
      }
      if (res.requirePayment === true || res.isSubsActive === false) {
        lastFailure = {
          kind: 'inactive',
          ...(res.actionUrl ? { actionUrl: res.actionUrl } : {}),
          ...(res.message ? { message: res.message } : {}),
          atMs: now,
        }
        return metaObservedMuseCodeUsage()
      }
      lastFailure = null
      const latest = readMetaMuseCodeGrant() ?? grant
      writeMetaMuseCodeGrant({
        ...latest,
        ...(res.apiKey ? { apiKey: res.apiKey } : {}),
        ...(res.userId ? { userId: res.userId } : {}),
        ...(res.email ? { email: res.email } : {}),
        ...(res.tierId ? { tierId: res.tierId } : {}),
        ...(res.tierName ? { tierName: res.tierName } : {}),
        ...(res.usage ? { usage: res.usage } : {}),
        observedAtMs: now,
      })
      return metaObservedMuseCodeUsage()
    } finally {
      inFlight = null
    }
  })()
  inFlight = work
  return work
}
