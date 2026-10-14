import { errorMessageWithCause } from '../../../utils/errors.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredMetaApiKey } from '../../../utils/router/providerSecrets.js'
import {
  metaApiBase,
  metaEnvKey,
  pollMetaDeviceToken,
  requestMuseCodeKey,
  startMetaDeviceAuth,
  writeMetaMuseCodeGrant,
  writePreferredMetaSource,
  type MetaDeviceAuthStart,
  type MetaMuseCodeGrant,
  type MetaOauthIo,
  type MetaSubsUsageRecord,
} from './metaAccounts.js'
import { fetchMetaLiveModels, MetaCatalogueHttpError } from './metaCatalogue.js'

export const META_MUSE_CODE_ROW = 'Sign in with Meta — a Muse Code subscription, a device code in your browser'
export const META_KEY_ROW = 'API key — pay-as-you-go Model API key (stored locally, mode 600)'

export const META_CONNECT_ROWS = [
  { label: META_MUSE_CODE_ROW, value: 'device' as const },
  { label: META_KEY_ROW, value: 'key' as const },
]

export const META_CONNECT_STOPPED_RECEIPT =
  'Meta sign-in cancelled — if the approval was already in flight it still lands; /accounts shows and removes it.'

export const META_SETTLED_AFTER_CANCEL_RECEIPT =
  'Meta sign-in completed after cancel — the approval landed while this flow was being cancelled, so the account IS signed in (an unstored copy would orphan the live grant). ⌫ on its /accounts row signs it out.'

const RFC_SLOW_DOWN_STEP_SEC = 5

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export type MetaDeviceLoginEvent =
  | { phase: 'starting' }
  | { phase: 'waiting'; start: MetaDeviceAuthStart; polls: number; note?: string }
  | { phase: 'finishing' }

export interface MetaDeviceLoginArgs {
  io?: MetaOauthIo
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
  onEvent?: (event: MetaDeviceLoginEvent) => void
}

export type MetaDeviceLoginOutcome =
  | {
      ok: true
      receipt: string
      grant: MetaMuseCodeGrant
      settledAfterCancel?: true
    }
  | {
      ok: false
      receipt: string
      code: 'start-failed' | 'expired' | 'denied' | 'refused' | 'require-payment' | 'cancelled' | 'store-failed'
      actionUrl?: string
      settledAfterCancel?: true
    }

