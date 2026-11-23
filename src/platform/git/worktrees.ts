import { execFile } from 'node:child_process'
import { subprocessEnv } from '../processes/subprocessEnv.js'
import { gitArgsAsync } from './spawnArgs.js'
import type { GitUnavailable, GitWorktreeInfo } from './gitShapes.js'

const MAX_BUFFER = 16 * 1024 * 1024
const GIT_TIMEOUT_MS = 30_000

async function gitAsync(root: string, args: string[]): Promise<string> {
  const argv = await gitArgsAsync(args, root)
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      argv,
      {
        windowsHide: true,
        cwd: root,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        env: { ...subprocessEnv(), GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve(stdout)
          return
        }
        const status = typeof err.code === 'number' ? err.code : null
        reject(Object.assign(err, { status, stdout, stderr }))
      },
    )
  })
}

type AsyncProbe = { out: string; failure: null } | { out: null; failure: string | null }

export async function tryGitAsync(root: string, args: string[]): Promise<AsyncProbe> {
  try {
    return { out: await gitAsync(root, args), failure: null }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number | null; signal?: string | null }
    return {
      out: null,
      failure: typeof err.status === 'number' ? null : (err.code ?? err.signal ?? 'exec-failure'),
    }
  }
}

export function notARepoNote(failure: string | null): GitUnavailable {
  return {
    state: 'unavailable',
    note: `not a git repository (or git is not installed) — the work graph needs one${
      failure ? ` (git probe failed: ${failure})` : ''
    }`,
  }
}

async function isGitRepoAsync(root: string): Promise<{ repo: boolean; failure: string | null }> {
  const probe = await tryGitAsync(root, ['rev-parse', '--is-inside-work-tree'])
  if (probe.out === null) return { repo: false, failure: probe.failure }
  return { repo: probe.out.trim() === 'true', failure: null }
}

export async function classifyAsyncFailure(root: string, failure: string | null, note: string): Promise<GitUnavailable> {
  const probe = await isGitRepoAsync(root)
  const mechanism = probe.failure ?? failure
  if (!probe.repo) return { ...notARepoNote(mechanism), ...(mechanism !== null && { failure: mechanism }) }
  return { state: 'unavailable', note: failure ? `${note} (${failure})` : note, ...(failure !== null && { failure }) }
}

export function parseWorktreeList(raw: string): GitWorktreeInfo[] {
  const out: GitWorktreeInfo[] = []
  let cur: Partial<GitWorktreeInfo> = {}
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9), isMain: out.length === 0 }
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '')
    else if (line === '') {
      if (cur.path) out.push({ path: cur.path, head: cur.head ?? '', branch: cur.branch ?? null, isMain: cur.isMain ?? false })
      cur = {}
    }
  }
  if (cur.path) out.push({ path: cur.path, head: cur.head ?? '', branch: cur.branch ?? null, isMain: cur.isMain ?? false })
  return out
}

export async function gitWorktreesAsync(root: string): Promise<GitWorktreeInfo[] | GitUnavailable> {
  const list = await tryGitAsync(root, ['worktree', 'list', '--porcelain'])
  if (list.out === null) return classifyAsyncFailure(root, list.failure, 'git worktree list failed')
  return parseWorktreeList(list.out)
}
