import { APIError, AuthenticationError, APIConnectionError, NotFoundError } from '@anthropic-ai/sdk'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { queryModelWithoutStreaming } from '../../services/providers/anthropic/index.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { createUserMessage } from '../messages.js'
import { isModelAlias } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'

export type ValidateModelResult = { valid: boolean; error?: string }

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
    | 'mistral',
  trimmed: string,
): Promise<ValidateModelResult & { skipCache?: boolean }> {
  if (route !== 'openrouter') {
    const { canonicalWireModelId } = await import('../../services/providers/routeLaw.js')
    const verdict = canonicalWireModelId(trimmed)
    if (!verdict.ok) return { valid: false, error: verdict.reason }
  }
  if (route === 'huggingface') {
    const { resolveHuggingfaceApiKey } = await import(
      '../../services/providers/huggingface/huggingfaceAccounts.js'
    )
    if (!resolveHuggingfaceApiKey()) {
      return {
        valid: false,
        error: 'Hugging Face is unavailable — no credential (/logins connects, or set HF_TOKEN).',
      }
    }
    const { huggingfaceLiveModel, getCachedHuggingfaceCatalogue, refreshHuggingfaceCatalogue } = await import(
      '../../services/providers/huggingface/huggingfaceCatalogue.js'
    )
    await refreshHuggingfaceCatalogue().catch(() => null)
    const snapshot = getCachedHuggingfaceCatalogue()
    if (!snapshot || snapshot.models.length === 0) return { valid: true, skipCache: true }
    const { qualifiedWireId } = await import('../../services/providers/routeLaw.js')
    if (!huggingfaceLiveModel(qualifiedWireId(trimmed))) {
      return {
        valid: false,
        error: `Model "${trimmed}" is not listed by the Hugging Face router catalogue (${snapshot.models.length} live models; huggingface/<org>/<model>).`,
      }
    }
    return { valid: true }
  }
  if (route === 'local') {
    const { localRecordFor } = await import('../../services/providers/local/localCatalogue.js')
    const { refreshLocalDiscovery } = await import('../../services/providers/local/localDiscovery.js')
    if (!localRecordFor(trimmed)) await refreshLocalDiscovery({ force: true }).catch(() => null)
    if (!localRecordFor(trimmed)) {
      return {
        valid: false,
        error: `No local server lists "${trimmed}" — start Ollama/LM Studio/vLLM/llama.cpp-server or set MERCURY_LOCAL_BASE_URL; /model re-probes on open.`,
      }
    }
    return { valid: true, skipCache: true }
  }
  if (route === 'openrouter') {
    const { resolveOpenrouterAccount } = await import(
      '../../services/providers/openrouter/openrouterAccounts.js'
    )
    const account = resolveOpenrouterAccount()
    if (!account) {
      return {
        valid: false,
        error: 'OpenRouter is unavailable — no account (/logins adds OpenRouter: OAuth mints a key, or paste one).',
      }
    }
    const { refreshOpenrouterCatalogue } = await import(
      '../../services/providers/openrouter/openrouterCatalogue.js'
    )
    const snapshot = await refreshOpenrouterCatalogue(account.keySource).catch(() => null)
    if (snapshot && snapshot.models.length > 0) {
      const { qualifiedWireId } = await import('../../services/providers/routeLaw.js')
      const { openrouterWireModelId } = await import(
        '../../services/providers/openrouter/openrouterCallModel.js'
      )
      const slug = qualifiedWireId(trimmed)
      const listed = snapshot.models.some(m => m.id.toLowerCase() === slug.trim().toLowerCase())
      if (!listed) {
        const healed = openrouterWireModelId(trimmed)
        const hint =
          healed.toLowerCase() !== slug.trim().toLowerCase()
            ? ` Did you mean "openrouter/${healed}"?`
            : ''
        return {
          valid: false,
          error: `Model "${trimmed}" is not listed by the live OpenRouter catalogue (${snapshot.models.length} models; openrouter/<vendor>/<model>).${hint}`,
        }
      }
    }
    return { valid: true, skipCache: true }
  }
  if (route === 'gemini') {
    const { resolveGeminiAccount } = await import(
      '../../services/providers/gemini/geminiAccounts.js'
    )
    if (!resolveGeminiAccount()) {
      return {
        valid: false,
        error: 'Gemini is unavailable — no account (/logins adds Gemini: API key, or Google OAuth with your own client).',
      }
    }
    return { valid: true }
  }
  if (route === 'zai') {
    const { resolveZaiApiKey } = await import('../router/providerDiscovery.js')
    if (!resolveZaiApiKey()) {
      return { valid: false, error: 'Z.AI is unavailable — no API key (/logins zai, or set ZAI_API_KEY).' }
    }
    return { valid: true }
  }
  if (route === 'moonshot') {
    const { moonshotDispatchSource } = await import(
      '../../services/providers/moonshot/moonshotAccounts.js'
    )
    if (moonshotDispatchSource() === undefined) {
      return {
        valid: false,
        error: 'Moonshot is unavailable — no Kimi sign-in or API key (/logins moonshot, or set MOONSHOT_API_KEY).',
      }
    }
    const { qualifyMoonshotModel } = await import('../../services/providers/moonshot/moonshotCatalogue.js')
    const verdict = await qualifyMoonshotModel(trimmed.toLowerCase())
    return verdict.kind === 'refused' ? { valid: false, error: verdict.message } : { valid: true, skipCache: true }
  }
  if (route === 'xai') {
    const { resolveXaiAccount } = await import('../../services/providers/xai/xaiAccounts.js')
    if (!resolveXaiAccount()) return { valid: false, error: 'xAI is unavailable — no API key (/logins xai, or set XAI_API_KEY).' }
    const { readCatalogueIfPending } = await import('../../services/providers/catalogueOnDemand.js')
    await readCatalogueIfPending('xai')
    const { getCachedXaiCatalogue } = await import('../../services/providers/xai/xaiCatalogue.js')
    const { isXaiChatModelId } = await import('../../services/providers/xai/xaiPins.js')
    const snapshot = getCachedXaiCatalogue()
    const id = trimmed.toLowerCase()
    if (id === 'grok') return snapshot?.models.length ? { valid: true, skipCache: true } : { valid: false, error: "xAI's live list has not served a chat model for 'grok' yet — /model refreshes it." }
    if (!isXaiChatModelId(id)) return { valid: false, error: 'This xAI model is not on the supported chat-completions road.' }
    if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins xai replaces the key.` }
    if (snapshot && snapshot.fetchedAtMs > 0 && !snapshot.models.some(row => row.id.toLowerCase() === id || row.aliases?.some(alias => alias.toLowerCase() === id))) return { valid: false, error: `Model "${trimmed}" is not listed by the xAI account's live catalogue.` }
    return { valid: true, skipCache: true }
  }
  if (route === 'meta') {
    const { resolveMetaAccount } = await import('../../services/providers/meta/metaAccounts.js')
    if (!resolveMetaAccount()) return { valid: false, error: 'Meta is unavailable — no API key (/logins meta, or set MODEL_API_KEY).' }
    const { readCatalogueIfPending } = await import('../../services/providers/catalogueOnDemand.js')
    await readCatalogueIfPending('meta')
    const { getCachedMetaCatalogue, newestMetaModel } = await import('../../services/providers/meta/metaCatalogue.js')
    const { isMetaChatModelId } = await import('../../services/providers/meta/metaPins.js')
    const snapshot = getCachedMetaCatalogue()
    const id = trimmed.toLowerCase()
    if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins meta replaces the key.` }
    if (id === 'muse') return newestMetaModel() ? { valid: true, skipCache: true } : { valid: false, error: "Meta's live list has not served a Standard Muse Spark model for 'muse' yet — /model refreshes it. Contributor models must be selected explicitly." }
    if (!isMetaChatModelId(id)) return { valid: false, error: 'This Meta model is not on the supported Muse Spark chat road.' }
    if (snapshot?.fetchedAtMs && !snapshot.models.some(row => row.id.toLowerCase() === id)) return { valid: false, error: `Model "${trimmed}" is not listed by the Meta account's live catalogue.` }
    return { valid: true, skipCache: true }
  }
  if (route === 'mistral') {
    const { resolveMistralAccount } = await import('../../services/providers/mistral/mistralAccounts.js')
    if (!resolveMistralAccount()) return { valid: false, error: 'Mistral is unavailable — no API key (/logins mistral, or set MISTRAL_API_KEY).' }
    const { readCatalogueIfPending } = await import('../../services/providers/catalogueOnDemand.js')
    await readCatalogueIfPending('mistral')
    const { getCachedMistralCatalogue, mistralListedModel, newestMistralModel } = await import('../../services/providers/mistral/mistralCatalogue.js')
    const { isMistralChatModelId } = await import('../../services/providers/mistral/mistralPins.js')
    const snapshot = getCachedMistralCatalogue()
    const id = trimmed.toLowerCase()
    if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins mistral replaces the key.` }
    if (id === 'mistral') return newestMistralModel() ? { valid: true, skipCache: true } : { valid: false, error: "Mistral's live list has not served a chat model for 'mistral' yet — /model refreshes it." }
    if (!isMistralChatModelId(id)) return { valid: false, error: 'This Mistral model is not on the chat-completions road.' }
    if (snapshot?.fetchedAtMs && !mistralListedModel(snapshot, id)) return { valid: false, error: `Model "${trimmed}" is not listed by the Mistral account's live catalogue.` }
    return { valid: true, skipCache: true }
  }
  if (route === 'deepseek') {
    const { resolveDeepseekApiKey } = await import(
      '../../services/providers/deepseek/deepseekAccounts.js'
    )
    if (!resolveDeepseekApiKey()) {
      return {
        valid: false,
        error: 'DeepSeek is unavailable — no API key (/logins deepseek, or set DEEPSEEK_API_KEY).',
      }
    }
    return { valid: true }
  }
  if (route === 'openai-compat') {
    const { resolveCompatSlotConfig } = await import(
      '../../services/providers/openaicompat/compatAccounts.js'
    )
    if (!resolveCompatSlotConfig()) {
      return {
        valid: false,
        error: 'The OpenAI-compatible endpoint slot is not configured — set MERCURY_COMPAT_BASE_URL.',
      }
    }
    return { valid: true }
  }
  const { resolveOpenaiAccount } = await import(
    '../../services/providers/openai/openaiAccounts.js'
  )
  const account = resolveOpenaiAccount()
  if (!account) {
    return {
      valid: false,
      error: 'No OpenAI account — /logins signs in a ChatGPT subscription, or set OPENAI_API_KEY.',
    }
  }
  const { evaluateGptCandidate, qualifiedGptCandidates, refreshOpenaiCatalogue } = await import(
    '../../services/providers/openai/openaiCatalogue.js'
  )
  const { modelNotOfferedByCatalogue } = await import('../../services/providers/catalogueAdmission.js')
  await refreshOpenaiCatalogue(account.kind).catch(() => null)
  const evaluated = evaluateGptCandidate(trimmed.toLowerCase(), account.kind)
  if (evaluated.ok) return { valid: true }
  switch (evaluated.why.reason) {
    case 'catalogue-unavailable':
      return { valid: true, skipCache: true }
    case 'not-in-live-catalogue':
      return {
        valid: false,
        error: modelNotOfferedByCatalogue(trimmed, account.label, qualifiedGptCandidates('specialist', account.kind).map(candidate => candidate.identity.canonicalId)),
      }
    case 'hidden-or-retired':
      return {
        valid: false,
        error: `Model "${trimmed}" is hidden/retired in the live catalogue (${evaluated.why.detail}).`,
      }
    default:
      return {
        valid: false,
        error: `Model "${trimmed}" is not accepted by the live GPT catalogue (${evaluated.why.reason}).`,
      }
  }
}

