import { getSubscriptionType } from '../utils/auth.js'
import { formatResetTime } from '../utils/format.js'
import { getMarketingNameForModel } from './model/model.js'
import type { AnthropicLimits, RateLimitType } from './anthropicLimits.js'
import { usageWarningTier } from './providers/usageTiers.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


const SEPARATOR = ' · '

export function isRateLimitErrorMessage(text: string): boolean {
  return notBuilt('src/services/rateLimitMessages.ts:23')
}

type RateLimitMessage = Unbuilt

function sonnetWindowName(): string {
  const subscription = getSubscriptionType()
  return subscription === 'pro' || subscription === 'enterprise' ? 'weekly limit' : 'Sonnet limit'
}

function limitReachedName(claim: RateLimitType | undefined): string {
  return notBuilt('src/services/rateLimitMessages.ts:37')
}

function earlyWarningName(claim: RateLimitType): string {
  return notBuilt('src/services/rateLimitMessages.ts:54')
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
  } catch (error) {
    passedOver(error)
  }
  return ` on ${marketing !== null && marketing.length > 0 ? marketing : model}`
}

function inFamilyClause(claim: RateLimitType | undefined): string | null {
  return notBuilt('src/services/rateLimitMessages.ts:105')
}

function limitReachedMessage(limits: AnthropicLimits, model: string): string {
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

function earlyWarningMessage(limits: AnthropicLimits): string | null {
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

export function getUsingOverageText(limits: AnthropicLimits): string {
  return notBuilt('src/services/rateLimitMessages.ts:152')
}

export function getRateLimitMessage(limits: AnthropicLimits, model: string): RateLimitMessage | null {
  return notBuilt('src/services/rateLimitMessages.ts:176')
}

export function getRateLimitErrorMessage(limits: AnthropicLimits, model: string): string | null {
  return notBuilt('src/services/rateLimitMessages.ts:197')
}


type UpsellMessageParams = {
  shouldShowUpsell: boolean
}

export function getUpsellMessage(params: UpsellMessageParams): string | null {
  if (!params.shouldShowUpsell) return null
  return 'Switch accounts with /logins to keep working past this window.'
}

interface WallRemedyReads {
  slotAppendix?: () => string
  upsellEligible?: () => boolean
  laneTarget?: () => { route: string; name: string } | null
  carryWords?: () => string | undefined
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
    } catch (error) {
      passedOver(error)
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
    } catch (error) {
      passedOver(error)
      return null
    }
  })()
  const laneRemedy = crossFamilyLaneRemedy('anthropic', reads?.laneTarget)
  const carry = ((): string | null => {
    try {
      const words = reads?.carryWords?.()
      return words === undefined || words === '' ? null : words
    } catch (error) {
      passedOver(error)
      return null
    }
  })()
  const lines = [carry, slotRemedy, upsell, laneRemedy].filter((line): line is string => line !== null)
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
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function getRateLimitWarning(limits: AnthropicLimits, model: string): string | null {
  return notBuilt('src/services/rateLimitMessages.ts:290')
}
