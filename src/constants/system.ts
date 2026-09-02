// ============================================================================
//  src/constants/system.ts — the system-prompt prefix vocabulary (Mercury
//  identity strings) and the billing attribution header.
// ============================================================================
import { getWorkload } from '../utils/workloadContext.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { logForDebugging } from '../utils/debug.js'
import { getAnthropicClientContractVersion } from './oauth.js'

// The three Mercury identity prefixes. Exported as a readonly SET so a
// prefix-splitting consumer identifies a prefix block by CONTENT rather
// than position.
const DEFAULT_PREFIX =
  'You are Mercury, a private source-built terminal coding harness, working interactively with its operator.'
const PRESET_PREFIX =
  'You are Mercury, a private source-built terminal coding harness, operating through the Agent SDK.'
const AGENT_PREFIX = 'You are a Mercury agent.'

export type CLISyspromptPrefix =
  | typeof DEFAULT_PREFIX
  | typeof PRESET_PREFIX
  | typeof AGENT_PREFIX

export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set([
  DEFAULT_PREFIX,
  PRESET_PREFIX,
  AGENT_PREFIX,
])

/**
 * Prefix selection: a non-interactive session gets the preset prefix when
 * an appended system prompt was supplied and the bare agent prefix
 * otherwise; interactive sessions get the default. The identity hardcodes
 * no model version — the env block's model-derived sentence is the single
 * source of model identity, so each session self-reports its actual model.
 */
export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  if (options?.isNonInteractive) {
    return options.hasAppendSystemPrompt ? PRESET_PREFIX : AGENT_PREFIX
  }
  return DEFAULT_PREFIX
}

/**
 * The attestation placeholder: a fixed-width zero run a native HTTP layer
 * overwrites in the serialized body (same-length replacement, so the
 * content length never changes). Empty in this build — the native-overwrite
 * mechanism is inert (recorded, not restored).
 */
const ATTESTATION_PLACEHOLDER = ''

/**
 * The billing attribution header — ONE complete header line, name and value
 * separated by a colon and a space. Enabled by default; disabled only by the
 * `mercury_attribution_header` flag (default true — in this build the flag
 * resolves to its default; no env kill). Disabled → the empty string. The
 * server tolerates unknown extra fields, so older deployments ignore the
 * workload pair.
 */
export function getAttributionHeader(fingerprint: string): string {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('mercury_attribution_header', true)) return ''
  // cc_version is the client-contract version the first-party door's model
  // gate reads (constants/oauth.ts carries the why; the operator's
  // MERCURY_ANTHROPIC_CLIENT_CONTRACT wins over the constant) — never the
  // product version, which sits below that gate's floors and is refused.
  const version = getAnthropicClientContractVersion()
  const entrypoint = process.env.MERCURY_ENTRYPOINT || 'unknown'
  const workload = getWorkload()
  const value = `cc_version=${version}.${fingerprint};cc_entrypoint=${entrypoint};${ATTESTATION_PLACEHOLDER}${
    workload ? ` cc_workload=${workload};` : ''
  }`
  const header = `x-anthropic-billing-header: ${value}`
  logForDebugging(`attribution header: ${header}`)
  return header
}
