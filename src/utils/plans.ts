import { readFileSync } from 'node:fs'
import { copyFile, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { getSessionId } from '../bootstrap/state.js'
import type { LogOption } from '../types/logs.js'
import { getCwd } from './cwd.js'
import { getMercuryHome } from './envUtils.js'
import { isENOENT } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import { getInitialSettings } from './settings/settings.js'
import { generateWordSlug } from './words.js'

/**
 * Per-session plan files: slug allocation, directory resolution, reads, and
 * carry-over on resume/fork.
 */

const SLUG_RETRIES = 10

const slugBySession = new Map<string, string>()

/** The cached slug, or a fresh word slug retried up to 10 times for a free filename (the last draw wins regardless). */
export function getPlanSlug(sessionId: string = getSessionId()): string {
  const cached = slugBySession.get(sessionId)
  if (cached) return cached
  const fs = getFsImplementation()
  const directory = getPlansDirectory()
  let slug = generateWordSlug()
  for (let attempt = 0; attempt < SLUG_RETRIES; attempt++) {
    slug = generateWordSlug()
    try {
      if (!fs.existsSync(join(directory, `${slug}.md`))) break
    } catch {
      break
    }
  }
  slugBySession.set(sessionId, slug)
  return slug
}

/** Used when resuming. */
export function setPlanSlug(sessionId: string, slug: string): void {
  slugBySession.set(sessionId, slug)
}

/** Clear-conversation uses this so a fresh plan file is used and sub-session entries are freed. */
export function clearAllPlanSlugs(): void {
  slugBySession.clear()
}

let plansDirectoryMemo: string | null = null

/**
 * Memoised — it is called from tool-result render bodies and permission
 * checks, and its inputs are fixed at startup; the memo's invalidation
 * handle is part of the contract (worktree entry/exit clears it).
 */
export function getPlansDirectory(): string {
  if (plansDirectoryMemo !== null) return plansDirectoryMemo
  let directory: string | null = null
  const configured = (getInitialSettings() as { plansDirectory?: string }).plansDirectory
  if (configured) {
    const cwd = getCwd()
    const resolved = isAbsolute(configured) ? resolve(configured) : resolve(cwd, configured)
    // Path-traversal guard: within the project root, or the root itself.
    const rel = relative(cwd, resolved)
    if (resolved === cwd || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel))) {
      directory = resolved
    } else {
      logError(new Error(`The configured plans directory must be within the project root; ignoring "${configured}"`))
    }
  }
  if (!directory) directory = join(getMercuryHome(), 'plans')
  try {
    getFsImplementation().mkdirSync(directory)
  } catch (err) {
    logError(err)
  }
  plansDirectoryMemo = directory
  return directory
}
getPlansDirectory.cache = {
  clear(): void {
    plansDirectoryMemo = null
  },
}

/** The slug is always the CURRENT session's — the agent id only decorates the file name. */
export function getPlanFilePath(agentId?: string): string {
  const slug = getPlanSlug()
  const name = agentId ? `${slug}-agent-${agentId}.md` : `${slug}.md`
  return join(getPlansDirectory(), name)
}

export function getPlan(agentId?: string): string | null {
  try {
    return readFileSync(getPlanFilePath(agentId), 'utf8')
  } catch (err) {
    if (!isENOENT(err)) logError(err)
    return null
  }
}

function slugFromLog(log: LogOption): string | null {
  for (const message of log.messages ?? []) {
    const slug = (message as { slug?: string }).slug
    if (slug) return slug
  }
  return null
}

/**
 * Resume: associate the FIRST recorded slug with the id the resumed
 * conversation will run under (the process may still carry its throw-away
 * startup id), then probe the plan file. Fire-and-forget — never throws.
 */
export async function copyPlanForResume(log: LogOption, targetSessionId: string = getSessionId()): Promise<boolean> {
  try {
    const slug = slugFromLog(log)
    if (!slug) return false
    setPlanSlug(targetSessionId, slug)
    try {
      // The main-conversation name, composed directly from the slug.
      await readFile(join(getPlansDirectory(), `${slug}.md`), 'utf8')
      return true
    } catch (err) {
      if (isENOENT(err)) return false
      logError(err)
      return false
    }
  } catch (err) {
    logError(err)
    return false
  }
}

/**
 * A fork must NOT reuse the original slug — both sessions stay live and two
 * sessions writing one plan file would overwrite each other. Allocate a new
 * slug for the target (cached as a side effect) and copy the file across.
 */
export async function copyPlanForFork(log: LogOption, targetSessionId: string): Promise<boolean> {
  try {
    const originalSlug = slugFromLog(log)
    if (!originalSlug) return false
    const newSlug = getPlanSlug(targetSessionId)
    try {
      await copyFile(join(getPlansDirectory(), `${originalSlug}.md`), join(getPlansDirectory(), `${newSlug}.md`))
      return true
    } catch (err) {
      if (isENOENT(err)) return false
      logError(err)
      return false
    }
  } catch (err) {
    logError(err)
    return false
  }
}
