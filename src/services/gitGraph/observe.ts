
import { execFile, execFileSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { projectScopePathspec } from '../../utils/projectBoundary.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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
const GIT_TIMEOUT_MS = 30_000

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    windowsHide: true,
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    env: { ...subprocessEnv(), GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function gitAsync(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
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

async function tryGitAsync(root: string, args: string[]): Promise<AsyncProbe> {
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

const notARepoNote = (failure: string | null): GitUnavailable => ({
  state: 'unavailable',
  note: `not a git repository (or git is not installed) — the work graph needs one${
    failure ? ` (git probe failed: ${failure})` : ''
  }`,
})

const notARepo = (): GitUnavailable => notARepoNote(lastProbeFailure)

export async function isGitRepoAsync(root: string): Promise<{ repo: boolean; failure: string | null }> {
  const probe = await tryGitAsync(root, ['rev-parse', '--is-inside-work-tree'])
  if (probe.out === null) return { repo: false, failure: probe.failure }
  return { repo: probe.out.trim() === 'true', failure: null }
}

async function classifyAsyncFailure(root: string, failure: string | null, note: string): Promise<GitUnavailable> {
  const probe = await isGitRepoAsync(root)
  const mechanism = probe.failure ?? failure
  if (!probe.repo) return { ...notARepoNote(mechanism), ...(mechanism !== null && { failure: mechanism }) }
  return { state: 'unavailable', note: failure ? `${note} (${failure})` : note, ...(failure !== null && { failure }) }
}


const STATUS_ARGS = (root: string): string[] =>
  ['-c', 'status.relativePaths=true', 'status', '--porcelain=v2', '--branch', ...projectScopePathspec(root)]

type ParsedStatus = Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'files'>

function parseStatusV2(raw: string): ParsedStatus {
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
  return { branch, upstream, ahead, behind, files }
}

function digestFiles(files: GitStatus['files']): GitStatus['files'] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path)).slice(0, 500)
}

function composeStatus(root: string, head: string, parsed: ParsedStatus, hasher: ReturnType<typeof createHash>): GitStatus {
  return {
    root,
    ...parsed,
    head,
    digest: hasher.digest('hex').slice(0, 16),
    clean: parsed.files.length === 0,
  }
}

export function gitStatus(root: string): GitStatus | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const raw = tryGit(root, STATUS_ARGS(root))
  if (raw === null) return notARepo()
  const head = tryGit(root, ['rev-parse', 'HEAD'])?.trim() ?? '(unborn)'
  const parsed = parseStatusV2(raw)
  const hasher = createHash('sha1').update(`${head}\n${raw}`)
  for (const f of digestFiles(parsed.files)) {
    try {
      hasher.update(`\n${f.path}\0`)
      hasher.update(readFileSync(joinPath(root, f.path)))
    } catch {
      hasher.update(`\n${f.path}\0DELETED`)
    }
  }
  return composeStatus(root, head, parsed, hasher)
}

export async function gitStatusAsync(root: string): Promise<GitStatus | GitUnavailable> {
  const status = await tryGitAsync(root, STATUS_ARGS(root))
  if (status.out === null) return classifyAsyncFailure(root, status.failure, 'git status failed')
  const head = (await tryGitAsync(root, ['rev-parse', 'HEAD'])).out?.trim() ?? '(unborn)'
  const raw = status.out
  const parsed = parseStatusV2(raw)
  const hasher = createHash('sha1').update(`${head}\n${raw}`)
  for (const f of digestFiles(parsed.files)) {
    try {
      hasher.update(`\n${f.path}\0`)
      hasher.update(await readFile(joinPath(root, f.path)))
    } catch {
      hasher.update(`\n${f.path}\0DELETED`)
    }
  }
  return composeStatus(root, head, parsed, hasher)
}


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


export function gitWorktrees(root: string): GitWorktreeInfo[] | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const raw = tryGit(root, ['worktree', 'list', '--porcelain'])
  if (raw === null) return { state: 'unavailable', note: 'git worktree list failed' }
  return parseWorktreeList(raw)
}

export async function gitWorktreesAsync(root: string): Promise<GitWorktreeInfo[] | GitUnavailable> {
  const list = await tryGitAsync(root, ['worktree', 'list', '--porcelain'])
  if (list.out === null) return classifyAsyncFailure(root, list.failure, 'git worktree list failed')
  return parseWorktreeList(list.out)
}

function parseWorktreeList(raw: string): GitWorktreeInfo[] {
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


const MAX_FILE_AT_REF_BYTES = 400_000
const MAX_TREE_ENTRIES = 500
const MAX_COMPARE_COMMITS = 20
const MAX_COMPARE_FILES = 60

export interface GitFileAtRef {
  ref: string
  path: string
  text: string
  bytes: number
  truncated: boolean
  binary: boolean
}

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

export function gitFileAtRef(root: string, ref: string, filePath: string): GitFileAtRef | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const raw: string | null = tryGit(root, ['show', `${ref}:${filePath}`])
  if (raw === null) {
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

export function gitTreeAtRef(root: string, ref: string, subPath?: string): GitTreeAtRef | GitUnavailable {
  if (!isGitRepo(root)) return notARepo()
  const spec = subPath ? `${ref}:${subPath}` : ref
  const raw = tryGit(root, ['-c', 'core.quotepath=off', 'ls-tree', '-l', spec])
  if (raw === null) {
    return {
      state: 'unavailable',
      note: `'${spec}' does not resolve to a tree (bad ref, or the path is a file/absent at that ref)`,
    }
  }
  const lines = raw.split('\n').filter(l => l.length > 0)
  const entries: GitTreeEntry[] = lines.slice(0, MAX_TREE_ENTRIES).map(line => {
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
  commitsAhead: { sha: string; subject: string }[]
  commitsBehind: { sha: string; subject: string }[]
  files: { path: string; additions: number; deletions: number }[]
  filesTruncated: boolean
}

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
