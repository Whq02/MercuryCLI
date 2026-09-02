import { queryModelWithStreaming } from '../providers/anthropic/index.js'
import { API_ERROR_MESSAGE_PREFIX } from '../api/errors.js'
import { APIUserAbortError } from '../api/sdkErrors.js'
import type { AssistantMessage } from '../../types/message.js'
import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import { openaiCallModel } from './openai/openaiCallModel.js'
import { zaiCallModel } from './zai/zaiCallModel.js'
import { moonshotCallModel } from './moonshot/moonshotCallModel.js'
import { deepseekCallModel } from './deepseek/deepseekCallModel.js'
import { compatCallModel } from './openaicompat/compatCallModel.js'
import { classifyModelRoute } from './routeLaw.js'
import { openrouterCallModel } from './openrouter/openrouterCallModel.js'
import { geminiCallModel } from './gemini/geminiCallModel.js'
import { huggingfaceCallModel } from './huggingface/huggingfaceCallModel.js'
import { localCallModel } from './local/localCallModel.js'
import { homeLaneAdmissionRefusal } from './homeLaneAdmission.js'

export {
  classifyModelRoute,
  declaredRouteOf,
  laneLabelForVerdict,
  qualifiedWireId,
  COMPAT_MODEL_PREFIX,
  isCompatModelId,
  stripCompatModelPrefix,
  PROVIDER_ID_SPACES,
  type CallModelRoute,
  type ModelRouteVerdict,
  type ProviderIdSpace,
} from './routeLaw.js'

export function settleAssistantTurn(
  settled: readonly AssistantMessage[],
  aborted: boolean,
): AssistantMessage {
  const content = settled.filter(m => !m.isApiErrorMessage)
  const pool = content.length > 0 ? content : settled
  const last = pool.at(-1)
  if (!last) {
    if (aborted) throw new APIUserAbortError()
    throw new Error('No assistant message found')
  }
  if (pool.length === 1) return last
  return {
    ...last,
    message: {
      ...last.message,
      content: pool.flatMap(m => m.message.content),
    },
  }
}

export async function routedCallModelSettled(
  params: Parameters<typeof queryModelWithStreaming>[0],
): Promise<AssistantMessage> {
  const settled: AssistantMessage[] = []
  for await (const message of routedCallModel(params)) {
    if (message.type === 'assistant') settled.push(message as AssistantMessage)
  }
  return settleAssistantTurn(settled, params.signal.aborted)
}

async function* homeLaneCall(
  params: Parameters<typeof queryModelWithStreaming>[0],
): ReturnType<typeof queryModelWithStreaming> {
  const refusal = homeLaneAdmissionRefusal(params.options.model)
  if (refusal !== null) {
    yield createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${refusal}`,
      error: 'invalid_request',
    })
    return
  }
  yield* queryModelWithStreaming(params)
}

export const routedCallModel: typeof queryModelWithStreaming = async function* (params) {
  const verdict = classifyModelRoute(params.options.model)
  if (verdict.kind === 'absence') {
    yield createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: no model id rides this call — the session's model resolves upstream (/model names one; the built-in default otherwise), and this dispatch was handed none.`,
      error: 'invalid_request',
    })
    return
  }
  if (verdict.kind === 'unrecognised') {
    yield* homeLaneCall(params)
    return
  }
  switch (verdict.route) {
    case 'zai':
      yield* zaiCallModel(params)
      return
    case 'openai':
      yield* openaiCallModel(params)
      return
    case 'moonshot':
      yield* moonshotCallModel(params)
      return
    case 'deepseek':
      yield* deepseekCallModel(params)
      return
    case 'openai-compat':
      yield* compatCallModel(params)
      return
    case 'openrouter':
      yield* openrouterCallModel(params)
      return
    case 'gemini':
      yield* geminiCallModel(params)
      return
    case 'huggingface':
      yield* huggingfaceCallModel(params)
      return
    case 'local':
      yield* localCallModel(params)
      return
    case 'anthropic':
      yield* homeLaneCall(params)
      return
  }
}
