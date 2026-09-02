// ============================================================================
//  swarm/engineDispatch — the Agent-tool dispatch grammar for the specialist
//  engines. ONE resolution
//  law:
//
//    - model 'gpt' ⇒ the native OpenAI in-process backend: the class resolves
//      to the highest-priority QUALIFIED candidate from the LIVE catalogue
//      (the live qualification law; openaiCatalogue.ts — never a static pin,
//      never an invented id) and the EXISTING agent runtime runs the turns
//      via the provider-aware callModel branch;
//    - model 'glm' ⇒ the Z.AI in-process backend: the class resolves against
//      the adapter's catalogue-verified pin (glm-5.2 today);
//    - an EXACT engine id ('gpt-5.6-sol' · 'glm-5.2' …) pins that model for
//      the job. GPT ids validate against the live catalogue when reachable
//      (display pins as the recorded fallback, never the preference);
//      deprecated ids refuse naming the deprecation; unknown ids refuse
//      listing what IS available — an invented id never reaches a wire;
//    - anything else ⇒ null (the Anthropic grammar, untouched).
//
//  Every ROUTED family sits in the grammar (cross-family matrix, lane CF):
//  gemini and openrouter were the two routed families the grammar skipped —
//  a session could run on them while the Agent tool could not dispatch a
//  worker onto them. 'gemini' resolves like 'huggingface' (session model
//  when already on the family, else the live catalogue head); exact
//  gemini-* ids validate against the live catalogue when reachable.
//  'openrouter' resolves to the router's own universal aggregate
//  (openrouter/openrouter/auto); exact openrouter/<vendor>/<model> ids
//  validate against the live catalogue when reachable. Unreachable
//  catalogues pass exact ids through labelled — the runtime answers for
//  itself at dispatch (the Hugging Face posture).
//
//  Refusals are HONEST AND LOUD: an unavailable provider throws with the
//  adapter's stable reason code — never a silent fallback to an Anthropic
//  model.
// ============================================================================
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

/** The openrouter qualified namespace (routeLaw's own reserved word). */
const OPENROUTER_MODEL_PREFIX = 'openrouter/'

function isOpenrouterModelId(v: string): boolean {
  return v.trim().toLowerCase().startsWith(OPENROUTER_MODEL_PREFIX)
}

/** An exact engine id spelling ('gpt-…' / 'glm-…' / 'kimi-…' / 'moonshot-…'
 *  / 'deepseek-…' / 'gemini-…' / 'compat/…' / 'openrouter/…'), any case. */
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

/** The schema-visible engine model choices — the class aliases ride first,
 *  then the catalogue-verified exact ids (the GPT ids are the official
 *  display pins — advertisement only; dispatch always re-validates against
 *  the LIVE catalogue). */
export function engineDispatchModelsForSchema(): readonly string[] {
  return [
    ...ENGINE_DISPATCH_MODELS,
    ...GPT_DISPLAY_PINS.map(pin => pin.id),
    ...GLM_STATIC_CATALOGUE.map(entry => entry.id),
    ...KIMI_STATIC_CATALOGUE.map(entry => entry.id),
    ...DEEPSEEK_STATIC_CATALOGUE.map(entry => entry.id),
    ...compatSlotModelIds(),
    // Hugging Face: the dated pins only (the live list is 100+ rows and the
    // schema must stay prompt-cache stable); any live-listed id still
    // dispatches when named exactly. Local: whatever discovery had found
    // when the schema was first built. Gemini and OpenRouter ride their
    // class aliases only (live catalogues, no static pins) — exact
    // gemini-*/openrouter/* ids still dispatch when named.
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
  /** Exact resolved id — every backend is in-process, so a dispatch
   *  always names its model (the class aliases resolve before launch). */
  model: string
  displayLabel: string
}

async function requireProviderAvailable(provider: EngineProvider): Promise<void> {
  // Freshness before launch: both probes are local-only (account/key
  // presence) behind the TTL'd single-flight cache.
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
    // Live catalogue unreachable — fall back to the last-observed display
    // pins (recorded as fallback, never the preference; the runtime
    // re-validates against the live source at dispatch and refuses honestly
    // if the id is dead — the pin's word is never the final one). Any
    // CURRENT pinned id is a candidate; the era ≥5.6 filter here was removed
    // with the generation floor.
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

/** The class alias resolves to the family's WORKING model: the session's
 *  main model when it already rides this family (a subagent on the same
 *  model as its parent), else the family's flagship — the live catalogue's
 *  first row, else the first dated pin. */
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

/** An exact huggingface/<org>/<model> id: validated against the live router
 *  catalogue when it is reachable (an unlisted slug refuses, naming the
 *  route); an unreachable catalogue lets the router answer for itself at
 *  dispatch (recorded as unvalidated, never the preference). */
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
  // Same law as the openrouter arm: an unreachable catalogue defers to the
  // router, never to structural junk — the wire-id owner rules first.
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

/** The class alias resolves like the huggingface class: the session's own
 *  model when it already rides gemini, else the live catalogue's first
 *  generateContent-capable row — never an invented id. */
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

/** An exact gemini-* id: validated against the live catalogue when it is
 *  reachable (an unlisted id refuses, naming the live count); an
 *  unreachable catalogue lets the runtime answer for itself at dispatch
 *  (recorded as unvalidated, never the preference). */
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

/** The class alias resolves to the session's own model when it already
 *  rides openrouter, else the router's universal aggregate id — the one row
 *  OpenRouter itself always serves. */
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

/** An exact openrouter/<vendor>/<model> id: validated against the live
 *  catalogue when reachable; an unreachable catalogue passes the id
 *  through labelled (the router answers at dispatch). */
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
  // Catalogue unreachable: the router answers for itself at dispatch — but
  // only for an id the wire-id owner would put on a wire at all; structural
  // junk (display dressing, a second vendor prefix) refuses HERE with the
  // owner's catalogue words instead of passing through labelled.
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

/**
 * Resolve an Agent-tool `model` param to its engine dispatch, or null for the
 * Anthropic grammar. Throws honest, model-visible errors for an unarmed or
 * unavailable engine and for deprecated/unknown exact ids — the caller
 * surfaces them verbatim.
 */
export async function resolveEngineDispatch(
  modelParam: string | undefined,
): Promise<EngineDispatch | null> {
  // Class aliases: 'gpt' (qualified live default) · 'glm'/'kimi'/'deepseek'
  // (catalogue-pin flagships) · 'compat' (the operator's first named model).
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
    // 'compat' — the operator-named slot's first model.
    await requireProviderAvailable('openai-compat')
    const first = compatSlotModelIds()[0]
    if (!first) {
      throw new Error(
        "The 'compat' class cannot resolve — the endpoint slot names no models (MERCURY_COMPAT_MODELS or the compatProvider config block). Name an exact compat/<id> instead.",
      )
    }
    return { backend: 'openai-compat', model: first, displayLabel: first }
  }
  // Exact ids (S6): catalogue-validated, never invented.
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
      // A non-empty operator list validates membership; an empty list accepts
      // the id as the operator's own naming at dispatch time (the slot's
      // models are operator-named either way — nothing is invented here).
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
    // glm-… (the remaining exact-id family)
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
