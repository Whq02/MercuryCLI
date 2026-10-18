import { errorMessageWithCause } from '../../../utils/errors.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredQwenApiKey } from '../providerSecrets.js'
import { QWEN_BASE_OVERRIDE_ENV, QWEN_ENV_KEY as QWEN_ENV_KEY_WORDS, qwenBaseOverride, qwenEndpointLabelOf, qwenEnvKey, rememberQwenBoundBase } from './qwenAccounts.js'
import { fetchQwenLiveModels, forgetQwenCatalogue, probeQwenEndpoints, qwenPinRows, QwenCatalogueHttpError } from './qwenCatalogue.js'
import { qwenDisplayName } from './qwenPins.js'
import { QWEN_OAUTH_CLIENT_ID, pollQwenDeviceToken, qwenPlanBase, startQwenDeviceAuth, writePreferredQwenSource, writeQwenTokens, type QwenDeviceAuthStart, type QwenOauthIo, type QwenTokens } from './qwenOauth.js'

interface QwenKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

const QWEN_KEY_PAGE_WORDS = 'modelstudio.alibabacloud.com (API-KEY, in the region the key is for)'
const QWEN_KEY_RECEIPT_TAIL = 'Text models only; the key is bound to the region and plan it was minted in, so requests ride that endpoint alone. Usage and balance are shown in the Model Studio console (no endpoint states them to an API key).'

function hostOf(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

export async function storeQwenApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<QwenKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Model Studio API key.' }
  const env = io?.env ?? process.env
  const fetchImpl = io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  let boundBase: string | undefined
  const override = qwenBaseOverride(env)
  if (override !== undefined) {
    try {
      const result = await fetchQwenLiveModels({ baseUrl: override, key, env, ...fetchImpl })
      boundBase = override
      note = `bound to ${qwenEndpointLabelOf(override, env)} (${hostOf(override)}, from ${QWEN_BASE_OVERRIDE_ENV}) · ${result.models.length} text ${result.models.length === 1 ? 'model' : 'models'} listed${result.otherLines > 0 ? ` (${result.otherLines} non-text rows set aside)` : ''}`
    } catch (error) {
      if (error instanceof QwenCatalogueHttpError && (error.status === 401 || error.status === 403)) {
        return { ok: false, stored: false, receipt: `${safe(error.message)} — nothing stored; ${QWEN_BASE_OVERRIDE_ENV} names ${hostOf(override)}, which is not the endpoint this key was minted for.` }
      }
      note = `UNVERIFIED — the model list at ${hostOf(override)} could not confirm the key (${safe(errorMessageWithCause(error))})`
    }
  } else {
    const probe = await probeQwenEndpoints({ key, env, ...fetchImpl })
    if (probe.kind === 'refused') return { ok: false, stored: false, receipt: `Model Studio refused this key on every endpoint — nothing stored; ${probe.words}. Keys are made at ${QWEN_KEY_PAGE_WORDS}.` }
    if (probe.kind === 'bound') {
      boundBase = probe.baseUrl
      note = probe.endpoint.plan === 'coding-plan'
        ? `bound to ${probe.endpoint.label} (${hostOf(probe.baseUrl)}) · the plan's ${qwenPinRows(env, 'coding-plan').length} documented models, ${qwenDisplayName(qwenPinRows(env, 'coding-plan')[0]?.id ?? '')} first (the endpoint's own model list answers every caller and is not the plan's)`
        : `bound to ${probe.endpoint.label} (${hostOf(probe.baseUrl)}) · ${probe.models.length} text ${probe.models.length === 1 ? 'model' : 'models'} listed${probe.otherLines > 0 ? ` (${probe.otherLines} non-text rows set aside)` : ''}`
    } else {
      note = `UNVERIFIED — no endpoint confirmed the key: ${safe(probe.words)}; the first turn probes the endpoints again`
    }
  }
  try {
    writeStoredQwenApiKey(key, boundBase)
    writePreferredQwenSource('api-key')
    if (boundBase !== undefined) rememberQwenBoundBase(key, boundBase)
    forgetQwenCatalogue()
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = qwenEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `Model Studio API key stored (auth-scoped, mode 600) · ${note}. ${QWEN_KEY_RECEIPT_TAIL}${shadow}` }
}

export const QWEN_CONNECT_ROWS = [
  { label: 'Sign in with your Qwen account — device code in the browser (the Qwen Coder plan)', value: 'device' },
  { label: 'Paste a Model Studio API key (pay-as-you-go or a plan key)', value: 'key' },
]
export const QWEN_CONNECT_CLIENT_LINE = `The sign-in runs Qwen Code's public OAuth client (client id ${QWEN_OAUTH_CLIENT_ID}) against chat.qwen.ai: the device code, the token and the refresh leave this machine for that service and nothing else; the plan's terms are yours with Qwen, and Mercury ships this road as it is.`
export const QWEN_FACE_PICK_LINE = "Sign in with your Qwen account in the browser (the Qwen Coder plan, on Qwen Code's public client and the plan's own terms), or paste a Model Studio API key."
export const QWEN_CONNECT_STOPPED_RECEIPT = 'Qwen account sign-in cancelled — an approval already in flight still lands; /accounts shows and removes it.'
const QWEN_KEY_LEG_OFFER = '/logins qwen retries the sign-in or stores a Model Studio API key.'

