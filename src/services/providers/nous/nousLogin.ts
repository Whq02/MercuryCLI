import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredNousApiKey } from '../../../utils/router/providerSecrets.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { NOUS_API_KEY_ENV, nousApiBase, nousSigninIdentity } from './nousAccounts.js'
import { peekNousClient } from './nousClientContract.js'
import { pollNousDeviceToken, startNousDeviceAuth, writeNousTokens, writePreferredNousSource, type NousDeviceAuthStart, type NousOauthIo, type NousTokens } from './nousOauth.js'
import { fetchNousAccount, nousCreditsDisplay, type NousObservedAccount, type NousUsageIo } from './nousUsageState.js'

export interface NousKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
  account?: NousObservedAccount
}

export const NOUS_CONNECT_ROWS = [
  { label: 'Sign in with your Nous Portal account — browser approval', value: 'device' },
  { label: 'Paste an API key (model gateway)', value: 'key' },
]
export const NOUS_CONNECT_STOPPED_RECEIPT = 'Nous Portal sign-in cancelled — an approval already in flight still lands; /accounts shows and removes it.'
export const NOUS_KEY_LEG_OFFER = '/logins nous retries the sign-in or stores an API key.'

export function nousAccountReceiptLine(account: NousObservedAccount): string {
  const parts: string[] = []
  const plan = account.subscription?.plan
  if (plan !== undefined) parts.push(`plan ${plan}${account.subscription?.tier !== undefined ? ` (tier ${account.subscription.tier})` : ''}`)
  const credits = nousCreditsDisplay(account)
  if (credits !== undefined) parts.push(`${credits} (provider-stated)`)
  if (account.accountTier !== undefined && plan === undefined && credits === undefined) parts.push(`account tier ${account.accountTier}`)
  return parts.length > 0 ? parts.join(' · ') : 'the Portal account endpoint answered (no plan or credit figures stated)'
}

