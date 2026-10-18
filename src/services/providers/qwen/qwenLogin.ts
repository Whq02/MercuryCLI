import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredQwenApiKey } from '../providerSecrets.js'
import { QWEN_BASE_OVERRIDE_ENV, qwenBaseOverride, qwenEndpointLabelOf, qwenEnvKey, rememberQwenBoundBase } from './qwenAccounts.js'
import { fetchQwenLiveModels, forgetQwenCatalogue, probeQwenEndpoints, QwenCatalogueHttpError } from './qwenCatalogue.js'

interface QwenKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

const QWEN_KEY_PAGE_WORDS = 'modelstudio.alibabacloud.com (API-KEY, in the region the key is for)'
const QWEN_KEY_RECEIPT_TAIL = 'Text models only; the key is bound to the region and plan it was minted in, so requests ride that endpoint alone. Usage and balance are shown in the Model Studio console (no endpoint states them to an API key).'
export const QWEN_KEY_KINDS_LINE = 'A Model Studio API key (pay-as-you-go or Token Plan) or a Coding Plan key (sk-sp-…): each binds to the endpoint that accepts it.'
export const QWEN_KEY_KINDS_SHORT = 'Model Studio or Coding Plan (sk-sp-…) key'

function hostOf(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

export async function storeQwenApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<QwenKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty Model Studio API key.' }
  const env = io?.env ?? process.env
  const fetchImpl = io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  let boundBase: string | undefined
  const override = qwenBaseOverride(env)
  if (override !== undefined) {
    try {
      const result = await fetchQwenLiveModels({ baseUrl: override, key, env, ...fetchImpl })
      boundBase = override
      note = `bound to ${qwenEndpointLabelOf(override, env)} (${hostOf(override)}, from ${QWEN_BASE_OVERRIDE_ENV}) · ${result.models.length} text ${result.models.length === 1 ? 'model' : 'models'} listed${result.otherLines > 0 ? ` (${result.otherLines} non-text rows set aside)` : ''}`
    } catch (error) {
      if (error instanceof QwenCatalogueHttpError && (error.status === 401 || error.status === 403)) {
        return { ok: false, stored: false, receipt: `${safe(error.message)} — nothing stored; ${QWEN_BASE_OVERRIDE_ENV} names ${hostOf(override)}, which is not the endpoint this key was minted for.` }
      }
      note = `UNVERIFIED — the model list at ${hostOf(override)} could not confirm the key (${safe(errorMessageWithCause(error))})`
    }
  } else {
    const probe = await probeQwenEndpoints({ key, env, ...fetchImpl })
    if (probe.kind === 'refused') return { ok: false, stored: false, receipt: `Model Studio refused this key on every endpoint — nothing stored; ${probe.words}. Keys are made at ${QWEN_KEY_PAGE_WORDS}.` }
    if (probe.kind === 'bound') {
      boundBase = probe.baseUrl
      note = `bound to ${probe.endpoint.label} (${hostOf(probe.baseUrl)}) · ${probe.models.length} text ${probe.models.length === 1 ? 'model' : 'models'} listed${probe.otherLines > 0 ? ` (${probe.otherLines} non-text rows set aside)` : ''}`
    } else {
      note = `UNVERIFIED — no endpoint confirmed the key: ${safe(probe.words)}; the first turn probes the endpoints again`
    }
  }
  try {
    writeStoredQwenApiKey(key, boundBase)
    if (boundBase !== undefined) rememberQwenBoundBase(key, boundBase)
    forgetQwenCatalogue()
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = qwenEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `Model Studio API key stored (auth-scoped, mode 600) · ${note}. ${QWEN_KEY_RECEIPT_TAIL}${shadow}` }
}
