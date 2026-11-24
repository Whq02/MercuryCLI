import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { missionGoalBeside } from '../mission-card/missionCard.js'
import { promptLabel, sessionFiles, sessionPromptFromWindow } from './sessionIndex.js'
import {
  extractJsonStringField,
  extractLastJsonStringField,
  getProjectsDir,
  readSessionLite,
  type LiteSessionFile,
} from './sessionStoragePortable.js'
import { passedOver } from '../../platform/errors/passedOver.js'

type SessionInfo = {
  sessionId: string
  summary: string
  cwd?: string
}

type Candidate = { sessionId: string; filePath: string; mtime: number }

const READ_BATCH = 32
const MERCURY_HEADER_MARKER = '"metaKind":"mercury-transcript-header"'

function lineIndicatesSidechain(line: string): boolean {
  return line.includes('"isSidechain":true') || line.includes('"isSidechain": true')
}

async function listCandidates(projectDir: string): Promise<Candidate[]> {
  const files = await sessionFiles(projectDir, { stat: true })
  return files.map(file => ({ sessionId: file.sessionId, filePath: file.path, mtime: file.mtime }))
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

function parseSessionInfo(candidate: Candidate, lite: LiteSessionFile): SessionInfo | null {
  const { head, tail } = lite
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
  const cwd = extractJsonStringField(head, 'cwd')
  return { sessionId: candidate.sessionId, summary, ...(cwd ? { cwd } : {}) }
}

async function readCandidate(candidate: Candidate): Promise<SessionInfo | null> {
  const lite = await readSessionLite(candidate.filePath)
  if (lite === null) return null
  return parseSessionInfo(candidate, lite)
}

async function collectAllProjectCandidates(): Promise<Candidate[]> {
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
  const lists = await Promise.all(dirs.map(dir => listCandidates(dir)))
  return lists.flat()
}

export async function listSessionsImpl(options: { limit: number }): Promise<SessionInfo[]> {
  const candidates = await collectAllProjectCandidates()
  candidates.sort(byMtimeThenIdDesc)
  const seen = new Set<string>()
  const collected: SessionInfo[] = []

  for (let i = 0; i < candidates.length && collected.length < options.limit; i += READ_BATCH) {
    const batch = candidates.slice(i, i + READ_BATCH)
    const rows = await Promise.all(batch.map(readCandidate))
    for (const row of rows) {
      if (row === null || seen.has(row.sessionId)) continue
      seen.add(row.sessionId)
      collected.push(row)
      if (collected.length >= options.limit) break
    }
  }

  return collected
}
