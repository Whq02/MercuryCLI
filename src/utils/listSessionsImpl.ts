import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { getWorktreePathsPortable } from './getWorktreePathsPortable.js'
import {
  canonicalizePath,
  extractFirstPromptFromHead,
  extractJsonStringField,
  extractLastJsonStringField,
  findProjectDir,
  getProjectsDir,
  MAX_SANITIZED_LENGTH,
  readSessionLite,
  sanitizePath,
  validateUuid,
  type LiteSessionFile,
} from './sessionStoragePortable.js'

/**
 * Dependency-light session listing for the SDK. The import graph is the
 * contract: nothing here may wake the CLI up — no bootstrap state, no
 * analytics, no module-scope mutable state; only Node's own modules plus the
 * portable session-storage and worktree helpers.
 */

export type SessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  tag?: string
  createdAt?: number
}

export type ListSessionsOptions = {
  dir?: string
  /** 0 means unlimited. */
  limit?: number
  offset?: number
  /** Defaults to true. */
  includeWorktrees?: boolean
}

type Candidate = { sessionId: string; filePath: string; mtime: number; projectPath?: string }

const READ_BATCH = 32
const MERCURY_HEADER_MARKER = '"metaKind":"mercury-transcript-header"'

function lineIndicatesSidechain(line: string): boolean {
  return line.includes('"isSidechain":true') || line.includes('"isSidechain": true')
}

/**
 * Everything comes from the lite read (head + tail + stat) — never a full
 * transcript parse; all field probes are raw-text scans, since the head is a
 * fixed-size read whose last line is routinely truncated mid-record.
 */
