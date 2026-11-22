import { join } from 'node:path'

import type { StructuredPatchHunk } from './diff.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getDefaultBranch, getIsGit, gitExe } from './git.js'
import { resolveGitDir } from './git/gitFilesystem.js'
import { getErrnoCode, isENOENT } from './errors.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


const GIT_TIMEOUT_MS: Unbuilt = unbuilt('src/utils/gitDiff.ts:10')

export type GitDiffStats = Unbuilt

export type GitDiffResult = Unbuilt

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
  return notBuilt('src/utils/gitDiff.ts:58')
}

async function isTransientStateIn(cwd: string): Promise<boolean> {
  return notBuilt('src/utils/gitDiff.ts:66')
}

function parseGitDiff(stdout: string): Map<string, StructuredPatchHunk[]> {
  return notBuilt('src/utils/gitDiff.ts:103')
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
  return notBuilt('src/utils/gitDiff.ts:181')
}

export async function fetchGitDiff(): Promise<GitDiffResult | null> {
  return notBuilt('src/utils/gitDiff.ts:213')
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
