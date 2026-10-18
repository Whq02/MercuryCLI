import { errorMessageWithCause } from '../../../utils/errors.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredMinimaxApiKey } from '../../../utils/router/providerSecrets.js'
import { minimaxApiBase, minimaxEnvKey } from './minimaxAccounts.js'
import { fetchMinimaxLiveModels, MinimaxCatalogueHttpError } from './minimaxCatalogue.js'
import { fetchMinimaxPlanUsage, minimaxPlanWindowLine } from './minimaxUsageState.js'

interface MinimaxKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

const MINIMAX_KEY_RECEIPT_TAIL = 'Text models only; an M Plan Subscription Key draws its 5-hour and weekly windows, a pay-as-you-go key draws the Open Platform balance.'

export async function storeMinimaxApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<MinimaxKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty MiniMax API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  try {
    const result = await fetchMinimaxLiveModels({ baseUrl: minimaxApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} text ${result.models.length === 1 ? 'model' : 'models'} listed`
  } catch (error) {
    if (error instanceof MinimaxCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `MiniMax refused this key (HTTP ${error.status}) — nothing stored; create an API key at platform.minimax.io/user-center (Account Management → API Keys), or a Subscription Key at platform.minimax.io/console/plan, and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  const probe = await fetchMinimaxPlanUsage(key, { env, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}), ...(io?.now ? { now: io.now } : {}) })
  switch (probe.state) {
    case 'confirmed':
      note += ` · M Plan · ${probe.usage.windows.map(minimaxPlanWindowLine).join(' · ')}`
      break
    case 'no-plan':
      note += ' · no M Plan window — pay-as-you-go'
      break
    case 'refused':
      if (probe.status === 401 || probe.status === 403) return { ok: false, stored: false, receipt: `MiniMax refused this key on the plan read (HTTP ${probe.status}${probe.message ? `, ${safe(probe.message)}` : ''}) — nothing stored; paste a current key.` }
      note += ` · the plan read answered HTTP ${probe.status}`
      break
    case 'invalid':
      note += ' · the plan read returned an unrecognised response'
      break
    case 'unreachable':
      note += ` · the plan read could not be made (${safe(probe.message)})`
      break
  }
  try {
    writeStoredMinimaxApiKey(key)
    recordSignIn('minimax', 'api-key')
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const ambient = minimaxEnvKey(env)
  const shadow = ambient ? ` NOTE: ${ambient.name} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `MiniMax API key stored (auth-scoped, mode 600) · ${note}. ${MINIMAX_KEY_RECEIPT_TAIL}${shadow}` }
}
