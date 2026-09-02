/**
 * Live model validation by a minimal API probe with typed error messages.
 *
 * This file is the ONE recorded provider-SDK importer in the slice (the
 * import fence pins it): the error classes come from `@anthropic-ai/sdk`
 * DIRECTLY here, and no other file of the slice may import the SDK.
 */
import { APIError, AuthenticationError, APIConnectionError, NotFoundError } from '@anthropic-ai/sdk'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { queryModelWithoutStreaming } from '../../services/providers/anthropic/index.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { createUserMessage } from '../messages.js'
import { isModelAlias } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'

export type ValidateModelResult = { valid: boolean; error?: string }

/** Successes only are cached — a transient failure never pins a model invalid. */
const validatedModels = new Set<string>()

/**
 * Provider-routed validation for non-Anthropic ids (the glm-/gpt- lanes): an
 * Anthropic "hi" probe for a GPT id is a guaranteed 404 that reads as "model
 * not found" — the wrong provider answered. Each lane validates against its
 * OWN owner: account source and (openai) the live catalogue's qualification
 * law, mirroring the runtime lane's refusal ladder so a model that validates
 * here is a model the dispatch would actually accept.
 */
async function validateNonAnthropicModel(
  route:
    | 'openai'
    | 'zai'
    | 'moonshot'
    | 'deepseek'
    | 'openai-compat'
    | 'openrouter'
    | 'gemini'
    | 'huggingface'
    | 'local',
  trimmed: string,
): Promise<ValidateModelResult & { skipCache?: boolean }> {
  // Wire-id truth first: an id the one canonicalization owner refuses
  // (display dressing in an id position, a second vendor prefix on an
  // already carrier-shaped id) refuses HERE, at typing time, with the same
  // catalogue words dispatch would use — junk never even persists. The
  // openrouter arm below adjudicates the SAME class against the live
  // catalogue itself (a mangled id refuses naming its healed spelling —
  // richer words than the structural refusal), so it speaks for its own
  // family; the dispatch owner still refuses openrouter junk wire-side.
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
    // The live catalogue answers for the id when fetched; an unlisted id on
    // a reachable catalogue is refused; an unreachable catalogue lets the
    // router answer for itself (not cached — re-checked next time).
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
    // The live-catalogue check (the huggingface arm's discipline): a slug
    // OpenRouter does not list would 400 at dispatch — refuse it HERE with
    // the listed spelling, so a display-dressed or double-vendored id
    // ('…terra[1m]', 'anthropic/openai/…') never persists as a setting.
    // An unfetched/unreachable catalogue keeps the account-presence pass —
    // the wire adjudicates what it can and the router answers at dispatch.
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
  // The key lanes: credential/config presence from
  // each OWNING resolver — the same refusal the dispatch itself would make.
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
    return { valid: true }
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
  const { evaluateGptCandidate, refreshOpenaiCatalogue } = await import(
    '../../services/providers/openai/openaiCatalogue.js'
  )
  await refreshOpenaiCatalogue(account.kind).catch(() => null)
  const evaluated = evaluateGptCandidate(trimmed.toLowerCase(), account.kind)
  if (evaluated.ok) return { valid: true }
  switch (evaluated.why.reason) {
    case 'catalogue-unavailable':
      // The runtime lane proceeds DEGRADED on a transiently unreachable
      // catalogue (named note, provider-default effort) — validation must
      // not refuse a model the dispatch would accept. Not cached: the next
      // validation re-checks against a possibly-recovered catalogue.
      return { valid: true, skipCache: true }
    case 'not-in-live-catalogue':
      return {
        valid: false,
        error: `Model "${trimmed}" is not offered by the ${account.label} live catalogue.`,
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
  // Allowlist rejection happens BEFORE any network call.
  if (!isModelAllowed(trimmed)) {
    return { valid: false, error: `Model "${trimmed}" is not in the list of available models` }
  }
  if (isModelAlias(trimmed.toLowerCase())) return { valid: true }
  if (trimmed === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) return { valid: true }
  if (validatedModels.has(trimmed)) return { valid: true }

  // Non-Anthropic ids validate against their OWN provider lane — the routing
  // law is callModelRouter's (glm-* → zai, gpt-* → openai). An id NO family
  // declares (null) takes the home-lane road below, where the admission
  // owner speaks the earned-ride law.
  const { declaredRouteOf } = await import(
    '../../services/providers/callModelRouter.js'
  )
  const route = declaredRouteOf(trimmed)
  if (route !== null && route !== 'anthropic') {
    const verdict = await validateNonAnthropicModel(route, trimmed)
    if (verdict.valid && !verdict.skipCache) validatedModels.add(trimmed)
    return { valid: verdict.valid, ...(verdict.error !== undefined ? { error: verdict.error } : {}) }
  }

  // The home lane's own admission (the one owner the dispatch seam reads
  // too): an id no family declares, bound for the first-party origin,
  // refuses here before the probe unless an operator-owned fact carries it
  // (an ANTHROPIC_* pin makes it first-party; a gateway base URL admits —
  // the endpoint owns its ids). Everything admitted probes.
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
    // A not-found on an UNRECOGNISED id says which fact it is: no family
    // declares the id and the endpoint does not serve it either — never
    // the bare "Model not found" a mistyped first-party id earns.
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
