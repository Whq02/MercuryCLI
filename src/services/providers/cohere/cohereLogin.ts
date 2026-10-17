import { errorMessageWithCause } from '../../../utils/errors.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredCohereApiKey } from '../../../utils/router/providerSecrets.js'
import { COHERE_KEY_PAGE, cohereApiBase, cohereEnvKey } from './cohereAccounts.js'
import { CohereCatalogueHttpError, fetchCohereLiveModels } from './cohereCatalogue.js'

export interface CohereKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export const COHERE_KEY_RECEIPT_TAIL = 'A trial key is rate-limited and for evaluation; a production key bills pay-as-you-go, with spend shown at dashboard.cohere.com.'

export async function storeCohereApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<CohereKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Cohere API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  try {
    const result = await fetchCohereLiveModels({ baseUrl: cohereApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} chat ${result.models.length === 1 ? 'model' : 'models'} listed`
  } catch (error) {
    if (error instanceof CohereCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `Cohere refused this key (HTTP ${error.status}) — nothing stored; create an API key at ${COHERE_KEY_PAGE} and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  try {
    writeStoredCohereApiKey(key)
    recordSignIn('cohere', 'api-key')
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = cohereEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `Cohere API key stored (auth-scoped, mode 600) · ${note}. ${COHERE_KEY_RECEIPT_TAIL}${shadow}` }
}
