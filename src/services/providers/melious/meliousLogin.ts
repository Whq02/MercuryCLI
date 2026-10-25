import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredMeliousApiKey } from '../providerSecrets.js'
import { meliousApiBase, meliousEnvKey } from './meliousAccounts.js'
import { fetchMeliousLiveModels, MeliousCatalogueHttpError, refreshMeliousCatalogue } from './meliousCatalogue.js'

export async function storeMeliousApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<{ ok: boolean; stored: boolean; receipt: string }> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Melious AI API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let listUnavailable = false
  try {
    await fetchMeliousLiveModels({ baseUrl: meliousApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
  } catch (error) {
    if (error instanceof MeliousCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `Melious AI refused this key (HTTP ${error.status}) — create a key with inference.models and inference.chat at melious.ai/account/api/keys and paste again.` }
    }
    listUnavailable = true
  }
  try { writeStoredMeliousApiKey(key) }
  catch (error) { return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` } }
  if (!listUnavailable) await refreshMeliousCatalogue({ force: true, env, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
  const ambient = meliousEnvKey(env)
  return { ok: true, stored: true, receipt: `Melious AI API key stored. ${listUnavailable ? '/model retries the model list.' : '/model lists models.'}${ambient ? ' MELIOUS_API_KEY is set and wins over this stored key.' : ''}` }
}
