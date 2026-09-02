import {
  evaluateGptCandidate,
  qualifiedGptCandidates,
  refreshOpenaiCatalogue,
  GPT_DISPLAY_PINS,
} from '../../services/providers/openai/openaiCatalogue.js'
import { resolveOpenaiAccount } from '../../services/providers/openai/openaiAccounts.js'
import { buildRouterModelSnapshot } from '../router/modelRegistry.js'
import { refreshProviderDiscovery } from '../router/providerDiscovery.js'
import { DEPRECATED_GPT_IDS } from '../router/providers/openai.js'
import { GLM_STATIC_CATALOGUE } from '../router/providers/zai.js'
import { KIMI_STATIC_CATALOGUE } from '../router/providers/moonshot.js'
import { DEEPSEEK_STATIC_CATALOGUE } from '../router/providers/deepseek.js'
import {
  compatSlotModelIds,
  resolveCompatSlotConfig,
} from '../../services/providers/openaicompat/compatAccounts.js'
import { COMPAT_MODEL_PREFIX, isCompatModelId } from '../../services/providers/routeLaw.js'
import { HUGGINGFACE_STATIC_CATALOGUE, huggingfaceLiveCatalogue } from '../router/providers/huggingface.js'
import { localLiveCatalogue } from '../router/providers/local.js'
import {
  HUGGINGFACE_MODEL_PREFIX,
  isHuggingfaceModelId,
} from '../../services/providers/huggingface/huggingfacePins.js'
import { huggingfaceLiveModel, refreshHuggingfaceCatalogue } from '../../services/providers/huggingface/huggingfaceCatalogue.js'
import { isLocalModelId, localRecordFor, localWireId, LOCAL_MODEL_PREFIX } from '../../services/providers/local/localCatalogue.js'
import { refreshLocalDiscovery } from '../../services/providers/local/localDiscovery.js'
import { getMainLoopModel } from '../model/model.js'
import { canonicalWireModelId, declaredRouteOf } from '../../services/providers/routeLaw.js'
import { resolveGeminiAccount } from '../../services/providers/gemini/geminiAccounts.js'
import {
  geminiGenerateModels,
  refreshGeminiCatalogue,
} from '../../services/providers/gemini/geminiCatalogue.js'
import { resolveOpenrouterAccount } from '../../services/providers/openrouter/openrouterAccounts.js'
import { refreshOpenrouterCatalogue } from '../../services/providers/openrouter/openrouterCatalogue.js'

export const ENGINE_DISPATCH_MODELS = ['gpt', 'glm', 'kimi', 'deepseek', 'compat', 'huggingface', 'local', 'gemini', 'openrouter'] as const
export type EngineDispatchModel = (typeof ENGINE_DISPATCH_MODELS)[number]

export function isEngineDispatchModel(v: unknown): v is EngineDispatchModel {
  return typeof v === 'string' && (ENGINE_DISPATCH_MODELS as readonly string[]).includes(v)
}

const OPENROUTER_MODEL_PREFIX = 'openrouter/'

function isOpenrouterModelId(v: string): boolean {
  return v.trim().toLowerCase().startsWith(OPENROUTER_MODEL_PREFIX)
}

export function isExactEngineModelId(v: unknown): v is string {
  if (typeof v !== 'string') return false
  return (
    /^(gpt|glm|kimi|moonshot|deepseek|gemini)-/i.test(v.trim()) ||
    isCompatModelId(v) ||
    isHuggingfaceModelId(v) ||
    isLocalModelId(v) ||
    isOpenrouterModelId(v)
  )
}

export function engineDispatchModelsForSchema(): readonly string[] {
  return [
    ...ENGINE_DISPATCH_MODELS,
    ...GPT_DISPLAY_PINS.map(pin => pin.id),
    ...GLM_STATIC_CATALOGUE.map(entry => entry.id),
    ...KIMI_STATIC_CATALOGUE.map(entry => entry.id),
    ...DEEPSEEK_STATIC_CATALOGUE.map(entry => entry.id),
    ...compatSlotModelIds(),
    ...HUGGINGFACE_STATIC_CATALOGUE.map(entry => entry.id),
    ...localLiveCatalogue().map(entry => entry.id),
  ]
}

