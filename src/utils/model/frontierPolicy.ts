
import {
  getRateLimitTier,
  isClaudeAISubscriber,
  isMaxSubscriber,
} from '../auth.js'
import { is1mContextDisabled } from './capabilities.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'

import {
  getDefaultFableModel,
  getDefaultOpusModel,
  isDefaultFableNatively1M,
  isDefaultOpusNatively1M,
  isOpus1mMergeEnabled,
} from './model.js'

export const FRONTIER_MAX_20X_TIER = 'default_claude_max_20x'

export type FrontierEligibilityCode =
  | 'eligible-env-pin'
  | 'eligible-allowlist'
  | 'eligible-max-20x'
  | 'not-subscriber'
  | 'not-max'
  | 'unknown-rate-limit-tier'
  | 'not-20x'
  | 'allowlist-excluded'

export type FrontierCandidateVerdict = {
  id: string
  family: string
  rank: number
  eligible: boolean
  code: FrontierEligibilityCode
}

export type FrontierOperatorDecision = {
  setting: string
  source: 'frontier' | 'fallback'
  winner: FrontierCandidateVerdict | null
  candidates: FrontierCandidateVerdict[]
  code: FrontierEligibilityCode | 'no-registered-candidate'
}

export type FrontierFacts = {
  fableEnvPin: boolean
  fableId: string
  fableNatively1M?: boolean
  allowlistPresent: boolean
  allowlistNamesFable: boolean
  allowlistPermits: (id: string) => boolean
  claudeAiSubscriber: boolean
  maxSubscriber: boolean
  rateLimitTier: string | null
  oneMDisabled: boolean
  opusFallbackSetting: string
}

function evaluateFableCandidate(f: FrontierFacts): FrontierCandidateVerdict {
  const base = { id: f.fableId, family: 'fable', rank: 100 }
  const verdict = (
    eligible: boolean,
    code: FrontierEligibilityCode,
  ): FrontierCandidateVerdict => ({ ...base, eligible, code })

  if (f.allowlistPresent && !f.allowlistPermits(f.fableId)) {
    return verdict(false, 'allowlist-excluded')
  }
  if (f.fableEnvPin) {
    return verdict(true, 'eligible-env-pin')
  }
  if (f.allowlistNamesFable) {
    return verdict(true, 'eligible-allowlist')
  }
  if (!f.claudeAiSubscriber) {
    return verdict(false, 'not-subscriber')
  }
  if (!f.maxSubscriber) {
    return verdict(false, 'not-max')
  }
  if (f.rateLimitTier === null) {
    return verdict(false, 'unknown-rate-limit-tier')
  }
  if (f.rateLimitTier !== FRONTIER_MAX_20X_TIER) {
    return verdict(false, 'not-20x')
  }
  return verdict(true, 'eligible-max-20x')
}

function settingForWinner(
  f: FrontierFacts,
  winner: FrontierCandidateVerdict,
): string {
  if (winner.code === 'eligible-env-pin') {
    return winner.id
  }
  return f.oneMDisabled || f.fableNatively1M === true ? winner.id : winner.id + '[1m]'
}

export function evaluateFrontierDecision(
  facts: FrontierFacts,
): FrontierOperatorDecision {
  const candidates: FrontierCandidateVerdict[] = [evaluateFableCandidate(facts)]

  const winner = candidates.find(c => c.eligible) ?? null
  if (winner) {
    return {
      setting: settingForWinner(facts, winner),
      source: 'frontier',
      winner,
      candidates,
      code: winner.code,
    }
  }
  const diagnostic = candidates[0]
  return {
    setting: facts.opusFallbackSetting,
    source: 'fallback',
    winner: null,
    candidates,
    code: diagnostic?.code ?? 'no-registered-candidate',
  }
}

let resolvingFrontier = false

function allowedUnderAllowlist(id: string): boolean {
  if (resolvingFrontier) {
    return true
  }
  resolvingFrontier = true
  try {
    return isModelAllowed(id)
  } finally {
    resolvingFrontier = false
  }
}

export function gatherFrontierFacts(): FrontierFacts {
  const settings = getSettings_DEPRECATED() || {}
  const allowlist = settings.availableModels
  return {
    fableEnvPin: !!process.env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    fableId: getDefaultFableModel(),
    fableNatively1M: isDefaultFableNatively1M(),
    allowlistPresent: allowlist !== undefined,
    allowlistNamesFable:
      !!allowlist &&
      allowlist.length > 0 &&
      allowlist.some(m => m.trim().toLowerCase().includes('fable')),
    allowlistPermits: allowedUnderAllowlist,
    claudeAiSubscriber: isClaudeAISubscriber(),
    maxSubscriber: isMaxSubscriber(),
    rateLimitTier: getRateLimitTier(),
    oneMDisabled: is1mContextDisabled(),
    opusFallbackSetting:
      getDefaultOpusModel() +
      (isOpus1mMergeEnabled() && !isDefaultOpusNatively1M() ? '[1m]' : ''),
  }
}

export function frontierOperatorDecision(): FrontierOperatorDecision {
  return evaluateFrontierDecision(gatherFrontierFacts())
}

export function describeFrontierDecision(
  decision: FrontierOperatorDecision,
): string {
  const why: Record<FrontierOperatorDecision['code'], string> = {
    'eligible-env-pin': 'env pin',
    'eligible-allowlist': 'model allowlist',
    'eligible-max-20x': 'Max 20x',
    'not-subscriber': 'no subscription facts',
    'not-max': 'not a Max subscription',
    'unknown-rate-limit-tier': 'unknown rate-limit tier',
    'not-20x': 'not Max 20x',
    'allowlist-excluded': 'excluded by allowlist',
    'no-registered-candidate': 'no registered candidate',
  }
  return decision.source === 'frontier'
    ? `first-party frontier · ${why[decision.code]}`
    : `first-party fallback · ${why[decision.code]}`
}
