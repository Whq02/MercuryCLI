import { errorMessageWithCause } from '../../../utils/errors.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredCerebrasApiKey } from '../providerSecrets.js'
import { cerebrasApiBase, cerebrasEnvKey } from './cerebrasAccounts.js'
import { fetchCerebrasLiveModels, CerebrasCatalogueHttpError } from './cerebrasCatalogue.js'

interface CerebrasKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

const CEREBRAS_KEY_RECEIPT_TAIL = 'Text models only. Trial and paid accounts have different context and rate limits; account spend is shown at cloud.cerebras.ai, Analytics → Cost.'

export async function storeCerebrasApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<CerebrasKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Cerebras API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  try {
    const result = await fetchCerebrasLiveModels({ baseUrl: cerebrasApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} chat ${result.models.length === 1 ? 'model' : 'models'} listed${result.otherLines > 0 ? ` (${result.otherLines} non-chat rows set aside)` : ''}`
  } catch (error) {
    if (error instanceof CerebrasCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `Cerebras refused this key (HTTP ${error.status}) — nothing stored; create a key at cloud.cerebras.ai and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  try {
    writeStoredCerebrasApiKey(key)
    recordSignIn('cerebras', 'api-key')
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = cerebrasEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `Cerebras API key stored (auth-scoped, mode 600) · ${note}. ${CEREBRAS_KEY_RECEIPT_TAIL}${shadow}` }
}
