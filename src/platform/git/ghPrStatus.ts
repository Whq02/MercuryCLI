import { execFileNoThrow } from '../processes/execFileNoThrow.js'
import { getDefaultBranch, getBranch, getIsGit } from './git.js'
import { jsonParse } from '../logs/slowOperations.js'
import { passedOver } from '../errors/passedOver.js'
import { isRecord } from '../primitives/isRecord.js'

export type PrReviewState = 'approved' | 'pending' | 'changes_requested' | 'draft' | 'merged' | 'closed'

type PrStatus = { reviewState: PrReviewState; url: string; number: number }

export async function fetchPrStatus(): Promise<PrStatus | null> {
  try {
    if (!(await getIsGit())) return null
    const [branch, defaultBranch] = await Promise.all([getBranch(), getDefaultBranch()])
    if (branch === defaultBranch) return null
    const { code, stdout } = await execFileNoThrow('gh', ['pr', 'view', '--json', 'number,url,reviewDecision,isDraft,headRefName,state'], {
      timeout: 5000,
      preserveOutputOnError: false,
    })
    if (code !== 0 || !stdout.trim()) return null
    const pr: unknown = jsonParse(stdout)
    if (!isRecord(pr)) return null
    if (pr.headRefName === defaultBranch || pr.headRefName === 'main' || pr.headRefName === 'master') return null
    if (pr.state === 'MERGED' || pr.state === 'CLOSED') return null
    if (typeof pr.number !== 'number' || typeof pr.url !== 'string') return null
    let reviewState: PrReviewState = 'pending'
    if (pr.isDraft) reviewState = 'draft'
    else if (pr.reviewDecision === 'APPROVED') reviewState = 'approved'
    else if (pr.reviewDecision === 'CHANGES_REQUESTED') reviewState = 'changes_requested'
    return { number: pr.number, url: pr.url, reviewState }
  } catch (error) {
    passedOver(error)
    return null
  }
}
