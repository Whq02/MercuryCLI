import {
  evaluateGptCandidate,
  qualifiedGptCandidates,
  refreshOpenaiCatalogue,
  GPT_DISPLAY_PINS,
} from '../../services/providers/openai/openaiCatalogue.js'
import { resolveOpenaiAccount } from '../../services/providers/openai/openaiAccounts.js'
import { buildProviderSnapshot } from '../../services/providers/modelRegistry.js'
import { refreshProviderDiscovery } from '../../services/providers/providerDiscovery.js'
import { DEPRECATED_GPT_IDS } from '../../services/providers/openai/openaiAdapter.js'
import { zaiCatalogueEntries, zaiCatalogueEntry } from '../../services/providers/zai/zaiAdapter.js'
import { qualifyMoonshotModel } from '../../services/providers/moonshot/moonshotCatalogue.js'
import { kimiDisplayName } from '../../services/providers/moonshot/kimiPins.js'
import { deepseekCatalogueEntries, deepseekCatalogueEntry } from '../../services/providers/deepseek/deepseekAdapter.js'
import { xaiCatalogueEntries, xaiCatalogueEntry } from '../../services/providers/xai/xaiAdapter.js'
import { metaCatalogueEntries, metaCatalogueEntry } from '../../services/providers/meta/metaAdapter.js'
import { mistralCatalogueEntries, mistralCatalogueEntry } from '../../services/providers/mistral/mistralAdapter.js'
import {
  compatSlotModelIds,
  resolveCompatSlotConfig,
} from '../../services/providers/openaicompat/compatAccounts.js'
import { COMPAT_MODEL_PREFIX, isCompatModelId } from '../../services/providers/routeLaw.js'
import { HUGGINGFACE_STATIC_CATALOGUE, huggingfaceLiveCatalogue } from '../../services/providers/huggingface/huggingfaceAdapter.js'
import { zenCatalogueEntries, zenCatalogueEntry } from '../../services/providers/zen/zenAdapter.js'
import { minimaxCatalogueEntries, minimaxCatalogueEntry } from '../../services/providers/minimax/minimaxAdapter.js'
import { togetherCatalogueEntries, togetherCatalogueEntry } from '../../services/providers/together/togetherAdapter.js'
import { cohereCatalogueEntries, cohereCatalogueEntry } from '../../services/providers/cohere/cohereAdapter.js'
import { isTogetherModelId } from '../../services/providers/together/togetherPins.js'
import { isZenModelId } from '../../services/providers/zen/zenPins.js'
import { localLiveCatalogue } from '../../services/providers/local/localAdapter.js'
import {
  HUGGINGFACE_MODEL_PREFIX,
  isHuggingfaceModelId,
} from '../../services/providers/huggingface/huggingfacePins.js'
import { huggingfaceLiveModel, refreshHuggingfaceCatalogue } from '../../services/providers/huggingface/huggingfaceCatalogue.js'
import { isLocalModelId, localRecordFor, localWireId, LOCAL_MODEL_PREFIX } from '../../services/providers/local/localCatalogue.js'
import { refreshLocalDiscovery } from '../../services/providers/local/localDiscovery.js'
import { getEngineModel, parseUserSpecifiedModel, parseUserSpecifiedModelRaw } from '../model/model.js'
import { bareFamilyListWords, bareFamilyWordOf, bareFamilyWordOfRoute, bareModelIdOf } from '../model/bareFamilyWords.js'
import { isModelAlias } from '../model/aliases.js'
import { isModelFamilyWord, modelFamilyWords } from '../model/modelFamilies.js'
import { canonicalWireModelId, classifyModelRoute, declaredRouteOf, providerDisplayName } from '../../services/providers/routeLaw.js'
import { isModelFromDisabledProvider, isProviderDisabled } from '../../services/providers/disabledProviders.js'
import { LIVE_LIST_FAMILIES, liveListedRouteOf, qualifiedIdSpaceOf } from '../../services/providers/idSpaces.js'
import { readCatalogueIfPending } from '../../services/providers/catalogueOnDemand.js'
import { resolveGeminiAccount } from '../../services/providers/gemini/geminiAccounts.js'
import {
  geminiGenerateModels,
  newestGeminiGenerationFirst,
  geminiPlanEffortRow,
  refreshGeminiCatalogue,
} from '../../services/providers/gemini/geminiCatalogue.js'
import { resolveOpenrouterAccount } from '../../services/providers/openrouter/openrouterAccounts.js'
import { refreshOpenrouterCatalogue } from '../../services/providers/openrouter/openrouterCatalogue.js'

