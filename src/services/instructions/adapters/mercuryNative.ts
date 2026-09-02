// ============================================================================
//  instructions/adapters/mercuryNative.ts — the MERCURY adapter: the
//  Mercury-native instruction convention (MERCURY.md · MERCURY.local.md,
//  root AND nested directories, the .mercury home variant via the
//  project-config seam). `.mercury` is
//  canonical, and this is the ONE convention — no claude-family
//  convention exists.
//
//  Deliberately narrow:
//    - rules ride the project-config home (.mercury/rules): rules are
//      a Mercury capability whose home derives from projectConfigDirs like
//      every other project config surface (identical-content copies dedup at
//      the engine); nothing parses a second rules tree;
//    - the managed/user OPERATOR layers (config-home file + rules, managed
//      policy file + rules) are unconditional and live here;
//    - exclusion honors the operator setting (instructionExcludes
//      expresses "no instructions from these paths").
// ============================================================================
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
  // Scope honesty (FC-058): the merged view let a repo-checked-in project
  // settings file exclude the operator's USER-scope instruction files —
  // a **/MERCURY.md pattern took the source count to zero — from the layer
  // the codebase elsewhere treats as untrusted. A User file consults only
  // the operator-controlled layers; project/local files keep the merged
  // view (a project excluding its own files is its right).
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
  // The convention's two halves are SYMMETRIC (FC-101): the project file is
  // discovered at the top level AND in the config homes; the local file was
  // top-level only, so .mercury/MERCURY.local.md never composed while
  // .mercury/MERCURY.md did.
  localDirFiles(dir: string): string[] {
    return [
      join(dir, 'MERCURY.local.md'),
      ...projectConfigDirs(dir).map(home => join(home, 'MERCURY.local.md')),
    ]
  },
  // The managed/user operator layers — unconditional, retained byte-for-byte
  // from the pre-retirement policy (the config-home memory file + rules dir,
  // the managed policy file + rules dir).
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
