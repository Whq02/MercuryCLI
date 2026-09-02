import { getSubscriptionType } from '../utils/auth.js'
import { formatResetTime } from '../utils/format.js'
import { getMarketingNameForModel } from '../utils/model/model.js'
import type { ClaudeAILimits, RateLimitType } from './claudeAiLimits.js'

/**
 * The single source of rate-limit user-facing message text and its
 * severity classification. No other surface may string-match limits state.
 *
 * THE FRAME (operator-ruled): a provider's usage/overage/limit state
 * reaches the screen in MERCURY'S one-line voice with the provider named —
 * "Anthropic says this account's … " — never as an unattributed voice-of-god
 * line. The wire spellings these lines are born from (the
 * anthropic-ratelimit-unified-* header states) stay byte-identical on the
 * wire side; only the operator-facing frame speaks here.
 *
 * THE HONESTY ORDER for a limit that is reached: name the POOL that is dry
 * and the MODEL that hit it, then the in-family fix. A refusal that names
 * neither pool nor model sends the operator hunting for which window closed;
 * a refusal that jumps straight to another provider spends money the account
 * did not need to spend. The account remedy and cross-provider steering
 * belong AFTER all of that, and live on the row's own surface
 * (components/messages/RateLimitMessage). Every slash name this owner
 * utters is a registered command.
 *
 * This owner speaks for the Claude account's windows — the pools the
 * anthropic-ratelimit headers report. Other provider families refuse on
 * their own runtimes and name themselves there.
 *
 * The classification invariant: every ERROR-severity message this module
 * can produce is classified true by its own predicate. The set is
 * deliberately NOT total over the module's output — the approaching-a-limit
 * warning family and the degraded overage notice are unclassified, because
 * they surface in the footer and the transient channel, never as assistant
 * text. Do not widen the partition.
 */

/** The inline separator every further clause joins with. */
const SEPARATOR = ' · '

export const RATE_LIMIT_ERROR_PREFIXES = [
  // The live emitter's frames (Mercury's voice, the provider attributed).
  "Anthropic says this account's",
  'Anthropic says this account has used',
  'Anthropic says this account is now using extra usage · ',
  'Anthropic says this account is close to its extra usage',
  // Frames persisted transcripts carry from earlier emitter eras —
  // recognised forever so old sessions keep their rate-limit row rendering
  // (the startsWithApiErrorPrefix dual-spelling law).
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

/** Weekly-window substitution: for pro/enterprise the Sonnet window IS the weekly window. */
function sonnetWindowName(): string {
  const subscription = getSubscriptionType()
  return subscription === 'pro' || subscription === 'enterprise' ? 'weekly limit' : 'Sonnet limit'
}

/** The error-path limit name for a claim type. */
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

/**
 * The early-warning limit name. The `seven_day_fable` switch arm assigning
 * the Fable label immediately is a prover-pinned control-flow shape.
 */
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

/** The window word for a claim — the early-warning naming exported for the
 *  provider-breadth warning owner (services/providers/limitWarning), so the
 *  pro/enterprise sonnet-week substitution keeps ONE spelling. */
export function rateLimitWindowName(claim: RateLimitType): string {
  return earlyWarningName(claim)
}

/** D6: the warning-only plan clause, or nothing. A usage window on a
 *  personal plan is the model provider's plan limit — Mercury does not gate
 *  usage — so the clause names where the plan is raised, never a slash
 *  command. */
function warningUpsell(claim: RateLimitType | undefined): string | null {
  if (claim !== 'five_hour') return null
  const subscription = getSubscriptionType()
  return subscription === 'pro' || subscription === 'max'
    ? 'raise your Claude plan limits at claude.ai'
    : null
}

/**
 * The model that hit the wall, named the way the operator names it. A refusal
 * reads as a mystery without it: "Fable limit" only means something once you
 * know this session runs Fable. Empty for a caller with no model in hand, and
 * for a registry that cannot resolve the id it falls back to the id itself.
 */
function onModelClause(model: string): string {
  if (typeof model !== 'string' || model.length === 0) return ''
  let marketing: string | null = null
  try {
    marketing = getMarketingNameForModel(model)
  } catch {
    /* an unbootable registry still leaves the raw id, which is the truth */
  }
  return ` on ${marketing !== null && marketing.length > 0 ? marketing : model}`
}

/**
 * The IN-FAMILY fix, ahead of any plan or provider move. The per-model weekly
 * windows are separate pools, so a dry Opus/Sonnet/Fable pool leaves the other
 * two spendable — one /model switch and the work continues on the same
 * account. Deliberately silent for the session (5h) and overall weekly
 * windows: those are shared across models, and "switch models" there would
 * send the operator somewhere just as dry.
 */
function inFamilyClause(claim: RateLimitType | undefined): string | null {
  if (claim === 'seven_day_opus' || claim === 'seven_day_sonnet' || claim === 'seven_day_fable') {
    return 'the other Claude model pools are separate — /model switches inside this account'
  }
  return null
}

/** D3: the limit-reached (error) text — pool, model, reset, then the fix. */
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
    // The pool still gets named here: a rejected overage sits ON TOP of a
    // window that closed, and a pool-less "limit is reached" names neither.
    return `Anthropic says this account's ${limitReachedName(limits.rateLimitType)} is reached${onModel}${resetClause}${fixes}`
  }
  const name = limitReachedName(limits.rateLimitType)
  const resetClause =
    limits.resetsAt !== undefined ? `${SEPARATOR}resets ${formatResetTime(limits.resetsAt)}` : ''
  return `Anthropic says this account's ${name} is reached${onModel}${resetClause}${fixes}`
}

