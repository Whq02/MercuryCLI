// ============================================================================
//  gitGraph/observe — typed, bounded LOCAL Git observation (
// Every read is an execFile of the system git against the
//  project root — no libgit, no daemon, no remote contact. Outputs are
//  bounded with flagged truncation; a repo-less directory answers
//  honestly unavailable.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import type {
  GitCommitMeta,
  GitConflict,
  GitDiff,
  GitHunk,
  GitStatus,
  GitUnavailable,
  GitWorktreeInfo,
} from './contracts.js'

const MAX_BUFFER = 16 * 1024 * 1024
const MAX_HUNKS = 200
const MAX_HUNK_LINES = 120
const MAX_CONFLICT_LINES = 80

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    windowsHide: true,
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: 30_000,
    env: { ...subprocessEnv(), GIT_OPTIONAL_LOCKS: '0' },
    // stderr is CAPTURED, never inherited: the isGitRepo probe runs on
    // arbitrary cwds and a child 'fatal: not a git repository' must not
    // leak onto the product terminal (it rides the thrown error instead).
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// The most recent tryGit failure that was NOT git's own verdict (no exit
// status): a spawn/timeout/resource error. Cleared on every successful probe
// so the unavailable note can say WHICH kind of failure produced it — a
// loaded runner's EAGAIN/ETIMEDOUT must not read as a deterministic
// "not a repository" (the hosted-gate shard-13 lesson).
let lastProbeFailure: string | null = null

function tryGit(root: string, args: string[]): string | null {
  try {
    const out = git(root, args)
    lastProbeFailure = null
    return out
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number | null; signal?: string | null }
    lastProbeFailure =
      typeof err.status === 'number' ? null : (err.code ?? err.signal ?? 'exec-failure')
    return null
  }
}

export function isGitRepo(root: string): boolean {
  // Real git ALWAYS prints `true`/`false` on exit 0 here — an exit-0 probe
  // whose captured stdout arrives EMPTY is the harness losing the pipe (the
  // bun subprocess fd race: trace2 showed git exit 0 + `true` while the
  // capture read ''), not a git verdict. One retry, then the unavailable
  // note names the mechanism instead of lying "not a repository".
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = tryGit(root, ['rev-parse', '--is-inside-work-tree'])
    if (out === null) return false
    const verdict = out.trim()
    if (verdict === 'true') return true
    if (verdict === 'false') return false
    lastProbeFailure = 'empty-stdout'
  }
  return false
}

const notARepo = (): GitUnavailable => ({
  state: 'unavailable',
  note: `not a git repository (or git is not installed) — the work graph needs one${
    lastProbeFailure ? ` (git probe failed: ${lastProbeFailure})` : ''
  }`,
})

// ── status ──────────────────────────────────────────────────────────────────

export function gitStatus(root: string): GitStatus | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  // relativePaths pinned to the DEFAULT: consumers treat these paths as
  // relative to `root` (the spawn cwd of focused runs) — a user config of
  // status.relativePaths=false must not flip the basis under them.
  const raw = tryGit(root, ['-c', 'status.relativePaths=true', 'status', '--porcelain=v2', '--branch'])
  if (raw === null) return notARepo()
  const head = tryGit(root, ['rev-parse', 'HEAD'])?.trim() ?? '(unborn)'
  let branch = '(detached)'
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitStatus['files'] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length)
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1]!
      // porcelain v2: renames ('2') carry "path<TAB>origPath" in the tail.
      const tail = parts.slice(line.startsWith('2 ') ? 9 : 8).join(' ')
      const [path, origPath] = tail.split('\t')
      files.push({
        path: path!,
        staged: xy[0] === '.' ? '' : xy[0]!,
        unstaged: xy[1] === '.' ? '' : xy[1]!,
        kind: 'tracked',
        ...(origPath !== undefined && { origPath }),
      })
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ')
      files.push({ path: parts.slice(10).join(' '), staged: parts[1]![0]!, unstaged: parts[1]![1]!, kind: 'unmerged' })
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), staged: '', unstaged: '?', kind: 'untracked' })
    }
  }
  // The digest must cover worktree CONTENT, not just the status shape:
  // appending to an ALREADY-modified file leaves the porcelain output
  // byte-identical (git hashes worktree content only at add time), and a
  // stale plan would slip through. Caught by the slice-4c artifact leg.
  const hasher = createHash('sha1').update(`${head}\n${raw}`)
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path)).slice(0, 500)) {
    try {
      hasher.update(`\n${f.path}\0`)
      hasher.update(readFileSync(joinPath(root, f.path)))
    } catch {
      hasher.update(`\n${f.path}\0DELETED`)
    }
  }
  const digest = hasher.digest('hex').slice(0, 16)
  return {
    root,
    branch,
    upstream,
    ahead,
    behind,
    head,
    files,
    digest,
    clean: files.length === 0,
  }
}