type EngineProvider =
  | 'openai'
  | 'zai'
  | 'moonshot'
  | 'deepseek'
  | 'openai-compat'
  | 'huggingface'
  | 'local'
  | 'gemini'
  | 'openrouter'

export interface EngineDispatch {
  backend: EngineProvider
  model: string
  displayLabel: string
}

async function requireProviderAvailable(provider: EngineProvider): Promise<void> {
  await refreshProviderDiscovery(provider)
  const snapshot = buildRouterModelSnapshot()
  const entry = snapshot.providers.find(p => p.id === provider)
  if (!entry?.available) {
    throw new Error(
      `Engine provider ${provider} is unavailable (${entry?.reason ?? 'unknown'}). /health ROUTER and /capabilities name the fix.`,
    )
  }
}

async function resolveGptClassDispatch(): Promise<EngineDispatch> {
  const account = resolveOpenaiAccount()
  if (!account) {
    throw new Error(
      'Engine provider openai has no connected account source — /logins signs in to this account or attaches an API key.',
    )
  }
  const snapshot = await refreshOpenaiCatalogue(account.kind)
  const head = qualifiedGptCandidates('specialist', account.kind)[0]
  if (!head) {
    throw new Error(
      snapshot?.lastError
        ? `The 'gpt' class cannot resolve — the live model catalogue is unavailable (${snapshot.lastError}). Name an exact id (e.g. gpt-5.6-sol) or retry when catalogue reachability recovers.`
        : `The 'gpt' class cannot resolve — the ${account.label} catalogue offers no usable GPT model.`,
    )
  }
  return {
    backend: 'openai',
    model: head.identity.canonicalId,
    displayLabel: head.displayName,
  }
}

async function resolveGptExactModel(id: string): Promise<EngineDispatch> {
  if (DEPRECATED_GPT_IDS.includes(id)) {
    throw new Error(
      `GPT model '${id}' is DEPRECATED/retired in the current catalogue — refusing to dispatch a dead id. Current ids: ${GPT_DISPLAY_PINS.map(p => p.id).join(', ')} (or 'gpt' for the catalogue's default).`,
    )
  }
  const account = resolveOpenaiAccount()
  if (!account) {
    throw new Error(
      'Engine provider openai has no connected account source — /logins signs in to this account or attaches an API key.',
    )
  }
  await refreshOpenaiCatalogue(account.kind)
  const evaluated = evaluateGptCandidate(id, account.kind)
  if (evaluated.ok) {
    return {
      backend: 'openai',
      model: evaluated.candidate.identity.canonicalId,
      displayLabel: evaluated.candidate.displayName,
    }
  }
  if (evaluated.why.reason === 'catalogue-unavailable') {
    const pinned = GPT_DISPLAY_PINS.find(pin => pin.id === id.trim().toLowerCase())
    if (!pinned) {
      throw new Error(
        `GPT model '${id}' is not a catalogue-verified id (live catalogue unreachable; dispatchable pins: ${GPT_DISPLAY_PINS.map(p => p.id).join(', ')}).`,
      )
    }
    return {
      backend: 'openai',
      model: pinned.id,
      displayLabel: `${pinned.displayName} (static-pin validated)`,
    }
  }
  const offered = qualifiedGptCandidates('specialist', account.kind)
    .map(c => c.identity.canonicalId)
    .join(', ')
  throw new Error(
    `GPT model '${id}' is not accepted by the live catalogue (${evaluated.why.reason}). ${offered ? `The catalogue offers: ${offered}.` : 'The catalogue currently offers no usable ids.'}`,
  )
}

