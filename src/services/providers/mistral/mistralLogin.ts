import { errorMessageWithCause } from '../../../utils/errors.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredMistralAdminApiKey, writeStoredMistralApiKey } from '../../../utils/router/providerSecrets.js'
import { MISTRAL_API_KEY_PAGE, mistralApiBase, mistralEnvKey } from './mistralAccounts.js'
import { fetchMistralLiveModels, MistralCatalogueHttpError } from './mistralCatalogue.js'
import { fetchMistralIdentity, fetchMistralLimits, mistralUsageFailureWords, type MistralUsageIo } from './mistralUsageState.js'

export interface MistralKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export async function storeMistralApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<MistralKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Mistral API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  const usageIo: MistralUsageIo = { env, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) }
  let note: string
  try {
    const result = await fetchMistralLiveModels({ baseUrl: mistralApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} chat ${result.models.length === 1 ? 'model' : 'models'} listed`
    const who = await fetchMistralIdentity(key, usageIo)
    if (who.state === 'confirmed') {
      const account = who.identity.email ?? who.identity.name
      const scope = [who.identity.organization, who.identity.workspace].filter(Boolean).join(' / ')
      if (account) note += ` · ${account}${scope ? ` (${scope})` : ''}`
    }
  } catch (error) {
    if (error instanceof MistralCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `Mistral refused this key (HTTP ${error.status}) — nothing stored; create an API key at ${MISTRAL_API_KEY_PAGE} and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  try {
    writeStoredMistralApiKey(key)
    recordSignIn('mistral', 'api-key')
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = mistralEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `Mistral API key stored (auth-scoped, mode 600) · ${note}. Requests draw on the plan's included monthly usage, then pay-as-you-go when it is switched on.${shadow}` }
}

export async function storeMistralAdminKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<MistralKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Mistral Admin API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  const probe = await fetchMistralLimits(key, { env, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
  if (probe.state === 'failed' && probe.failure.kind === 'refused') {
    return { ok: false, stored: false, receipt: `${mistralUsageFailureWords(probe.failure)} — nothing stored.` }
  }
  try {
    writeStoredMistralAdminApiKey(key)
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the Admin API key: ${safe(errorMessageWithCause(error))}` }
  }
  if (probe.state === 'failed') {
    return { ok: true, stored: true, receipt: `Mistral Admin API key stored (auth-scoped, mode 600) · UNVERIFIED — ${safe(mistralUsageFailureWords(probe.failure))}.` }
  }
  const limits = probe.limits
  const spent = limits.totalUsage ?? limits.usage
  const meter = limits.noMonthlyLimit
    ? `${limits.currency} ${spent !== undefined ? spent.toFixed(2) : '?'} used this month · no monthly limit`
    : `${limits.currency} ${spent !== undefined ? spent.toFixed(2) : '?'} of ${limits.usageLimit !== undefined ? limits.usageLimit.toFixed(2) : '?'} used this month${limits.monthlyLimitReached ? ' · LIMIT REACHED' : ''}`
  const shadow = env.MISTRAL_ADMIN_API_KEY?.trim() ? ' NOTE: MISTRAL_ADMIN_API_KEY is set and wins over this stored key.' : ''
  return { ok: true, stored: true, receipt: `Mistral Admin API key stored (auth-scoped, mode 600) · ${meter}.${shadow}` }
}