// ── diff / hunks ─────────────────────────────────────────────────────────────

export function hunkId(file: string, header: string, body: string): string {
  return `gh-${createHash('sha1').update(`${file}\n${header}\n${body}`).digest('hex').slice(0, 12)}`
}

export function parseUnifiedDiff(raw: string): { files: GitDiff['files']; hunks: GitHunk[]; truncated: boolean } {
  const files: GitDiff['files'] = []
  const hunks: GitHunk[] = []
  let truncated = false
  let currentFile: string | null = null
  let currentHunk: { header: string; lines: string[] } | null = null

  const flush = (): void => {
    if (currentFile && currentHunk) {
      if (hunks.length >= MAX_HUNKS) {
        truncated = true
      } else {
        const body = currentHunk.lines.join('\n')
        const bounded = currentHunk.lines.slice(0, MAX_HUNK_LINES)
        if (bounded.length < currentHunk.lines.length) truncated = true
        hunks.push({
          id: hunkId(currentFile, currentHunk.header, body),
          file: currentFile,
          header: currentHunk.header,
          lines: bounded,
          additions: currentHunk.lines.filter(l => l.startsWith('+')).length,
          deletions: currentHunk.lines.filter(l => l.startsWith('-')).length,
        })
      }
    }
    currentHunk = null
  }

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      const m = line.match(/ b\/(.+)$/)
      currentFile = m ? m[1]! : null
      if (currentFile) files.push({ path: currentFile, additions: 0, deletions: 0, binary: false })
    } else if (line.startsWith('Binary files')) {
      const f = files[files.length - 1]
      if (f) f.binary = true
    } else if (line.startsWith('@@')) {
      flush()
      currentHunk = { header: line, lines: [] }
    } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '\\ No newline at end of file')) {
      currentHunk.lines.push(line)
      const f = files[files.length - 1]
      if (f) {
        if (line.startsWith('+')) f.additions++
        else if (line.startsWith('-')) f.deletions++
      }
    }
  }
  flush()
  return { files, hunks, truncated }
}

export interface DiffOptions {
  scope: 'worktree' | 'staged' | 'commit' | 'range'
  /** commit sha (scope commit) or 'A..B' (scope range). */
  ref?: string
  paths?: string[]
}

export function gitDiff(root: string, opts: DiffOptions): GitDiff | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const args = ['diff', '--no-color', '--unified=3']
  if (opts.scope === 'staged') args.push('--cached')
  else if (opts.scope === 'commit') {
    if (!opts.ref) return { state: 'unavailable', note: "scope 'commit' needs ref (a sha)" }
    args.splice(0, args.length, 'show', '--no-color', '--unified=3', '--format=', opts.ref)
  } else if (opts.scope === 'range') {
    if (!opts.ref?.includes('..')) return { state: 'unavailable', note: "scope 'range' needs ref 'A..B'" }
    args.push(opts.ref)
  }
  if (opts.paths?.length && opts.scope !== 'commit') args.push('--', ...opts.paths)
  const raw = tryGit(root, args)
  if (raw === null) return { state: 'unavailable', note: `git ${args[0]} failed for ${opts.ref ?? opts.scope}` }
  const parsed = parseUnifiedDiff(raw)
  return { scope: opts.scope, ...(opts.ref !== undefined && { ref: opts.ref }), ...parsed }
}

// ── commits ─────────────────────────────────────────────────────────────────

