import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredMetaApiKey } from '../../../utils/router/providerSecrets.js'
import { metaApiBase, metaEnvKey } from './metaAccounts.js'
import { fetchMetaLiveModels, MetaCatalogueHttpError } from './metaCatalogue.js'

export interface MetaKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export async function storeMetaApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<MetaKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Meta Model API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  try {
    const result = await fetchMetaLiveModels({ baseUrl: metaApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} Muse Spark ${result.models.length === 1 ? 'model' : 'models'} listed`
  } catch (error) {
    if (error instanceof MetaCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `Meta refused this key (HTTP ${error.status}) — nothing stored; create a Model API key at dev.meta.ai and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  try {
    writeStoredMetaApiKey(key)
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = metaEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `Meta API key stored (auth-scoped, mode 600) · ${note}. Requests use pay-as-you-go billing; Muse Code subscriptions are for Muse Code only.${shadow}` }
}