function parseSessionInfoFromLite(sessionId: string, lite: LiteSessionFile, projectPath?: string): SessionInfo | null {
  const headLines = lite.head.split('\n')
  // Under the versioned format the first line is a header record; the
  // sidechain marker rides the first MESSAGE record.
  const probeLine = (headLines[0] ?? '').includes(MERCURY_HEADER_MARKER) ? (headLines[1] ?? '') : (headLines[0] ?? '')
  if (lineIndicatesSidechain(probeLine)) return null

  // A user-authored title wins over a model-generated one.
  const customTitle =
    extractLastJsonStringField(lite.tail, 'customTitle') ??
    extractLastJsonStringField(lite.head, 'customTitle') ??
    extractLastJsonStringField(lite.tail, 'aiTitle') ??
    extractLastJsonStringField(lite.head, 'aiTitle')

  const firstPrompt = extractFirstPromptFromHead(lite.head) || undefined

  let createdAt: number | undefined
  const firstTimestamp = extractJsonStringField(lite.head, 'timestamp')
  if (firstTimestamp) {
    const epoch = Date.parse(firstTimestamp)
    if (Number.isFinite(epoch)) createdAt = epoch
  }

  const summary =
    customTitle ??
    extractLastJsonStringField(lite.tail, 'lastPrompt') ??
    extractLastJsonStringField(lite.tail, 'summary') ??
    firstPrompt
  // Metadata-only sessions are not listed.
  if (!summary) return null

  const gitBranch = extractLastJsonStringField(lite.tail, 'gitBranch') ?? extractJsonStringField(lite.head, 'gitBranch')
  const cwd = extractJsonStringField(lite.head, 'cwd') ?? projectPath

  // Type-scoped: `tag` is a common tool parameter name, so only the last
  // tail line that IS a tag record is searched.
  let tag: string | undefined
  const tailLines = lite.tail.split('\n')
  for (let index = tailLines.length - 1; index >= 0; index--) {
    const line = tailLines[index] as string
    if (line.startsWith('{"type":"tag"')) {
      tag = extractJsonStringField(line, 'tag')
      break
    }
  }

  return {
    sessionId,
    summary,
    lastModified: lite.mtime,
    fileSize: lite.size,
    ...(customTitle ? { customTitle } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(cwd ? { cwd } : {}),
    ...(tag ? { tag } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

/** Exported live contract: the auto-dream consolidation lock enumerates candidates through this. */
export async function listCandidates(projectDir: string, doStat: boolean, projectPath?: string): Promise<Candidate[]> {
  let entries: string[]
  try {
    entries = await readdir(projectDir)
  } catch {
    return []
  }
  const jsonl = entries.filter(name => name.endsWith('.jsonl'))
  const results = await Promise.all(
    jsonl.map(async (name): Promise<Candidate | null> => {
      const stem = name.slice(0, -'.jsonl'.length)
      if (!validateUuid(stem)) return null
      const filePath = join(projectDir, name)
      if (!doStat) return { sessionId: stem, filePath, mtime: 0, ...(projectPath ? { projectPath } : {}) }
      try {
        const stats = await stat(filePath)
        return { sessionId: stem, filePath, mtime: stats.mtimeMs, ...(projectPath ? { projectPath } : {}) }
      } catch {
        return null
      }
    }),
  )
  return results.filter((candidate): candidate is Candidate => candidate !== null)
}

function byMtimeThenIdDesc(a: Candidate, b: Candidate): number {
  if (a.mtime !== b.mtime) return b.mtime - a.mtime
  return b.sessionId.localeCompare(a.sessionId)
}

async function readCandidate(candidate: Candidate, statRan: boolean): Promise<SessionInfo | null> {
  const lite = await readSessionLite(candidate.filePath)
  if (!lite) return null
  const info = parseSessionInfoFromLite(candidate.sessionId, lite, candidate.projectPath)
  if (!info) return null
  // When a stat pass ran, its mtime is the sort key and must agree with the
  // reported value; otherwise the content read's own mtime stands.
  if (statRan && candidate.mtime > 0) info.lastModified = candidate.mtime
  return info
}

async function gatherCandidates(options: ListSessionsOptions, doStat: boolean): Promise<Candidate[]> {
  const projectsRoot = getProjectsDir()
  if (!options.dir) {
    let entries: string[]
    try {
      entries = await readdir(projectsRoot)
    } catch {
      return []
    }
    const all: Candidate[][] = await Promise.all(
      entries.map(async name => {
        const dir = join(projectsRoot, name)
        try {
          if (!(await stat(dir)).isDirectory()) return []
        } catch {
          return []
        }
        return listCandidates(dir, doStat)
      }),
    )
    return all.flat()
  }

  const canonical = await canonicalizePath(options.dir)
  let worktrees: string[] = []
  if (options.includeWorktrees !== false) {
    try {
      worktrees = await getWorktreePathsPortable(canonical)
    } catch {
      worktrees = []
    }
  }

  const listSingle = async (): Promise<Candidate[]> => {
    const projectDir = await findProjectDir(canonical)
    if (!projectDir) return []
    return listCandidates(projectDir, doStat, canonical)
  }

  if (worktrees.length <= 1) return listSingle()

  // Worktree-aware scan: longest sanitised forms first so specific prefixes win.
  const isWindows = process.platform === 'win32'
  const formOf = (path: string): string => {
    const form = sanitizePath(path)
    return isWindows ? form.toLowerCase() : form
  }
  const worktreeForms = worktrees
    .map(path => ({ path, form: formOf(path) }))
    .sort((a, b) => b.form.length - a.form.length)

  let rootEntries: string[]
  try {
    rootEntries = await readdir(projectsRoot)
  } catch {
    return listSingle()
  }

  const results: Candidate[][] = []
  const seen = new Set<string>()
  // Always the caller's own project directory first (a caller in a
  // subdirectory of the repository matches no worktree root prefix).
  const ownDir = await findProjectDir(canonical)
  if (ownDir) {
    results.push(await listCandidates(ownDir, doStat, canonical))
    seen.add(isWindows ? ownDir.split(/[\\/]/).pop()!.toLowerCase() : ownDir.split(/[\\/]/).pop()!)
  }
  for (const entry of rootEntries) {
    const entryKey = isWindows ? entry.toLowerCase() : entry
    if (seen.has(entryKey)) continue
    const dir = join(projectsRoot, entry)
    try {
      if (!(await stat(dir)).isDirectory()) continue
    } catch {
      continue
    }
    for (const { path, form } of worktreeForms) {
      // Exact, or — only for a truncated (hash-suffixed) form — a prefix
      // followed by a hyphen; short names must not claim sibling directories.
      const matches =
        entryKey === form || (form.length >= MAX_SANITIZED_LENGTH && entryKey.startsWith(form) && entryKey[form.length] === '-')
      if (matches) {
        results.push(await listCandidates(dir, doStat, path))
        break
      }
    }
  }
  return results.flat()
}

export async function listSessionsImpl(options: ListSessionsOptions = {}): Promise<SessionInfo[]> {
  const limit = options.limit && options.limit > 0 ? options.limit : null
  const offset = options.offset && options.offset > 0 ? options.offset : 0
  const paginated = limit !== null || offset > 0

  if (!paginated) {
    // Read-all-then-sort: no stats at all (the pre-optimisation I/O cost).
    const candidates = await gatherCandidates(options, false)
    const reads = await Promise.all(candidates.map(candidate => readCandidate(candidate, false).then(info => ({ candidate, info }))))
    // De-duplicate by session id keeping the newest by modification time.
    const bySession = new Map<string, SessionInfo>()
    for (const { info } of reads) {
      if (!info) continue
      const existing = bySession.get(info.sessionId)
      if (!existing || info.lastModified > existing.lastModified) bySession.set(info.sessionId, info)
    }
    return [...bySession.values()].sort((a, b) =>
      a.lastModified !== b.lastModified ? b.lastModified - a.lastModified : b.sessionId.localeCompare(a.sessionId),
    )
  }

  // Stat-then-page: sort by metadata first, then read only what the page needs.
  const candidates = (await gatherCandidates(options, true)).sort(byMtimeThenIdDesc)
  const collected: SessionInfo[] = []
  // De-duplication AFTER the content read: newest-first order makes the first
  // successful read per id the newest valid copy, so a session whose
  // freshest file is unreadable still appears via an older readable twin.
  const seenIds = new Set<string>()
  let discarded = 0
  for (let start = 0; start < candidates.length; start += READ_BATCH) {
    const batch = candidates.slice(start, start + READ_BATCH)
    const reads = await Promise.all(batch.map(candidate => readCandidate(candidate, true)))
    for (const info of reads) {
      if (!info) continue
      if (seenIds.has(info.sessionId)) continue
      seenIds.add(info.sessionId)
      if (discarded < offset) {
        discarded++
        continue
      }
      collected.push(info)
      if (limit !== null && collected.length >= limit) return collected
    }
  }
  return collected
}