export function gitCommitMeta(root: string, sha: string): GitCommitMeta | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const raw = tryGit(root, ['show', '-s', '--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%s%x00%b', sha])
  if (raw === null) return { state: 'unavailable', note: `no commit '${sha}' here` }
  const [full, author, email, date, parents, subject, body] = raw.split('\0')
  const nameStatus = tryGit(root, ['show', '--name-status', '--format=', full!.trim()]) ?? ''
  const files = nameStatus
    .split('\n')
    .filter(Boolean)
    .slice(0, 200)
    .map(line => {
      const [status, ...rest] = line.split('\t')
      return { path: rest[rest.length - 1] ?? '', status: status ?? '' }
    })
  return {
    sha: full!.trim(),
    author: author ?? '',
    authorEmail: email ?? '',
    date: date ?? '',
    subject: subject ?? '',
    body: (body ?? '').trim().slice(0, 2000),
    files,
    parents: (parents ?? '').trim().split(' ').filter(Boolean),
  }
}

export function gitMergeBase(root: string, a: string, b: string): string | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const raw = tryGit(root, ['merge-base', a, b])
  if (raw === null) return { state: 'unavailable', note: `no merge base between '${a}' and '${b}'` }
  return raw.trim()
}

// ── worktrees ────────────────────────────────────────────────────────────────

export function gitWorktrees(root: string): GitWorktreeInfo[] | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const raw = tryGit(root, ['worktree', 'list', '--porcelain'])
  if (raw === null) return { state: 'unavailable', note: 'git worktree list failed' }
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

// ── conflicts ────────────────────────────────────────────────────────────────

export function conflictId(path: string): string {
  return `gc-${createHash('sha1').update(path).digest('hex').slice(0, 10)}`
}

export function gitConflicts(root: string): GitConflict[] | GitUnavailable {
  const status = gitStatus(root)
  if ('state' in status) return status
  const unmerged = status.files.filter(f => f.kind === 'unmerged')
  return unmerged.slice(0, 20).map(f => {
    const stage = (n: number): string[] =>
      (tryGit(root, ['show', `:${n}:${f.path}`]) ?? '').split('\n').slice(0, MAX_CONFLICT_LINES)
    return {
      id: conflictId(f.path),
      path: f.path,
      base: stage(1),
      ours: stage(2),
      theirs: stage(3),
    }
  })
}

// ── Family 2: file/tree at an exact ref + compare (LOCAL reads) ───────

const MAX_FILE_AT_REF_BYTES = 400_000
const MAX_TREE_ENTRIES = 500
const MAX_COMPARE_COMMITS = 20
const MAX_COMPARE_FILES = 60

export interface GitFileAtRef {
  ref: string
  path: string
  text: string
  /** REAL byte length of the blob (utf8), not JS code units. */
  bytes: number
  truncated: boolean
  /** NUL-carrying blob — `text` is not faithful; named, never silent. */
  binary: boolean
}

/**
 * Split a slash-joined `<ref>/<path>` resource id by trying PROGRESSIVELY
 * LONGER ref prefixes against the repository (bounded) — `origin/main/src/x`
 * resolves as ref `origin/main` + path `src/x`, never a truncated `origin`.
 * The SHORTEST resolving prefix wins (deterministic).
 */
export function splitRefPath(
  root: string,
  rest: string,
  opts: { allowEmptyPath?: boolean } = {},
): { ref: string; path: string } | null {
  const segments = rest.split('/')
  const max = Math.min(segments.length - (opts.allowEmptyPath ? 0 : 1), 8)
  for (let i = 1; i <= max; i++) {
    const ref = segments.slice(0, i).join('/')
    if (tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null) {
      return { ref, path: segments.slice(i).join('/') }
    }
  }
  return null
}

/** One file's content at an exact ref (`git show ref:path`), bounded. */
export function gitFileAtRef(root: string, ref: string, filePath: string): GitFileAtRef | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const raw: string | null = tryGit(root, ['show', `${ref}:${filePath}`])
  if (raw === null) {
    // Name the exact failure: missing ref vs missing path at that ref.
    const refOk = tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return {
      state: 'unavailable',
      note:
        refOk === null
          ? `ref '${ref}' does not resolve to a commit here`
          : `'${filePath}' does not exist at ${ref} (check the path as of that ref)`,
    }
  }
  const bytes = Buffer.byteLength(raw, 'utf8')
  const truncated = raw.length > MAX_FILE_AT_REF_BYTES
  return {
    ref,
    path: filePath,
    text: truncated ? raw.slice(0, MAX_FILE_AT_REF_BYTES) : raw,
    bytes,
    truncated,
    binary: raw.includes('\u0000'),
  }
}

