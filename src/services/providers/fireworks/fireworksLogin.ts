import { errorMessageWithCause } from '../../../utils/errors.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredFireworksApiKey } from '../providerSecrets.js'
import { fireworksApiBase, fireworksEnvKey } from './fireworksAccounts.js'
import { fetchFireworksLiveModels, FireworksCatalogueHttpError } from './fireworksCatalogue.js'

interface FireworksKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

const FIREWORKS_KEY_RECEIPT_TAIL = 'Text models only. Standard keys bill at the model’s price; Fire Pass keys work only on their enabled routers. The Fireworks console shows account credits and spend.'

export async function storeFireworksApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<FireworksKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Fireworks API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  try {
    const result = await fetchFireworksLiveModels({ baseUrl: fireworksApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} chat ${result.models.length === 1 ? 'model' : 'models'} listed${result.otherLines > 0 ? ` (${result.otherLines} non-chat rows set aside)` : ''}`
  } catch (error) {
    if (error instanceof FireworksCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `Fireworks refused this key (HTTP ${error.status}) — nothing stored; create a key at app.fireworks.ai/api-keys and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  try {
    writeStoredFireworksApiKey(key)
    recordSignIn('fireworks', 'api-key')
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = fireworksEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `Fireworks API key stored (auth-scoped, mode 600) · ${note}. ${FIREWORKS_KEY_RECEIPT_TAIL}${shadow}` }
}
