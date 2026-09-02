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


const SLUG_RETRIES = 10

const slugBySession = new Map<string, string>()

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

export function setPlanSlug(sessionId: string, slug: string): void {
  slugBySession.set(sessionId, slug)
}

export function clearAllPlanSlugs(): void {
  slugBySession.clear()
}

let plansDirectoryMemo: string | null = null

export function getPlansDirectory(): string {
  if (plansDirectoryMemo !== null) return plansDirectoryMemo
  let directory: string | null = null
  const configured = (getInitialSettings() as { plansDirectory?: string }).plansDirectory
  if (configured) {
    const cwd = getCwd()
    const resolved = isAbsolute(configured) ? resolve(configured) : resolve(cwd, configured)
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

export async function copyPlanForResume(log: LogOption, targetSessionId: string = getSessionId()): Promise<boolean> {
  try {
    const slug = slugFromLog(log)
    if (!slug) return false
    setPlanSlug(targetSessionId, slug)
    try {
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
