import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { MERCURY_PROJECT_DIR, PROJECT_CONFIG_DIR_NAMES, projectConfigDirs } from '../../utils/projectConfig.js'

let homeUnknownSaid = false

export function projectLocalDir(root: string): string {
  return join(root, MERCURY_PROJECT_DIR)
}

export function projectLocalPath(root: string, ...segments: string[]): string {
  return join(root, MERCURY_PROJECT_DIR, ...segments)
}

export function projectLocalEstateExists(root: string): boolean {
  return projectConfigDirs(root).some(home => existsSync(home))
}

export function initializeProjectLocalEstate(root: string): { dir: string; created: boolean } | null {
  if ((PROJECT_CONFIG_DIR_NAMES as readonly string[]).includes(basename(root))) return null
  const absolute = resolve(root)
  if (dirname(absolute) === absolute) return null
  let home = ''
  try {
    home = resolve(homedir())
  } catch (error) {
    if (!homeUnknownSaid) {
      homeUnknownSaid = true
      logError(new Error(`the home folder could not be told (${errorMessage(error)}), so a project estate is made without checking that its folder is not the home`))
    }
  }
  if (home !== '' && absolute === home) return null
  if (projectLocalEstateExists(root)) return { dir: projectLocalDir(root), created: false }
  const dir = projectLocalDir(root)
  try {
    mkdirSync(dir)
  } catch (error) {
    return (error as { code?: string }).code === 'EEXIST' ? { dir, created: false } : null
  }
  return { dir, created: true }
}