export type QwenDeviceLoginEvent =
  | { phase: 'starting' | 'finishing' }
  | { phase: 'waiting'; start: QwenDeviceAuthStart; polls: number; note?: string }

export async function runQwenDeviceLogin(args: {
  io?: QwenOauthIo
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
  onEvent?: (event: QwenDeviceLoginEvent) => void
} = {}): Promise<{ ok: boolean; receipt: string; settledAfterCancel?: true }> {
  const cancelled = args.cancelled ?? (() => false)
  const now = args.io?.now ?? Date.now
  const sleep = args.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const fail = (what: string): { ok: false; receipt: string } => ({ ok: false, receipt: `${what} — nothing stored. ${QWEN_KEY_LEG_OFFER}` })
  args.onEvent?.({ phase: 'starting' })
  if (cancelled()) return { ok: false, receipt: `Qwen account sign-in cancelled — nothing stored. ${QWEN_KEY_LEG_OFFER}` }
  let start: QwenDeviceAuthStart
  try {
    start = await startQwenDeviceAuth(args.io)
  } catch (error) {
    return fail(`Qwen account sign-in could not start: ${errorMessageWithCause(error)}`)
  }
  let polls = 0
  let interval = start.intervalSec
  args.onEvent?.({ phase: 'waiting', start, polls })
  while (!cancelled() && now() < start.expiresAtMs) {
    await sleep(Math.min(interval * 1000, Math.max(0, start.expiresAtMs - now())))
    if (cancelled() || now() >= start.expiresAtMs) break
    let result: Awaited<ReturnType<typeof pollQwenDeviceToken>>
    try {
      result = await pollQwenDeviceToken(start, args.io)
    } catch {
      args.onEvent?.({ phase: 'waiting', start, polls: ++polls, note: 'the sign-in service did not answer the approval check — waiting until the code expires.' })
      continue
    }
    polls++
    if (result.state === 'slow-down') interval = Math.min(interval + 1, 30)
    if (result.state === 'pending' || result.state === 'slow-down' || result.state === 'unavailable') {
      args.onEvent?.({ phase: 'waiting', start, polls, ...(result.state === 'unavailable' ? { note: 'the sign-in service is busy — waiting until the code expires.' } : {}) })
      continue
    }
    if (result.state === 'denied') return fail('Qwen account sign-in was declined in the browser')
    if (result.state === 'expired') return fail('Qwen account sign-in code expired before it was approved')
    if (result.state === 'refused') return fail(`the Qwen sign-in service refused the sign-in (${result.words})`)
    const approved: QwenTokens = result.tokens
    args.onEvent?.({ phase: 'finishing' })
    try {
      writeQwenTokens(approved)
      writePreferredQwenSource('signin')
      recordSignIn('qwen', 'oauth')
      forgetQwenCatalogue()
    } catch {
      return fail('the Qwen account approved the sign-in but storing it failed')
    }
    const late = (): { ok: boolean; receipt: string; settledAfterCancel: true } => ({ ok: true, settledAfterCancel: true, receipt: 'Qwen account sign-in completed after cancel — the approved sign-in is stored; /accounts removes it.' })
    if (cancelled()) return late()
    const env = args.io?.env ?? process.env
    const planBase = qwenPlanBase(approved, env)
    let note: string
    try {
      const result = await fetchQwenLiveModels({ baseUrl: planBase, key: approved.accessToken, env, ...(args.io?.fetchImpl ? { fetchImpl: args.io.fetchImpl } : {}) })
      note = `${result.models.length} text ${result.models.length === 1 ? 'model' : 'models'} listed on the plan endpoint`
    } catch (error) {
      note = `UNVERIFIED — the plan endpoint's model list could not be read (${errorMessageWithCause(error).split(approved.accessToken).join('[redacted]')}); the first turn proves the sign-in and the pinned plan row runs meanwhile`
    }
    if (cancelled()) return late()
    const shadow = qwenEnvKey(env) ? ` NOTE: ${QWEN_ENV_KEY_WORDS} is set and wins over this sign-in.` : ''
    return { ok: true, receipt: `Qwen account sign-in stored (auth-scoped, mode 600) · ${note}. Requests ride ${hostOf(planBase)} under the Qwen Coder plan's own terms, on Qwen Code's public client; /usage counts the session's tokens; /accounts manages it.${shadow}` }
  }
  return cancelled() ? { ok: false, receipt: `Qwen account sign-in cancelled — nothing stored. ${QWEN_KEY_LEG_OFFER}` } : fail('Qwen account sign-in code expired before it was approved')
}
