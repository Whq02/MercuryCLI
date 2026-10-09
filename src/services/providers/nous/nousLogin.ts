import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredNousApiKey } from '../../../utils/router/providerSecrets.js'
import { NOUS_API_KEY_ENV, nousApiBase } from './nousAccounts.js'
import { fetchNousAccount, nousCreditsDisplay, type NousObservedAccount, type NousUsageIo } from './nousUsageState.js'

export interface NousKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
  account?: NousObservedAccount
}

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
