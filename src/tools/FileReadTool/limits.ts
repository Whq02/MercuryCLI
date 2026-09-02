import { memoize } from 'lodash-es'

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { MAX_OUTPUT_SIZE } from '../../utils/file.js'

/**
 * Resolution of the Read tool's byte and token caps from the environment,
 * remote configuration, and built-in defaults.
 */

export const DEFAULT_MAX_OUTPUT_TOKENS = 25000

export type FileReadingLimits = {
  /** Cap on the tokens of the actual returned content. */
  maxTokens: number
  /** Cap checked against the TOTAL file size before the read. */
  maxSizeBytes: number
  /** Make the prompt mention the byte cap. */
  includeMaxSizeInPrompt?: boolean
  /** Switch the prompt's offset/limit advice to "read only the part you need". */
  targetedRangeNudge?: boolean
}

/** The remote override object: one partial record under a single gate key. */
type RemoteReadLimits = {
  maxTokens?: unknown
  maxSizeBytes?: unknown
  includeMaxSizeInPrompt?: unknown
  targetedRangeNudge?: unknown
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Always undefined: no env override exists. */
function envMaxTokensOverride(): number | undefined {
  return undefined
}

/**
 * The resolved defaults, memoised on first use so a remote-config refresh
 * cannot change the caps mid-session. Precedence for maxTokens: environment
 * override > remote > built-in; for maxSizeBytes: remote > built-in. Every
 * remote field is validated independently, so an invalid value falls
 * through to the default and no cap can resolve to zero.
 */
export const getDefaultFileReadingLimits = memoize((): FileReadingLimits => {
  const remote = getFeatureValue_CACHED_MAY_BE_STALE<RemoteReadLimits>('mercury_amber_wren', {})
  const limits: FileReadingLimits = {
    maxTokens:
      envMaxTokensOverride() ??
      positiveFiniteNumber(remote?.maxTokens) ??
      DEFAULT_MAX_OUTPUT_TOKENS,
    maxSizeBytes: positiveFiniteNumber(remote?.maxSizeBytes) ?? MAX_OUTPUT_SIZE,
  }
  if (typeof remote?.includeMaxSizeInPrompt === 'boolean') {
    limits.includeMaxSizeInPrompt = remote.includeMaxSizeInPrompt
  }
  if (typeof remote?.targetedRangeNudge === 'boolean') {
    limits.targetedRangeNudge = remote.targetedRangeNudge
  }
  return limits
})
