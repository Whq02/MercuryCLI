import { dirname, parse, resolve } from 'path'

import { getFsImplementation } from '../../../utils/fsOperations.js'
import type {
  InstructionAdapter,
  InstructionConvention,
} from '../contracts.js'
import { resolveRequestedInstructionProfile } from '../profile.js'
import { agentsMdConvention } from './agentsMd.js'
import { mercuryNativeConvention } from './mercuryNative.js'

export const mercuryAdapter: InstructionAdapter = {
  id: 'mercury',
  foreignConventions(): InstructionConvention[] {
    return [agentsMdConvention]
  },
}

export function adapterForProfile(): InstructionAdapter {
  return mercuryAdapter
}

export function conventionsForProfile(profile: 'auto' | 'native'): InstructionConvention[] {
  const foreign = adapterForProfile().foreignConventions()
  return profile === 'native' ? [mercuryNativeConvention] : [mercuryNativeConvention, ...foreign]
}

function isFile(path: string): boolean {
  try {
    return getFsImplementation().statSync(path).isFile()
  } catch {
    return false
  }
}

export function hasPrimaryProjectFile(conventions: InstructionConvention[], dirs: string[]): boolean {
  return conventions.some(
    convention => !convention.fallback && dirs.some(dir => convention.projectDirFiles(dir).some(isFile)),
  )
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
  const present = primary.flatMap(c => c.projectDirFiles(dir)).filter(isFile)
  if (present.length > 0) return present
  if (hasPrimaryProjectFile(primary, chainOf(dir))) return []
  return conventions
    .filter(c => c.fallback)
    .flatMap(c => c.projectDirFiles(dir).filter(path => isFile(path) && !c.isExcluded(path, 'Project')))
}