export async function validateModel(model: string): Promise<ValidateModelResult> {
  const trimmed = model.trim()
  if (trimmed === '') {
    return { valid: false, error: 'Model name cannot be empty' }
  }
  if (!isModelAllowed(trimmed)) {
    return { valid: false, error: `Model "${trimmed}" is not in the list of available models` }
  }
  if (isModelAlias(trimmed.toLowerCase())) return { valid: true }
  if (trimmed === process.env.MERCURY_CUSTOM_MODEL_OPTION) return { valid: true }
  if (validatedModels.has(trimmed)) return { valid: true }

  const { declaredRouteOf } = await import(
    '../../services/providers/callModelRouter.js'
  )
  const { classifyModelRoute, LIVE_LIST_FAMILIES } = await import('../../services/providers/idSpaces.js')
  const early = classifyModelRoute(trimmed)
  if (early.kind === 'unrecognised' && !early.carrierShaped) {
    const { readCatalogueIfPending } = await import('../../services/providers/catalogueOnDemand.js')
    await Promise.all(LIVE_LIST_FAMILIES.map(family => readCatalogueIfPending(family)))
  }
  const route = declaredRouteOf(trimmed)
  if (route !== null && route !== 'anthropic') {
    const verdict = await validateNonAnthropicModel(route, trimmed)
    if (verdict.valid && !verdict.skipCache) validatedModels.add(trimmed)
    return { valid: verdict.valid, ...(verdict.error !== undefined ? { error: verdict.error } : {}) }
  }

  const { homeLaneAdmissionRefusal } = await import(
    '../../services/providers/homeLaneAdmission.js'
  )
  const admissionRefusal = homeLaneAdmissionRefusal(trimmed)
  if (admissionRefusal !== null) return { valid: false, error: admissionRefusal }
  const { recognizeModelId, unrecognisedModelIdReason } = await import(
    '../../services/providers/idSpaces.js'
  )
  const recognition = recognizeModelId(trimmed)

  try {
    await queryModelWithoutStreaming({
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
        maxOutputTokens: 1,
        maxRetries: 0,
        skipCacheWrite: true,
      },
    } as never)
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