export const ENGINE_DISPATCH_MODELS = ['gpt', 'glm', 'kimi', 'deepseek', 'grok', 'muse', 'compat', 'huggingface', 'local', 'gemini', 'openrouter', 'mistral', 'nous', 'zen', 'minimax', 'together', 'cohere'] as const
export type EngineDispatchModel = (typeof ENGINE_DISPATCH_MODELS)[number]

export function isEngineDispatchModel(v: unknown): v is EngineDispatchModel {
  if (typeof v !== 'string' || !(ENGINE_DISPATCH_MODELS as readonly string[]).includes(v)) return false
  const route = v === 'gpt' ? 'openai' : v === 'glm' ? 'zai' : v === 'kimi' ? 'moonshot' : v === 'grok' ? 'xai' : v === 'muse' ? 'meta' : v === 'compat' ? 'openai-compat' : v
  return !isProviderDisabled(route)
}

const OPENROUTER_MODEL_PREFIX = 'openrouter/'

function isOpenrouterModelId(v: string): boolean {
  return v.trim().toLowerCase().startsWith(OPENROUTER_MODEL_PREFIX)
}

const NOUS_ENGINE_MODEL_PREFIX = 'nous/'

function isNousModelId(v: string): boolean {
  return v.trim().toLowerCase().startsWith(NOUS_ENGINE_MODEL_PREFIX)
}

function isGoogleRosterModelId(v: string): boolean {
  return qualifiedIdSpaceOf(v)?.route === 'gemini'
}

export function isExactEngineModelId(v: unknown): v is string {
  if (typeof v !== 'string') return false
  if (isModelFromDisabledProvider(v)) return false
  return (
    liveListedRouteOf(v) !== undefined ||
    /^(gpt|glm|kimi|moonshot|deepseek|grok|muse|gemini|mistral|ministral|codestral|minimax|command|north|c4ai-aya)-/i.test(v.trim()) ||
    isCompatModelId(v) ||
    isHuggingfaceModelId(v) ||
    isLocalModelId(v) ||
    isOpenrouterModelId(v) ||
    isNousModelId(v) ||
    isZenModelId(v) ||
    isTogetherModelId(v) ||
    isGoogleRosterModelId(v)
  )
}

function exactEngineFamilyOf(id: string): 'openai' | 'moonshot' | 'deepseek' | 'xai' | 'meta' | 'gemini' | 'mistral' | 'minimax' | 'cohere' | undefined {
  const listed = liveListedRouteOf(id)
  if (listed !== undefined) return listed
  if (/^gpt-/i.test(id)) return 'openai'
  if (/^(kimi|moonshot)-/i.test(id)) return 'moonshot'
  if (/^deepseek-/i.test(id)) return 'deepseek'
  if (/^grok-/i.test(id)) return 'xai'
  if (/^muse-/i.test(id)) return 'meta'
  if (/^gemini-/i.test(id) || isGoogleRosterModelId(id)) return 'gemini'
  if (/^(mistral|ministral|codestral)-/i.test(id)) return 'mistral'
  if (/^minimax-/i.test(id)) return 'minimax'
  if (/^(command|north|c4ai-aya)-/i.test(id)) return 'cohere'
  return undefined
}

async function readLiveListsForBareId(modelParam: string | undefined): Promise<void> {
  if (typeof modelParam !== 'string') return
  const word = modelParam.trim()
  if (word === '' || qualifiedIdSpaceOf(word) !== undefined) return
  const verdict = classifyModelRoute(parseUserSpecifiedModelRaw(word))
  if (verdict.kind !== 'unrecognised' || verdict.carrierShaped) return
  await Promise.all(LIVE_LIST_FAMILIES.map(family => readCatalogueIfPending(family)))
}

