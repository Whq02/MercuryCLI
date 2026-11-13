import { homedir } from 'os'
import { dirname, parse, resolve } from 'path'

import { normalizePathForComparison } from '../../../utils/file.js'
import { getFsImplementation, safeResolvePath } from '../../../utils/fsOperations.js'
import { pathInWorkingPath } from '../../../utils/permissions/filesystem.js'
import type {
  InstructionAdapter,
  InstructionConvention,
} from '../contracts.js'
import { resolveRequestedInstructionProfile } from '../profile.js'
import { conventionsForProfile as composeNativeFirst } from '../compositionOrder.js'

export const mercuryAdapter: InstructionAdapter = {
  id: 'mercury',
  conventionsFor: conventionsForProfile,
}

export function adapterForProfile(): InstructionAdapter {
  return mercuryAdapter
}

export function conventionsForProfile(profile: 'auto' | 'native'): InstructionConvention[] {
  return composeNativeFirst(profile)
}

function isFile(path: string): boolean {
  try {
    return getFsImplementation().statSync(path).isFile()
  } catch {
    return false
  }
}

const resolvedSpelling = (path: string): string =>
  normalizePathForComparison(safeResolvePath(getFsImplementation(), path).resolvedPath)

function isPersonalGuide(convention: InstructionConvention, path: string): boolean {
  const personal = convention.userFile()
  return personal !== null && resolvedSpelling(path) === resolvedSpelling(personal)
}

function projectGuidesAt(convention: InstructionConvention, dir: string): string[] {
  return convention.projectDirFiles(dir).filter(path => isFile(path) && !isPersonalGuide(convention, path))
}

export function hasPrimaryProjectFile(conventions: InstructionConvention[], dirs: string[]): boolean {
  return conventions.some(
    convention => !convention.fallback && dirs.some(dir => projectGuidesAt(convention, dir).length > 0),
  )
}

type FolderSources = {
  guides(convention: InstructionConvention, dir: string): string[]
  rules(convention: InstructionConvention, dir: string): string[]
  within(convention: InstructionConvention, dir: string, paths: string[]): string[]
}

export function folderSources(start: string): FolderSources {
  const home = safeResolvePath(getFsImplementation(), homedir()).resolvedPath
  const within = (convention: InstructionConvention, dir: string, paths: string[]): string[] => {
    if (!convention.belowHome || !pathInWorkingPath(home, dir)) return paths
    return dir === start ? paths.filter(path => dirname(path) === dir) : []
  }
  return {
    guides: (convention, dir) => within(convention, dir, convention.projectDirFiles(dir)),
    rules: (convention, dir) => within(convention, dir, convention.projectRulesDirs(dir)),
    within,
  }
}

export function decidingGuideOf(start: string): string | null {
  const primary = conventionsForProfile(resolveRequestedInstructionProfile().profile).filter(c => !c.fallback)
  for (const dir of chainOf(start)) {
    for (const convention of primary) {
      const guide = projectGuidesAt(convention, dir)[0]
      if (guide !== undefined) return guide
    }
  }
  return null
}

function chainOf(dir: string): string[] {
  const dirs: string[] = []
  let current = resolve(dir)
  while (current !== parse(current).root) {
    dirs.push(current)
    current = dirname(current)
  }
  return dirs
}

export function composedGuideFilesAt(dir: string): string[] {
  const conventions = conventionsForProfile(resolveRequestedInstructionProfile().profile)
  const primary = conventions.filter(c => !c.fallback)
  const present = primary.flatMap(c => projectGuidesAt(c, dir))
  if (present.length > 0) return present
  if (hasPrimaryProjectFile(primary, chainOf(dir))) return []
  const at = resolve(dir)
  const own = folderSources(at)
  return conventions
    .filter(c => c.fallback)
    .flatMap(c => [...own.guides(c, at), ...own.rules(c, at)].filter(path => isFile(path) && !c.isExcluded(path, 'Project')))
}
