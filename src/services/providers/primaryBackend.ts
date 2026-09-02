// ============================================================================
//  providers/primaryBackend — the typed PrimaryAgentBackend contract
// (brief) over the zai + openai + anthropic
//  callModel seam.
// ----------------------------------------------------------------------------
// ONE agent architecture: the EXISTING turn machine is the loop; a
//  backend is a typed record whose stream face IS queryModelWithStreaming's
//  exact generator contract (begin-one-turn = invoke; interrupt = the
//  AbortSignal; settle-exactly-once = the generator's settlement law each
//  runtime already proves). This module adds the missing TYPED layer:
//
//    - AgentRuntimeRef — never a raw model string: backend id, provider,
//      canonical id, parsed family/generation, route, architecture epoch;
//    - PrimaryAgentBackend — id/provider/label + the callModel face + a
//      READINESS RECEIPT (typed, honest: engines/account/catalogue/live-proof
//      for engines; 'ready' by construction for the Anthropic main loop,
//      whose credential machinery owns its own errors);
//    - ONE resolver (resolvePrimaryAgentBackend) over the SAME law
//      callModelRouter enforces — the two can never disagree because both
//      read classifyModelRoute; a stranger resolves null (no borrowed
//      backend identity — the phase-2 neutrality ruling).
//
//  Anthropic adapts with ZERO behavioural churn (the record wraps
//  queryModelWithStreaming untouched); the daemon's crews keep their dispatch
//  owners and resolve refs at their own seams.
// ============================================================================
import { queryModelWithStreaming } from '../providers/anthropic/index.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import { resolveZaiApiKey } from '../../utils/router/providerDiscovery.js'
import { parseGptModelId } from './openai/gptPins.js'
import { resolveOpenaiAccount } from './openai/openaiAccounts.js'
import { classifyModelRoute, type CallModelRoute } from './callModelRouter.js'
import { activeWalletEntry } from '../wallet/wallet.js'
import { openrouterCallModel, openrouterLiveProofState } from './openrouter/openrouterCallModel.js'
import { resolveOpenrouterApiKey } from './openrouter/openrouterAccounts.js'
import { geminiCallModel, geminiLiveProofState } from './gemini/geminiCallModel.js'
import { resolveGeminiAccount } from './gemini/geminiAccounts.js'
import { openaiCallModel, openaiLiveProofState } from './openai/openaiCallModel.js'
import { zaiCallModel, zaiLiveProofState } from './zai/zaiCallModel.js'
import { moonshotCallModel, moonshotLiveProofState } from './moonshot/moonshotCallModel.js'
import { moonshotDispatchSource } from './moonshot/moonshotAccounts.js'
import { deepseekCallModel, deepseekLiveProofState } from './deepseek/deepseekCallModel.js'
import { resolveDeepseekApiKey } from './deepseek/deepseekAccounts.js'
import { compatCallModel, compatSlotLiveProofState } from './openaicompat/compatCallModel.js'
import { resolveCompatSlotConfig } from './openaicompat/compatAccounts.js'
import {
  HUGGINGFACE_UNVERIFIED_NOTE,
  huggingfaceCallModel,
  huggingfaceLiveProofState,
} from './huggingface/huggingfaceCallModel.js'
import { resolveHuggingfaceApiKey } from './huggingface/huggingfaceAccounts.js'
import { localCallModel, localLiveProofState } from './local/localCallModel.js'
import { resolveLocalAccount } from './local/localAccounts.js'

export const APEX_BACKEND_CONTRACT_VERSION = 1

export type PrimaryBackendId =
  | 'anthropic-messages'
  | 'zai-glm'
  | 'openai-responses'
  // The chat-completions lanes:
  | 'moonshot-chat'
  | 'deepseek-chat'
  | 'openai-compat-chat'
  | 'openrouter-chat'
  | 'gemini-generate'
  | 'huggingface-chat'
  | 'local-chat'

/** the typed runtime ref. Never a raw model string. THIN by
 *  contract: transport and capabilities are
 *  DERIVED from the adapter + the one catalogue, never stored here — the
 * field list is pinned by prove-wallet; resist growing it. */