import { MODEL_LOOKUP_LADDER } from '../model/modelLookup.js'

const ENGINE_ID_SHAPES = 'gpt-*, glm-*, kimi-*, deepseek-*, grok-*, muse-spark-*, gemini-*, google/*, mistral-*, minimax-*, command-*, compat/*, huggingface/*, local/*, openrouter/*, nous/*, together/*'

export function unrecognisedModelWordRefusal(model: string | undefined): string | null {
  if (model === undefined) return null
  const word = model.trim()
  if (word === '') return null
  const lowered = word.toLowerCase()
  if (isEngineDispatchModel(lowered) || isExactEngineModelId(word)) return null
  if (isModelFamilyWord(lowered) || (!isProviderDisabled('anthropic') && isModelAlias(lowered))) return null
  const parsed = parseUserSpecifiedModel(word)
  const routeVerdict = classifyModelRoute(parsed)
  if (routeVerdict.kind === 'route' && !isProviderDisabled(routeVerdict.route)) return null
  return `model '${word}' names no model: no provider family declares it. Pass a family word (${modelFamilyWords().join(' · ')}), a first-party alias, an exact id of a listed row, or an engine id (${ENGINE_ID_SHAPES}). mercury://models lists the providers the operator is signed into and the models each reaches. ${MODEL_LOOKUP_LADDER}`
}

type EngineProvider =
  | 'openai'
  | 'zai'
  | 'moonshot'
  | 'deepseek'
  | 'xai'
  | 'meta'
  | 'openai-compat'
  | 'huggingface'
  | 'local'
  | 'gemini'
  | 'openrouter'
  | 'mistral'
  | 'nous'
  | 'zen'
  | 'minimax'
  | 'together'
  | 'cohere'

export interface EngineDispatch {
  backend: EngineProvider
  model: string
  displayLabel: string
  note?: string
}

const SIGN_IN_DOORS: Partial<Record<EngineProvider, string>> = {
  openai: '/logins openai',
  zai: '/logins zai',
  moonshot: '/logins moonshot',
  deepseek: '/logins deepseek',
  xai: '/logins xai',
  meta: '/logins meta',
  huggingface: '/logins huggingface',
  gemini: '/logins gemini',
  openrouter: '/logins openrouter',
  mistral: '/logins mistral',
  nous: '/logins nous',
  zen: '/logins zen',
  minimax: '/logins minimax',
  together: '/logins together',
  cohere: '/logins cohere',
}

export function providerUnavailableRefusal(provider: EngineProvider, reason: string | undefined): string {
  const door = SIGN_IN_DOORS[provider]
  const why = reason ?? 'unknown'
  if (door !== undefined && /^no-(api-key|credential|account):/.test(why)) {
    return `Engine provider ${provider} is unavailable (${why}) — the operator is not signed in to ${providerDisplayName(provider)}; ${door} connects it. mercury://models lists the providers that are signed in; never switch to another provider on your own.`
  }
  if (provider === 'local') return `Engine provider local is unavailable (${why}) — no local server lists a model; start Ollama, LM Studio, vLLM or llama.cpp-server, or set MERCURY_LOCAL_BASE_URL. mercury://models lists what is reachable.`
  if (provider === 'openai-compat') return `Engine provider openai-compat is unavailable (${why}) — MERCURY_COMPAT_BASE_URL (or the compatProvider config block) configures the endpoint slot. mercury://models lists what is reachable.`
  return `Engine provider ${provider} is unavailable (${why}). /health ROUTER names the fix; mercury://models lists the providers that are signed in.`
}

