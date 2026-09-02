import { scribeModeEnabled } from './scribeGates.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export const REGULATION_CONTEXT_CLEAR_PCT = 85
export const REGULATION_THRASH_ERRORS = 5
export const REGULATION_TOKEN_CEILING_DEFAULT = 5_000_000

export function scribeRegulationEnabled(): boolean {
  return scribeModeEnabled()
}

export function getScribeTokenCeiling(): number {
  const raw = flagEnv('MERCURY_SCRIBE_TOKEN_CEILING')
  const parsed = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : REGULATION_TOKEN_CEILING_DEFAULT
}

export interface RegulationSnapshot {
  contextPercent?: number
  repeatedErrors?: number
  tokenTotal?: number
}

export type RegulationAction = 'ok' | 'clear-implementer' | 'pause' | 'escalate-human'

export interface RegulationVerdict {
  action: RegulationAction
  reason: string
}

export function assessRegulation(s: RegulationSnapshot): RegulationVerdict {
  const tokens = Number.isFinite(s.tokenTotal) ? (s.tokenTotal as number) : 0
  const errors = Number.isFinite(s.repeatedErrors) ? (s.repeatedErrors as number) : 0
  const ctx = Number.isFinite(s.contextPercent) ? (s.contextPercent as number) : 0

  const ceiling = getScribeTokenCeiling()
  if (tokens >= ceiling) {
    return {
      action: 'escalate-human',
      reason: `cumulative tokens ${tokens} reached the hard ceiling ${ceiling} — escalate to the human/operator: only they decide whether to keep spending`,
    }
  }
  if (errors >= REGULATION_THRASH_ERRORS) {
    return {
      action: 'pause',
      reason: `${errors} repeated errors (thrash >= ${REGULATION_THRASH_ERRORS}) — pause the loop instead of spinning`,
    }
  }
  if (ctx >= REGULATION_CONTEXT_CLEAR_PCT) {
    return {
      action: 'clear-implementer',
      reason: `Implementer context at ${ctx}% (>= ${REGULATION_CONTEXT_CLEAR_PCT}%) — clear/restart it before it degrades`,
    }
  }
  return { action: 'ok', reason: 'within limits' }
}
