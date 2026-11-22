import { flagEnv } from '../../substrate/flagRegistry.js'
import { APIError, AuthenticationError, APIConnectionError, NotFoundError } from '../../utils/api/sdkErrors.js'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { queryModelWithoutStreaming } from './anthropic/index.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { createUserMessage } from '../messages.js'
import { isModelAlias } from '../../utils/model/aliases.js'
import { isModelAllowed } from '../model/modelAllowlist.js'
import { isModelFromDisabledProvider, isProviderDisabled } from './disabledProviders.js'
import { routeOfFamilyWord } from '../model/modelFamilies.js'
import { validateHuggingfaceModel, validateLocalModel, validateNousModel, validateOpenrouterModel, validateMoonshotModel, validateOpenaiModel } from './validateModel/catalogues.js'
import { validateGeminiModel, validateZaiModel, validateOrcarouterModel, validateDeepseekModel, validateCompatModel } from './validateModel/credentials.js'
import { validateXaiModel, validateMetaModel, validateMistralModel, validateZenModel, validateMinimaxModel, validateQwenModel, validateTogetherModel, validateCohereModel, validateGroqModel, validateMeliousModel, validateCerebrasModel, validateFireworksModel } from './validateModel/onDemandCatalogues.js'
import type { ValidateModelResult } from './validateModel/result.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/services/providers/validateModel.ts:76')
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
