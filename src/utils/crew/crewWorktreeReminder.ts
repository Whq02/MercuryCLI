import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { findCanonicalGitRoot, gitExe } from '../git.js'
import { worktreeBranchName, worktreeRemovalSafe } from '../worktree.js'

export const CREW_JANITOR_DAYS = 7
const DAY_MS = 86_400_000
const AGENT_LANE_SLUG = /^agent-a[0-9a-f]{7,32}$/

export type CrewWorktreeLeftoverState = 'clean' | 'uncommitted' | 'unreachable' | 'unowned'

export interface CrewWorktreeLeftoverV1 {
  name: string
  path: string
  branch: string | null
  gitRoot: string | null
  state: CrewWorktreeLeftoverState
  detail: string
  changedAt: number
  janitorAt: number
}

export const CREW_WORKTREE_NEVER_REMOVED = 'never removed by the machine'

export function crewWorktreeLeftWords(path: string): string {
  return `worktree left: ${path}`
}

export function crewWorktreeAgeWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${Math.max(0, minutes)} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(ms / DAY_MS)
  return `${days} day${days === 1 ? '' : 's'}`
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export async function crewWorktreeLeftoverOf(
  lane: { name: string; path: string; branch?: string; gitRoot?: string },
  nowMs: number,
): Promise<CrewWorktreeLeftoverV1> {
  let changedAt = nowMs
  try {
    changedAt = (await stat(lane.path)).mtimeMs
  } catch {
    changedAt = nowMs
  }
  const verdict = await worktreeRemovalSafe(lane.path, lane.branch)
  return {
    name: lane.name,
    path: lane.path,
    branch: lane.branch ?? null,
    gitRoot: lane.gitRoot ?? null,
    state: verdict.safe ? 'clean' : verdict.state,
    detail: verdict.safe ? 'clean and reachable' : verdict.detail,
    changedAt,
    janitorAt: changedAt + CREW_JANITOR_DAYS * DAY_MS,
  }
}

export function crewWorktreeReminderTail(leftover: CrewWorktreeLeftoverV1, nowMs: number): string {
  const age = crewWorktreeAgeWords(Math.max(0, nowMs - leftover.changedAt))
  if (leftover.state === 'clean') {
    return `${age} old, ${leftover.detail}; the seven-day janitor removes it on ${dayOf(leftover.janitorAt)} unless you keep it`
  }
  return `${age} old; ${leftover.detail} — ${CREW_WORKTREE_NEVER_REMOVED}: decide what to keep`
}

export function crewWorktreeReminderLine(leftover: CrewWorktreeLeftoverV1, nowMs: number): string {
  return `${leftover.name} left its worktree ${leftover.path}${leftover.branch !== null ? ` (branch ${leftover.branch})` : ''} — ${crewWorktreeReminderTail(leftover, nowMs)}`
}

const noted = new Map<string, CrewWorktreeLeftoverV1>()

export function noteCrewWorktreeLeftover(leftover: CrewWorktreeLeftoverV1): void {
  noted.set(leftover.path, leftover)
}

export function crewWorktreeLeftoverNoted(path: string): CrewWorktreeLeftoverV1 | null {
  return noted.get(path) ?? null
}

export async function crewLeftoverWorktrees(from: string, nowMs: number): Promise<CrewWorktreeLeftoverV1[]> {
  const gitRoot = findCanonicalGitRoot(from)
  if (!gitRoot) return []
  const listed = await execFileNoThrowWithCwd(gitExe(), ['worktree', 'list', '--porcelain'], { cwd: gitRoot })
  if (listed.code !== 0) return []
  const out: CrewWorktreeLeftoverV1[] = []
  for (const line of listed.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const path = line.slice('worktree '.length).trim()
    if (path === gitRoot || basename(dirname(path)) !== 'worktrees') continue
    const slug = basename(path)
    if (!AGENT_LANE_SLUG.test(slug)) continue
    out.push(await crewWorktreeLeftoverOf({ name: slug, path, branch: worktreeBranchName(slug), gitRoot }, nowMs))
  }
  return out
}
