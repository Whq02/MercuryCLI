import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredXaiApiKey, writeStoredXaiManagementApiKey } from '../../../utils/router/providerSecrets.js'
import { resolveXaiApiKey, xaiApiBase } from './xaiAccounts.js'
import { fetchXaiUsage, xaiUsageFailureWords, type XaiUsageIo } from './xaiUsageState.js'
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
    note = `${result.models.length} chat ${result.models.length === 1 ? 'model' : 'models'} listed`
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
export async function storeXaiManagementKeyLogin(key: string, io?: XaiUsageIo): Promise<XaiKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste an xAI management key, or leave it blank to skip.' }
  const env = io?.env ?? process.env
  const apiKey = resolveXaiApiKey(env)?.key
  if (!apiKey) return { ok: false, stored: false, receipt: 'Add the xAI API key first — its metadata identifies the team whose usage is read.' }
  const probe = await fetchXaiUsage(apiKey, key, io)
  if (probe.state === 'failed' && probe.failure.kind === 'refused') {
    return { ok: false, stored: false, receipt: `${xaiUsageFailureWords(probe.failure)} — management key not stored.` }
  }
  const safe = (message: string): string => message.split(key).join('[redacted]').split(apiKey).join('[redacted]')
  try { writeStoredXaiManagementApiKey(key) } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the management key: ${safe(errorMessageWithCause(error))}` }
  }
  const note = probe.state === 'confirmed' ? 'team usage confirmed' : `UNVERIFIED — ${xaiUsageFailureWords(probe.failure)}`
  const shadow = env.XAI_MANAGEMENT_API_KEY?.trim() ? ' NOTE: XAI_MANAGEMENT_API_KEY is set and wins over this stored key.' : ''
  return { ok: true, stored: true, receipt: `xAI management key stored (auth-scoped, mode 600) · ${note}. /usage reads the team meter.${shadow}` }
}
