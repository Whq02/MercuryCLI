import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { MERCURY_PROJECT_DIR, PROJECT_CONFIG_DIR_NAMES, projectConfigDirs } from '../projectConfig.js'
import { passedOver } from '../passedOver.js'
import { isOneOf } from '../isOneOf.js'

export { projectLocalPath } from '../projectConfig.js'

export function projectLocalDir(root: string): string {
  return join(root, MERCURY_PROJECT_DIR)
}

export function projectLocalEstateExists(root: string): boolean {
  return projectConfigDirs(root).some(home => existsSync(home))
}

export function initializeProjectLocalEstate(root: string): { dir: string; created: boolean } | null {
  if (isOneOf(PROJECT_CONFIG_DIR_NAMES, basename(root))) return null
  const absolute = resolve(root)
  if (dirname(absolute) === absolute) return null
  let home = ''
  try {
    home = resolve(homedir())
  } catch (error) {
    passedOver(error)
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
