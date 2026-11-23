import { memoize } from 'lodash-es'
import { MAX_OUTPUT_SIZE } from './file.js'

export const DEFAULT_MAX_OUTPUT_TOKENS = 25_000

export type FileReadingLimits = { maxSizeBytes: number; maxTokens: number; room?: true }

export const getDefaultFileReadingLimits = memoize((): FileReadingLimits => ({
  maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  maxSizeBytes: MAX_OUTPUT_SIZE,
}))
