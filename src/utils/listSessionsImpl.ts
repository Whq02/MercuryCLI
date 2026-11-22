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
import { notBuilt, type Unbuilt } from '../pi/holes.js'


type SessionInfo = Unbuilt

type ListSessionsOptions = Unbuilt

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

export async function listSessionsImpl(options?: ListSessionsOptions): Promise<SessionInfo[]> {
  return notBuilt('src/utils/listSessionsImpl.ts:219')
}
