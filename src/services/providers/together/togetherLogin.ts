import { errorMessageWithCause } from '../../../utils/errors.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredTogetherApiKey } from '../../../utils/router/providerSecrets.js'
import { TOGETHER_KEY_PAGE, togetherApiBase, togetherEnvKey } from './togetherAccounts.js'
import { fetchTogetherLiveModels, TogetherCatalogueHttpError } from './togetherCatalogue.js'

export interface TogetherKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export const TOGETHER_KEY_RECEIPT_TAIL = 'Requests draw the prepaid balance at the vendor\'s per-model prices; the balance and spend controls live at api.together.ai/settings/billing.'

export async function storeTogetherApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<TogetherKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Together AI API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  try {
    const result = await fetchTogetherLiveModels({ baseUrl: togetherApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} chat ${result.models.length === 1 ? 'model' : 'models'} listed${result.otherKinds > 0 ? ` (${result.otherKinds} image, video and audio rows set aside)` : ''}`
  } catch (error) {
    if (error instanceof TogetherCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `Together AI refused this key (HTTP ${error.status}) — nothing stored; create a key at ${TOGETHER_KEY_PAGE} and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  try {
    writeStoredTogetherApiKey(key)
    recordSignIn('together', 'api-key')
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = togetherEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `Together AI API key stored (auth-scoped, mode 600) · ${note}. ${TOGETHER_KEY_RECEIPT_TAIL}${shadow}` }
}
