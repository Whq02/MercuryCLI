import { getSubscriptionType } from '../utils/auth.js'
import { formatResetTime } from '../utils/format.js'
import { getMarketingNameForModel } from '../utils/model/model.js'
import type { ClaudeAILimits, RateLimitType } from './claudeAiLimits.js'


const SEPARATOR = ' · '

export const RATE_LIMIT_ERROR_PREFIXES = [
  "Anthropic says this account's",
  'Anthropic says this account has used',
  'Anthropic says this account is now using extra usage · ',
  'Anthropic says this account is close to its extra usage',
  "You've reached your",
  "You've used",
  "You're now using extra usage · ",
  "You're close to your extra usage",
  "You've run out of extra usage",
] as const

export function isRateLimitErrorMessage(text: string): boolean {
  return RATE_LIMIT_ERROR_PREFIXES.some(prefix => text.startsWith(prefix))
}

export type RateLimitMessage = {
  message: string
  severity: 'error' | 'warning'
}

function sonnetWindowName(): string {
  const subscription = getSubscriptionType()
  return subscription === 'pro' || subscription === 'enterprise' ? 'weekly limit' : 'Sonnet limit'
}

function limitReachedName(claim: RateLimitType | undefined): string {
  switch (claim) {
    case 'seven_day_opus':
      return 'Opus limit'
    case 'seven_day_fable':
      return 'Fable limit'
    case 'seven_day':
      return 'weekly limit'
    case 'five_hour':
      return 'session limit'
    case 'seven_day_sonnet':
      return sonnetWindowName()
    default:
      return 'usage limit'
  }
}

function earlyWarningName(claim: RateLimitType): string {
  let limitName: string
  switch (claim) {
    case 'seven_day_fable':
      limitName = 'Fable limit'
      break
    case 'seven_day_opus':
      limitName = 'Opus limit'
      break
    case 'seven_day':
      limitName = 'weekly limit'
      break
    case 'five_hour':
      limitName = 'session limit'
      break
    case 'seven_day_sonnet':
      limitName = sonnetWindowName()
      break
    case 'overage':
      limitName = 'extra usage'
      break
    default:
      limitName = 'usage limit'
      break
  }
  return limitName
}

export function rateLimitWindowName(claim: RateLimitType): string {
  return earlyWarningName(claim)
}

function warningUpsell(claim: RateLimitType | undefined): string | null {
  if (claim !== 'five_hour') return null
  const subscription = getSubscriptionType()
  return subscription === 'pro' || subscription === 'max'
    ? 'raise your Claude plan limits at claude.ai'
    : null
}

function onModelClause(model: string): string {
  if (typeof model !== 'string' || model.length === 0) return ''
  let marketing: string | null = null
  try {
    marketing = getMarketingNameForModel(model)
  } catch {
  }
  return ` on ${marketing !== null && marketing.length > 0 ? marketing : model}`
}

function inFamilyClause(claim: RateLimitType | undefined): string | null {
  if (claim === 'seven_day_opus' || claim === 'seven_day_sonnet' || claim === 'seven_day_fable') {
    return 'the other Claude model pools are separate — /model switches inside this account'
  }
  return null
}

function limitReachedMessage(limits: ClaudeAILimits, model: string): string {
  const onModel = onModelClause(model)
  const inFamily = inFamilyClause(limits.rateLimitType)
  const fixes = inFamily !== null ? `${SEPARATOR}${inFamily}` : ''
  if (limits.overageStatus === 'rejected') {
    const candidates = [limits.resetsAt, limits.overageResetsAt].filter(
      (value): value is number => typeof value === 'number',
    )
    const earliest = candidates.length > 0 ? Math.min(...candidates) : undefined
    const resetClause = earliest !== undefined ? `${SEPARATOR}resets ${formatResetTime(earliest)}` : ''
    if (limits.overageDisabledReason === 'out_of_credits') {
      return `Anthropic says this account's extra usage is used up${onModel}${resetClause}${fixes}`
    }
    return `Anthropic says this account's ${limitReachedName(limits.rateLimitType)} is reached${onModel}${resetClause}${fixes}`
  }
  const name = limitReachedName(limits.rateLimitType)
  const resetClause =
    limits.resetsAt !== undefined ? `${SEPARATOR}resets ${formatResetTime(limits.resetsAt)}` : ''
  return `Anthropic says this account's ${name} is reached${onModel}${resetClause}${fixes}`
}

function earlyWarningMessage(limits: ClaudeAILimits): string | null {
  const claim = limits.rateLimitType
  if (claim === undefined) return null
  const name = earlyWarningName(claim)
  const upsell = warningUpsell(claim)
  const upsellClause = upsell !== null ? `${SEPARATOR}${upsell}` : ''
  const resetClause =
    limits.resetsAt ? `${SEPARATOR}resets ${formatResetTime(limits.resetsAt)}` : ''
  const percentage = limits.utilization !== undefined ? Math.floor(limits.utilization * 100) : 0
  if (percentage && limits.resetsAt) {
    return `Anthropic says this account has used ${percentage}% of its ${name}${resetClause}${upsellClause}`
  }
  if (percentage) {
    return `Anthropic says this account has used ${percentage}% of its ${name}${upsellClause}`
  }
  const approachName = claim === 'overage' ? 'extra usage limit' : name
  return `Anthropic says this account is approaching its ${approachName}${resetClause}${upsellClause}`
}

