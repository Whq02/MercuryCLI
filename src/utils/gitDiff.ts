import { dirname, join, relative, sep } from 'node:path'

import { getCwd } from './cwd.js'
import { getCachedRepository } from './detectRepository.js'
import type { StructuredPatchHunk } from './diff.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { isFileWithinReadSizeLimit } from './file.js'
import { findGitRoot, getDefaultBranch, getIsGit, gitExe } from './git.js'
import { resolveGitDir } from './git/gitFilesystem.js'

/**
 * Diff statistics and hunks for the status line, the diff surfaces, and
 * tool-use diffs.
 */

const GIT_TIMEOUT_MS = 5000
const SINGLE_FILE_TIMEOUT_MS = 3000
const MAX_FILES_DETAILED = 50
const MAX_FILE_DIFF_BYTES = 1024 * 1024
const MAX_LINES_PER_FILE = 400
const MAX_CHANGED_FILES_FOR_DETAIL = 500

export type GitDiffStats = {
  filesCount: number
  linesAdded: number
  linesRemoved: number
}

export type PerFileStats = {
  added: number
  removed: number
  isBinary: boolean
  isUntracked?: boolean
}

export type GitDiffResult = {
  stats: GitDiffStats
  perFileStats: Map<string, PerFileStats>
  /** Always empty from the stats entry points; hunks are on demand. */
  hunks: Map<string, StructuredPatchHunk[]>
}

export type NumstatResult = {
  stats: GitDiffStats
  perFileStats: Map<string, PerFileStats>
}

export type ToolUseDiff = {
  filename: string
  status: 'added' | 'modified'
  additions: number
  deletions: number
  changes: number
  patch: string
  repository?: string | null
}

export type GitDiffSpec = {
  /** The selector passed to the diff command. */
  args: string[]
  cwd?: string
  includeUntracked?: boolean
}

// ---------------------------------------------------------------------------
// Transient-state refusal (two DIFFERENT marker sets, deliberately)
// ---------------------------------------------------------------------------

async function pathExistsAny(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises')
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Session cwd: git dir via the filesystem helper (no spawn), four marker FILES. */
async function isTransientState(): Promise<boolean> {
  const gitDir = await resolveGitDir()
  if (!gitDir) return false
  const markers = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
  const present = await Promise.all(markers.map(marker => pathExistsAny(join(gitDir, marker))))
  return present.some(Boolean)
}

/** Explicit directory: git dir via `rev-parse --git-dir`; drops REBASE_HEAD, gains the two rebase state directories. */
async function isTransientStateIn(cwd: string): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(gitExe(), ['rev-parse', '--git-dir'], { cwd, preserveOutputOnError: false })
  if (result.code !== 0) return false
  const { isAbsolute } = await import('node:path')
  const answer = result.stdout.trim()
  const gitDir = isAbsolute(answer) ? answer : join(cwd, answer)
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
  const present = await Promise.all(markers.map(marker => pathExistsAny(join(gitDir, marker))))
  return present.some(Boolean)
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** `added<TAB>removed<TAB>path`; a dash count marks a binary file (zero contribution, still counted). */
export function parseGitNumstat(stdout: string): NumstatResult {
  const perFileStats = new Map<string, PerFileStats>()
  let filesCount = 0
  let linesAdded = 0
  let linesRemoved = 0
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const addedRaw = parts[0] as string
    const removedRaw = parts[1] as string
    // The path may itself contain tabs.
    const path = parts.slice(2).join('\t')
    const isBinary = addedRaw === '-' || removedRaw === '-'
    const added = isBinary ? 0 : parseInt(addedRaw, 10) || 0
    const removed = isBinary ? 0 : parseInt(removedRaw, 10) || 0
    filesCount++
    linesAdded += added
    linesRemoved += removed
    if (perFileStats.size < MAX_FILES_DETAILED) {
      perFileStats.set(path, { added, removed, isBinary })
    }
  }
  return { stats: { filesCount, linesAdded, linesRemoved }, perFileStats }
}

/**
 * Split on file-diff headers (the split consumes `diff --git`, so each
 * segment begins with the `a/… b/…` remainder). Stored lines are forced
 * into flat copies — split results are views into the parent string and
 * would otherwise retain the whole multi-megabyte diff.
 */