export async function storeNousApiKeyLogin(key: string, io?: NousUsageIo): Promise<NousKeyLoginOutcome> {
  const env = io?.env ?? process.env
  try {
    writeStoredNousApiKey(key)
    writePreferredNousSource('api-key')
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${errorMessageWithCause(error)}` }
  }
  const shadowNote = env[NOUS_API_KEY_ENV]?.trim() ? ` NOTE: a ${NOUS_API_KEY_ENV} env pin is set and WINS over the store this session.` : ''
  const ride = `Requests ride ${nousApiBase(env)} against the Portal credits or subscription behind the key (portal.nousresearch.com manages both); the Portal rows join /model.`
  const probe = await fetchNousAccount(key, io)
  if (probe.state === 'confirmed') {
    return {
      ok: true,
      stored: true,
      account: probe.account,
      receipt: `Nous Portal API key stored (auth-scoped, mode 600) · ${nousAccountReceiptLine(probe.account)}. ${ride}${shadowNote}`,
    }
  }
  if (probe.state === 'refused') {
    return {
      ok: true,
      stored: true,
      receipt: `Nous Portal API key stored (auth-scoped, mode 600) — the Portal account endpoint did not confirm it (HTTP ${probe.status}${probe.message ? `: ${probe.message}` : ''}); the first turn proves the key, and the lane refuses at dispatch if it is wrong. ${ride}${shadowNote}`,
    }
  }
  return {
    ok: true,
    stored: true,
    receipt: `Nous Portal API key stored UNVERIFIED (auth-scoped, mode 600) — the Portal could not be reached to confirm it (${probe.message}); the lane refuses at dispatch if the key is wrong. ${ride}${shadowNote}`,
  }
}

export type NousDeviceLoginEvent =
  | { phase: 'starting' | 'finishing' }
  | { phase: 'waiting'; start: NousDeviceAuthStart; polls: number; note?: string }

export async function runNousDeviceLogin(args: {
  io?: NousOauthIo
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
  onEvent?: (event: NousDeviceLoginEvent) => void
} = {}): Promise<{ ok: boolean; receipt: string; settledAfterCancel?: true }> {
  const cancelled = args.cancelled ?? (() => false)
  const now = args.io?.now ?? Date.now
  const sleep = args.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const fail = (what: string): { ok: false; receipt: string } => ({ ok: false, receipt: `${what} — nothing stored. ${NOUS_KEY_LEG_OFFER}` })
  args.onEvent?.({ phase: 'starting' })
  await peekNousClient(args.io).catch(() => undefined)
  if (cancelled()) return { ok: false, receipt: `Nous Portal sign-in cancelled — nothing stored. ${NOUS_KEY_LEG_OFFER}` }
  let start: NousDeviceAuthStart
  try {
    start = await startNousDeviceAuth(args.io)
  } catch (error) {
    return fail(`Nous Portal sign-in could not start: ${errorMessageWithCause(error)}`)
  }
  let polls = 0
  let interval = start.intervalSec
  args.onEvent?.({ phase: 'waiting', start, polls })
  while (!cancelled() && now() < start.expiresAtMs) {
    await sleep(Math.min(interval * 1000, Math.max(0, start.expiresAtMs - now())))
    if (cancelled() || now() >= start.expiresAtMs) break
    let result: Awaited<ReturnType<typeof pollNousDeviceToken>>
    try {
      result = await pollNousDeviceToken(start, args.io)
    } catch {
      args.onEvent?.({ phase: 'waiting', start, polls: ++polls, note: 'the Portal did not answer the approval check — waiting until the code expires.' })
      continue
    }
    polls++
    if (result.state === 'slow-down') interval = Math.min(interval + 1, 30)
    if (result.state === 'pending' || result.state === 'slow-down' || result.state === 'unavailable') {
      args.onEvent?.({ phase: 'waiting', start, polls, ...(result.state === 'unavailable' ? { note: 'the Portal is busy — waiting until the code expires.' } : {}) })
      continue
    }
    if (result.state === 'denied') return fail('Nous Portal sign-in was declined in the browser')
    if (result.state === 'expired') return fail('Nous Portal sign-in code expired before it was approved')
    if (result.state === 'refused') return fail(`Nous Portal refused the sign-in (${result.words})`)
    const approved: NousTokens = result.tokens
    args.onEvent?.({ phase: 'finishing' })
    try {
      writeNousTokens(approved)
      writePreferredNousSource('signin')
      recordSignIn('nous', 'oauth')
    } catch {
      return fail('Nous Portal approved the sign-in but storing it failed')
    }
    const late = (): { ok: boolean; receipt: string; settledAfterCancel: true } => ({ ok: true, settledAfterCancel: true, receipt: 'Nous Portal sign-in completed after cancel — the approved sign-in is stored; /accounts removes it.' })
    if (cancelled()) return late()
    const probe = await fetchNousAccount(approved.accessToken, args.io as NousUsageIo | undefined, 'signin', nousSigninIdentity(approved))
    if (cancelled()) return late()
    const note = probe.state === 'confirmed'
      ? nousAccountReceiptLine(probe.account)
      : probe.state === 'refused'
        ? `UNVERIFIED — the Portal account endpoint answered HTTP ${probe.status}; the first turn proves the sign-in`
        : 'UNVERIFIED — the Portal account endpoint did not answer; the first turn proves the sign-in'
    const shadow = (args.io?.env ?? process.env)[NOUS_API_KEY_ENV]?.trim() ? ` NOTE: ${NOUS_API_KEY_ENV} is set and wins over this sign-in.` : ''
    return { ok: true, receipt: `Nous Portal sign-in stored (auth-scoped, mode 600) · ${note}. Requests ride ${nousApiBase(args.io?.env ?? process.env, approved)} on the account's credits or subscription; /usage reads the plan and credits; /accounts manages it.${shadow}` }
  }
  return cancelled() ? { ok: false, receipt: `Nous Portal sign-in cancelled — nothing stored. ${NOUS_KEY_LEG_OFFER}` } : fail('Nous Portal sign-in code expired before it was approved')
}
