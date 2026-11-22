import { execFileNoThrow } from './execFileNoThrow.js'
import { getDefaultBranch, getBranch, getIsGit } from './git.js'
import { jsonParse } from './slowOperations.js'
import { passedOver } from './passedOver.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


export type PrReviewState = 'approved' | 'pending' | 'changes_requested' | 'draft' | 'merged' | 'closed'

type PrStatus = Unbuilt

export async function fetchPrStatus(): Promise<PrStatus | null> {
  return notBuilt('src/utils/ghPrStatus.ts:22')
}
