import { type GitInitRefusal, gitInitRefusal } from '../../platform/files/projectBoundary.js'
import { inspectWorkspaceKind, workspaceGitCheckNote } from './concourseWorktrees.js'
import { describeSeatReading, resolveSeatCeiling } from '../switchboard-capacity/capacityCheck.js'
import { resolveDirectoryIdentity } from '../../platform/storage/projectStoreIdentity.js'

export const CONCOURSE_SHORT_PREFIX = 'concourse-w'

export function canonicalWorkspaceId(dir: string): string {
  return resolveDirectoryIdentity(dir).canonical
}

export type WorkspaceIsolation = 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'

export interface WorkspaceClaim {
  workspaceId: string
  isolation?: WorkspaceIsolation
  title?: string
}

export function seatHoldersWords(live: readonly WorkspaceClaim[], ceiling: number): string {
  const titles = live.map(claim => claim.title?.trim() ?? '').filter(title => title !== '')
  const named = titles.slice(0, 3).map(title => `“${title.length > 32 ? `${title.slice(0, 31)}…` : title}”`)
  const rest = live.length - named.length
  const holders = named.length === 0 ? '' : ` (${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''})`
  return `${live.length} live session${live.length === 1 ? '' : 's'} hold${live.length === 1 ? 's' : ''} the ${ceiling} seat${ceiling === 1 ? '' : 's'}${holders}`
}

export const SEAT_FREEING_MOVES: readonly ConcourseMoveV1[] = [
  { verb: 'pause-holder', label: 'stop or park a live session on the Session Concourse to free a seat' },
  { verb: 'retry', label: 'or raise the ceiling: /seats N in a chat, the Seats row of the Boot Menu or of /config' },
]

export interface ConcourseMoveV1 {
  verb: 'worktree' | 'read-only' | 'queue' | 'pause-holder' | 'revive' | 'retry' | 'init-git'
  label: string
}

export type AdmissionDecision =
  | { admit: true }
  | {
      admit: false
      reason: string
      code: 'runtime-ceiling' | 'workspace-collision'
      moves?: ConcourseMoveV1[]
    }

export function evaluateConcourseAdmission(
  live: readonly WorkspaceClaim[],
  req: WorkspaceClaim,
  ceiling: number = effectiveSeatCeiling(),
): AdmissionDecision {
  if (live.length >= ceiling) {
    return {
      admit: false,
      code: 'runtime-ceiling',
      reason: `every seat is taken: ${seatHoldersWords(live, ceiling)} (${describeSeatReading(ceiling)})`,
      moves: [
        { verb: 'queue', label: 'it queues and starts when a seat frees' },
        ...SEAT_FREEING_MOVES,
      ],
    }
  }
  const reqIso = req.isolation ?? 'exclusive'
  for (const claim of live) {
    if (claim.workspaceId !== req.workspaceId) continue
    const liveIso = claim.isolation ?? 'exclusive'
    const bothReadOnly = liveIso === 'read-only' && reqIso === 'read-only'
    const eitherIsolated = liveIso === 'worktree-isolated' || reqIso === 'worktree-isolated'
    const bothShared = liveIso === 'shared' && reqIso === 'shared'
    if (bothReadOnly || eitherIsolated || bothShared) continue
    return {
      admit: false,
      code: 'workspace-collision',
      reason: `the repo's main checkout is held by a live session`,
      moves: [
        { verb: 'worktree', label: 'retry the launch — it forks a worktree of its own' },
        { verb: 'queue', label: 'or wait — it starts when the checkout frees' },
      ],
    }
  }
  return { admit: true }
}

export function effectiveSeatCeiling(): number {
  return resolveSeatCeiling()
}

export type DefaultedAdmissionResolution =
  | {
      kind: 'decision'
      decision: AdmissionDecision
      effectiveIsolation: WorkspaceIsolation
      gitOfferRefused?: GitInitRefusal
      gitCheckError?: string
    }
  | { kind: 'git-offer'; code: 'no-repository'; error: string; moves: ConcourseMoveV1[] }

export function resolveDefaultedAdmission(
  live: ReadonlyArray<{ workspaceId: string; isolation?: WorkspaceIsolation }>,
  claim: { workspaceId: string; isolation?: WorkspaceIsolation },
  seatCeiling: number = effectiveSeatCeiling(),
): DefaultedAdmissionResolution {
  const requested: WorkspaceIsolation = claim.isolation ?? 'exclusive'
  let decision = evaluateConcourseAdmission(
    live,
    { workspaceId: claim.workspaceId, isolation: requested },
    seatCeiling,
  )
  let effectiveIsolation = requested
  if (!decision.admit && decision.code === 'workspace-collision' && claim.isolation === undefined) {
    const inspected = inspectWorkspaceKind(claim.workspaceId)
    if (inspected.kind === 'git') {
      const retry = evaluateConcourseAdmission(
        live,
        { workspaceId: claim.workspaceId, isolation: 'worktree-isolated' },
        seatCeiling,
      )
      if (retry.admit) effectiveIsolation = 'worktree-isolated'
      decision = retry
    } else if (inspected.gitCheckError !== undefined) {
      return {
        kind: 'decision',
        decision: {
          ...decision,
          reason: `${decision.reason} — ${workspaceGitCheckNote(claim.workspaceId, inspected.gitCheckError)}`,
        },
        effectiveIsolation,
        gitCheckError: inspected.gitCheckError,
      }
    } else {
      const refusal = gitInitRefusal(claim.workspaceId)
      if (refusal !== null) {
        return {
          kind: 'decision',
          decision: {
            admit: false,
            code: 'workspace-collision',
            reason: `two sessions here would need git, and Mercury will not start a repository in ${claim.workspaceId} — ${refusal.words}; kept without git: this one starts when the folder frees`,
            moves: [{ verb: 'queue', label: 'it waits — it starts when the folder frees' }],
          },
          effectiveIsolation,
          gitOfferRefused: refusal,
        }
      }
      return {
        kind: 'git-offer',
        code: 'no-repository',
        error: 'two sessions here need git — say yes to the git offer and this one forks on its own',
        moves: [{ verb: 'init-git', label: 'say yes to the git offer — it forks and starts by itself' }],
      }
    }
  }
  return { kind: 'decision', decision, effectiveIsolation }
}
