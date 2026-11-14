import { homedir } from 'os'
import { dirname, join, parse, resolve, sep } from 'path'

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
  reads(convention: InstructionConvention, dir: string): boolean
  guides(convention: InstructionConvention, dir: string): string[]
  rules(convention: InstructionConvention, dir: string): string[]
  within(convention: InstructionConvention, dir: string, paths: string[]): string[]
}

export function folderSources(start: string): FolderSources {
  const fs = getFsImplementation()
  let home: string | undefined
  const above = new Map<string, boolean>()
  const homeOrAbove = (dir: string): boolean => {
    let known = above.get(dir)
    if (known === undefined) {
      home ??= safeResolvePath(fs, homedir()).resolvedPath
      known = pathInWorkingPath(home, dir) || home.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)
      above.set(dir, known)
    }
    return known
  }
  const standing = new Map<string, boolean>()
  const stands = (path: string): boolean => {
    let known = standing.get(path)
    if (known === undefined) {
      known = fs.existsSync(path)
      standing.set(path, known)
    }
    return known
  }
  const reach = new Map<string, 'none' | 'own' | 'all'>()
  const reachOf = (convention: InstructionConvention, dir: string): 'none' | 'own' | 'all' => {
    if (convention.belowHome !== true && convention.entryNames === undefined) return 'all'
    const key = `${convention.id}\n${dir}`
    let known = reach.get(key)
    if (known === undefined) {
      const personal = convention.belowHome === true && homeOrAbove(dir)
      const held = (): boolean => convention.entryNames === undefined || convention.entryNames.some(name => stands(join(dir, name)))
      known = (personal && dir !== start) || !held() ? 'none' : personal ? 'own' : 'all'
      reach.set(key, known)
    }
    return known
  }
  const kept = (convention: InstructionConvention, dir: string, paths: () => string[]): string[] => {
    const reaches = reachOf(convention, dir)
    if (reaches === 'none') return []
    return reaches === 'own' ? paths().filter(path => dirname(path) === dir) : paths()
  }
  return {
    reads: (convention, dir) => reachOf(convention, dir) !== 'none',
    guides: (convention, dir) => kept(convention, dir, () => convention.projectDirFiles(dir)),
    rules: (convention, dir) => kept(convention, dir, () => convention.projectRulesDirs(dir)),
    within: (convention, dir, paths) => kept(convention, dir, () => paths),
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
