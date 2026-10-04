import { join } from 'path'

import type { InstructionConvention } from '../contracts.js'
import { isProjectInstructionExcluded } from '../nativeSource.js'

export const SHARED_INSTRUCTION_FILE = 'AGENTS.md'

export const agentsMdConvention: InstructionConvention = {
  id: 'agents-md',
  family: 'shared',
  fallback: true,
  projectDirFiles(dir: string): string[] {
    return [join(dir, SHARED_INSTRUCTION_FILE)]
  },
  projectRulesDirs(): string[] {
    return []
  },
  localDirFile(): string | null {
    return null
  },
  localDirFiles(): string[] {
    return []
  },
  userFile(): string | null {
    return null
  },
  userRulesDir(): string | null {
    return null
  },
  managedFile(): string | null {
    return null
  },
  managedRulesDir(): string | null {
    return null
  },
  isExcluded: isProjectInstructionExcluded,
  instructionFileNames: [SHARED_INSTRUCTION_FILE],
  rulesPathMarkers: [],
}
export function foreignInstructionConventions(): InstructionConvention[] {
  return [agentsMdConvention]
}