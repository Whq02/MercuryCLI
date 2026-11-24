import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { APIError, AuthenticationError, APIConnectionError, NotFoundError } from '../../engine/request-parts/sdkErrors.js'

import { getEmptyToolPermissionContext } from '../../tools/kit/tool.js'
import { anthropicCallModelSettled } from './anthropic/index.js'
import { asSystemPrompt } from '../../engine/system-prompt/systemPromptType.js'
import { createUserMessage } from '../../engine/messages/messages.js'
import { isModelAlias } from '../facts/aliases.js'
import { isModelAllowed } from '../catalogue/modelAllowlist.js'
import { isModelFromDisabledProvider, isProviderDisabled } from './disabledProviders.js'
import { routeOfFamilyWord } from '../catalogue/modelFamilies.js'
import { validateHuggingfaceModel, validateLocalModel, validateNousModel, validateOpenrouterModel, validateMoonshotModel, validateOpenaiModel } from './validate-model/catalogues.js'
import { validateGeminiModel, validateZaiModel, validateOrcarouterModel, validateDeepseekModel, validateCompatModel } from './validate-model/credentials.js'
import { validateXaiModel, validateMetaModel, validateMistralModel, validateZenModel, validateMinimaxModel, validateQwenModel, validateTogetherModel, validateCohereModel, validateGroqModel, validateMeliousModel, validateCerebrasModel, validateFireworksModel } from './validate-model/onDemandCatalogues.js'
import type { ValidateModelResult } from './validate-model/result.js'

const validatedModels = new Set<string>()

async function validateNonAnthropicModel(
  route:
    | 'openai'
    | 'zai'
    | 'moonshot'
    | 'deepseek'
    | 'xai'
    | 'meta'
    | 'openai-compat'
    | 'openrouter'
    | 'gemini'
    | 'huggingface'
    | 'local'
    | 'mistral'
    | 'nous'
    | 'zen'
    | 'minimax'
    | 'together'
    | 'cohere'
    | 'groq'
    | 'melious'
    | 'orcarouter'
    | 'cerebras'
    | 'fireworks'
    | 'qwen',
  trimmed: string,
): Promise<ValidateModelResult & { skipCache?: boolean }> {
  if (route !== 'openrouter') {
    const { canonicalWireModelId } = await import('./routeLaw.js')
    const verdict = canonicalWireModelId(trimmed)
    if (!verdict.ok) return { valid: false, error: verdict.reason }
  }
  if (route === 'huggingface') return validateHuggingfaceModel(trimmed)
  if (route === 'local') return validateLocalModel(trimmed)
  if (route === 'nous') return validateNousModel(trimmed)
  if (route === 'openrouter') return validateOpenrouterModel(trimmed)
  if (route === 'gemini') return validateGeminiModel()
  if (route === 'zai') return validateZaiModel()
  if (route === 'moonshot') return validateMoonshotModel(trimmed)
  if (route === 'xai') return validateXaiModel(trimmed)
  if (route === 'meta') return validateMetaModel(trimmed)
  if (route === 'mistral') return validateMistralModel(trimmed)
  if (route === 'zen') return validateZenModel(trimmed)
  if (route === 'minimax') return validateMinimaxModel(trimmed)
  if (route === 'qwen') return validateQwenModel(trimmed)
  if (route === 'together') return validateTogetherModel(trimmed)
  if (route === 'cohere') return validateCohereModel(trimmed)
  if (route === 'orcarouter') return validateOrcarouterModel()
  if (route === 'groq') return validateGroqModel(trimmed)
  if (route === 'melious') return validateMeliousModel(trimmed)
  if (route === 'cerebras') return validateCerebrasModel(trimmed)
  if (route === 'fireworks') return validateFireworksModel(trimmed)
  if (route === 'deepseek') return validateDeepseekModel()
  if (route === 'openai-compat') return validateCompatModel(trimmed)
  return validateOpenaiModel(trimmed)
}

