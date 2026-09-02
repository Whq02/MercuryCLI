import type { NonNullableUsage } from '../entrypoints/sdk/coreTypes.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { shouldIncludeFirstPartyOnlyBetas } from './betas.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * Advisor (stronger-reviewer-model) capability gate, block typeguards,
 * usage extraction, and the advisor tool instruction text.
 *
 * Under Mercury the feature gate never fetches, so the advisor is off; the
 * shapes below are the wire contract for when it is enabled.
 */

/** Wire shape: the advisor invocation block. */
export type AdvisorServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input: unknown
}

/** Wire shape: the advisor result block. */
export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content:
    | { type: 'advisor_result'; text: string }
    | { type: 'advisor_redacted_result'; encrypted_content: string }
    | { type: 'advisor_tool_result_error'; error_code: string }
}

export type AdvisorBlock = AdvisorServerToolUseBlock | AdvisorToolResultBlock

export function isAdvisorBlock(param: { type: string; name?: string }): param is AdvisorBlock {
  return (
    param.type === 'advisor_tool_result' ||
    (param.type === 'server_tool_use' && param.name === 'advisor')
  )
}

type AdvisorGateConfig = {
  enabled?: boolean
  canUserConfigure?: boolean
  baseModel?: string
  advisorModel?: string
}

function getAdvisorConfig(): AdvisorGateConfig {
  return getFeatureValue_CACHED_MAY_BE_STALE<AdvisorGateConfig>('mercury_sage_compass', {})
}

/**
 * Both must hold: first-party-only betas are permitted (the advisor's beta
 * header is accepted only by the first-party API — the cloud gateway
 * providers answer it with HTTP 400) and the gate config enables it. No
 * env kill exists.
 */
export function isAdvisorEnabled(): boolean {
  if (!shouldIncludeFirstPartyOnlyBetas()) return false
  return Boolean(getAdvisorConfig().enabled)
}

export function canUserConfigureAdvisor(): boolean {
  return isAdvisorEnabled() && Boolean(getAdvisorConfig().canUserConfigure)
}

/**
 * The experiment's fixed model pair — only when the advisor is enabled, the
 * user may NOT configure it, and both models are present in the config.
 */
export function getExperimentAdvisorModels():
  | { baseModel: string; advisorModel: string }
  | undefined {
  if (!isAdvisorEnabled() || canUserConfigureAdvisor()) return undefined
  const { baseModel, advisorModel } = getAdvisorConfig()
  if (!baseModel || !advisorModel) return undefined
  return { baseModel, advisorModel }
}

/** The settings value, or undefined when the advisor is disabled. */
export function getInitialAdvisorSetting(): string | undefined {
  if (!isAdvisorEnabled()) return undefined
  return getInitialSettings().advisorModel
}

type AdvisorUsageIteration = Partial<NonNullableUsage> & {
  type?: string
  model?: string
}

/**
 * Extract per-iteration advisor usage rows from an API usage object. Each
 * `advisor_message` entry already holds the complete token-count fields for
 * its own iteration, so the filtered entries are returned as they are.
 */
export function getAdvisorUsage(usage: unknown): Array<NonNullableUsage & { model: string }> {
  const iterations = (usage as { iterations?: AdvisorUsageIteration[] } | null | undefined)
    ?.iterations
  if (!Array.isArray(iterations)) return []
  return iterations.filter(
    (entry): entry is NonNullableUsage & { model: string; type: string } =>
      entry != null && entry.type === 'advisor_message',
  )
}

/**
 * Model-facing instructions for the advisor tool, composed into the system
 * prompt when the capability is enabled.
 */
export const ADVISOR_TOOL_INSTRUCTIONS = `## Advisor tool

The advisor is a stronger reviewer model. Call it with no arguments: your whole conversation is forwarded automatically, so the reviewer already has the task statement, the tool calls you made, and the results you saw — nothing needs to be summarised for it.

When to call it:
- Before doing anything substantive. Locating and reading material to understand the problem does not count as substantive; producing or changing artifacts, or stating a conclusion, does.
- When the work looks finished. Persist the result first (write the file, stage the change) — the call is slow, and a session that dies during it should not take an unsaved result with it.
- When you are stuck: the same failure keeps coming back, or the evidence gathered so far does not cohere.
- When you are contemplating a different approach.

Cadence: on work spanning more than a few steps, call it at least once before settling on an approach and once before declaring completion. On short reactive work where the next step follows directly from what you just read, further calls add little — most of the value lands on the first call, before the approach has hardened.

Weigh the answer seriously. Depart from it only when a suggested step empirically fails, or when primary-source evidence contradicts a specific claim. A self-test that passes does not refute the advice; it more likely means the test does not exercise what the advice is about.

If evidence you have already gathered points one way and the advice points another, do not silently pick one. Make one further call that states both and asks which consideration should decide — resolving the disagreement costs less than proceeding down the wrong path.
`

export { isValidAdvisorModel, modelSupportsAdvisor } from './model/capabilities.js'
