import { getWorkload } from '../utils/workloadContext.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { logForDebugging } from '../utils/debug.js'
import { getAnthropicClientContractVersion } from './oauth.js'

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

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  if (options?.isNonInteractive) {
    return options.hasAppendSystemPrompt ? PRESET_PREFIX : AGENT_PREFIX
  }
  return DEFAULT_PREFIX
}

const ATTESTATION_PLACEHOLDER = ''

export function getAttributionHeader(fingerprint: string): string {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('mercury_attribution_header', true)) return ''
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
