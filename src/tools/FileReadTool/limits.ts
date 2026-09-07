import { memoize } from 'lodash-es'

import { MAX_OUTPUT_SIZE } from '../../utils/file.js'


export const DEFAULT_MAX_OUTPUT_TOKENS = 25000

export type FileReadingLimits = {
  maxTokens: number
  maxSizeBytes: number
  includeMaxSizeInPrompt?: boolean
  targetedRangeNudge?: boolean
}

export const getDefaultFileReadingLimits = memoize((): FileReadingLimits => ({
  maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  maxSizeBytes: MAX_OUTPUT_SIZE,
}))
