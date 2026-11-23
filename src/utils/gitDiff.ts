import { join, resolve } from 'node:path'

import type { StructuredPatchHunk } from './diff.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getDefaultBranch, getIsGit, gitExe } from './git.js'
import { resolveGitDir } from './git/gitFilesystem.js'
import { getErrnoCode, isENOENT } from './errors.js'


const GIT_TIMEOUT_MS = 5_000
const MAX_DETAIL_FILES = 200
const MAX_FILE_CHUNK_CHARS = 500_000
const MAX_LINES_PER_FILE = 400

export type GitDiffStats = {
  filesCount: number
  linesAdded: number
  linesRemoved: number
}

type GitDiffPerFileStats = {
  linesAdded: number
  linesRemoved: number
  isBinary: boolean
  isUntracked?: boolean
}

export type GitDiffResult = {
  stats: GitDiffStats
  perFileStats: Map<string, GitDiffPerFileStats>
  hunks: Map<string, StructuredPatchHunk[]>
}

export type GitDiffSpec = {
  args: string[]
  cwd?: string
  includeUntracked?: boolean
}


async function pathExistsAny(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises')
    await stat(path)
    return true
  } catch (error) {
    if (isENOENT(error) || getErrnoCode(error) === 'ENOTDIR') return false
    throw error
  }
}

async function isTransientState(): Promise<boolean> {
  const gitDir = await resolveGitDir()
  if (!gitDir) return false
  for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (await pathExistsAny(join(gitDir, marker))) return true
  }
  return false
}

async function isTransientStateIn(cwd: string): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(gitExe(), ['rev-parse', '--git-dir'], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    preserveOutputOnError: false,
  })
  if (result.code !== 0) return false
  const raw = result.stdout.trim()
  if (raw === '') return false
  const gitDir = resolve(cwd, raw)
  for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (await pathExistsAny(join(gitDir, marker))) return true
  }
  return false
}

function parseGitDiff(stdout: string): Map<string, StructuredPatchHunk[]> {
  const result = new Map<string, StructuredPatchHunk[]>()
  if (!stdout) return result

  const chunks = stdout.split(/^diff --git /m)
  for (let chunkIndex = 1; chunkIndex < chunks.length; chunkIndex++) {
    if (result.size >= MAX_DETAIL_FILES) break
    const chunk = chunks[chunkIndex]
    if (!chunk || chunk.length > MAX_FILE_CHUNK_CHARS) continue

    const lines = chunk.split('\n')
    const headerLine = lines[0] ?? ''
    const headerMatch = /^a\/.+ b\/(.+)$/.exec(headerLine)
    let filePath = headerMatch ? headerMatch[1] : undefined

    const hunks: StructuredPatchHunk[] = []
    let currentHunk: StructuredPatchHunk | null = null
    let storedLines = 0

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!
      if (currentHunk === null) {
        if (line.startsWith('+++ b/')) {
          filePath = line.slice('+++ b/'.length)
          continue
        }
        if (
          line.startsWith('--- ') ||
          line.startsWith('+++ ') ||
          line.startsWith('index ') ||
          line.startsWith('old mode ') ||
          line.startsWith('new mode ') ||
          line.startsWith('deleted file mode ') ||
          line.startsWith('new file mode ') ||
          line.startsWith('copy from ') ||
          line.startsWith('copy to ') ||
          line.startsWith('rename from ') ||
          line.startsWith('rename to ') ||
          line.startsWith('similarity index ') ||
          line.startsWith('dissimilarity index ') ||
          line.startsWith('Binary files ') ||
          line.startsWith('GIT binary patch')
        ) {
          continue
        }
      }

      if (line.startsWith('@@ ')) {
        const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (!hunkMatch) continue
        const rawOldStart = Number(hunkMatch[1])
        const oldLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2])
        const rawNewStart = Number(hunkMatch[3])
        const newLines = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4])
        const oldStart = oldLines === 0 ? rawOldStart + 1 : rawOldStart
        const newStart = newLines === 0 ? rawNewStart + 1 : rawNewStart
        currentHunk = {
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: [],
        }
        hunks.push(currentHunk)
        continue
      }

      if (currentHunk === null) continue
      if (line.startsWith('\\')) continue
      if (
        line.startsWith(' ') ||
        line.startsWith('+') ||
        line.startsWith('-') ||
        (line === '' && i < lines.length - 1)
      ) {
        if (storedLines < MAX_LINES_PER_FILE) {
          currentHunk.lines.push(line)
          storedLines++
        }
      }
    }

    if (filePath && hunks.length > 0) {
      result.set(filePath, hunks)
    }
  }

  return result
}

