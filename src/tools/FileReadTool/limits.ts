import { memoize } from 'lodash-es'

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { MAX_OUTPUT_SIZE } from '../../utils/file.js'


export const DEFAULT_MAX_OUTPUT_TOKENS = 25000

export type FileReadingLimits = {
  maxTokens: number
  maxSizeBytes: number
  includeMaxSizeInPrompt?: boolean
  targetedRangeNudge?: boolean
}

type RemoteReadLimits = {
  maxTokens?: unknown
  maxSizeBytes?: unknown
  includeMaxSizeInPrompt?: unknown
  targetedRangeNudge?: unknown
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function envMaxTokensOverride(): number | undefined {
  return undefined
}

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