async function requireProviderAvailable(provider: EngineProvider): Promise<void> {
  await refreshProviderDiscovery(provider)
  const snapshot = buildProviderSnapshot()
  const entry = snapshot.providers.find(p => p.id === provider)
  if (!entry?.available) {
    throw new Error(providerUnavailableRefusal(provider, entry?.reason))
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
        ? `The 'gpt' class cannot resolve — the live model catalogue is unavailable (${snapshot.lastError}). Name an exact id this build knows from mercury://models/known (e.g. gpt-5.6-sol), or retry when the list reads; never switch to another provider on your own.`
        : `The 'gpt' class cannot resolve — the ${account.label} catalogue offers no usable GPT model. mercury://models shows what the account does reach; ask the operator for the model id, and never switch to another provider on your own.`,
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
      `GPT model '${id}' is DEPRECATED/retired in the current catalogue — refusing to dispatch a dead id. Current ids: ${GPT_DISPLAY_PINS.map(p => p.id).join(', ')} (or 'gpt' for the catalogue's default; mercury://models lists what the account reaches). Never switch to another provider on your own.`,
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
        `GPT model '${id}' is not a catalogue-verified id — the live list could not be read and this build knows only ${GPT_DISPLAY_PINS.map(p => p.id).join(', ')} (mercury://models/known). Name one of them, or ask the operator for the model id; never switch to another provider on your own.`,
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
    `GPT model '${id}' is not accepted by the live catalogue (${evaluated.why.reason}). ${offered ? `The catalogue offers: ${offered} — name one of them (mercury://models lists them)` : 'The catalogue currently offers no usable ids'}, or ask the operator for the model id; never switch to another provider on your own.`,
  )
}

async function resolveHuggingfaceClassDispatch(): Promise<EngineDispatch> {
  const main = getEngineModel()
  if (declaredRouteOf(main) === 'huggingface') {
    return { backend: 'huggingface', model: main, displayLabel: main.slice(HUGGINGFACE_MODEL_PREFIX.length) }
  }
  await refreshHuggingfaceCatalogue().catch(() => null)
  const head = huggingfaceLiveCatalogue()?.entries[0] ?? HUGGINGFACE_STATIC_CATALOGUE[0]
  if (!head) throw new Error("The 'huggingface' class cannot resolve — the router's model list could not be read and this build pins no Hugging Face row. Name an exact huggingface/<org>/<model> id from mercury://models/known, or ask the operator for the model id; never switch to another provider on your own.")
  return { backend: 'huggingface', model: head.id, displayLabel: head.displayLabel }
}

async function resolveHuggingfaceExactModel(id: string): Promise<EngineDispatch> {
  const slug = id.slice(HUGGINGFACE_MODEL_PREFIX.length)
  const snapshot = await refreshHuggingfaceCatalogue().catch(() => null)
  if (snapshot && snapshot.models.length > 0) {
    const live = huggingfaceLiveModel(slug)
    if (!live) {
      throw new Error(
        `Hugging Face model '${id}' is not listed by the router catalogue (${snapshot.models.length} live models) — name a listed huggingface/<org>/<model> id (mercury://models lists them), or 'huggingface' for the flagship, or ask the operator for the model id; never switch to another provider on your own.`,
      )
    }
    return { backend: 'huggingface', model: `${HUGGINGFACE_MODEL_PREFIX}${live.id}${slug.includes(':') ? slug.slice(slug.lastIndexOf(':')) : ''}`, displayLabel: live.id }
  }
  const verdict = canonicalWireModelId(id)
  if (!verdict.ok) throw new Error(verdict.reason)
  return { backend: 'huggingface', model: id, displayLabel: `${slug} (catalogue unreachable — the router validates at dispatch)` }
}

async function resolveLocalClassDispatch(): Promise<EngineDispatch> {
  const main = getEngineModel()
  if (declaredRouteOf(main) === 'local' && localRecordFor(main)) {
    return { backend: 'local', model: main, displayLabel: localWireId(main) }
  }
  const first = localLiveCatalogue()[0]
  if (!first) throw new Error("The 'local' class cannot resolve — no local server lists a model (start Ollama/LM Studio/vLLM/llama.cpp-server, or set MERCURY_LOCAL_BASE_URL). mercury://models lists what is reachable; never switch to another provider on your own.")
  return { backend: 'local', model: first.id, displayLabel: first.displayLabel }
}

async function resolveGeminiClassDispatch(): Promise<EngineDispatch> {
  const main = getEngineModel()
  if (declaredRouteOf(main) === 'gemini') {
    return { backend: 'gemini', model: main, displayLabel: main }
  }
  const account = resolveGeminiAccount()
  if (!account) {
    throw new Error(
      'Engine provider gemini has no connected account source — /logins gemini signs in or attaches an API key.',
    )
  }
  const snapshot = await refreshGeminiCatalogue(account.kind).catch(() => null)
  const head = newestGeminiGenerationFirst(geminiGenerateModels(snapshot), m => m.id)[0]
  if (!head) {
    throw new Error(
      snapshot?.lastError
        ? `The 'gemini' class cannot resolve — the live model catalogue is unavailable (${snapshot.lastError}). Name an exact gemini-* id this build knows from mercury://models/known, or retry when the list reads; never switch to another provider on your own.`
        : "The 'gemini' class cannot resolve — the live catalogue lists no generateContent model. Name an exact gemini-* id from mercury://models, or ask the operator for the model id; never switch to another provider on your own.",
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
  const snapshot = await refreshGeminiCatalogue(account.kind).catch(() => null)
  const live = geminiGenerateModels(snapshot)
  if (live.length > 0) {
    const match = live.find(m => m.id === id) ?? (account.kind === 'plan' ? geminiPlanEffortRow(id, undefined) : undefined)
    if (!match) {
      throw new Error(
        `Gemini model '${id}' is not listed by the live catalogue (${live.length} generateContent models) — name a listed gemini-* id (mercury://models lists them), or 'gemini' for the catalogue head, or ask the operator for the model id; never switch to another provider on your own.`,
      )
    }
    return { backend: 'gemini', model: match.id, displayLabel: match.displayName ?? match.id }
  }
  return { backend: 'gemini', model: id, displayLabel: `${id} (catalogue unreachable — the runtime validates at dispatch)` }
}

async function resolveZenClassDispatch(): Promise<EngineDispatch> {
  const main = getEngineModel()
  if (declaredRouteOf(main) === 'zen') {
    return { backend: 'zen', model: main, displayLabel: zenCatalogueEntry(main)?.displayLabel ?? main.slice('zen/'.length) }
  }
  if (!zenCatalogueEntries().length) await readCatalogueIfPending('zen')
  const head = zenCatalogueEntries()[0]
  if (!head) {
    throw new Error("The 'zen' class cannot resolve — the OpenCode Zen gateway's model list has not been read or lists no row this road carries. Name an exact zen/<id> this build knows from mercury://models/known, or retry when the list lands; never switch to another provider on your own.")
  }
  return { backend: 'zen', model: head.id, displayLabel: head.displayLabel }
}

async function resolveTogetherClassDispatch(): Promise<EngineDispatch> {
  const main = getEngineModel()
  if (declaredRouteOf(main) === 'together') {
    return { backend: 'together', model: main, displayLabel: togetherCatalogueEntry(main)?.displayLabel ?? main.slice('together/'.length) }
  }
  if (!togetherCatalogueEntries().length) await readCatalogueIfPending('together')
  const head = togetherCatalogueEntries()[0]
  if (!head) {
    throw new Error("The 'together' class cannot resolve — the Together AI gateway's chat list has not been read or lists no row. Name an exact together/<org>/<model> this build knows from mercury://models/known, or retry when the list lands; never switch to another provider on your own.")
  }
  return { backend: 'together', model: head.id, displayLabel: head.displayLabel }
}

async function resolveOpenrouterClassDispatch(): Promise<EngineDispatch> {
  const main = getEngineModel()
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
        `OpenRouter model '${id}' is not listed by the live catalogue (${snapshot.models.length} models) — name a listed openrouter/<vendor>/<model> id (mercury://models lists them), or 'openrouter' for the auto router, or ask the operator for the model id; never switch to another provider on your own.`,
      )
    }
    return { backend: 'openrouter', model: `${OPENROUTER_MODEL_PREFIX}${match.id}`, displayLabel: match.name ?? match.id }
  }
  const verdict = canonicalWireModelId(id)
  if (!verdict.ok) throw new Error(verdict.reason)
  return { backend: 'openrouter', model: id, displayLabel: `${slug} (catalogue unreachable — the router validates at dispatch)` }
}

