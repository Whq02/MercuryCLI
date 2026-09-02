// ============================================================================
//  providers/deepseek/deepseekLogin — the /logins card's DeepSeek key leg as
//  ONE driver, shared by the connect surface (which only paints) and the
//  loopback prover (which drives the same code path): prove the key live
//  through the documented balance endpoint FIRST (a refused key is never
//  stored; a dead platform stores it unverified with the fault named), then
//  store it auth-scoped and report the balance. DeepSeek is API-key only
//  (deepseekAccounts' header records the live check) — no sign-in is
//  invented. Receipts never carry the key value.
// ============================================================================
import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredDeepseekApiKey } from '../../../utils/router/providerSecrets.js'
import { fetchDeepseekBalance } from './deepseekUsageState.js'

export interface DeepseekKeyLoginOutcome {
  ok: boolean
  /** True when the key reached the store (a refused key never does). */
  stored: boolean
  receipt: string
}

export async function storeDeepseekApiKeyLogin(
  key: string,
  io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<DeepseekKeyLoginOutcome> {
  const env = io?.env ?? process.env
  const probe = await fetchDeepseekBalance(key, io)
  if (probe.state === 'refused') {
    return {
      ok: false,
      stored: false,
      receipt: `DeepSeek refused this key (HTTP ${probe.status}) — it is not a valid DeepSeek API key; check platform.deepseek.com → API keys and paste again.`,
    }
  }
  try {
    writeStoredDeepseekApiKey(key)
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${errorMessageWithCause(error)}` }
  }
  const shadowNote = env.DEEPSEEK_API_KEY?.trim()
    ? ' NOTE: a DEEPSEEK_API_KEY env pin is set and WINS over the store this session.'
    : ''
  if (probe.state === 'confirmed') {
    const primary = probe.balance.balances[0]
    const balanceNote = primary
      ? `balance ${primary.currency} ${primary.totalBalance} (provider-stated${probe.balance.isAvailable ? '' : ' · the account is marked unavailable for inference'})`
      : `the balance endpoint answered${probe.balance.isAvailable ? '' : ' · the account is marked unavailable for inference'}`
    return {
      ok: true,
      stored: true,
      receipt: `DeepSeek API key stored (auth-scoped, mode 600) · ${balanceNote}. Requests ride api.deepseek.com under usage-based billing; the DeepSeek rows join /model.${shadowNote}`,
    }
  }
  return {
    ok: true,
    stored: true,
    receipt: `DeepSeek API key stored UNVERIFIED (auth-scoped, mode 600) — the platform could not be reached to confirm it (${probe.message}); the lane refuses at dispatch if the key is wrong.${shadowNote}`,
  }
}
