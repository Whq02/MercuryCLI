import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const MERCURY_PROJECT_DIR = '.mercury'

export const PROJECT_CONFIG_DIR_NAMES = [MERCURY_PROJECT_DIR] as const

export function projectConfigDirs(root: string): [string] {
  return [join(root, MERCURY_PROJECT_DIR)]
}

export function projectLocalPath(root: string, ...segments: string[]): string {
  return join(root, MERCURY_PROJECT_DIR, ...segments)
}

export function apolloSpecDirectory(projectRoot: string): string {
  return projectLocalPath(projectRoot, 'apollo')
}

export function resolveProjectConfigPath(root: string, ...segments: string[]): string | null {
  for (const home of projectConfigDirs(root)) {
    const candidate = join(home, ...segments)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function projectConfigCandidates(root: string, ...segments: string[]): string[] {
  return projectConfigDirs(root)
    .map(home => join(home, ...segments))
    .filter(p => existsSync(p))
}

export function projectConfigCandidatePaths(root: string, ...segments: string[]): string[] {
  return projectConfigDirs(root).map(home => join(home, ...segments))
}
