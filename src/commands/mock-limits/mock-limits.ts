import type { LocalCommandResult } from '../../types/command.js'
import { extractQuotaStatusFromHeaders } from '../../services/claudeAiLimits.js'
import {
  getMockStatus,
  getScenarioDescription,
  setMockUsagePercent,
  setMockRateLimitScenario,
  type MockScenario,
} from '../../services/mockRateLimits.js'

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

const WARNING_ALIASES: Record<string, '5h' | '7d'> = {
  'warning-5h': '5h',
  'warning-7d': '7d',
}

export async function call(args: string): Promise<LocalCommandResult> {
  const [scenario = '', percent, ...extra] = args.trim().split(/\s+/)
  if (!scenario) {
    const lines = SCENARIOS.map(s => `  ${s} — ${getScenarioDescription(s)}`)
    const warnLines = Object.keys(WARNING_ALIASES).map(
      a => `  ${a} [percent 0–100] — ${WARNING_ALIASES[a]} window; use 80 and 90 for the two warnings (default 92)`,
    )
    return {
      type: 'text',
      value: `Usage: /mock-limits <scenario>\n\n${lines.join('\n')}\n${warnLines.join('\n')}\n\n${getMockStatus()}`,
    }
  }
  if (WARNING_ALIASES[scenario]) {
    const pct = percent === undefined ? 92 : Number(percent)
    if (extra.length > 0 || (percent !== undefined && !/^\d{1,3}$/.test(percent)) || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      return { type: 'text', value: 'Usage: /mock-limits warning-5h|warning-7d [percent 0–100]' }
    }
    setMockUsagePercent(WARNING_ALIASES[scenario], pct)
    extractQuotaStatusFromHeaders(new globalThis.Headers())
    return {
      type: 'text',
      value: `Mock rate-limit scenario: ${scenario} — ${WARNING_ALIASES[scenario]} window at ${pct}%\n${getMockStatus()}`,
    }
  }
  if (percent !== undefined || !(SCENARIOS as readonly string[]).includes(scenario)) {
    return {
      type: 'text',
      value: `Unknown scenario '${scenario}'. Run /mock-limits with no argument for the list.`,
    }
  }
  setMockRateLimitScenario(scenario as MockScenario)
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  extractQuotaStatusFromHeaders(new globalThis.Headers())
  return {
    type: 'text',
    value: `Mock rate-limit scenario: ${scenario} — ${getScenarioDescription(scenario as MockScenario)}\n${getMockStatus()}`,
  }
}