export interface GitTreeEntry {
  mode: string
  type: 'blob' | 'tree' | 'commit' | 'other'
  name: string
  size: number | null
}

export interface GitTreeAtRef {
  ref: string
  path: string
  entries: GitTreeEntry[]
  truncated: boolean
}

/** One directory level at an exact ref (`git ls-tree -l`), bounded. */
export function gitTreeAtRef(root: string, ref: string, subPath?: string): GitTreeAtRef | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const spec = subPath ? `${ref}:${subPath}` : ref
  // quotepath off: listed names must ROUND-TRIP into gitFileAtRef — a
  // C-quoted `"caf\303\251.txt"` would not.
  const raw = tryGit(root, ['-c', 'core.quotepath=off', 'ls-tree', '-l', spec])
  if (raw === null) {
    return {
      state: 'unavailable',
      note: `'${spec}' does not resolve to a tree (bad ref, or the path is a file/absent at that ref)`,
    }
  }
  const lines = raw.split('\n').filter(l => l.length > 0)
  const entries: GitTreeEntry[] = lines.slice(0, MAX_TREE_ENTRIES).map(line => {
    // <mode> <type> <object> <size>\t<name>
    const tab = line.indexOf('\t')
    const [mode = '', type = '', , sizeRaw = ''] = line.slice(0, tab).split(/\s+/)
    const name = line.slice(tab + 1)
    return {
      mode,
      type: type === 'blob' || type === 'tree' || type === 'commit' ? type : 'other',
      name,
      size: sizeRaw === '-' || sizeRaw === '' ? null : Number(sizeRaw),
    }
  })
  return { ref, path: subPath ?? '', entries, truncated: lines.length > MAX_TREE_ENTRIES }
}

export interface GitCompare {
  base: string
  head: string
  mergeBase: string
  ahead: number
  behind: number
  /** Commits reachable from head only (newest first, bounded). */
  commitsAhead: { sha: string; subject: string }[]
  /** Commits reachable from base only (newest first, bounded). */
  commitsBehind: { sha: string; subject: string }[]
  /** three-dot diffstat (merge-base..head), bounded. */
  files: { path: string; additions: number; deletions: number }[]
  filesTruncated: boolean
}

/** Ahead/behind + bounded commit lists + three-dot diffstat. */
export function gitCompare(root: string, base: string, head: string): GitCompare | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const counts = tryGit(root, ['rev-list', '--left-right', '--count', `${base}...${head}`])
  if (counts === null) {
    return { state: 'unavailable', note: `cannot compare '${base}...${head}' — check both refs resolve here` }
  }
  const [behindRaw = '0', aheadRaw = '0'] = counts.trim().split(/\s+/)
  const mergeBase = tryGit(root, ['merge-base', base, head])?.trim() ?? ''
  const list = (range: string): { sha: string; subject: string }[] =>
    (tryGit(root, ['log', '--format=%H%x09%s', `-${MAX_COMPARE_COMMITS}`, range]) ?? '')
      .split('\n')
      .filter(l => l.includes('\t'))
      .map(l => {
        const tab = l.indexOf('\t')
        return { sha: l.slice(0, tab), subject: l.slice(tab + 1) }
      })
  const numstat = tryGit(root, ['-c', 'core.quotepath=off', 'diff', '--numstat', `${base}...${head}`]) ?? ''
  const fileLines = numstat.split('\n').filter(l => l.includes('\t'))
  const files = fileLines.slice(0, MAX_COMPARE_FILES).map(l => {
    const [a = '-', d = '-', ...rest] = l.split('\t')
    return { path: rest.join('\t'), additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d) }
  })
  return {
    base,
    head,
    mergeBase,
    ahead: Number(aheadRaw),
    behind: Number(behindRaw),
    commitsAhead: list(`${base}..${head}`),
    commitsBehind: list(`${head}..${base}`),
    files,
    filesTruncated: fileLines.length > MAX_COMPARE_FILES,
  }
}
