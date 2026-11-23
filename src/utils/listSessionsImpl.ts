import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { getWorktreePathsPortable } from './getWorktreePathsPortable.js'
import { missionGoalBeside } from './mission/missionCard.js'
import { promptLabel, sessionFiles, sessionPromptFromWindow } from './sessionStorage/sessionIndex.js'
import {
  canonicalizePath,
  extractJsonStringField,
  extractLastJsonStringField,
  findProjectDir,
  getProjectsDir,
  MAX_SANITIZED_LENGTH,
  readSessionLite,
  sanitizePath,
  type LiteSessionFile,
} from './sessionStoragePortable.js'
import { passedOver } from './passedOver.js'
import { foldPathCase } from './platform/paths.js'


type SessionInfo = {
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

type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeWorktrees?: boolean
}

type Candidate = { sessionId: string; filePath: string; mtime: number; projectPath?: string }

const READ_BATCH = 32
const MERCURY_HEADER_MARKER = '"metaKind":"mercury-transcript-header"'

function lineIndicatesSidechain(line: string): boolean {
  return line.includes('"isSidechain":true') || line.includes('"isSidechain": true')
}

async function listCandidates(projectDir: string, doStat: boolean, projectPath?: string): Promise<Candidate[]> {
  const files = await sessionFiles(projectDir, { stat: doStat })
  return files.map(file => ({ sessionId: file.sessionId, filePath: file.path, mtime: file.mtime, ...(projectPath ? { projectPath } : {}) }))
}

function byMtimeThenIdDesc(a: Candidate, b: Candidate): number {
  if (a.mtime !== b.mtime) return b.mtime - a.mtime
  return b.sessionId.localeCompare(a.sessionId)
}

function isAbsenceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function headIndicatesSidechain(head: string): boolean {
  let offset = 0
  let checked = 0
  while (offset < head.length && checked < 2) {
    const end = head.indexOf('\n', offset)
    const line = end === -1 ? head.slice(offset) : head.slice(offset, end)
    offset = end === -1 ? head.length : end + 1
    if (line.trim() === '') continue
    checked++
    if (lineIndicatesSidechain(line)) return true
    if (!line.includes(MERCURY_HEADER_MARKER)) break
  }
  return false
}

type TagScan = { found: true; tag: string | undefined } | { found: false }

function scanLastTagRecord(window: string): TagScan {
  const lines = window.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const isMetaTag = line.includes('"metaKind":"tag"') || line.includes('"metaKind": "tag"')
    const isLegacyTag = line.includes('"type":"tag"') || line.includes('"type": "tag"')
    if (!isMetaTag && !isLegacyTag) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      passedOver(error)
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const record = parsed as {
      type?: unknown
      tag?: unknown
      payload?: { kind?: unknown; metaKind?: unknown; fields?: { tag?: unknown } | null } | null
    }
    if (record.payload?.kind === 'session-meta' && record.payload.metaKind === 'tag') {
      const value = record.payload.fields?.tag
      if (typeof value === 'string') return { found: true, tag: value || undefined }
    } else if (record.type === 'tag' && typeof record.tag === 'string') {
      return { found: true, tag: record.tag || undefined }
    }
  }
  return { found: false }
}

function extractTag(head: string, tail: string): string | undefined {
  const fromTail = scanLastTagRecord(tail)
  if (fromTail.found) return fromTail.tag
  if (tail === head) return undefined
  const fromHead = scanLastTagRecord(head)
  return fromHead.found ? fromHead.tag : undefined
}

