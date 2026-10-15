import { errorMessageWithCause } from '../../../utils/errors.js'
import { formatAge } from '../../../utils/healthCertCore.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredMetaApiKey } from '../../../utils/router/providerSecrets.js'
import {
  metaApiBase,
  metaEnvKey,
  metaMuseCodeFacts,
  pollMetaDeviceToken,
  requestMuseCodeKey,
  resolveMetaAccount,
  resolveMetaRawApiKey,
  startMetaDeviceAuth,
  writeMetaMuseCodeGrant,
  writePreferredMetaSource,
  type MetaDeviceAuthStart,
  type MetaMuseCodeGrant,
  type MetaOauthIo,
  type MetaSourceKind,
  type MetaSubsUsageRecord,
} from './metaAccounts.js'
import { fetchMetaLiveModels, MetaCatalogueHttpError } from './metaCatalogue.js'

export const META_MUSE_CODE_ROW = 'Sign in with Meta — a Muse Code subscription, a device code in your browser'
const META_KEY_ROW = 'API key — pay-as-you-go Model API key (stored locally, mode 600)'

const META_KEY_RIDES = 'requests ride api.meta.ai/v1 under pay-as-you-go billing'
const META_MUSE_CODE_RIDES = "requests ride api.meta.ai/v1 with your Muse Code subscription's minted key"

export type MetaConnectRowValue = 'device' | 'key'
type MetaConnectRowAction = 'activate' | 'enter'

export interface MetaConnectFacts {
  keySource?: 'env' | 'stored'
  keyEnvName?: 'MODEL_API_KEY' | 'META_API_KEY'
  museCodeConnected: boolean
  museCodeTier?: string
  museCodeEmail?: string
  museCodeReadAtMs?: number
  active?: MetaSourceKind
}

export const META_CONNECT_ROWS: Array<{ label: string; value: MetaConnectRowValue }> = [
  { label: META_MUSE_CODE_ROW, value: 'device' },
  { label: META_KEY_ROW, value: 'key' },
]

function storedSourceCount(facts: MetaConnectFacts): number {
  return (facts.museCodeConnected ? 1 : 0) + (facts.keySource !== undefined ? 1 : 0)
}

export function metaConnectRowAction(facts: MetaConnectFacts, value: MetaConnectRowValue): MetaConnectRowAction {
  if (storedSourceCount(facts) < 2) return 'enter'
  if (value === 'device') return facts.museCodeConnected && facts.active !== 'muse-code' ? 'activate' : 'enter'
  return facts.keySource !== undefined && facts.active !== 'api-key' ? 'activate' : 'enter'
}

export function metaMuseCodeTierWordsWithAge(
  facts: Pick<MetaConnectFacts, 'museCodeTier' | 'museCodeReadAtMs'>,
  now: number = Date.now(),
): string {
  const tier = facts.museCodeTier ?? 'Muse Code'
  return facts.museCodeReadAtMs !== undefined && facts.museCodeReadAtMs > 0
    ? `${tier}, read ${formatAge(now - facts.museCodeReadAtMs)}`
    : tier
}

function metaMuseCodeRowLabel(facts: MetaConnectFacts, now: number = Date.now()): string {
  if (!facts.museCodeConnected) return META_MUSE_CODE_ROW
  const tier = metaMuseCodeTierWordsWithAge(facts, now)
  return metaConnectRowAction(facts, 'device') === 'activate'
    ? `Sign in with Meta — connected (${tier}), not active · ↵ makes it active`
    : `Sign in with Meta — connected (${tier}) · ↵ signs in again`
}

export function metaConnectRows(
  facts: MetaConnectFacts,
  now: number = Date.now(),
): Array<{ label: string; value: MetaConnectRowValue }> {
  const envName = facts.keyEnvName ?? 'MODEL_API_KEY'
  const keyRow =
    facts.keySource === undefined
      ? META_KEY_ROW
      : metaConnectRowAction(facts, 'key') === 'activate'
        ? facts.keySource === 'stored'
          ? 'API key — stored, not active · ↵ makes it active'
          : `API key — ${envName} in the environment, not active · ↵ makes it active`
        : facts.keySource === 'stored'
          ? 'API key — connected (stored locally) · ↵ pastes a replacement'
          : `API key — connected (${envName} in the environment) · ↵ pastes a stored one`
  return [
    { label: metaMuseCodeRowLabel(facts, now), value: 'device' },
    { label: keyRow, value: 'key' },
  ]
}

