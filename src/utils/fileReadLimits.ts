import { unbuilt, type Unbuilt } from '../pi/holes.js'

export const DEFAULT_MAX_OUTPUT_TOKENS: Unbuilt = unbuilt('src/utils/fileReadLimits.ts:6')

export type FileReadingLimits = Unbuilt

export const getDefaultFileReadingLimits: Unbuilt = unbuilt('src/utils/fileReadLimits.ts:14')
