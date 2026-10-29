import { flagEnv } from '../../substrate/flagRegistry.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { classifyModelRoute, type CallModelRoute } from './idSpaces.js'
import { OPENAI_FIRST_PARTY_PROBE_KEY, openaiGatewayProbeKey, readGatewayProbeVerdict } from './deferralProbe.js'
import { kimiSupportsDynamicToolLoading } from './moonshot/kimiPins.js'
import { parseGptModelId } from './openai/gptPins.js'
import { deepseekCurrentModelId } from './deepseek/deepseekPins.js'

export type DeferralWireForm =
  | 'block'
  | 'text'
  | 'openai-native'
  | 'text-append'
  | 'openrouter-native'

export type DeferralWireCapability = DeferralWireForm | 'gateway-evidence'

export const DEFERRAL_WIRE_CAPABILITY: Readonly<Record<CallModelRoute, DeferralWireCapability>> = {
  anthropic: 'gateway-evidence',
  openai: 'openai-native',
  zai: 'text',
  moonshot: 'text-append',
  deepseek: 'text-append',
  xai: 'text',
  meta: 'text',
  'openai-compat': 'text',
  openrouter: 'openrouter-native',
  gemini: 'text',
  huggingface: 'text',
  local: 'text-append',
  mistral: 'text',
  nous: 'text',
  zen: 'text',
  minimax: 'text',
  together: 'text',
  cohere: 'text',
  groq: 'text',
  melious: 'text',
  orcarouter: 'text',
  cerebras: 'text',
  fireworks: 'text',
  qwen: 'text',
}

export interface DeferralWireReads {
  firstPartyBaseUrl?: () => boolean
  env?: Record<string, string | undefined>
  probeVerdict?: (host: string) => DeferralWireForm | undefined
}

export interface DeferralWireVerdict {
  form: DeferralWireForm
  why:
    | 'first-party-contract'
    | 'route-table'
    | 'gateway-asserted'
    | 'gateway-probed-block'
    | 'gateway-probed-text'
    | 'gateway-unprobed'
    | 'model-without-dynamic-tools'
    | 'no-route'
    | 'model-below-native-floor'
    | 'gateway-probed-native'
    | 'first-party-refused'
    | 'self-hosted-engine'
}

export function gatewayHost(env: Record<string, string | undefined> = process.env): string | null {
  const baseUrl = env.ANTHROPIC_BASE_URL
  if (!baseUrl) return null
  try {
    const host = new URL(baseUrl).host
    return host === 'api.anthropic.com' ? null : host
  } catch {
    return null
  }
}

export function homeLaneWireForm(reads: DeferralWireReads = {}): DeferralWireVerdict {
  const env = reads.env ?? process.env
  const firstParty = reads.firstPartyBaseUrl ? reads.firstPartyBaseUrl() : isFirstPartyAnthropicBaseUrl()
  if (firstParty) return { form: 'block', why: 'first-party-contract' }
  const asserted = env.MERCURY_TOOL_SEARCH
  if (asserted !== undefined && asserted !== '') return { form: 'block', why: 'gateway-asserted' }
  const host = gatewayHost(env)
  if (host === null) return { form: 'text', why: 'gateway-unprobed' }
  const verdict = reads.probeVerdict ? reads.probeVerdict(host) : readGatewayProbeVerdict(host)
  if (verdict === 'block') return { form: 'block', why: 'gateway-probed-block' }
  if (verdict === 'text') return { form: 'text', why: 'gateway-probed-text' }
  return { form: 'text', why: 'gateway-unprobed' }
}

export function deferralWireFormFor(model: string, reads: DeferralWireReads = {}): DeferralWireVerdict {
  const verdict = classifyModelRoute(model, reads.env)
  if (verdict.kind === 'absence') return { form: 'text', why: 'no-route' }
  if (verdict.kind === 'unrecognised') return homeLaneWireForm(reads)
  const capability = DEFERRAL_WIRE_CAPABILITY[verdict.route]
  if (capability === 'gateway-evidence') return homeLaneWireForm(reads)
  if (capability === 'openai-native') return openaiLaneWireForm(model, reads)
  if (capability === 'text-append' && !textAppendAccepted(verdict.route, model)) {
    return { form: 'text', why: 'model-without-dynamic-tools' }
  }
  if (verdict.route === 'openai-compat' && compatEndpointIsSelfHosted(model, reads.env)) return { form: 'text-append', why: 'self-hosted-engine' }
  return { form: capability, why: 'route-table' }
}

