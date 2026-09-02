import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { MERCURY_PROJECT_DIR, PROJECT_CONFIG_DIR_NAMES, projectConfigDirs } from '../../utils/projectConfig.js'
import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'

export function projectLocalDir(root: string): string {
  return join(root, MERCURY_PROJECT_DIR)
}

export function projectLocalPath(root: string, ...segments: string[]): string {
  return join(root, MERCURY_PROJECT_DIR, ...segments)
}

export function adoptiveProjectLocalPath(root: string, ...segments: string[]): string {
  return adoptiveProjectPath(root, ...segments)
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
  } catch {
  }
  if (home !== '' && absolute === home) return null
  if (projectLocalEstateExists(root)) return { dir: projectLocalDir(root), created: false }
  let dir: string
  try {
    dir = adoptiveProjectPath(root)
  } catch {
    return null
  }
  try {
    mkdirSync(dir)
  } catch (error) {
    return (error as { code?: string }).code === 'EEXIST' ? { dir, created: false } : null
  }
  return { dir, created: true }
}