export interface AgentRuntimeRef {
  contractVersion: typeof APEX_BACKEND_CONTRACT_VERSION
  /** Absent when no family claims the id — a stranger ref names no backend
   *  (its only possible ride is the earned home-transport gateway ride). */
  backend?: PrimaryBackendId
  /** Absent exactly when backend is: no family, no provider identity. */
  provider?:
    | 'anthropic'
    | 'zai'
    | 'openai'
    | 'moonshot'
    | 'deepseek'
    | 'openai-compat'
    | 'openrouter'
    | 'gemini'
    | 'huggingface'
    | 'local'
  /** The verdict's route, or the honest non-route kind: 'unrecognised' (no
   *  family declares the id) · 'absence' (no id at all). Never a borrowed
   *  family. */
  route: CallModelRoute | 'unrecognised' | 'absence'
  /** The id exactly as it will ride the wire. */
  canonicalModel: string
  family:
    | { kind: 'claude' }
    | { kind: 'glm' }
    | { kind: 'gpt'; major: number; minor: number; variant: string }
    | { kind: 'kimi' }
    | { kind: 'deepseek' }
    | { kind: 'compat' }
    | { kind: 'openrouter' }
    | { kind: 'gemini' }
    | { kind: 'huggingface' }
    | { kind: 'local' }
    | { kind: 'unknown' }
  /** The wallet entry a dispatch on this ref would BILL (stage 8): the
   *  provider's active entry. Absent when no entry is active (nothing
   *  connected · the zai socket, which has no wallet custodian yet). */
  walletEntryId?: string
}

export type BackendReadiness =
  | { state: 'ready'; detail: string }
  | { state: 'configured'; detail: string }
  | { state: 'unavailable'; reason: string }

export interface PrimaryAgentBackend {
  id: PrimaryBackendId
  provider: AgentRuntimeRef['provider']
  label: string
  /** The stream face — queryModelWithStreaming's EXACT generator contract
   *  (the turn machine consumes any of these interchangeably; interruption =
   *  params.signal; exactly-once settlement is each runtime's proved law). */
  callModel: typeof queryModelWithStreaming
  /** Typed readiness receipt — honest, never 'ready' by config alone
   *  for an engine backend. */
  readiness(): BackendReadiness
}

function anthropicReadiness(): BackendReadiness {
  // The main loop's own credential machinery owns errors; a Mercury session
  // exists because this path works.
  return { state: 'ready', detail: 'main-loop Anthropic transport' }
}

const anthropicBackend: PrimaryAgentBackend = {
  id: 'anthropic-messages',
  provider: 'anthropic',
  label: 'Anthropic Messages (main loop)',
  callModel: queryModelWithStreaming,
  readiness: anthropicReadiness,
}

const openaiBackend: PrimaryAgentBackend = {
  id: 'openai-responses',
  provider: 'openai',
  label: 'OpenAI Responses (native, in-process)',
  callModel: openaiCallModel as unknown as typeof queryModelWithStreaming,
  readiness: (): BackendReadiness => {
    const account = resolveOpenaiAccount()
    if (!account) return { state: 'unavailable', reason: 'no OpenAI account source connected' }
    const proof = openaiLiveProofState()
    return proof
      ? { state: 'ready', detail: `live turn settled this session (${proof.model}) · ${account.label}` }
      : {
          state: 'configured',
          detail: `${account.label} connected · native Responses runtime landed · no live turn proven this session`,
        }
  },
}

const zaiBackend: PrimaryAgentBackend = {
  id: 'zai-glm',
  provider: 'zai',
  label: 'Z.AI GLM (native, in-process)',
  callModel: zaiCallModel as unknown as typeof queryModelWithStreaming,
  readiness: (): BackendReadiness => {
    if (!resolveZaiApiKey()) return { state: 'unavailable', reason: 'no API key (/logins zai, or ZAI_API_KEY)' }
    const proof = zaiLiveProofState()
    return proof
      ? { state: 'ready', detail: `live turn settled this session (${proof.model})` }
      : {
          state: 'configured',
          detail: 'key present · native runtime landed · no live turn proven this session',
        }
  },
}

// The chat lanes — the zai backend's shape,
// each reading its OWNING credential resolver + per-lane live-proof latch.
const moonshotBackend: PrimaryAgentBackend = {
  id: 'moonshot-chat',
  provider: 'moonshot',
  label: 'Moonshot Kimi (native, in-process)',
  callModel: moonshotCallModel as unknown as typeof queryModelWithStreaming,
  readiness: (): BackendReadiness => {
    const source = moonshotDispatchSource()
    if (source === undefined) {
      return { state: 'unavailable', reason: 'no Kimi sign-in or Moonshot API key (/logins moonshot, or MOONSHOT_API_KEY)' }
    }
    const proof = moonshotLiveProofState()
    return proof
      ? { state: 'ready', detail: `live turn settled this session (${proof.model})` }
      : {
          state: 'configured',
          detail: `${source === 'kimi-oauth' ? 'Kimi sign-in' : 'key'} present · shared compat runtime landed · no live turn proven this session`,
        }
  },
}