function textAppendAccepted(route: CallModelRoute, model: string): boolean {
  if (route === 'deepseek') return deepseekCurrentModelId(model.trim().toLowerCase()) === 'deepseek-flash'
  return route === 'moonshot' ? kimiSupportsDynamicToolLoading(model) : true
}

const SELF_HOSTED_DIALECTS: ReadonlySet<string> = new Set(['vllm', 'sglang', 'llamacpp', 'ollama', 'lmstudio'])

function compatEndpointIsSelfHosted(model: string, env?: Record<string, string | undefined>): boolean {
  try {
    const { compatModelEndpoint } = require('./openaicompat/compatAccounts.js') as typeof import('./openaicompat/compatAccounts.js')
    const endpoint = compatModelEndpoint(model, env as NodeJS.ProcessEnv | undefined)?.endpoint
    return endpoint !== undefined && (endpoint.hostPodId !== undefined || (endpoint.dialect !== undefined && SELF_HOSTED_DIALECTS.has(endpoint.dialect)))
  } catch {
    return false
  }
}

export const OPENAI_NATIVE_DEFERRAL_FLOOR = { major: 5, minor: 4 } as const

export const OPENAI_FIRST_PARTY_HOSTS: ReadonlySet<string> = new Set(['api.openai.com', 'chatgpt.com'])

const OPENAI_BASE_ENV_KEYS = ['MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE'] as const

export function gptModelCarriesNativeDeferral(model: string): boolean {
  const identity = parseGptModelId(model)
  if (identity === undefined) return false
  if (identity.major !== OPENAI_NATIVE_DEFERRAL_FLOOR.major) return identity.major > OPENAI_NATIVE_DEFERRAL_FLOOR.major
  return identity.minor >= OPENAI_NATIVE_DEFERRAL_FLOOR.minor
}

export function openaiGatewayHost(env: Record<string, string | undefined> = process.env): { firstParty: true } | { firstParty: false; host: string | null } {
  for (const key of OPENAI_BASE_ENV_KEYS) {
    const baseUrl = env[key]?.trim()
    if (!baseUrl) continue
    try {
      const host = new URL(baseUrl).host
      if (!OPENAI_FIRST_PARTY_HOSTS.has(host)) return { firstParty: false, host }
    } catch {
      return { firstParty: false, host: null }
    }
  }
  return { firstParty: true }
}

export function openaiLaneWireForm(model: string, reads: DeferralWireReads = {}): DeferralWireVerdict {
  const env = reads.env ?? process.env
  if (!gptModelCarriesNativeDeferral(model)) return { form: 'text', why: 'model-below-native-floor' }
  const endpoint = openaiGatewayHost(env)
  const verdictOf = (key: string): DeferralWireForm | undefined => (reads.probeVerdict ? reads.probeVerdict(key) : readGatewayProbeVerdict(key))
  if (endpoint.firstParty) {
    if (verdictOf(OPENAI_FIRST_PARTY_PROBE_KEY) === 'text') return { form: 'text', why: 'first-party-refused' }
    return { form: 'openai-native', why: 'first-party-contract' }
  }
  if (endpoint.host === null) return { form: 'text', why: 'gateway-unprobed' }
  const verdict = verdictOf(openaiGatewayProbeKey(endpoint.host))
  if (verdict === 'openai-native') return { form: 'openai-native', why: 'gateway-probed-native' }
  if (verdict === 'text') return { form: 'text', why: 'gateway-probed-text' }
  return { form: 'text', why: 'gateway-unprobed' }
}

export function toolReferenceWireAccepted(reads: DeferralWireReads = {}): boolean {
  return homeLaneWireForm(reads).form === 'block'
}

export function gatewayProbeAllowedByFlag(): boolean {
  return flagEnv('MERCURY_TOOL_DEFER_PROBE') === '1'
}

const SERVER_SEARCH_FORMS: ReadonlySet<DeferralWireForm> = new Set<DeferralWireForm>(['openai-native', 'openrouter-native'])

export function deferralSearchIsServerSide(form: DeferralWireForm): boolean {
  return SERVER_SEARCH_FORMS.has(form)
}

export function supportsToolDeferral(model: string, form: DeferralWireForm = deferralWireFormFor(model).form): boolean {
  if (form !== 'text') return true
  const verdict = classifyModelRoute(model)
  return verdict.kind === 'route' && verdict.route !== 'anthropic'
}