async function resolveHuggingfaceClassDispatch(): Promise<EngineDispatch> {
  const main = getMainLoopModel()
  if (declaredRouteOf(main) === 'huggingface') {
    return { backend: 'huggingface', model: main, displayLabel: main.slice(HUGGINGFACE_MODEL_PREFIX.length) }
  }
  await refreshHuggingfaceCatalogue().catch(() => null)
  const head = huggingfaceLiveCatalogue()?.entries[0] ?? HUGGINGFACE_STATIC_CATALOGUE[0]
  if (!head) throw new Error('Engine provider huggingface has no catalogue entry — cannot resolve a model.')
  return { backend: 'huggingface', model: head.id, displayLabel: head.displayLabel }
}

async function resolveHuggingfaceExactModel(id: string): Promise<EngineDispatch> {
  const slug = id.slice(HUGGINGFACE_MODEL_PREFIX.length)
  const snapshot = await refreshHuggingfaceCatalogue().catch(() => null)
  if (snapshot && snapshot.models.length > 0) {
    const live = huggingfaceLiveModel(slug)
    if (!live) {
      throw new Error(
        `Hugging Face model '${id}' is not listed by the router catalogue (${snapshot.models.length} live models) — name a listed huggingface/<org>/<model> id, or 'huggingface' for the flagship.`,
      )
    }
    return { backend: 'huggingface', model: `${HUGGINGFACE_MODEL_PREFIX}${live.id}${slug.includes(':') ? slug.slice(slug.lastIndexOf(':')) : ''}`, displayLabel: live.id }
  }
  const verdict = canonicalWireModelId(id)
  if (!verdict.ok) throw new Error(verdict.reason)
  return { backend: 'huggingface', model: id, displayLabel: `${slug} (catalogue unreachable — the router validates at dispatch)` }
}

async function resolveLocalClassDispatch(): Promise<EngineDispatch> {
  const main = getMainLoopModel()
  if (declaredRouteOf(main) === 'local' && localRecordFor(main)) {
    return { backend: 'local', model: main, displayLabel: localWireId(main) }
  }
  const first = localLiveCatalogue()[0]
  if (!first) throw new Error("The 'local' class cannot resolve — no local server lists a model (start Ollama/LM Studio/vLLM/llama.cpp-server, or set MERCURY_LOCAL_BASE_URL).")
  return { backend: 'local', model: first.id, displayLabel: first.displayLabel }
}

async function resolveGeminiClassDispatch(): Promise<EngineDispatch> {
  const main = getMainLoopModel()
  if (declaredRouteOf(main) === 'gemini') {
    return { backend: 'gemini', model: main, displayLabel: main }
  }
  const account = resolveGeminiAccount()
  if (!account) {
    throw new Error(
      'Engine provider gemini has no connected account source — /logins gemini signs in or attaches an API key.',
    )
  }
  const snapshot = await refreshGeminiCatalogue(account.kind === 'oauth' ? 'oauth' : 'api-key').catch(() => null)
  const head = geminiGenerateModels(snapshot)[0]
  if (!head) {
    throw new Error(
      snapshot?.lastError
        ? `The 'gemini' class cannot resolve — the live model catalogue is unavailable (${snapshot.lastError}). Name an exact gemini-* id, or retry when catalogue reachability recovers.`
        : "The 'gemini' class cannot resolve — the live catalogue lists no generateContent model. Name an exact gemini-* id.",
    )
  }
  return { backend: 'gemini', model: head.id, displayLabel: head.displayName ?? head.id }
}

async function resolveGeminiExactModel(id: string): Promise<EngineDispatch> {
  const account = resolveGeminiAccount()
  if (!account) {
    throw new Error(
      'Engine provider gemini has no connected account source — /logins gemini signs in or attaches an API key.',
    )
  }
  const snapshot = await refreshGeminiCatalogue(account.kind === 'oauth' ? 'oauth' : 'api-key').catch(() => null)
  const live = geminiGenerateModels(snapshot)
  if (live.length > 0) {
    const match = live.find(m => m.id === id)
    if (!match) {
      throw new Error(
        `Gemini model '${id}' is not listed by the live catalogue (${live.length} generateContent models) — name a listed gemini-* id, or 'gemini' for the catalogue head.`,
      )
    }
    return { backend: 'gemini', model: match.id, displayLabel: match.displayName ?? match.id }
  }
  return { backend: 'gemini', model: id, displayLabel: `${id} (catalogue unreachable — the runtime validates at dispatch)` }
}

