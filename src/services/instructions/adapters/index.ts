import { basename } from 'path'

import { getFsImplementation } from '../../../utils/fsOperations.js'
import type {
  InstructionAdapter,
  InstructionConvention,
  InstructionProfile,
} from '../contracts.js'
import { resolveRequestedInstructionProfile } from '../profile.js'
import { agentsMdConvention } from './agentsMd.js'
import { mercuryNativeConvention } from './mercuryNative.js'

export const mercuryAdapter: InstructionAdapter = {
  id: 'mercury',
  conventionsFor(profile: InstructionProfile): InstructionConvention[] {
    return profile === 'native'
      ? [mercuryNativeConvention]
      : [mercuryNativeConvention, agentsMdConvention]
  },
}

export function adapterForProfile(): InstructionAdapter {
  return mercuryAdapter
}

function projectFilesOf(convention: InstructionConvention, dir: string): string[] {
  return [
    ...convention.projectDirFiles(dir),
    ...(convention.localDirFiles?.(dir) ??
      (convention.localDirFile(dir) !== null ? [convention.localDirFile(dir) as string] : [])),
  ]
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
    convention => !convention.fallback && dirs.some(dir => projectFilesOf(convention, dir).some(isFile)),
  )
}

export function composedGuideFilesAt(dir: string): string[] {
  const conventions = adapterForProfile().conventionsFor(resolveRequestedInstructionProfile().profile)
  const primary = conventions.filter(c => !c.fallback)
  const present = primary.flatMap(c => projectFilesOf(c, dir)).filter(isFile)
  if (present.length > 0) return present
  return conventions
    .filter(c => c.fallback)
    .flatMap(c => projectFilesOf(c, dir))
    .filter(isFile)
}

export function composedGuideNamesAt(dir: string): string[] {
  return composedGuideFilesAt(dir).map(p => basename(p))
}