const deepseekBackend: PrimaryAgentBackend = {
  id: 'deepseek-chat',
  provider: 'deepseek',
  label: 'DeepSeek (native, in-process)',
  callModel: deepseekCallModel as unknown as typeof queryModelWithStreaming,
  readiness: (): BackendReadiness => {
    if (!resolveDeepseekApiKey()) {
      return { state: 'unavailable', reason: 'no API key (/logins deepseek, or DEEPSEEK_API_KEY)' }
    }
    const proof = deepseekLiveProofState()
    return proof
      ? { state: 'ready', detail: `live turn settled this session (${proof.model})` }
      : { state: 'configured', detail: 'key present · shared compat runtime landed · no live turn proven this session' }
  },
}

const compatBackend: PrimaryAgentBackend = {
  id: 'openai-compat-chat',
  provider: 'openai-compat',
  label: 'OpenAI-compatible endpoint (operator-named)',
  callModel: compatCallModel as unknown as typeof queryModelWithStreaming,
  readiness: (): BackendReadiness => {
    if (!resolveCompatSlotConfig()) {
      return { state: 'unavailable', reason: 'no endpoint configured (MERCURY_COMPAT_BASE_URL)' }
    }
    const proof = compatSlotLiveProofState()
    return proof
      ? { state: 'ready', detail: `live turn settled this session (${proof.model})` }
      : { state: 'configured', detail: 'endpoint configured · shared compat runtime landed · no live turn proven this session' }
  },
}

const huggingfaceBackend: PrimaryAgentBackend = {
  id: 'huggingface-chat',
  provider: 'huggingface',
  label: 'Hugging Face Inference Providers (router, in-process)',
  callModel: huggingfaceCallModel as unknown as typeof queryModelWithStreaming,
  readiness: (): BackendReadiness => {
    const key = resolveHuggingfaceApiKey()
    if (!key) return { state: 'unavailable', reason: 'no credential (/logins, or HF_TOKEN)' }
    const proof = huggingfaceLiveProofState()
    return proof
      ? { state: 'ready', detail: `live turn settled this session (${proof.model}) · ${key.source}` }
      : {
          state: 'configured',
          detail: `credential present (${key.source}) · shared compat runtime · ${HUGGINGFACE_UNVERIFIED_NOTE} · no live turn proven this session`,
        }
  },
}

const localBackend: PrimaryAgentBackend = {
  id: 'local-chat',
  provider: 'local',
  label: 'Local models (Ollama · LM Studio · vLLM · llama.cpp, in-process)',
  callModel: localCallModel as unknown as typeof queryModelWithStreaming,
  readiness: (): BackendReadiness => {
    const account = resolveLocalAccount()
    if (!account) return { state: 'unavailable', reason: 'no local server discovered (Ollama :11434 · LM Studio :1234 · vLLM :8000 · llama.cpp :8080 · MERCURY_LOCAL_BASE_URL)' }
    const proof = localLiveProofState()
    return proof
      ? { state: 'ready', detail: `live turn settled this session (${proof.model}) · ${account.label}` }
      : {
          state: 'configured',
          detail: `${account.label} · shared compat runtime · no live turn proven this session`,
        }
  },
}

// The two carrier lanes: live runtimes on the shared compat chat runtime
// (callModelRouter dispatches them), so their receipts read like every
// other landed family — the owning credential resolver decides
// unavailable/configured, and only a settled live turn reads ready. (A
// placeholder receipt that said "the runtime folds in from the auth lane"
// over a live wire painted /health's engine rows false for both.)
const openrouterBackend: PrimaryAgentBackend = {
  id: 'openrouter-chat',
  provider: 'openrouter',
  label: 'OpenRouter (multi-vendor catalogue, shared compat runtime)',
  callModel: openrouterCallModel as unknown as typeof queryModelWithStreaming,
  readiness: (): BackendReadiness => {
    const key = resolveOpenrouterApiKey()
    if (!key) {
      return { state: 'unavailable', reason: 'no OpenRouter credential (/logins, or OPENROUTER_API_KEY)' }
    }
    const proof = openrouterLiveProofState()
    const source =
      key.source === 'oauth' ? 'OAuth-minted key' : key.source === 'env' ? 'OPENROUTER_API_KEY' : 'stored key'
    return proof
      ? { state: 'ready', detail: `live turn settled this session (${proof.model}) · ${source}` }
      : {
          state: 'configured',
          detail: `${source} present · shared compat runtime landed · no live turn proven this session`,
        }
  },
}