async function resolveNousClassDispatch(): Promise<EngineDispatch> {
  const main = getEngineModel()
  if (declaredRouteOf(main) === 'nous') {
    return { backend: 'nous', model: main, displayLabel: main.slice(NOUS_ENGINE_MODEL_PREFIX.length) }
  }
  const { getNousModelOptions, refreshNousCatalogue } = await import('../../services/providers/nous/nousCatalogue.js')
  await refreshNousCatalogue().catch(() => null)
  const head = getNousModelOptions().find(option => option.value.startsWith(NOUS_ENGINE_MODEL_PREFIX) && option.unavailable === undefined)
  if (!head) {
    throw new Error("The 'nous' class cannot resolve — the Nous Portal catalogue serves no selectable row yet (the key's live list has not been read, or listed none). Name an exact nous/<vendor>/<model> id from mercury://models, or ask the operator for the model id; never switch to another provider on your own.")
  }
  return { backend: 'nous', model: head.value, displayLabel: head.label }
}

async function resolveNousExactModel(id: string): Promise<EngineDispatch> {
  const { resolveNousAccount } = await import('../../services/providers/nous/nousAccounts.js')
  if (!resolveNousAccount()) {
    throw new Error('Engine provider nous has no API key — /logins nous stores one (or set NOUS_API_KEY).')
  }
  const { refreshNousCatalogue } = await import('../../services/providers/nous/nousCatalogue.js')
  const slug = id.slice(NOUS_ENGINE_MODEL_PREFIX.length)
  const snapshot = await refreshNousCatalogue().catch(() => null)
  if (snapshot && snapshot.models.length > 0) {
    const match = snapshot.models.find(m => m.id.toLowerCase() === slug.toLowerCase())
    if (!match) {
      throw new Error(`Nous Portal model '${id}' is not listed by the live catalogue (${snapshot.models.length} models) — name a listed nous/<vendor>/<model> id (mercury://models lists them), or ask the operator for the model id; never switch to another provider on your own.`)
    }
    return { backend: 'nous', model: `${NOUS_ENGINE_MODEL_PREFIX}${match.id}`, displayLabel: match.name ?? match.id }
  }
  const verdict = canonicalWireModelId(id)
  if (!verdict.ok) throw new Error(verdict.reason)
  return { backend: 'nous', model: id, displayLabel: `${slug} (catalogue unreachable — the Portal validates at dispatch)` }
}

