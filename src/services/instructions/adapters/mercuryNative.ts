import { join, sep } from 'path'

import {
  getManagedRulesDir,
  getMemoryPath,
  getUserRulesDir,
} from '../../../utils/config.js'
import type { MemoryType } from '../../../utils/memory/types.js'
import { projectConfigDirs } from '../../../utils/projectConfig.js'
import { getInitialSettings, getSettingsForSource } from '../../../utils/settings/settings.js'
import type { InstructionConvention } from '../contracts.js'
import { matchesInstructionExcludes } from '../discovery.js'

function isMercuryMdExcluded(filePath: string, type: MemoryType): boolean {
  if (type !== 'User' && type !== 'Project' && type !== 'Local') {
    return false
  }
  if (type === 'User') {
    const operatorLayers = [
      ...(getSettingsForSource('userSettings')?.instructionExcludes ?? []),
      ...(getSettingsForSource('policySettings')?.instructionExcludes ?? []),
      ...(getSettingsForSource('flagSettings')?.instructionExcludes ?? []),
    ]
    return matchesInstructionExcludes(filePath, operatorLayers)
  }
  return matchesInstructionExcludes(
    filePath,
    getInitialSettings().instructionExcludes,
  )
}

export const mercuryNativeConvention: InstructionConvention = {
  id: 'mercury-native',
  family: 'native',
  projectDirFiles(dir: string): string[] {
    return [
      join(dir, 'MERCURY.md'),
      ...projectConfigDirs(dir).map(home => join(home, 'MERCURY.md')),
    ]
  },
  projectRulesDirs(dir: string): string[] {
    return projectConfigDirs(dir).map(home => join(home, 'rules'))
  },
  localDirFile(dir: string): string {
    return join(dir, 'MERCURY.local.md')
  },
  localDirFiles(dir: string): string[] {
    return [
      join(dir, 'MERCURY.local.md'),
      ...projectConfigDirs(dir).map(home => join(home, 'MERCURY.local.md')),
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
  isExcluded: isMercuryMdExcluded,
  instructionFileNames: ['MERCURY.md', 'MERCURY.local.md'],
  rulesPathMarkers: [`${sep}.mercury${sep}rules${sep}`],
}
