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
import { LIVE_LIST_FAMILIES, type ModelRouteVerdict } from './idSpaces.js'
import { readCatalogueIfPending } from './catalogueOnDemand.js'
import { openrouterCallModel } from './openrouter/openrouterCallModel.js'
import { geminiCallModel } from './gemini/geminiCallModel.js'
import { huggingfaceCallModel } from './huggingface/huggingfaceCallModel.js'
import { localCallModel } from './local/localCallModel.js'
import { homeLaneAdmissionRefusal } from './homeLaneAdmission.js'
import { readStoredImageRefsForRequest } from '../../utils/imageStore.js'

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

async function classifyAfterLiveLists(model: string): Promise<ModelRouteVerdict> {
  const verdict = classifyModelRoute(model)
  if (verdict.kind !== 'unrecognised' || verdict.carrierShaped) return verdict
  await Promise.all(LIVE_LIST_FAMILIES.map(family => readCatalogueIfPending(family)))
  return classifyModelRoute(model)
}

export const routedCallModel: typeof queryModelWithStreaming = async function* (params) {
  const verdict = await classifyAfterLiveLists(params.options.model)
  if (verdict.kind === 'absence') {
    yield createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: no model id rides this call — the session's model resolves upstream (/model names one; the built-in default otherwise), and this dispatch was handed none.`,
      error: 'invalid_request',
    })
    return
  }
  const request = { ...params, messages: await readStoredImageRefsForRequest(params.messages) }
  if (verdict.kind === 'unrecognised') {
    yield* homeLaneCall(request)
    return
  }
  switch (verdict.route) {
    case 'zai':
      yield* zaiCallModel(request)
      return
    case 'openai':
      yield* openaiCallModel(request)
      return
    case 'moonshot':
      yield* moonshotCallModel(request)
      return
    case 'deepseek':
      yield* deepseekCallModel(request)
      return
    case 'openai-compat':
      yield* compatCallModel(request)
      return
    case 'openrouter':
      yield* openrouterCallModel(request)
      return
    case 'gemini':
      yield* geminiCallModel(request)
      return
    case 'huggingface':
      yield* huggingfaceCallModel(request)
      return
    case 'local':
      yield* localCallModel(request)
      return
    case 'anthropic':
      yield* homeLaneCall(request)
      return
  }
}
