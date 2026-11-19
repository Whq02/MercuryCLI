import { resolveWorktreeAdminDir } from './baseline.js'
import { runGit } from './git.js'

const MERCURY_EPHEMERAL_PREFIXES = ['.mercury/cache-clock/']

function isMercuryEphemeralLanePath(relPath: string): boolean {
  return MERCURY_EPHEMERAL_PREFIXES.some(prefix => relPath.startsWith(prefix))
}

type WorktreeDelta = {
  commitsAhead: number
  tracked: string[]
  untrackedAuthored: string[]
  mercuryEphemeral: string[]
  uncertainty: string | null
}

export function classifyPorcelainRecords(zOutput: string): {
  tracked: string[]
  untrackedAuthored: string[]
  mercuryEphemeral: string[]
} {
  const tracked: string[] = []
  const untrackedAuthored: string[] = []
  const mercuryEphemeral: string[] = []
  const records = zOutput.split('\u0000')
  for (let index = 0; index < records.length; index++) {
    const record = records[index] as string
    if (record.length < 4) continue
    const statusPair = record.slice(0, 2)
    const path = record.slice(3)
    if (statusPair === '??') {
      if (isMercuryEphemeralLanePath(path)) mercuryEphemeral.push(path)
      else untrackedAuthored.push(path)
      continue
    }
    tracked.push(path)
    if (statusPair.includes('R') || statusPair.includes('C')) {
      const origin = records[index + 1]
      if (origin !== undefined && origin !== '') {
        tracked.push(origin)
        index++
      }
    }
  }
  return { tracked, untrackedAuthored, mercuryEphemeral }
}

export async function readWorktreeDelta(worktreePath: string, headCommit?: string): Promise<WorktreeDelta> {
  const status = await runGit(['--no-optional-locks', 'status', '--porcelain=v1', '-uall', '-z'], worktreePath)
  if (status.code !== 0) {
    return {
      commitsAhead: 0,
      tracked: [],
      untrackedAuthored: [],
      mercuryEphemeral: [],
      uncertainty: `git status exited ${status.code}`,
    }
  }
  const classified = classifyPorcelainRecords(status.stdout)
  let commitsAhead = 0
  let uncertainty: string | null = null
  if (headCommit !== undefined) {
    const revList = await runGit(['rev-list', '--count', `${headCommit}..HEAD`], worktreePath)
    if (revList.code !== 0) {
      uncertainty = `git rev-list exited ${revList.code}`
    } else {
      const parsed = parseInt(revList.stdout.trim(), 10)
      if (Number.isNaN(parsed)) uncertainty = 'git rev-list output was malformed'
      else commitsAhead = parsed
    }
  }
  return { commitsAhead, ...classified, uncertainty }
}

export function deltaBlocksSettlement(delta: WorktreeDelta): boolean {
  return (
    delta.uncertainty !== null ||
    delta.commitsAhead > 0 ||
    delta.tracked.length > 0 ||
    delta.untrackedAuthored.length > 0
  )
}

export async function hasWorktreeChanges(worktreePath: string, headCommit: string): Promise<boolean> {
  const delta = await readWorktreeDelta(worktreePath, headCommit)
  return deltaBlocksSettlement(delta)
}

type WorktreeRemovalVerdict =
  | { safe: true }
  | { safe: false; state: 'uncommitted' | 'unreachable' | 'unowned'; detail: string }

async function worktreeUnreachableCommits(worktreePath: string, ownBranch?: string): Promise<number | null> {
  const refs = await runGit(['for-each-ref', '--format=%(refname)'], worktreePath)
  if (refs.code !== 0) return null
  const others = refs.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && line !== `refs/heads/${ownBranch ?? ''}`)
  const counted = await runGit(['rev-list', '--count', 'HEAD', '--not', ...others], worktreePath)
  if (counted.code !== 0) return null
  const parsed = parseInt(counted.stdout.trim(), 10)
  return Number.isNaN(parsed) ? null : parsed
}

export async function worktreeRemovalSafe(worktreePath: string, ownBranch?: string): Promise<WorktreeRemovalVerdict> {
  const owned = await resolveWorktreeAdminDir(worktreePath)
  if (owned === null) return { safe: false, state: 'unowned', detail: 'git no longer owns it, so what it holds cannot be judged' }
  const delta = await readWorktreeDelta(worktreePath)
  if (delta.uncertainty !== null) return { safe: false, state: 'unowned', detail: `its state could not be read (${delta.uncertainty})` }
  if (delta.tracked.length > 0 || delta.untrackedAuthored.length > 0) {
    const parts: string[] = []
    if (delta.tracked.length > 0) parts.push(`${delta.tracked.length} uncommitted change${delta.tracked.length === 1 ? '' : 's'} (${delta.tracked.slice(0, 3).join(', ')}${delta.tracked.length > 3 ? ', …' : ''})`)
    if (delta.untrackedAuthored.length > 0) parts.push(`${delta.untrackedAuthored.length} untracked file${delta.untrackedAuthored.length === 1 ? '' : 's'} (${delta.untrackedAuthored.slice(0, 3).join(', ')}${delta.untrackedAuthored.length > 3 ? ', …' : ''})`)
    return { safe: false, state: 'uncommitted', detail: parts.join(' · ') }
  }
  const unreachable = await worktreeUnreachableCommits(worktreePath, ownBranch)
  if (unreachable === null) return { safe: false, state: 'unowned', detail: 'its commits could not be read' }
  if (unreachable > 0) {
    return { safe: false, state: 'unreachable', detail: `${unreachable} commit${unreachable === 1 ? '' : 's'} reachable from no other branch` }
  }
  return { safe: true }
}