const geminiBackend: PrimaryAgentBackend = {
  id: 'gemini-generate',
  provider: 'gemini',
  label: 'Gemini (OpenAI-compatibility surface, shared compat runtime)',
  callModel: geminiCallModel as unknown as typeof queryModelWithStreaming,
  readiness: (): BackendReadiness => {
    const account = resolveGeminiAccount()
    if (!account) {
      return {
        state: 'unavailable',
        reason: 'no Gemini credential (/logins, or GOOGLE_API_KEY / GEMINI_API_KEY)',
      }
    }
    const proof = geminiLiveProofState()
    return proof
      ? { state: 'ready', detail: `live turn settled this session (${proof.model}) · ${account.label}` }
      : {
          state: 'configured',
          detail: `${account.label} · shared compat runtime landed · no live turn proven this session`,
        }
  },
}

const BACKENDS: Record<CallModelRoute, PrimaryAgentBackend> = {
  anthropic: anthropicBackend,
  zai: zaiBackend,
  openai: openaiBackend,
  moonshot: moonshotBackend,
  deepseek: deepseekBackend,
  'openai-compat': compatBackend,
  openrouter: openrouterBackend,
  gemini: geminiBackend,
  huggingface: huggingfaceBackend,
  local: localBackend,
}

/** Resolve the typed backend for a model id — the SAME law the callModel
 *  seam enforces (both read classifyModelRoute). null when NO family claims
 *  the id (unrecognised) or there is no id at all (absence): a stranger has
 *  no backend identity to borrow — its only possible ride is the home
 *  transport's earned gateway ride, adjudicated at the dispatch seam. */
export function resolvePrimaryAgentBackend(model: string | undefined): PrimaryAgentBackend | null {
  const verdict = classifyModelRoute(model)
  return verdict.kind === 'route' ? BACKENDS[verdict.route] : null
}

/** mint the typed runtime ref for a model id. Total — a stranger mints an
 *  honest stranger ref (unknown family, no backend, no provider, no billing
 *  entry: nothing custodies an id no family declares). */
export function describeAgentRuntimeRef(model: string | undefined): AgentRuntimeRef {
  const canonical = normalizeModelStringForAPI(model ?? '').trim()
  const verdict = classifyModelRoute(model)
  if (verdict.kind !== 'route') {
    return {
      contractVersion: APEX_BACKEND_CONTRACT_VERSION,
      route: verdict.kind,
      canonicalModel: canonical,
      family: { kind: 'unknown' },
    }
  }
  const route = verdict.route
  const backend = BACKENDS[route]
  let family: AgentRuntimeRef['family']
  if (route === 'openai') {
    const parsed = parseGptModelId(canonical)
    family = parsed
      ? { kind: 'gpt', major: parsed.major, minor: parsed.minor, variant: parsed.variant }
      : { kind: 'unknown' }
  } else if (route === 'zai') {
    family = { kind: 'glm' }
  } else if (route === 'moonshot') {
    family = { kind: 'kimi' }
  } else if (route === 'deepseek') {
    family = { kind: 'deepseek' }
  } else if (route === 'openai-compat') {
    family = { kind: 'compat' }
  } else if (route === 'openrouter') {
    // A carrier id carries the VENDOR's identity: openrouter/anthropic/…
    // is an OpenRouter row, never the claude family.
    family = { kind: 'openrouter' }
  } else if (route === 'gemini') {
    family = { kind: 'gemini' }
  } else if (route === 'huggingface') {
    family = { kind: 'huggingface' }
  } else if (route === 'local') {
    family = { kind: 'local' }
  } else {
    family = canonical.toLowerCase().includes('claude') ? { kind: 'claude' } : { kind: 'unknown' }
  }
  // The billing entry (stage 8): each provider's active wallet entry, for
  // every family the wallet custodies. Read failures leave the ref
  // entry-less rather than failing the mint (the ref is a description,
  // not a gate).
  let walletEntryId: string | undefined
  try {
    if (route === 'openai' || route === 'anthropic' || route === 'openrouter' || route === 'gemini') {
      walletEntryId = activeWalletEntry(route)?.id
    }
  } catch {
    walletEntryId = undefined
  }
  return {
    contractVersion: APEX_BACKEND_CONTRACT_VERSION,
    backend: backend.id,
    provider: backend.provider,
    route,
    canonicalModel: canonical,
    family,
    ...(walletEntryId !== undefined ? { walletEntryId } : {}),
  }
}
