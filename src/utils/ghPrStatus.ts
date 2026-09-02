import { execFileNoThrow } from './execFileNoThrow.js'
import { getDefaultBranch, getBranch, getIsGit } from './git.js'
import { jsonParse } from './slowOperations.js'


export type PrReviewState = 'approved' | 'pending' | 'changes_requested' | 'draft' | 'merged' | 'closed'

export type PrStatus = {
  number: number
  url: string
  reviewState: PrReviewState
}

export function deriveReviewState(isDraft: boolean, reviewDecision: string): PrReviewState {
  if (isDraft) return 'draft'
  if (reviewDecision === 'APPROVED') return 'approved'
  if (reviewDecision === 'CHANGES_REQUESTED') return 'changes_requested'
  return 'pending'
}

export async function fetchPrStatus(): Promise<PrStatus | null> {
  try {
    if (!(await getIsGit())) return null
    const [branch, defaultBranch] = await Promise.all([getBranch(), getDefaultBranch()])
    if (branch === defaultBranch) return null
    const result = await execFileNoThrow(
      'gh',
      ['pr', 'view', '--json', 'number,url,reviewDecision,isDraft,headRefName,state'],
      { timeout: 5000, preserveOutputOnError: false },
    )
    if (result.code !== 0 || result.stdout.trim() === '') return null
    const parsed = jsonParse(result.stdout) as {
      number?: number
      url?: string
      reviewDecision?: string
      isDraft?: boolean
      headRefName?: string
      state?: string
    }
    if (parsed.headRefName === defaultBranch || parsed.headRefName === 'main' || parsed.headRefName === 'master') {
      return null
    }
    if (parsed.state === 'MERGED' || parsed.state === 'CLOSED') return null
    if (typeof parsed.number !== 'number' || typeof parsed.url !== 'string') return null
    return {
      number: parsed.number,
      url: parsed.url,
      reviewState: deriveReviewState(Boolean(parsed.isDraft), parsed.reviewDecision ?? ''),
    }
  } catch {
    return null
  }
}
