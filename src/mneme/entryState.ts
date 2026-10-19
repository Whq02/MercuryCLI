import { basename, isAbsolute, relative } from 'node:path'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { gitExe } from '../utils/git.js'
import { projectScopePathspec } from '../utils/projectBoundary.js'
import { readGitHead, resolveGitDir } from '../utils/git/gitFilesystem.js'
import { readLedger } from './ledger.js'
import { lookupTerms } from './mnemeLookup.js'
import type { LedgerEntry } from './types.js'

const STATE_SESSIONS_BACK = 3
const STATE_FILES_CAP = 60
const STATE_CHUNK_STEMS = 16
const STATUS_TIMEOUT_MS = 10_000

export interface ProjectState {
  branch: string | null
  files: string[]
  note: { text: string; session: number; at: string } | null
  at: string
}

const UNIT_BREAK = /[^a-zA-Z0-9_.\-/]+/
const NAME_BREAK = /[^a-zA-Z0-9]+/

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(NAME_BREAK)
    .filter(word => word.length >= 3)
}

export function branchWords(branch: string): string[] {
  return [branch, ...branch.split(/[/._-]+/).filter(word => word.length >= 3)]
}

export function fileWords(path: string, root: string | null): string[] {
  const out = [path]
  if (root !== null && isAbsolute(path)) {
    const rel = relative(root, path)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) out.push(rel)
  }
  const base = basename(path)
  if (base !== '' && base !== path) out.push(base)
  out.push(...nameWords(base))
  return out
}

export function stateUnits(state: ProjectState, root: string | null): string[] {
  const out: string[] = []
  if (state.branch !== null) out.push(...branchWords(state.branch))
  for (const file of state.files) out.push(...fileWords(file, root))
  if (state.note !== null) out.push(...state.note.text.split(UNIT_BREAK))
  return out.filter(unit => unit !== '')
}

export function stateQueryChunks(units: readonly string[], chunkStems: number = STATE_CHUNK_STEMS): string[] {
  const seen = new Set<string>()
  const chunks: string[][] = []
  let open: string[] = []
  let openStems = 0
  for (const unit of units) {
    const fresh = lookupTerms(unit).filter(stem => !seen.has(stem))
    if (fresh.length === 0) continue
    for (const stem of fresh) seen.add(stem)
    if (openStems + fresh.length > chunkStems && open.length > 0) {
      chunks.push(open)
      open = []
      openStems = 0
    }
    open.push(unit)
    openStems += fresh.length
  }
  if (open.length > 0) chunks.push(open)
  return chunks.map(chunk => chunk.join(' '))
}

export function stateQuery(state: ProjectState, root: string | null): string[] {
  return stateQueryChunks(stateUnits(state, root))
}

export function lastNoteOf(previous: readonly LedgerEntry[]): ProjectState['note'] {
  const noted = [...previous].reverse().find(entry => entry.handoff !== null) ?? null
  if (noted === null || noted.handoff === null) return null
  return { text: noted.handoff.text, session: noted.ordinal, at: noted.handoff.at }
}

function ledgerFilesOf(previous: readonly LedgerEntry[], back: number = STATE_SESSIONS_BACK): string[] {
  return previous.slice(-back).reverse().flatMap(entry => entry.files)
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

async function readBranch(root: string): Promise<string | null> {
  try {
    const gitDir = await resolveGitDir(root)
    if (gitDir === null) return null
    const head = await readGitHead(gitDir)
    return head !== null && head.type === 'branch' ? head.name : null
  } catch {
    return null
  }
}

export function parseStatusPaths(porcelain: string): string[] {
  const out: string[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    if (path !== '') out.push(path)
  }
  return out
}

async function readModifiedFiles(root: string): Promise<string[]> {
  try {
    const result = await execFileNoThrowWithCwd(gitExe(), ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal', ...projectScopePathspec(root)], {
      cwd: root,
      preserveOutputOnError: false,
      timeout: STATUS_TIMEOUT_MS,
    })
    if (result.code !== 0) return []
    return parseStatusPaths(result.stdout)
  } catch {
    return []
  }
}

export async function readProjectState(input: { projectKey: string; sessionId?: string; root: string; now?: Date; ledger?: readonly LedgerEntry[] }): Promise<ProjectState> {
  const now = input.now ?? new Date()
  const previous = (input.ledger ?? readLedger(input.projectKey)).filter(entry => entry.sessionId !== input.sessionId)
  const [branch, modified] = await Promise.all([readBranch(input.root), readModifiedFiles(input.root)])
  return {
    branch,
    files: dedupe([...modified, ...ledgerFilesOf(previous)]).slice(0, STATE_FILES_CAP),
    note: lastNoteOf(previous),
    at: now.toISOString(),
  }
}
