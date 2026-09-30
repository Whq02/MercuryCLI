import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredXaiApiKey } from '../../../utils/router/providerSecrets.js'
import { xaiApiBase } from './xaiAccounts.js'
import { fetchXaiLiveModels, XaiCatalogueHttpError } from './xaiCatalogue.js'

export interface XaiKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}
export async function storeXaiApiKeyLogin(
  key: string,
  io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<XaiKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty xAI API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  try {
    const result = await fetchXaiLiveModels({ baseUrl: xaiApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} chat ${result.models.length === 1 ? 'model' : 'models'} listed; credits are not reported by the provider`
  } catch (error) {
    if (error instanceof XaiCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `xAI refused this key (HTTP ${error.status}) — nothing stored; check the key and its model-list permissions at console.x.ai and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  try {
    writeStoredXaiApiKey(key)
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const shadow = env.XAI_API_KEY?.trim() ? ' NOTE: XAI_API_KEY is set and wins over this stored key.' : ''
  return { ok: true, stored: true, receipt: `xAI API key stored (auth-scoped, mode 600) · ${note}. Requests use api.x.ai under usage-based billing.${shadow}` }
}