export function parseGitDiff(stdout: string): Map<string, StructuredPatchHunk[]> {
  const result = new Map<string, StructuredPatchHunk[]>()
  const segments = stdout.split(/^diff --git /m).slice(1)
  let files = 0
  for (const segment of segments) {
    if (files >= MAX_FILES_DETAILED) break
    if (segment.length > MAX_FILE_DIFF_BYTES) continue
    const lines = segment.split('\n')
    const header = /^a\/(.+?) b\/(.+)$/.exec(lines[0] as string)
    if (!header) continue
    files++
    const path = header[2] as string
    const hunks: StructuredPatchHunk[] = []
    let open: StructuredPatchHunk | null = null
    let storedLines = 0
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] as string
      const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (hunkHeader) {
        if (open) hunks.push(open)
        open = {
          oldStart: Number(hunkHeader[1]),
          oldLines: hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]),
          newStart: Number(hunkHeader[3]),
          newLines: hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]),
          lines: [],
        }
        continue
      }
      if (
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('old mode') ||
        line.startsWith('new mode') ||
        line.startsWith('Binary files')
      ) {
        continue
      }
      if (!open) continue
      // The segment's final empty string is the trailing-newline artifact,
      // not a hunk line.
      if (line === '' && i === lines.length - 1) continue
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
        if (storedLines < MAX_LINES_PER_FILE) {
          // Force a flat string copy.
          open.lines.push((' ' + line).slice(1))
          storedLines++
        }
      }
    }
    if (open) hunks.push(open)
    if (hunks.length > 0) result.set(path, hunks)
  }
  return result
}

