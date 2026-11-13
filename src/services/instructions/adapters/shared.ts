import { join, sep } from 'path'

import type { InstructionConvention } from '../contracts.js'
import { isProjectInstructionExcluded } from '../nativeSource.js'

type SharedFormat = {
  id: string
  label: string
  guides?: readonly string[]
}

const under = (dir: string, relative: string): string => join(dir, ...relative.split('/'))

function folderHolding(filePath: string, relative: string): string | null {
  const ending = `${sep}${relative.split('/').join(sep)}`
  return filePath.endsWith(ending) ? filePath.slice(0, -ending.length) : null
}

export function sharedFormat({ id, label, guides = [] }: SharedFormat): InstructionConvention {
  return {
    id,
    family: 'shared',
    fallback: true,
    label,
    belowHome: true,
    projectDirFiles: dir => guides.map(guide => under(dir, guide)),
    projectRulesDirs: () => [],
    localDirFile: () => null,
    localDirFiles: () => [],
    userFile: () => null,
    userRulesDir: () => null,
    managedFile: () => null,
    managedRulesDir: () => null,
    isExcluded: isProjectInstructionExcluded,
    instructionFileNames: [],
    rulesPathMarkers: [],
    folderOf(filePath) {
      for (const guide of guides) {
        const folder = folderHolding(filePath, guide)
        if (folder !== null) return folder
      }
      return null
    },
  }
}
