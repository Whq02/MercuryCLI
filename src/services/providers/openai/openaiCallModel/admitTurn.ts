import type {
  AssistantMessage,
  Message,
} from '../../../../types/message.js'
import type { CallModelParams } from '../../callModelContract.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../../api/errors.js'
import { normalizeModelStringForAPI } from '../../../../utils/model/model.js'
import { getSessionId } from '../../../../bootstrap/state.js'
import {
  resolveOpenaiAccount,
  resolveOpenaiRequestAuth,
  type OpenaiRequestAuth,
} from '../openaiAccounts.js'
import {
  type GptCandidate,
} from '../openaiCatalogue.js'
import { openaiLimitWindow } from '../openaiLimitState.js'
import { refreshProviderUsage } from '../../providerUsage.js'
import { providerKeyCommandFailure } from '../../providerKeyCommand.js'
import { applyCompactedToolResults, compactedToolResultsByConversation, priorTurn4xxCodeOf } from './resumeTrim.js'
import { apiErrorMessage } from './faults.js'
import { qualifyRequestedModel, type QualificationOutcome } from './qualify.js'

export type AdmittedTurn = {
  requestedId: string
  conversation4xxKey: string
  messages: Message[]
  prior4xxCode: string | undefined
  auth: OpenaiRequestAuth
  qualification: Exclude<QualificationOutcome, { kind: 'refused' }>
  modelId: string
  candidate: GptCandidate | undefined
}

export async function* admitOpenaiTurn(params: CallModelParams): AsyncGenerator<AssistantMessage, AdmittedTurn | undefined> {
  const { options } = params
  const requestedId = normalizeModelStringForAPI(options.model).trim().toLowerCase()
  const conversation4xxKey = `${getSessionId()}:${options.agentId ?? options.ownerKey ?? ''}:${params.messages[0]?.uuid ?? ''}`
  const messages = applyCompactedToolResults(params.messages, compactedToolResultsByConversation.get(conversation4xxKey))
  const prior4xxCode = priorTurn4xxCodeOf(messages, conversation4xxKey)

  const account = resolveOpenaiAccount()
  if (!account) {
    const failure = providerKeyCommandFailure('openai')
    const hint = failure ? `the configured ${failure.message} — no OpenAI account source is connected.` : 'no OpenAI account source is connected — /logins signs in to this account or attaches an API key.'
    yield apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${hint} Model '${requestedId}' cannot run.`,
    )
    return
  }
  if (openaiLimitWindow(account.kind).state === 'limited') await refreshProviderUsage('openai', { force: true, reason: 'operator' })
  let auth = await resolveOpenaiRequestAuth({ sourceKind: account.kind })
  if (!auth) {
    yield apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: the ${account.label} source failed to produce request credentials (expired/revoked sign-in or missing key) — reconnect the OpenAI account. Model '${requestedId}' cannot run.`,
    )
    return
  }

  const qualification = await qualifyRequestedModel(requestedId, auth)
  if (qualification.kind === 'refused') {
    yield apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${qualification.message}`)
    return
  }
  const modelId = qualification.modelId
  const candidate = qualification.kind === 'ok' ? qualification.candidate : undefined
  return { requestedId, conversation4xxKey, messages, prior4xxCode, auth, qualification, modelId, candidate }
}