function parseSessionInfo(candidate: Candidate, lite: LiteSessionFile): SessionInfo | null {
  const { head, tail, mtime, size } = lite
  if (headIndicatesSidechain(head)) return null
  const customTitle =
    extractLastJsonStringField(tail, 'customTitle') ??
    extractLastJsonStringField(head, 'customTitle') ??
    extractLastJsonStringField(tail, 'aiTitle') ??
    extractLastJsonStringField(head, 'aiTitle')
  const missionGoal = missionGoalBeside(candidate.filePath)
  const firstPrompt = sessionPromptFromWindow(head, undefined, true)
  const tailSummary = extractLastJsonStringField(tail, 'summary')
  const lastPromptRaw = extractLastJsonStringField(tail, 'lastPrompt')
  const summary =
    customTitle ||
    (missionGoal ? promptLabel(missionGoal) : '') ||
    firstPrompt ||
    tailSummary ||
    (lastPromptRaw ? promptLabel(lastPromptRaw) : '')
  if (!summary) return null
  const gitBranch = extractLastJsonStringField(tail, 'gitBranch') ?? extractJsonStringField(head, 'gitBranch')
  const cwd = extractJsonStringField(head, 'cwd') ?? candidate.projectPath
  const tag = extractTag(head, tail)
  const firstTimestamp = extractJsonStringField(head, 'timestamp')
  const parsedCreatedAt = firstTimestamp ? Date.parse(firstTimestamp) : Number.NaN
  const createdAt = Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : undefined
  return {
    sessionId: candidate.sessionId,
    summary,
    lastModified: mtime,
    fileSize: size,
    ...(customTitle ? { customTitle } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(cwd ? { cwd } : {}),
    ...(tag ? { tag } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

async function readCandidate(candidate: Candidate): Promise<SessionInfo | null> {
  const lite = await readSessionLite(candidate.filePath)
  if (lite === null) return null
  return parseSessionInfo(candidate, lite)
}

async function collectAllProjectCandidates(doStat: boolean): Promise<Candidate[]> {
  const projectsDir = getProjectsDir()
  let entries: string[]
  try {
    entries = await readdir(projectsDir)
  } catch (error) {
    if (isAbsenceError(error)) {
      passedOver(error)
      return []
    }
    throw error
  }
  const dirs: string[] = []
  for (const entry of entries) {
    const full = join(projectsDir, entry)
    try {
      const info = await stat(full)
      if (info.isDirectory()) dirs.push(full)
    } catch (error) {
      if (isAbsenceError(error)) {
        passedOver(error)
        continue
      }
      throw error
    }
  }
  const lists = await Promise.all(dirs.map(dir => listCandidates(dir, doStat)))
  return lists.flat()
}

async function collectDirCandidates(
  dir: string,
  includeWorktrees: boolean,
  doStat: boolean,
): Promise<Candidate[]> {
  const canonicalDir = await canonicalizePath(dir)
  let worktrees: string[] = []
  if (includeWorktrees) {
    try {
      worktrees = await getWorktreePathsPortable(canonicalDir)
    } catch (error) {
      passedOver(error)
      worktrees = []
    }
  }
  if (!includeWorktrees || worktrees.length <= 1) {
    const projectDir = await findProjectDir(canonicalDir)
    if (!projectDir) return []
    return listCandidates(projectDir, doStat, canonicalDir)
  }

  const canonicalWorktrees: string[] = []
  const seenWorktrees = new Set<string>()
  for (const wt of [canonicalDir, ...worktrees]) {
    const resolved = await canonicalizePath(wt)
    const key = foldPathCase(resolved)
    if (seenWorktrees.has(key)) continue
    seenWorktrees.add(key)
    canonicalWorktrees.push(resolved)
  }

  const exactByFoldedDir = new Map<string, string>()
  const matchers: Array<{ worktree: string; exactName: string; prefix: string }> = []
  for (const wt of canonicalWorktrees) {
    const found = await findProjectDir(wt)
    if (found) exactByFoldedDir.set(foldPathCase(found), wt)
    const sanitized = sanitizePath(wt)
    const exactName = foldPathCase(sanitized)
    const prefix = foldPathCase(
      sanitized.length > MAX_SANITIZED_LENGTH ? `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-` : `${sanitized}-`,
    )
    matchers.push({ worktree: wt, exactName, prefix })
  }

  const projectsDir = getProjectsDir()
  let entries: string[]
  try {
    entries = await readdir(projectsDir)
  } catch (error) {
    if (isAbsenceError(error)) {
      passedOver(error)
      entries = []
    } else {
      throw error
    }
  }

  const matchedDirs = new Map<string, { dir: string; projectPath: string }>()
  for (const entry of entries) {
    const full = join(projectsDir, entry)
    try {
      const info = await stat(full)
      if (!info.isDirectory()) continue
    } catch (error) {
      if (isAbsenceError(error)) {
        passedOver(error)
        continue
      }
      throw error
    }
    const foldedFull = foldPathCase(full)
    const exactOwner = exactByFoldedDir.get(foldedFull)
    if (exactOwner !== undefined) {
      matchedDirs.set(foldedFull, { dir: full, projectPath: exactOwner })
      continue
    }
    const foldedEntry = foldPathCase(entry)
    for (const matcher of matchers) {
      if (foldedEntry === matcher.exactName || foldedEntry.startsWith(matcher.prefix)) {
        matchedDirs.set(foldedFull, { dir: full, projectPath: matcher.worktree })
        break
      }
    }
  }

  for (const [foldedFull, wt] of exactByFoldedDir) {
    if (!matchedDirs.has(foldedFull)) {
      const found = await findProjectDir(wt)
      if (found) matchedDirs.set(foldedFull, { dir: found, projectPath: wt })
    }
  }

  const lists = await Promise.all(
    Array.from(matchedDirs.values(), ({ dir: storeDir, projectPath }) => listCandidates(storeDir, doStat, projectPath)),
  )
  return lists.flat()
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const existing = byId.get(candidate.sessionId)
    if (existing === undefined || candidate.mtime > existing.mtime) {
      byId.set(candidate.sessionId, candidate)
    }
  }
  return Array.from(byId.values())
}

export async function listSessionsImpl(options?: ListSessionsOptions): Promise<SessionInfo[]> {
  const offset = Math.max(0, options?.offset ?? 0)
  const limit = options?.limit
  if (limit !== undefined && limit <= 0) return []

  const hasLimit = limit !== undefined
  const rawCandidates = options?.dir
    ? await collectDirCandidates(options.dir, options.includeWorktrees ?? true, hasLimit)
    : await collectAllProjectCandidates(hasLimit)

  const candidates = dedupeCandidates(rawCandidates)
  if (hasLimit) candidates.sort(byMtimeThenIdDesc)

  const targetCount = hasLimit ? offset + limit : Number.POSITIVE_INFINITY
  const sessions: SessionInfo[] = []

  for (let i = 0; i < candidates.length; i += READ_BATCH) {
    const batch = candidates.slice(i, i + READ_BATCH)
    const rows = await Promise.all(batch.map(readCandidate))
    for (const row of rows) {
      if (row !== null) sessions.push(row)
    }
    if (sessions.length >= targetCount) break
  }

  sessions.sort((a, b) => {
    if (a.lastModified !== b.lastModified) return b.lastModified - a.lastModified
    return b.sessionId.localeCompare(a.sessionId)
  })

  return hasLimit ? sessions.slice(offset, offset + limit) : offset > 0 ? sessions.slice(offset) : sessions
}
