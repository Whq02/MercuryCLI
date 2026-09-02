// ============================================================================
//  providers/deferralWire — the per-route WIRE FORM of tool deferral: one
//  capability table and one selection owner, never a per-call guess.
//
//  Deferral itself is Mercury's own context-assembly decision (the payload
//  plan lives in ./toolEconomy.ts and applies on EVERY route). This leaf
//  answers only HOW a route carries it:
//
//    'block' — the Anthropic beta form: defer_loading on the schema, the
//              advanced-tool-use header, tool_reference blocks the server
//              expands into the tool's schema. Declared by contract for the
//              first-party host.
//    'text'  — the client-side form every wire understands: a deferred
//              schema is simply absent from the tools term, the name-only
//              announcement rides as text, and an admission record renders
//              as text while the admitted schema rides the next request's
//              tool list. Nothing in it can draw a 400.
//
//  A gateway in front of Anthropic (ANTHROPIC_BASE_URL off the first-party
//  host) is decided by EVIDENCE, never assumption (the study's open question
//  3): an explicit MERCURY_TOOL_SEARCH value is the operator's own assertion
//  that the gateway passes the beta form through; otherwise the durable
//  probe verdict (./deferralProbe.ts, armed by MERCURY_TOOL_DEFER_PROBE=1)
//  decides; an unprobed gateway reads 'text' — the form that cannot fail
//  and already carries the whole economy — until a probe has spoken.
//
//  Dependency-light by design (the id-space leaf, the base-URL predicate,
//  the flag registry, the probe store): toolSearch.ts, capabilities.ts and
//  api.ts all read this module, so it must never import them back.
// ============================================================================
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { classifyModelRoute, type CallModelRoute } from './idSpaces.js'
import { readGatewayProbeVerdict } from './deferralProbe.js'

export type DeferralWireForm = 'block' | 'text'

/** What a route's wire can carry: a fixed form, or a gateway decided by evidence. */
export type DeferralWireCapability = DeferralWireForm | 'gateway-evidence'

/**
 * THE TABLE. Every declared route names its capability here; a new family
 * is one data row. The home lane is the only route whose form depends on
 * the endpoint: first-party is 'block' by contract, a gateway is decided by
 * evidence (see deferralWireFormFor).
 */
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

/** Injectable reads for provers; production callers pass nothing. */
export interface DeferralWireReads {
  firstPartyBaseUrl?: () => boolean
  env?: Record<string, string | undefined>
  /** The durable probe verdict for a gateway host (undefined = unprobed). */
  probeVerdict?: (host: string) => DeferralWireForm | undefined
}

export interface DeferralWireVerdict {
  form: DeferralWireForm
  /** The one-line reason surfaces and receipts print. */
  why:
    | 'first-party-contract'
    | 'route-table'
    | 'gateway-asserted'
    | 'gateway-probed-block'
    | 'gateway-probed-text'
    | 'gateway-unprobed'
    | 'no-route'
}

/** The gateway host of the home lane's base URL, or null on first-party /
 *  unparseable (an unparseable base URL is a gateway with no host to key a
 *  verdict on — it reads text). */
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

/** The home lane's form on the CURRENT endpoint — the gateway evidence ladder. */
export function homeLaneWireForm(reads: DeferralWireReads = {}): DeferralWireVerdict {
  const env = reads.env ?? process.env
  const firstParty = reads.firstPartyBaseUrl ? reads.firstPartyBaseUrl() : isFirstPartyAnthropicBaseUrl()
  if (firstParty) return { form: 'block', why: 'first-party-contract' }
  // The registered MERCURY_TOOL_SEARCH row: an explicit non-empty value is
  // the operator asserting the gateway passes the beta form through.
  const asserted = env.MERCURY_TOOL_SEARCH
  if (asserted !== undefined && asserted !== '') return { form: 'block', why: 'gateway-asserted' }
  const host = gatewayHost(env)
  if (host === null) return { form: 'text', why: 'gateway-unprobed' }
  const verdict = reads.probeVerdict ? reads.probeVerdict(host) : readGatewayProbeVerdict(host)
  if (verdict === 'block') return { form: 'block', why: 'gateway-probed-block' }
  if (verdict === 'text') return { form: 'text', why: 'gateway-probed-text' }
  return { form: 'text', why: 'gateway-unprobed' }
}

/**
 * The wire form for a request to `model`. A declared route reads the table;
 * an unrecognised id rides the home transport (the gateway world is the
 * only world it runs) and reads the home lane's evidence; absence has no
 * wire and reads text.
 */
export function deferralWireFormFor(model: string, reads: DeferralWireReads = {}): DeferralWireVerdict {
  const verdict = classifyModelRoute(model, reads.env)
  if (verdict.kind === 'absence') return { form: 'text', why: 'no-route' }
  if (verdict.kind === 'unrecognised') return homeLaneWireForm(reads)
  const capability = DEFERRAL_WIRE_CAPABILITY[verdict.route]
  if (capability === 'gateway-evidence') return homeLaneWireForm(reads)
  return { form: capability, why: 'route-table' }
}

/**
 * May the home lane's request carry the beta form right now — defer_loading
 * on schemas, the advanced-tool-use header, tool_reference blocks? The
 * api.ts strip choke point and the Anthropic lane's header emission read
 * THIS, so a text-form gateway never sees a field it would 400.
 */
export function toolReferenceWireAccepted(reads: DeferralWireReads = {}): boolean {
  return homeLaneWireForm(reads).form === 'block'
}

/** The registered MERCURY_TOOL_DEFER_PROBE gate: '1' arms the probe; unset
 *  (or anything else) never probes. */
export function gatewayProbeAllowedByFlag(): boolean {
  return flagEnv('MERCURY_TOOL_DEFER_PROBE') === '1'
}