export function metaMuseCodeUsageReceiptLine(usage?: MetaSubsUsageRecord): string | undefined {
  if (!usage) return undefined
  const parts: string[] = []
  if (usage.window?.usedPercent !== undefined) {
    parts.push(`window ${Math.round(usage.window.usedPercent)}%`)
  }
  if (usage.weekly?.usedPercent !== undefined) {
    parts.push(`weekly ${Math.round(usage.weekly.usedPercent)}%`)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export async function runMetaDeviceLogin(args: MetaDeviceLoginArgs = {}): Promise<MetaDeviceLoginOutcome> {
  const { io, onEvent } = args
  const sleep = args.sleep ?? defaultSleep
  const cancelled = args.cancelled ?? (() => false)
  const now = (): number => io?.now?.() ?? Date.now()
  onEvent?.({ phase: 'starting' })
  let start: MetaDeviceAuthStart
  try {
    start = await startMetaDeviceAuth(io)
  } catch (error) {
    return {
      ok: false,
      code: 'start-failed',
      receipt: `Meta sign-in could not start: ${errorMessageWithCause(error)} — retry from /logins meta, or paste a Meta Model API key.`,
    }
  }
  let polls = 0
  let intervalSec = start.intervalSec
  let note: string | undefined
  onEvent?.({ phase: 'waiting', start, polls })
  while (true) {
    if (cancelled()) return { ok: false, code: 'cancelled', receipt: 'Meta sign-in cancelled — nothing stored.' }
    if (now() >= start.expiresAtMs) {
      return {
        ok: false,
        code: 'expired',
        receipt: 'Meta sign-in expired before the code was entered — retry from /logins meta.',
      }
    }
    await sleep(intervalSec * 1000)
    if (cancelled()) return { ok: false, code: 'cancelled', receipt: 'Meta sign-in cancelled — nothing stored.' }
    polls += 1
    const result = await pollMetaDeviceToken(start, io)
    if (result.state === 'unreachable') {
      note = `the Meta authorization host did not answer (${result.message}) — still trying until the code expires`
      onEvent?.({ phase: 'waiting', start, polls, note })
      continue
    }
    note = undefined
    if (result.state === 'pending') {
      onEvent?.({ phase: 'waiting', start, polls })
      continue
    }
    if (result.state === 'slow-down') {
      intervalSec += RFC_SLOW_DOWN_STEP_SEC
      onEvent?.({ phase: 'waiting', start, polls })
      continue
    }
    if (result.state === 'denied') {
      if (result.code === 'expired_token') {
        return {
          ok: false,
          code: 'expired',
          receipt: 'Meta sign-in expired before the code was entered — retry from /logins meta.',
        }
      }
      if (result.code === 'access_denied') {
        return { ok: false, code: 'denied', receipt: 'Meta sign-in was denied on the Meta page — nothing stored.' }
      }
      return {
        ok: false,
        code: 'refused',
        receipt: `Meta sign-in refused (${result.code}${result.description ? `: ${result.description}` : ''}) — nothing stored.`,
      }
    }
    onEvent?.({ phase: 'finishing' })
    const approvedAfterCancel = cancelled()
    const mint = await requestMuseCodeKey(result.accessToken, { ...io, onboard: true })
    if (mint.state === 'unreachable') {
      return {
        ok: false,
        code: 'refused',
        receipt: `Meta key mint could not reach api.meta.ai (${mint.message}) — nothing stored; retry from /logins meta.`,
      }
    }
    if (mint.state === 'refused') {
      return {
        ok: false,
        code: 'refused',
        receipt: `Meta key mint refused the account token (HTTP ${mint.status}${mint.message ? `: ${mint.message}` : ''}) — nothing stored; retry from /logins meta.`,
      }
    }
    if (mint.requirePayment === true || (!mint.apiKey && mint.actionUrl)) {
      const metaWords = [
        'require_payment',
        ...(mint.isSubsActive === false ? ['is_subs_active: false'] : []),
        ...(mint.message ? [mint.message] : []),
      ].join(' · ')
      const pageClause = mint.actionUrl ? ` — visit ${mint.actionUrl} to activate a Muse Code plan` : ''
      return {
        ok: false,
        code: 'require-payment',
        ...(mint.actionUrl ? { actionUrl: mint.actionUrl } : {}),
        receipt: `Meta requires an active Muse Code subscription (${metaWords})${pageClause} — nothing stored as active.`,
      }
    }
    if (mint.isSubsActive === false) {
      const pageClause = mint.actionUrl ? ` — visit ${mint.actionUrl}` : ''
      return {
        ok: false,
        code: 'refused',
        receipt: `Meta reports the Muse Code subscription is inactive (is_subs_active: false${mint.message ? ` · ${mint.message}` : ''})${pageClause} — nothing stored as active.`,
      }
    }
    if (!mint.apiKey) {
      return {
        ok: false,
        code: 'refused',
        receipt: 'Meta key response returned no api_key — nothing stored as active.',
      }
    }
    const grant: MetaMuseCodeGrant = {
      accessToken: result.accessToken,
      apiKey: mint.apiKey,
      ...(mint.userId ? { userId: mint.userId } : {}),
      ...(mint.email ? { email: mint.email } : {}),
      ...(mint.tierId ? { tierId: mint.tierId } : {}),
      ...(mint.tierName ? { tierName: mint.tierName } : {}),
      ...(mint.usage ? { usage: mint.usage } : {}),
      observedAtMs: mint.observedAtMs,
    }
    try {
      writeMetaMuseCodeGrant(grant)
      writePreferredMetaSource('muse-code')
    } catch (error) {
      return {
        ok: false,
        code: 'store-failed',
        receipt: `Meta authorized but the grant could not be stored: ${errorMessageWithCause(error)} — retry from /logins meta.`,
      }
    }
    recordSignIn('meta', 'oauth')
    if (approvedAfterCancel || cancelled()) {
      return {
        ok: true,
        settledAfterCancel: true,
        grant,
        receipt: META_SETTLED_AFTER_CANCEL_RECEIPT,
      }
    }
    const tierWords = grant.tierName ?? grant.tierId ?? 'Muse Code subscription'
    const who = grant.email ? ` as ${grant.email}` : ''
    const usageWords = metaMuseCodeUsageReceiptLine(grant.usage)
    const usageClause = usageWords ? ` · ${usageWords}` : ''
    return {
      ok: true,
      grant,
      receipt: `Meta connected: Muse Code sign-in${who} (${tierWords}) · stored auth-scoped (mode 600)${usageClause}. Requests ride api.meta.ai/v1 with the minted key; the Muse Spark rows join /model; /usage shows the plan windows; /accounts manages the sign-in.`,
    }
  }
}

export interface MetaKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export async function storeMetaApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<MetaKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Meta Model API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  try {
    const result = await fetchMetaLiveModels({ baseUrl: metaApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} Muse Spark ${result.models.length === 1 ? 'model' : 'models'} listed`
  } catch (error) {
    if (error instanceof MetaCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `Meta refused this key (HTTP ${error.status}) — nothing stored; create a Model API key at dev.meta.ai and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  try {
    writeStoredMetaApiKey(key)
    writePreferredMetaSource('api-key')
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = metaEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `Meta API key stored (auth-scoped, mode 600) · ${note}. Requests use pay-as-you-go billing; Muse Code subscriptions are for Muse Code only.${shadow}` }
}