export function liveMetaConnectFacts(env: NodeJS.ProcessEnv = process.env): MetaConnectFacts {
  const rawKey = resolveMetaRawApiKey(env)
  const muse = metaMuseCodeFacts()
  const active = resolveMetaAccount(env)?.kind
  const tier = muse?.tierName ?? muse?.tierId
  return {
    ...(rawKey ? { keySource: rawKey.source } : {}),
    ...(rawKey?.envName ? { keyEnvName: rawKey.envName } : {}),
    museCodeConnected: muse !== undefined,
    ...(tier ? { museCodeTier: tier } : {}),
    ...(muse?.email ? { museCodeEmail: muse.email } : {}),
    ...(muse?.observedAtMs ? { museCodeReadAtMs: muse.observedAtMs } : {}),
    ...(active !== undefined ? { active } : {}),
  }
}

export function metaStoredSourcesNote(facts: MetaConnectFacts): string | undefined {
  if (facts.active === undefined || !facts.museCodeConnected || facts.keySource === undefined) return undefined
  const envName = facts.keyEnvName ?? 'MODEL_API_KEY'
  const activeWords =
    facts.active === 'muse-code'
      ? 'the Muse Code sign-in'
      : facts.keySource === 'env'
        ? `the API key (${envName})`
        : 'the API key'
  const otherWords = facts.active === 'muse-code' ? 'an API key' : 'the Muse Code sign-in'
  return `Active source: ${activeWords} · ${otherWords} is also stored — ↵ on its /logins meta row makes it active`
}

function metaSourceRides(kind: MetaSourceKind): string {
  return kind === 'api-key' ? META_KEY_RIDES : META_MUSE_CODE_RIDES
}

function otherSourceTail(active: MetaSourceKind, env: NodeJS.ProcessEnv = process.env): string {
  const facts = liveMetaConnectFacts(env)
  if (active === 'api-key' && facts.museCodeConnected) {
    return ' The Muse Code sign-in stays stored — ↵ on its /logins row makes it active.'
  }
  if (active === 'muse-code' && facts.keySource !== undefined) {
    return ' An API key is also stored — ↵ on its /logins row makes it active.'
  }
  return ''
}

export function activateMetaSource(
  kind: MetaSourceKind,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; receipt: string } {
  writePreferredMetaSource(kind)
  const named = kind === 'api-key' ? 'the API key' : 'the Muse Code sign-in'
  return {
    ok: true,
    receipt: `Meta: ${named} is now the active source — ${metaSourceRides(kind)}.${otherSourceTail(kind, env)}`,
  }
}

export const META_CONNECT_STOPPED_RECEIPT =
  'Meta sign-in cancelled — if the approval was already in flight it still lands; /accounts shows and removes it.'

const META_SETTLED_AFTER_CANCEL_RECEIPT =
  'Meta sign-in completed after cancel — the approval landed while this flow was being cancelled, so the account IS signed in (an unstored copy would orphan the live grant). ⌫ on its /accounts row signs it out.'

const RFC_SLOW_DOWN_STEP_SEC = 5

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export type MetaDeviceLoginEvent =
  | { phase: 'starting' }
  | { phase: 'waiting'; start: MetaDeviceAuthStart; polls: number; note?: string }
  | { phase: 'finishing' }

interface MetaDeviceLoginArgs {
  io?: MetaOauthIo
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
  onEvent?: (event: MetaDeviceLoginEvent) => void
}

type MetaDeviceLoginOutcome =
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

function metaMuseCodeUsageReceiptLine(usage?: MetaSubsUsageRecord): string | undefined {
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
  const env = io?.env ?? process.env
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
      receipt: `Meta connected: Muse Code sign-in${who} (${tierWords}) — the active source, ${META_MUSE_CODE_RIDES} · stored auth-scoped (mode 600)${usageClause}. The Muse Spark rows join /model; /usage shows the plan windows; /accounts manages the sign-in.${otherSourceTail('muse-code', env)}`,
    }
  }
}

interface MetaKeyLoginOutcome {
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
  return { ok: true, stored: true, receipt: `Meta API key stored (auth-scoped, mode 600) — the active source, ${META_KEY_RIDES} · ${note}. Requests use pay-as-you-go billing.${otherSourceTail('api-key', env)}${shadow}` }
}