async function resolveOpenrouterClassDispatch(): Promise<EngineDispatch> {
  const main = getMainLoopModel()
  if (declaredRouteOf(main) === 'openrouter') {
    return { backend: 'openrouter', model: main, displayLabel: main.slice(OPENROUTER_MODEL_PREFIX.length) }
  }
  return {
    backend: 'openrouter',
    model: 'openrouter/openrouter/auto',
    displayLabel: 'Auto Router (openrouter/auto)',
  }
}

async function resolveOpenrouterExactModel(id: string): Promise<EngineDispatch> {
  const account = resolveOpenrouterAccount()
  if (!account) {
    throw new Error(
      'Engine provider openrouter has no connected account source — /logins openrouter connects one.',
    )
  }
  const slug = id.slice(OPENROUTER_MODEL_PREFIX.length)
  const snapshot = await refreshOpenrouterCatalogue(account.keySource).catch(() => null)
  if (snapshot && snapshot.models.length > 0) {
    const match = snapshot.models.find(m => m.id.toLowerCase() === slug.toLowerCase())
    if (!match) {
      throw new Error(
        `OpenRouter model '${id}' is not listed by the live catalogue (${snapshot.models.length} models) — name a listed openrouter/<vendor>/<model> id, or 'openrouter' for the auto router.`,
      )
    }
    return { backend: 'openrouter', model: `${OPENROUTER_MODEL_PREFIX}${match.id}`, displayLabel: match.name ?? match.id }
  }
  const verdict = canonicalWireModelId(id)
  if (!verdict.ok) throw new Error(verdict.reason)
  return { backend: 'openrouter', model: id, displayLabel: `${slug} (catalogue unreachable — the router validates at dispatch)` }
}

async function resolveLocalExactModel(id: string): Promise<EngineDispatch> {
  if (!localRecordFor(id)) await refreshLocalDiscovery({ force: true }).catch(() => null)
  const record = localRecordFor(id)
  if (!record) {
    const listed = localLiveCatalogue().map(e => e.id)
    throw new Error(
      `No local server lists '${id}'${listed.length > 0 ? ` (discovered: ${listed.join(', ')})` : ' (no local server answered)'} — never dispatching an undiscovered id.`,
    )
  }
  return { backend: 'local', model: `${LOCAL_MODEL_PREFIX}${record.id}`, displayLabel: record.displayName ?? record.id }
}

