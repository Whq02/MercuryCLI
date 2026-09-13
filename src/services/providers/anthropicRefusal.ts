import { credentialWallLine, isRevokedSignInText, observedCredentialWall } from './credentialWall.js'

export type AnthropicRefusalKind = 'window' | 'sign-in' | 'other'

export interface AnthropicRefusalFacts {
  status?: number | undefined
  wireText?: string | undefined
  oauthErrorType?: string | undefined
  signInExpired?: boolean | undefined
}

export interface AnthropicWindowObservation {
  account: string
  observedAtMs: number
  resetsAtMs?: number
  lapsesAtMs?: number
}

export type StandingAnthropicRefusal = { kind: 'window' | 'sign-in'; words: string }

const INVALID_GRANT = /\binvalid_grant\b/

export function classifyAnthropicRefusal(facts: AnthropicRefusalFacts): AnthropicRefusalKind {
  const text = facts.wireText ?? ''
  if (facts.oauthErrorType === 'invalid_grant' || INVALID_GRANT.test(text)) return 'sign-in'
  if (facts.status === 429) return 'window'
  if ((facts.status === 401 || facts.status === 403) && isRevokedSignInText(text)) return 'sign-in'
  if (facts.status === 401 && facts.signInExpired === true) return 'sign-in'
  return 'other'
}

export function anthropicRefusalFactsOf(error: unknown, signInExpired?: boolean): AnthropicRefusalFacts {
  const record = error as { status?: unknown; message?: unknown; oauthErrorType?: unknown } | null
  return {
    ...(typeof record?.status === 'number' ? { status: record.status } : {}),
    ...(typeof record?.message === 'string' ? { wireText: record.message } : {}),
    ...(typeof record?.oauthErrorType === 'string' ? { oauthErrorType: record.oauthErrorType } : {}),
    ...(signInExpired !== undefined ? { signInExpired } : {}),
  }
}

function clockWords(ms: number): string {
  const { formatClock } = require('../../utils/cockpit/quota.js') as typeof import('../../utils/cockpit/quota.js')
  return formatClock(ms)
}

export function anthropicWindowWords(seen?: AnthropicWindowObservation): string {
  if (seen === undefined) return 'the Anthropic usage window is reached — the reset time is not known'
  const head = `the Anthropic usage window is reached for ${seen.account}, seen at ${clockWords(seen.observedAtMs)}`
  if (seen.resetsAtMs !== undefined) return `${head} — resets at ${clockWords(seen.resetsAtMs)}`
  if (seen.lapsesAtMs !== undefined) {
    return `${head} — no reset time was given; delegated work is refused until ${clockWords(seen.lapsesAtMs)}`
  }
  return head
}

export function anthropicSignInWords(opts?: { nonInteractive?: boolean }): string {
  return credentialWallLine('anthropic', 'sign-in', opts)
}

export function standingAnthropicRefusal(): StandingAnthropicRefusal | null {
  if (observedCredentialWall('anthropic') === 'sign-in') return { kind: 'sign-in', words: anthropicSignInWords() }
  const { anthropicLimitVerdict } = require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
  const verdict = anthropicLimitVerdict()
  if (verdict.status !== 'rejected') return null
  const seen: AnthropicWindowObservation | undefined =
    verdict.account !== undefined && verdict.observedAtMs !== undefined
      ? {
          account: verdict.account,
          observedAtMs: verdict.observedAtMs,
          ...(verdict.resetsAtMs !== undefined ? { resetsAtMs: verdict.resetsAtMs } : {}),
          ...(verdict.lapsesAtMs !== undefined ? { lapsesAtMs: verdict.lapsesAtMs } : {}),
        }
      : undefined
  return { kind: 'window', words: anthropicWindowWords(seen) }
}
