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
  | 'moonshot-chat'
  | 'deepseek-chat'
  | 'openai-compat-chat'
  | 'openrouter-chat'
  | 'gemini-generate'
  | 'huggingface-chat'
  | 'local-chat'

export interface AgentRuntimeRef {
  contractVersion: typeof APEX_BACKEND_CONTRACT_VERSION
  backend?: PrimaryBackendId
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
  route: CallModelRoute | 'unrecognised' | 'absence'
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
  callModel: typeof queryModelWithStreaming
  readiness(): BackendReadiness
}

function anthropicReadiness(): BackendReadiness {
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

export function resolvePrimaryAgentBackend(model: string | undefined): PrimaryAgentBackend | null {
  const verdict = classifyModelRoute(model)
  return verdict.kind === 'route' ? BACKENDS[verdict.route] : null
}

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