export function getUsingOverageText(limits: ClaudeAILimits): string {
  const rateLimitType = limits.rateLimitType
  let limitName: string | null = null
  if (rateLimitType === 'seven_day_fable') {
    limitName = 'Fable limit'
  } else if (rateLimitType === 'five_hour') {
    limitName = 'session limit'
  } else if (rateLimitType === 'seven_day') {
    limitName = 'weekly limit'
  } else if (rateLimitType === 'seven_day_opus') {
    limitName = 'Opus limit'
  } else if (rateLimitType === 'seven_day_sonnet') {
    limitName = sonnetWindowName()
  }
  if (limitName === null) {
    return 'Anthropic says this account is now using extra usage'
  }
  const resetClause =
    limits.resetsAt !== undefined
      ? `${SEPARATOR}its ${limitName} resets ${formatResetTime(limits.resetsAt)}`
      : `${SEPARATOR}its ${limitName} has been reached`
  return `Anthropic says this account is now using extra usage${resetClause}`
}

export function getRateLimitMessage(limits: ClaudeAILimits, model: string): RateLimitMessage | null {
  if (limits.isUsingOverage) {
    if (limits.overageStatus === 'allowed_warning') {
      return {
        message: 'Anthropic says this account is close to its extra usage spending limit',
        severity: 'warning',
      }
    }
    return null
  }
  if (limits.status === 'rejected') {
    return { message: limitReachedMessage(limits, model), severity: 'error' }
  }
  if (limits.status === 'allowed_warning') {
    if (limits.utilization !== undefined && limits.utilization < 0.7) return null
    const message = earlyWarningMessage(limits)
    return message !== null ? { message, severity: 'warning' } : null
  }
  return null
}

export function getRateLimitErrorMessage(limits: ClaudeAILimits, model: string): string | null {
  const result = getRateLimitMessage(limits, model)
  return result !== null && result.severity === 'error' ? result.message : null
}


export type UpsellMessageParams = {
  shouldShowUpsell: boolean
}

export function getUpsellMessage(params: UpsellMessageParams): string | null {
  if (!params.shouldShowUpsell) return null
  return 'Switch accounts with /logins to keep working past this window.'
}

export interface WallRemedyReads {
  slotAppendix?: () => string
  upsellEligible?: () => boolean
  laneTarget?: () => { route: string; name: string } | null
}

export function composeAnthropicWallRemedies(reads?: WallRemedyReads): string {
  const slotRemedy = ((): string | null => {
    try {
      const appendix = (
        reads?.slotAppendix ??
        ((): string => {
          const { slotWallAppendix } =
            require('./providers/slotSwitch.js') as typeof import('./providers/slotSwitch.js')
          return slotWallAppendix('anthropic')
        })
      )().trim()
      return appendix === '' ? null : appendix
    } catch {
      return null
    }
  })()
  const upsell = ((): string | null => {
    try {
      const eligible = (
        reads?.upsellEligible ??
        ((): boolean => {
          const { isClaudeAISubscriber } = require('../utils/auth.js') as typeof import('../utils/auth.js')
          const { getCurrentMockScenario } = require('./mockRateLimits.js') as typeof import('./mockRateLimits.js')
          return isClaudeAISubscriber() || getCurrentMockScenario() !== null
        })
      )()
      return getUpsellMessage({ shouldShowUpsell: eligible })
    } catch {
      return null
    }
  })()
  const laneRemedy = crossFamilyLaneRemedy('anthropic', reads?.laneTarget)
  const lines = [slotRemedy, upsell, laneRemedy].filter((line): line is string => line !== null)
  return lines.length === 0 ? '' : `\n${lines.join('\n')}`
}

export function crossFamilyLaneRemedy(
  home: string,
  laneTarget?: () => { route: string; name: string } | null,
): string | null {
  try {
    const pick = (
      laneTarget ??
      ((): { route: string; name: string } | null => {
        const { liveCapFailoverTarget } = require('./capFailover.js') as typeof import('./capFailover.js')
        const { providerDisplayName } = require('./providers/routeLaw.js') as typeof import('./providers/routeLaw.js')
        const target = liveCapFailoverTarget(home)
        return target === null ? null : { route: target.route, name: providerDisplayName(target.route) }
      })
    )()
    if (pick === null) return null
    return pick.route === 'local'
      ? `The ${pick.name} lane is usable now — /model moves there (your own server; no API billing, not this window).`
      : `The ${pick.name} lane is usable now — /model moves there (bills under your ${pick.name} account, not this window).`
  } catch {
    return null
  }
}

export function getRateLimitWarning(limits: ClaudeAILimits, model: string): string | null {
  const result = getRateLimitMessage(limits, model)
  return result !== null && result.severity === 'warning' ? result.message : null
}