/** D4: the early-warning (warning) text, or nothing without a claim. */
function earlyWarningMessage(limits: ClaudeAILimits): string | null {
  const claim = limits.rateLimitType
  if (claim === undefined) return null
  const name = earlyWarningName(claim)
  const upsell = warningUpsell(claim)
  const upsellClause = upsell !== null ? `${SEPARATOR}${upsell}` : ''
  const resetClause =
    limits.resetsAt ? `${SEPARATOR}resets ${formatResetTime(limits.resetsAt)}` : ''
  const percentage = limits.utilization !== undefined ? Math.floor(limits.utilization * 100) : 0
  // Faithful truthiness gate: a floored percentage of 0 falls through to
  // the approaching wording.
  if (percentage && limits.resetsAt) {
    return `Anthropic says this account has used ${percentage}% of its ${name}${resetClause}${upsellClause}`
  }
  if (percentage) {
    return `Anthropic says this account has used ${percentage}% of its ${name}${upsellClause}`
  }
  // In this branch only, the overage claim regains its noun.
  const approachName = claim === 'overage' ? 'extra usage limit' : name
  return `Anthropic says this account is approaching its ${approachName}${resetClause}${upsellClause}`
}

/**
 * D5: the overage-transition notice. The `seven_day_fable` if-chain arm
 * assigning the Fable label is a prover-pinned control-flow shape. The
 * degraded (unnameable-claim) variant is a different string that the D1
 * prefix set deliberately does not match.
 */
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

/** D2: the message decision for a limits record plus the (inert) model. */
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

/** Errors only — the API error path surfaces these as assistant messages. */
export function getRateLimitErrorMessage(limits: ClaudeAILimits, model: string): string | null {
  const result = getRateLimitMessage(limits, model)
  return result !== null && result.severity === 'error' ? result.message : null
}

// ── the wall row's remedy appendix, composed at CREATION ────────────────────
//  A transcript row is a record of what was true when it printed. These
//  remedy lines used to be recomputed in the row's RENDER body from live
//  slot, account and lane state, so a slot flip REWROTE settled history —
//  the historical wall row advertised the just-exhausted slot as having
//  headroom, the subscriber upsell line vanished as the seat changed, and a
//  resumed session recomputed a week-old row from today's state (FN-016
//  R9). The remedies now ride the message text itself, composed once where
//  the row is created (the API-error mint — the OpenAI lane's own pattern:
//  openaiCallModel bakes its slot appendix into the wall sentence).

export type UpsellMessageParams = {
  shouldShowUpsell: boolean
}

/** The pure account-remedy decision table (contract data: the command name).
 *  Every slash name it utters is a registered command. */
export function getUpsellMessage(params: UpsellMessageParams): string | null {
  if (!params.shouldShowUpsell) return null
  return 'Switch accounts with /logins to keep working past this window.'
}

/** Injectable reads so the provers drive every remedy arm; the live
 *  defaults read the owning stores (late requires — the slot and lane
 *  owners sit above this module in the import graph). */
export interface WallRemedyReads {
  /** The within-family slot remedy — slotWallAppendix('anthropic'). */
  slotAppendix?: () => string
  /** The account-remedy eligibility: a subscription seat, or the
   *  limit-mocking seam (how the table is exercised without a real wall). */
  upsellEligible?: () => boolean
  /** The readiest usable OTHER-family lane, display-named — null when none. */
  laneTarget?: () => { route: string; name: string } | null
}

/** The remedy block the wall row carries: '' when there is nothing to say,
 *  else a newline-led block, one remedy per line, in the honesty order —
 *  the in-family slot fix first, the account remedy second, the other
 *  provider LAST. The renderer paints these lines dim behind the refusal
 *  head and never recomputes them. */
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
  const laneRemedy = ((): string | null => {
    try {
      const pick = (
        reads?.laneTarget ??
        ((): { route: string; name: string } | null => {
          const { liveCapFailoverTarget } = require('./capFailover.js') as typeof import('./capFailover.js')
          const { providerDisplayName } = require('./providers/routeLaw.js') as typeof import('./providers/routeLaw.js')
          const target = liveCapFailoverTarget()
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
  })()
  const lines = [slotRemedy, upsell, laneRemedy].filter((line): line is string => line !== null)
  return lines.length === 0 ? '' : `\n${lines.join('\n')}`
}

/** Warnings only — the input-area footer. */
export function getRateLimitWarning(limits: ClaudeAILimits, model: string): string | null {
  const result = getRateLimitMessage(limits, model)
  return result !== null && result.severity === 'warning' ? result.message : null
}