async function resolveLocalExactModel(id: string): Promise<EngineDispatch> {
  if (!localRecordFor(id)) await refreshLocalDiscovery({ force: true }).catch(() => null)
  const record = localRecordFor(id)
  if (!record) {
    const listed = localLiveCatalogue().map(e => e.id)
    throw new Error(
      `No local server lists '${id}'${listed.length > 0 ? ` (discovered: ${listed.join(', ')})` : ' (no local server answered)'} — never dispatching an undiscovered id. mercury://models lists the discovered models; name one of them, or ask the operator for the model id; never switch to another provider on your own.`,
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
    const familyWord = bareFamilyWordOf(modelParam)
    if (familyWord !== undefined) {
      await requireProviderAvailable(familyWord.route)
      await readCatalogueIfPending(familyWord.route)
      const head = familyWord.headRow()
      if (head) return { backend: familyWord.route, model: head.id, displayLabel: head.displayName }
      const providerName = providerDisplayName(familyWord.route)
      const pinned = familyWord.pinnedDefault()
      if (!pinned) {
        throw new Error(
          `The '${familyWord.word}' class cannot resolve — ${bareFamilyListWords(familyWord, providerName)} and this build pins no ${providerName} default. Name an exact id from mercury://models or mercury://models/known, or ask the operator for the model id.`,
        )
      }
      return {
        backend: familyWord.route,
        model: pinned.id,
        displayLabel: pinned.displayName,
        note: `${bareFamilyListWords(familyWord, providerName)} — ${pinned.displayName} (${pinned.id}), the family's default this build knows, runs; the provider's own answer decides. mercury://models shows the live list, mercury://models/known what this build knows.`,
      }
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
    if (modelParam === 'nous') {
      await requireProviderAvailable('nous')
      return resolveNousClassDispatch()
    }
    if (modelParam === 'zen') {
      await requireProviderAvailable('zen')
      return resolveZenClassDispatch()
    }
    if (modelParam === 'together') {
      await requireProviderAvailable('together')
      return resolveTogetherClassDispatch()
    }
    await requireProviderAvailable('openai-compat')
    const first = compatSlotModelIds()[0]
    if (!first) {
      throw new Error(
        "The 'compat' class cannot resolve — the endpoint slot names no models (MERCURY_COMPAT_MODELS or the compatProvider config block). Name an exact compat/<id> instead, or ask the operator for the model id; never switch to another provider on your own.",
      )
    }
    return { backend: 'openai-compat', model: first, displayLabel: first }
  }
  await readLiveListsForBareId(modelParam)
  if (isExactEngineModelId(modelParam)) {
    const id = modelParam!.trim()
    const family = exactEngineFamilyOf(id)
    if (family === 'openai') {
      await requireProviderAvailable('openai')
      return resolveGptExactModel(id.toLowerCase())
    }
    if (family === 'moonshot') {
      await requireProviderAvailable('moonshot')
      const qualification = await qualifyMoonshotModel(id.toLowerCase())
      if (qualification.kind === 'refused') throw new Error(qualification.message)
      return {
        backend: 'moonshot', model: qualification.modelId,
        displayLabel: `${kimiDisplayName(qualification.modelId) ?? kimiDisplayName(id) ?? qualification.modelId}${qualification.kind === 'degraded' ? ` (${qualification.note})` : ''}`,
      }
    }
    if (family === 'meta') {
      await requireProviderAvailable('meta')
      return resolveKeyLaneExactModel('meta', id, metaCatalogueEntry, metaCatalogueEntries)
    }
    if (family === 'mistral') {
      await requireProviderAvailable('mistral')
      return resolveKeyLaneExactModel('mistral', id, mistralCatalogueEntry, mistralCatalogueEntries)
    }
    if (family === 'minimax') {
      await requireProviderAvailable('minimax')
      return resolveKeyLaneExactModel('minimax', id, minimaxCatalogueEntry, minimaxCatalogueEntries)
    }
    if (family === 'cohere') {
      await requireProviderAvailable('cohere')
      return resolveKeyLaneExactModel('cohere', id, cohereCatalogueEntry, cohereCatalogueEntries)
    }
    if (family === 'deepseek') {
      await requireProviderAvailable('deepseek')
      return resolveKeyLaneExactModel('deepseek', id, deepseekCatalogueEntry, deepseekCatalogueEntries)
    }
    if (family === 'xai') {
      await requireProviderAvailable('xai')
      return resolveKeyLaneExactModel('xai', id, xaiCatalogueEntry, xaiCatalogueEntries)
    }
    if (family === 'gemini') {
      await requireProviderAvailable('gemini')
      return resolveGeminiExactModel(id.toLowerCase())
    }
    if (isOpenrouterModelId(id)) {
      await requireProviderAvailable('openrouter')
      return resolveOpenrouterExactModel(id)
    }
    if (isNousModelId(id)) {
      await requireProviderAvailable('nous')
      return resolveNousExactModel(id)
    }
    if (isHuggingfaceModelId(id)) {
      await requireProviderAvailable('huggingface')
      return resolveHuggingfaceExactModel(id)
    }
    if (isLocalModelId(id)) {
      await requireProviderAvailable('local')
      return resolveLocalExactModel(id)
    }
    if (isTogetherModelId(id)) {
      await requireProviderAvailable('together')
      if (!togetherCatalogueEntry(id)) await readCatalogueIfPending('together')
      const pin = togetherCatalogueEntry(id)
      if (!pin) {
        throw new Error(
          `Together AI model '${id}' is not on the gateway's chat list (listed: ${togetherCatalogueEntries().map(c => c.id).join(', ')}) — name one of them from mercury://models, or ask the operator for the model id; never switch to another provider on your own.`,
        )
      }
      return { backend: 'together', model: pin.id, displayLabel: pin.displayLabel }
    }
    if (isZenModelId(id)) {
      await requireProviderAvailable('zen')
      if (!zenCatalogueEntry(id)) await readCatalogueIfPending('zen')
      const pin = zenCatalogueEntry(id)
      if (!pin) {
        throw new Error(
          `OpenCode Zen model '${id}' is not on the gateway's list (listed: ${zenCatalogueEntries().map(c => c.id).join(', ')}) — name one of them from mercury://models, or ask the operator for the model id; never switch to another provider on your own.`,
        )
      }
      return { backend: 'zen', model: pin.id, displayLabel: pin.displayLabel }
    }
    if (isCompatModelId(id)) {
      await requireProviderAvailable('openai-compat')
      const { compatModelEndpoint, compatModelRefusal } = await import('../../services/providers/openaicompat/compatAccounts.js')
      const endpoint = compatModelEndpoint(id)
      if (endpoint?.endpoint.named) {
        const refusal = compatModelRefusal(id)
        if (refusal) throw new Error(refusal)
        return { backend: 'openai-compat', model: id, displayLabel: `${endpoint.wireId} (${endpoint.endpoint.label})` }
      }
      const named = compatSlotModelIds()
      if (named.length > 0 && !named.includes(id.toLowerCase())) {
        throw new Error(
          `compat model '${id}' is not in the slot's named list (${named.join(', ')}) — name one of them (mercury://models lists them), or the operator extends MERCURY_COMPAT_MODELS or the compatProvider config block; never switch to another provider on your own.`,
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
    return resolveKeyLaneExactModel('zai', id, zaiCatalogueEntry, zaiCatalogueEntries)
  }
  return null
}

type KeyLaneRoute = 'xai' | 'meta' | 'mistral' | 'deepseek' | 'zai' | 'minimax' | 'cohere'

async function resolveKeyLaneExactModel(
  route: KeyLaneRoute,
  id: string,
  liveEntry: (id: string) => { id: string; displayLabel: string } | undefined,
  liveEntries: () => ReadonlyArray<{ id: string; displayLabel: string }>,
): Promise<EngineDispatch> {
  const family = bareFamilyWordOfRoute(route)
  const providerName = providerDisplayName(route)
  const bare = bareModelIdOf(id)
  if (!liveEntry(bare)) await readCatalogueIfPending(route)
  const live = liveEntry(bare)
  if (live) return { backend: route, model: live.id, displayLabel: live.displayLabel }
  const state = family?.listState()
  if (state?.kind === 'live') {
    const listed = liveEntries().map(entry => entry.id)
    throw new Error(
      `${providerName} model '${id}' is not on the account's live model list${listed.length > 0 ? ` (listed: ${listed.join(', ')})` : ' (the list serves no chat model)'} — name one of the listed ids from mercury://models, or ask the operator for the model id; never switch to another provider on your own.`,
    )
  }
  const known = family?.knownRow(bare)
  const listWords = family === undefined ? `the ${providerName} model list could not be read` : bareFamilyListWords(family, providerName)
  if (known) {
    return {
      backend: route,
      model: known.id,
      displayLabel: known.displayName,
      note: `${listWords} — ${known.displayName} (${known.id}) runs as this build knows it; the provider's own answer decides. mercury://models shows the live list, mercury://models/known what this build knows.`,
    }
  }
  const knownIds = family?.knownRows().map(row => row.id) ?? []
  throw new Error(
    `${providerName} model '${id}' is on neither mercury://models (${listWords}) nor mercury://models/known${knownIds.length > 0 ? ` (this build knows: ${knownIds.join(', ')})` : ''}. ${MODEL_LOOKUP_LADDER}`,
  )
}
