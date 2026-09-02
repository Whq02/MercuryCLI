import type { LocalCommandResult } from '../../types/command.js'
import { extractQuotaStatusFromHeaders } from '../../services/claudeAiLimits.js'
import {
  getMockStatus,
  getScenarioDescription,
  setMockEarlyWarning,
  setMockRateLimitScenario,
  type MockScenario,
} from '../../services/mockRateLimits.js'

// The scenarios the journey seam sanctions from the command surface — the
// full MockScenario union, spelled once so the help text and the validator
// cannot drift. STATE KEYS, not operator prose: each id selects a mocked
// anthropic-ratelimit header shape in mockRateLimits (spellings like
// 'overage-active'/'extra-usage-required' stay byte-identical to that union).
const SCENARIOS: readonly MockScenario[] = [
  'normal',
  'session-limit-reached',
  'approaching-weekly-limit',
  'weekly-limit-reached',
  'overage-active',
  'overage-warning',
  'overage-exhausted',
  'out-of-credits',
  'org-zero-credit-limit',
  'org-spend-cap-hit',
  'member-zero-credit-limit',
  'seat-tier-zero-credit-limit',
  'opus-limit',
  'opus-warning',
  'sonnet-limit',
  'sonnet-warning',
  'extra-usage-required',
  'clear',
]

// Early-warning journey aliases: the real warning vocabulary is the
// surpassed-threshold headers (a bare allowed_warning status demotes in
// computeNewLimitsFromHeaders), so the warning legs speak it via the seam's
// early-warning setter.
const WARNING_ALIASES: Record<string, '5h' | '7d'> = {
  'warning-5h': '5h',
  'warning-7d': '7d',
}

export async function call(args: string): Promise<LocalCommandResult> {
  const scenario = args.trim()
  if (!scenario) {
    const lines = SCENARIOS.map(s => `  ${s} — ${getScenarioDescription(s)}`)
    const warnLines = Object.keys(WARNING_ALIASES).map(
      a => `  ${a} — early-warning threshold surpassed (${WARNING_ALIASES[a]} window, 92%)`,
    )
    return {
      type: 'text',
      value: `Usage: /mock-limits <scenario>\n\n${lines.join('\n')}\n${warnLines.join('\n')}\n\n${getMockStatus()}`,
    }
  }
  if (WARNING_ALIASES[scenario]) {
    setMockRateLimitScenario('clear')
    setMockEarlyWarning(WARNING_ALIASES[scenario], 0.92)
    extractQuotaStatusFromHeaders(new globalThis.Headers())
    return {
      type: 'text',
      value: `Mock rate-limit scenario: ${scenario} — early warning (${WARNING_ALIASES[scenario]} window at 92%)\n${getMockStatus()}`,
    }
  }
  if (!(SCENARIOS as readonly string[]).includes(scenario)) {
    return {
      type: 'text',
      value: `Unknown scenario '${scenario}'. Run /mock-limits with no argument for the list.`,
    }
  }
  setMockRateLimitScenario(scenario as MockScenario)
  // Propagate through the REAL ingestion path: processRateLimitHeaders
  // overlays the mock headers onto this (empty) response, computes the new
  // limits, and emits the status change every live consumer subscribes to.
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  extractQuotaStatusFromHeaders(new globalThis.Headers())
  return {
    type: 'text',
    value: `Mock rate-limit scenario: ${scenario} — ${getScenarioDescription(scenario as MockScenario)}\n${getMockStatus()}`,
  }
}
