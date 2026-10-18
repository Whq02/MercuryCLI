import { errorMessageWithCause } from '../../../utils/errors.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredGroqApiKey } from '../providerSecrets.js'
import { groqApiBase, groqEnvKey } from './groqAccounts.js'
import { fetchGroqLiveModels, GroqCatalogueHttpError } from './groqCatalogue.js'

interface GroqKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

const GROQ_KEY_RECEIPT_TAIL = 'Groq Free-tier token limits can be too small for tool-bearing turns; the Developer tier offers higher limits. Account spend is shown at console.groq.com/dashboard/usage.'

export async function storeGroqApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<GroqKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Groq API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  try {
    const result = await fetchGroqLiveModels({ baseUrl: groqApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} chat ${result.models.length === 1 ? 'model' : 'models'} listed${result.otherLines > 0 ? ` (${result.otherLines} non-chat rows set aside)` : ''}`
  } catch (error) {
    if (error instanceof GroqCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `Groq refused this key (HTTP ${error.status}) — nothing stored; create a key at console.groq.com/keys and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  try {
    writeStoredGroqApiKey(key)
    recordSignIn('groq', 'api-key')
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = groqEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `Groq API key stored (auth-scoped, mode 600) · ${note}. ${GROQ_KEY_RECEIPT_TAIL}${shadow}` }
}