function parseShortstat(stdout: string): GitDiffStats | null {
  const match = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stdout)
  if (!match) return null
  return {
    filesCount: Number(match[1]),
    linesAdded: match[2] === undefined ? 0 : Number(match[2]),
    linesRemoved: match[3] === undefined ? 0 : Number(match[3]),
  }
}


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

  const runGit = (args: string[]) =>
    spec.cwd
      ? execFileNoThrowWithCwd(gitExe(), args, { cwd: spec.cwd, timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false })
      : execFileNoThrow(gitExe(), args, { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false })

  const shortstatResult = await runGit(['diff', '--shortstat', ...spec.args])
  if (spec.cwd !== undefined && shortstatResult.code !== 0) return null

  const shortstat = shortstatResult.code === 0 ? parseShortstat(shortstatResult.stdout) : null
  if (shortstat !== null && shortstat.filesCount > MAX_DETAIL_FILES) {
    return {
      stats: shortstat,
      perFileStats: new Map(),
      hunks: new Map(),
    }
  }

  const numstatResult = await runGit(['diff', '--numstat', ...spec.args])
  if (numstatResult.code !== 0) return null

  const perFileStats = new Map<string, GitDiffPerFileStats>()
  let totalAdded = 0
  let totalRemoved = 0
  for (const line of numstatResult.stdout.split('\n')) {
    if (!line) continue
    const firstTab = line.indexOf('\t')
    if (firstTab === -1) continue
    const secondTab = line.indexOf('\t', firstTab + 1)
    if (secondTab === -1) continue
    const addedRaw = line.slice(0, firstTab)
    const removedRaw = line.slice(firstTab + 1, secondTab)
    const filePath = line.slice(secondTab + 1)
    if (!filePath) continue
    const isBinary = addedRaw === '-' || removedRaw === '-'
    const linesAdded = isBinary ? 0 : Number(addedRaw) || 0
    const linesRemoved = isBinary ? 0 : Number(removedRaw) || 0
    totalAdded += linesAdded
    totalRemoved += linesRemoved
    if (perFileStats.size < MAX_DETAIL_FILES) {
      perFileStats.set(filePath, { linesAdded, linesRemoved, isBinary })
    }
  }

  const stats: GitDiffStats = shortstat
    ? { ...shortstat }
    : {
        filesCount: perFileStats.size,
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
      }

  const includeUntracked = spec.includeUntracked ?? spec.cwd === undefined
  if (includeUntracked) {
    const untracked = await listUntracked(spec.cwd)
    if (untracked && untracked.length > 0) {
      let addedUntracked = 0
      for (const filePath of untracked) {
        if (perFileStats.has(filePath)) continue
        addedUntracked++
        if (perFileStats.size < MAX_DETAIL_FILES) {
          perFileStats.set(filePath, {
            linesAdded: 0,
            linesRemoved: 0,
            isBinary: false,
            isUntracked: true,
          })
        }
      }
      stats.filesCount += addedUntracked
    }
  }

  return {
    stats,
    perFileStats,
    hunks: new Map(),
  }
}

export async function fetchGitDiff(): Promise<GitDiffResult | null> {
  return fetchDiffCore({ args: ['HEAD'] }, true)
}

export async function fetchGitDiffFor(spec: GitDiffSpec): Promise<GitDiffResult | null> {
  return fetchDiffCore(spec, spec.cwd === undefined)
}

async function fetchHunksCore(spec: GitDiffSpec, checkRepository: boolean): Promise<Map<string, StructuredPatchHunk[]>> {
  if (checkRepository && !(await getIsGit())) return new Map()
  if (spec.cwd ? await isTransientStateIn(spec.cwd) : await isTransientState()) return new Map()
  const result = spec.cwd
    ? await execFileNoThrowWithCwd(gitExe(), ['diff', ...spec.args], { cwd: spec.cwd, timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false })
    : await execFileNoThrow(gitExe(), ['diff', ...spec.args], { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false })
  if (result.code !== 0) return new Map()
  return parseGitDiff(result.stdout)
}

export async function fetchGitDiffHunks(): Promise<Map<string, StructuredPatchHunk[]>> {
  return fetchHunksCore({ args: ['HEAD'] }, true)
}

export async function fetchGitDiffHunksFor(spec: GitDiffSpec): Promise<Map<string, StructuredPatchHunk[]>> {
  return fetchHunksCore(spec, spec.cwd === undefined)
}

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