export async function resolveEngineDispatch(
  modelParam: string | undefined,
): Promise<EngineDispatch | null> {
  if (isEngineDispatchModel(modelParam)) {
    if (modelParam === 'gpt') {
      await requireProviderAvailable('openai')
      return resolveGptClassDispatch()
    }
    if (modelParam === 'glm') {
      await requireProviderAvailable('zai')
      const pin = GLM_STATIC_CATALOGUE[0]
      if (!pin) throw new Error('Engine provider zai has no catalogue entry — cannot resolve a model.')
      return { backend: 'zai', model: pin.id, displayLabel: pin.displayLabel }
    }
    if (modelParam === 'kimi') {
      await requireProviderAvailable('moonshot')
      const pin = KIMI_STATIC_CATALOGUE[0]
      if (!pin) throw new Error('Engine provider moonshot has no catalogue entry — cannot resolve a model.')
      return { backend: 'moonshot', model: pin.id, displayLabel: pin.displayLabel }
    }
    if (modelParam === 'deepseek') {
      await requireProviderAvailable('deepseek')
      const pin = DEEPSEEK_STATIC_CATALOGUE[0]
      if (!pin) throw new Error('Engine provider deepseek has no catalogue entry — cannot resolve a model.')
      return { backend: 'deepseek', model: pin.id, displayLabel: pin.displayLabel }
    }
    if (modelParam === 'huggingface') {
      await requireProviderAvailable('huggingface')
      return resolveHuggingfaceClassDispatch()
    }
    if (modelParam === 'local') {
      await requireProviderAvailable('local')
      return resolveLocalClassDispatch()
    }
    if (modelParam === 'gemini') {
      await requireProviderAvailable('gemini')
      return resolveGeminiClassDispatch()
    }
    if (modelParam === 'openrouter') {
      await requireProviderAvailable('openrouter')
      return resolveOpenrouterClassDispatch()
    }
    await requireProviderAvailable('openai-compat')
    const first = compatSlotModelIds()[0]
    if (!first) {
      throw new Error(
        "The 'compat' class cannot resolve — the endpoint slot names no models (MERCURY_COMPAT_MODELS or the compatProvider config block). Name an exact compat/<id> instead.",
      )
    }
    return { backend: 'openai-compat', model: first, displayLabel: first }
  }
  if (isExactEngineModelId(modelParam)) {
    const id = modelParam!.trim()
    if (/^gpt-/i.test(id)) {
      await requireProviderAvailable('openai')
      return resolveGptExactModel(id.toLowerCase())
    }
    if (/^(kimi|moonshot)-/i.test(id)) {
      await requireProviderAvailable('moonshot')
      const pin = KIMI_STATIC_CATALOGUE.find(entry => entry.id === id.toLowerCase())
      if (!pin) {
        throw new Error(
          `Kimi model '${id}' is not a catalogue-verified id (pins: ${KIMI_STATIC_CATALOGUE.map(c => c.id).join(', ')}) — never dispatching an unverified id.`,
        )
      }
      return { backend: 'moonshot', model: pin.id, displayLabel: pin.displayLabel }
    }
    if (/^deepseek-/i.test(id)) {
      await requireProviderAvailable('deepseek')
      const pin = DEEPSEEK_STATIC_CATALOGUE.find(entry => entry.id === id.toLowerCase())
      if (!pin) {
        throw new Error(
          `DeepSeek model '${id}' is not a catalogue-verified id (pins: ${DEEPSEEK_STATIC_CATALOGUE.map(c => c.id).join(', ')}) — never dispatching an unverified id.`,
        )
      }
      return { backend: 'deepseek', model: pin.id, displayLabel: pin.displayLabel }
    }
    if (/^gemini-/i.test(id)) {
      await requireProviderAvailable('gemini')
      return resolveGeminiExactModel(id.toLowerCase())
    }
    if (isOpenrouterModelId(id)) {
      await requireProviderAvailable('openrouter')
      return resolveOpenrouterExactModel(id)
    }
    if (isHuggingfaceModelId(id)) {
      await requireProviderAvailable('huggingface')
      return resolveHuggingfaceExactModel(id)
    }
    if (isLocalModelId(id)) {
      await requireProviderAvailable('local')
      return resolveLocalExactModel(id)
    }
    if (isCompatModelId(id)) {
      await requireProviderAvailable('openai-compat')
      const named = compatSlotModelIds()
      if (named.length > 0 && !named.includes(id.toLowerCase())) {
        throw new Error(
          `compat model '${id}' is not in the slot's named list (${named.join(', ')}) — extend MERCURY_COMPAT_MODELS or the compatProvider config block.`,
        )
      }
      const label = resolveCompatSlotConfig()?.label ?? 'Custom endpoint'
      return {
        backend: 'openai-compat',
        model: id.toLowerCase(),
        displayLabel: `${id.slice(COMPAT_MODEL_PREFIX.length)} (${label})`,
      }
    }
    await requireProviderAvailable('zai')
    const pin = GLM_STATIC_CATALOGUE.find(entry => entry.id === id)
    if (!pin) {
      throw new Error(
        `GLM model '${id}' is not a catalogue-verified id (pins: ${GLM_STATIC_CATALOGUE.map(c => c.id).join(', ')}) — never dispatching an unverified id.`,
      )
    }
    return { backend: 'zai', model: pin.id, displayLabel: pin.displayLabel }
  }
  return null
}
