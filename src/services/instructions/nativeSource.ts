import { join, sep } from 'path'

import { getManagedRulesDir, getMemoryPath, getUserRulesDir } from '../../utils/config.js'
import type { MemoryType } from '../../utils/memory/types.js'
import { projectConfigDirs } from '../../utils/projectConfig.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import type { InstructionConvention } from './contracts.js'
import { matchesInstructionExcludes } from './discovery.js'

export const NATIVE_INSTRUCTION_FILE_NAMES = ['MERCURY.md', 'MERCURY.local.md'] as const

export function isProjectInstructionExcluded(filePath: string, type: MemoryType): boolean {
  if (type !== 'User' && type !== 'Project' && type !== 'Local') return false
  const patterns = type === 'User'
    ? [
        ...(getSettingsForSource('userSettings')?.briefs?.exclude ?? []),
        ...(getSettingsForSource('policySettings')?.briefs?.exclude ?? []),
        ...(getSettingsForSource('flagSettings')?.briefs?.exclude ?? []),
      ]
    : getInitialSettings().briefs?.exclude
  return matchesInstructionExcludes(filePath, patterns)
}

export const mercuryNativeConvention: InstructionConvention = {
  id: 'mercury-native',
  family: 'native',
  projectDirFiles(dir: string): string[] {
    return [
      join(dir, NATIVE_INSTRUCTION_FILE_NAMES[0]),
      ...projectConfigDirs(dir).map(home => join(home, NATIVE_INSTRUCTION_FILE_NAMES[0])),
    ]
  },
  projectRulesDirs(dir: string): string[] {
    return projectConfigDirs(dir).map(home => join(home, 'rules'))
  },
  localDirFile(dir: string): string {
    return join(dir, NATIVE_INSTRUCTION_FILE_NAMES[1])
  },
  localDirFiles(dir: string): string[] {
    return [
      join(dir, NATIVE_INSTRUCTION_FILE_NAMES[1]),
      ...projectConfigDirs(dir).map(home => join(home, NATIVE_INSTRUCTION_FILE_NAMES[1])),
    ]
  },
  userFile(): string {
    return getMemoryPath('User')
  },
  userRulesDir(): string {
    return getUserRulesDir()
  },
  managedFile(): string {
    return getMemoryPath('Managed')
  },
  managedRulesDir(): string {
    return getManagedRulesDir()
  },
  isExcluded: isProjectInstructionExcluded,
  instructionFileNames: NATIVE_INSTRUCTION_FILE_NAMES,
  rulesPathMarkers: [`${sep}.mercury${sep}rules${sep}`],
}