/** "N files changed, N insertions(+), N deletions(-)" with optional groups. */
export function parseShortstat(stdout: string): GitDiffStats | null {
  const match = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stdout)
  if (!match) return null
  return {
    filesCount: Number(match[1]),
    linesAdded: match[2] === undefined ? 0 : Number(match[2]),
    linesRemoved: match[3] === undefined ? 0 : Number(match[3]),
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function listUntracked(cwd?: string): Promise<string[] | null> {
  const args = ['ls-files', '--others', '--exclude-standard']
  const result = cwd
    ? await execFileNoThrowWithCwd(gitExe(), args, { cwd, timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false })
    : await execFileNoThrow(gitExe(), args, { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false })
  if (result.code !== 0) return null
  return result.stdout.split('\n').filter(line => line.length > 0)
}

async function fetchDiffCore(spec: GitDiffSpec, checkRepository: boolean): Promise<GitDiffResult | null> {
  if (checkRepository && !(await getIsGit())) return null
  if (spec.cwd ? await isTransientStateIn(spec.cwd) : await isTransientState()) return null
  const run = (args: string[]) =>
    spec.cwd
      ? execFileNoThrowWithCwd(gitExe(), args, { cwd: spec.cwd, timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false })
      : execFileNoThrow(gitExe(), args, { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false })

  // A short-stat probe (constant memory) first: past the detail cap, return
  // accurate totals with EMPTY per-file maps.
  const shortstat = await run(['diff', '--shortstat', ...spec.args])
  const quick = shortstat.code === 0 ? parseShortstat(shortstat.stdout) : null
  if (spec.cwd !== undefined && quick === null && shortstat.code !== 0) return null
  if (quick && quick.filesCount > MAX_CHANGED_FILES_FOR_DETAIL) {
    return { stats: quick, perFileStats: new Map(), hunks: new Map() }
  }
  const numstat = await run(['diff', '--numstat', ...spec.args])
  if (numstat.code !== 0) return null
  const parsed = parseGitNumstat(numstat.stdout)
  const wantUntracked = spec.cwd === undefined ? true : Boolean(spec.includeUntracked)
  if (wantUntracked && parsed.perFileStats.size < MAX_FILES_DETAILED) {
    const untracked = await listUntracked(spec.cwd)
    if (untracked) {
      const room = MAX_FILES_DETAILED - parsed.perFileStats.size
      const added = untracked.slice(0, room)
      for (const path of added) {
        parsed.perFileStats.set(path, { added: 0, removed: 0, isBinary: false, isUntracked: true })
      }
      parsed.stats.filesCount += added.length
    }
  }
  return { stats: parsed.stats, perFileStats: parsed.perFileStats, hunks: new Map() }
}

/** The status-line diff against head; hunks are on demand. */
export async function fetchGitDiff(): Promise<GitDiffResult | null> {
  return fetchDiffCore({ args: ['HEAD'] }, true)
}

/** The parameterised sources; a given working directory skips the repo re-check but probes ITS transient state. */
export async function fetchGitDiffFor(spec: GitDiffSpec): Promise<GitDiffResult | null> {
  return fetchDiffCore(spec, spec.cwd === undefined)
}

async function fetchHunksCore(spec: GitDiffSpec, checkRepository: boolean): Promise<Map<string, StructuredPatchHunk[]>> {
  try {
    if (checkRepository && !(await getIsGit())) return new Map()
    if (spec.cwd ? await isTransientStateIn(spec.cwd) : await isTransientState()) return new Map()
    const result = spec.cwd
      ? await execFileNoThrowWithCwd(gitExe(), ['diff', ...spec.args], { cwd: spec.cwd, timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false })
      : await execFileNoThrow(gitExe(), ['diff', ...spec.args], { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false })
    if (result.code !== 0) return new Map()
    return parseGitDiff(result.stdout)
  } catch {
    return new Map()
  }
}

export async function fetchGitDiffHunks(): Promise<Map<string, StructuredPatchHunk[]>> {
  return fetchHunksCore({ args: ['HEAD'] }, true)
}

export async function fetchGitDiffHunksFor(spec: GitDiffSpec): Promise<Map<string, StructuredPatchHunk[]>> {
  return fetchHunksCore(spec, spec.cwd === undefined)
}

/**
 * The branch-vs-base selector: try the merge base of `origin/<default>` and
 * then `<default>` with head; the first non-empty success yields
 * `<sha>...HEAD` plus the base used. Never guess a base.
 */
export async function branchDiffSpec(): Promise<{ spec: GitDiffSpec; base: string } | null> {
  if (!(await getIsGit())) return null
  const defaultBranch = await getDefaultBranch()
  if (!defaultBranch) return null
  for (const base of [`origin/${defaultBranch}`, defaultBranch]) {
    const mergeBase = await execFileNoThrow(gitExe(), ['merge-base', base, 'HEAD'], {
      timeout: GIT_TIMEOUT_MS,
      preserveOutputOnError: false,
    })
    const sha = mergeBase.stdout.trim()
    if (mergeBase.code === 0 && sha !== '') {
      return { spec: { args: [`${sha}...HEAD`] }, base }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Single-file, PR-shaped diff
// ---------------------------------------------------------------------------

/**
 * The base BRANCH is the resolved default; the reference is the merge base
 * of head with it, falling back to head when the merge-base fails or
 * prints nothing.
 */
async function resolveDiffReference(repoRoot: string, defaultBranch: string): Promise<string> {
  const mergeBase = await execFileNoThrowWithCwd(gitExe(), ['merge-base', 'HEAD', defaultBranch], {
    cwd: repoRoot,
    timeout: SINGLE_FILE_TIMEOUT_MS,
    preserveOutputOnError: false,
  })
  const sha = mergeBase.stdout.trim()
  return mergeBase.code === 0 && sha !== '' ? sha : 'HEAD'
}

function parseRawDiff(raw: string): { additions: number; deletions: number; patch: string } {
  let additions = 0
  let deletions = 0
  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  const firstHunk = raw.indexOf('@@')
  return { additions, deletions, patch: firstHunk === -1 ? '' : raw.slice(firstHunk) }
}

export async function fetchSingleFileGitDiff(absoluteFilePath: string): Promise<ToolUseDiff | null> {
  try {
    const repoRoot = findGitRoot(dirname(absoluteFilePath))
    if (!repoRoot) return null
    const filename = relative(repoRoot, absoluteFilePath).split(sep).join('/')
    const repository = getCachedRepository()
    const tracked = await execFileNoThrowWithCwd(gitExe(), ['ls-files', '--error-unmatch', '--', filename], {
      cwd: repoRoot,
      timeout: SINGLE_FILE_TIMEOUT_MS,
      preserveOutputOnError: false,
    })
    if (tracked.code === 0) {
      // The default branch fed here is the SESSION working directory's
      // cached one, not one resolved for the file's repository.
      const reference = await resolveDiffReference(repoRoot, await getDefaultBranch())
      const diff = await execFileNoThrowWithCwd(gitExe(), ['diff', reference, '--', filename], {
        cwd: repoRoot,
        timeout: SINGLE_FILE_TIMEOUT_MS,
        preserveOutputOnError: false,
      })
      if (diff.code !== 0 || diff.stdout.trim() === '') return null
      const { additions, deletions, patch } = parseRawDiff(diff.stdout)
      return { filename, status: 'modified', additions, deletions, changes: additions + deletions, patch, repository }
    }
    // Untracked: a synthetic all-additions diff.
    if (!isFileWithinReadSizeLimit(absoluteFilePath, MAX_FILE_DIFF_BYTES)) return null
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(absoluteFilePath, 'utf8')
    const lines = content.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const patch = `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}`
    return { filename, status: 'added', additions: lines.length, deletions: 0, changes: lines.length, patch, repository }
  } catch {
    return null
  }
}
