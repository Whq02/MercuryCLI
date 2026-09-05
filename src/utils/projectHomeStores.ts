import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from './debug.js'
import { MERCURY_PROJECT_DIR } from './projectConfig.js'
import { getProjectDir } from './sessionStoragePortable.js'

export const PROJECT_HOME_STORES: ReadonlyArray<readonly string[]> = Object.freeze([
  ['workflows', 'runs'],
  ['evolution'],
  ['test-runs'],
  ['themis'],
  ['agent-memory-local'],
  ['router'],
  ['ide-transactions'],
  ['reviews'],
  ['doctor'],
  ['unity-test-results'],
])

export function projectHomePath(root: string, ...segments: string[]): string {
  return join(getProjectDir(root), ...segments)
}

export function projectFolderPath(root: string, ...segments: string[]): string {
  return join(root, MERCURY_PROJECT_DIR, ...segments)
}

const migrated = new Set<string>()

export function projectHomeStore(root: string, ...segments: string[]): string {
  const home = projectHomePath(root, ...segments)
  const key = JSON.stringify([root, segments])
  if (migrated.has(key)) return home
  migrated.add(key)
  const folder = projectFolderPath(root, ...segments)
  try {
    if (existsSync(folder) && statSync(folder).isDirectory() && !existsSync(home)) {
      mkdirSync(join(home, '..'), { recursive: true })
      cpSync(folder, home, { recursive: true, errorOnExist: false, force: false })
      logForDebugging(`[project-home] migrated ${folder} → ${home} (the project's copy stays)`)
    }
  } catch (e) {
    logForDebugging(`[project-home] migration of ${folder} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return home
}

export function projectHomeLeftovers(root: string): string[] {
  const out: string[] = []
  for (const segments of PROJECT_HOME_STORES) {
    const folder = projectFolderPath(root, ...segments)
    try {
      if (existsSync(folder) && statSync(folder).isDirectory()) out.push(join(MERCURY_PROJECT_DIR, ...segments))
    } catch {
    }
  }
  return out
}