export async function validateModel(model: string): Promise<ValidateModelResult> {
  const trimmed = model.trim()
  if (trimmed === '') {
    return { valid: false, error: 'Model name cannot be empty' }
  }
  const lowered = trimmed.toLowerCase()
  const rawRoute = routeOfFamilyWord(lowered)
  if ((rawRoute && isProviderDisabled(rawRoute)) || isModelFromDisabledProvider(trimmed)) {
    return { valid: false, error: `Model not found — ${trimmed}` }
  }
  if (!isModelAllowed(trimmed)) {
    return { valid: false, error: `Model "${trimmed}" is not in the list of available models` }
  }
  if (isModelAlias(trimmed.toLowerCase())) return { valid: true }
  if (trimmed === flagEnv('MERCURY_CUSTOM_MODEL_OPTION')) return { valid: true }
  if (validatedModels.has(trimmed)) return { valid: true }

  const { declaredRouteOf } = await import(
    './callModelRouter.js'
  )
  const { classifyModelRoute, LIVE_LIST_FAMILIES } = await import('./idSpaces.js')
  const early = classifyModelRoute(trimmed)
  if (early.kind === 'unrecognised' && !early.carrierShaped) {
    const { readCatalogueIfPending } = await import('./catalogueOnDemand.js')
    await Promise.all(LIVE_LIST_FAMILIES.map(family => readCatalogueIfPending(family)))
  }
  const route = declaredRouteOf(trimmed)
  if (route !== null && route !== 'anthropic') {
    const verdict = await validateNonAnthropicModel(route, trimmed)
    if (verdict.valid && !verdict.skipCache) validatedModels.add(trimmed)
    return { valid: verdict.valid, ...(verdict.error !== undefined ? { error: verdict.error } : {}) }
  }

  const { homeLaneAdmissionRefusal } = await import(
    './homeLaneAdmission.js'
  )
  const admissionRefusal = homeLaneAdmissionRefusal(trimmed)
  if (admissionRefusal !== null) return { valid: false, error: admissionRefusal }
  const { recognizeModelId, unrecognisedModelIdReason } = await import(
    './idSpaces.js'
  )
  const recognition = recognizeModelId(trimmed)

  try {
    const answer = await anthropicCallModelSettled({
      messages: [createUserMessage({ content: 'hi' })],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: trimmed,
        toolChoice: undefined,
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'model_validation',
        mcpTools: [],
        skipCacheWrite: true,
      },
    })
    if (answer.isApiErrorMessage === true) {
      const said = answer.message.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join(' ')
        .trim()
      if (/\b404\b|not found|not served|does not exist/i.test(said)) {
        return {
          valid: false,
          error: `Model not found — ${trimmed} is not served to this account (${said}). The /model picker lists the live catalogues.`,
        }
      }
      return { valid: false, error: `Unable to validate model: ${said}` }
    }
    validatedModels.add(trimmed)
    return { valid: true }
  } catch (error) {
    const mapped = mapValidationError(error)
    if (mapped === 'Model not found' && recognition.kind === 'unrecognised') {
      return {
        valid: false,
        error: `${mapped} — ${unrecognisedModelIdReason(trimmed)}, and the endpoint does not serve it either. The /model picker lists the live catalogues.`,
      }
    }
    return { valid: false, error: mapped }
  }
}

function mapValidationError(error: unknown): string {
  if (error instanceof NotFoundError) {
    return 'Model not found'
  }
  if (error instanceof APIError) {
    if (error instanceof AuthenticationError) {
      return 'Authentication failed — check your credentials'
    }
    if (error instanceof APIConnectionError) {
      return 'Network error — could not reach the API'
    }
    const body = (error as { error?: { type?: unknown } }).error
    if (
      body !== null &&
      typeof body === 'object' &&
      (body as { type?: unknown }).type === 'not_found_error' &&
      error.message.toLowerCase().includes('model')
    ) {
      return 'Model not found'
    }
    return `API error: ${error.message}`
  }
  return `Unable to validate model: ${error instanceof Error ? error.message : String(error)}`
}
