import { flagEnv } from '../../substrate/flagRegistry.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { classifyModelRoute, type CallModelRoute } from './idSpaces.js'
import { readGatewayProbeVerdict } from './deferralProbe.js'

export type DeferralWireForm = 'block' | 'text'

export type DeferralWireCapability = DeferralWireForm | 'gateway-evidence'

export const DEFERRAL_WIRE_CAPABILITY: Readonly<Record<CallModelRoute, DeferralWireCapability>> = {
  anthropic: 'gateway-evidence',
  openai: 'text',
  zai: 'text',
  moonshot: 'text',
  deepseek: 'text',
  'openai-compat': 'text',
  openrouter: 'text',
  gemini: 'text',
  huggingface: 'text',
  local: 'text',
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
    | 'no-route'
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
  return { form: capability, why: 'route-table' }
}

export function toolReferenceWireAccepted(reads: DeferralWireReads = {}): boolean {
  return homeLaneWireForm(reads).form === 'block'
}

export function gatewayProbeAllowedByFlag(): boolean {
  return flagEnv('MERCURY_TOOL_DEFER_PROBE') === '1'
}
