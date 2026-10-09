
import { dirname, parse, relative, resolve } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import type { InstructionSourceEntry } from '../../services/instructions/contracts.js'
import {
  getConditionalInstructionRulesForCwdLevelDirectory,
  getManagedAndUserConditionalInstructionRules,
  getInstructionFilesForNestedDirectory,
} from '../../services/instructions/engine.js'
import type { FileState } from '../fileStateCache.js'
import { logError } from '../log.js'
import { pathInAllowedWorkingPath } from '../permissions/filesystem.js'
import type { Attachment } from './types.js'

export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  const targetDir = dirname(resolve(targetPath))
  const root = originalCwd
  const nestedDirs: string[] = []
  let currentDir = targetDir

  while (currentDir !== root && currentDir !== parse(currentDir).root) {
    if (currentDir.startsWith(root)) {
      nestedDirs.push(currentDir)
    }
    currentDir = dirname(currentDir)
  }

  nestedDirs.reverse()

  const cwdLevelDirs: string[] = []
  currentDir = root

  while (currentDir !== parse(currentDir).root) {
    cwdLevelDirs.push(currentDir)
    currentDir = dirname(currentDir)
  }

  cwdLevelDirs.reverse()

  return { nestedDirs, cwdLevelDirs }
}

function contextRecordOf(entry: InstructionSourceEntry): FileState {
  const content = entry.contentDiffersFromDisk
    ? entry.rawContent ?? entry.content
    : entry.content
  return {
    content,
    timestamp: Date.now(),
    offset: undefined,
    limit: undefined,
    isPartialView: entry.contentDiffersFromDisk,
  }
}

export function memoryFilesToAttachments(
  memoryFiles: InstructionSourceEntry[],
  toolUseContext: ToolUseContext,
): Attachment[] {
  const { loadedNestedMemoryPaths: ledger, readFileState: cache } = toolUseContext
  return memoryFiles.flatMap(entry => {
    if (ledger?.has(entry.path) || cache.has(entry.path)) return []
    ledger?.add(entry.path)
    cache.set(entry.path, contextRecordOf(entry))
    return [{
      type: 'nested_memory' as const,
      path: entry.path,
      content: entry,
      displayPath: relative(getCwd(), entry.path),
    }]
  })
}

export async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  toolUseContext: ToolUseContext,
  appState: { toolPermissionContext: ToolPermissionContext },
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  try {
    if (!pathInAllowedWorkingPath(filePath, appState.toolPermissionContext)) {
      return attachments
    }

    const processedPaths = new Set<string>()
    const originalCwd = getOriginalCwd()

    const managedUserRules = await getManagedAndUserConditionalInstructionRules(
      filePath,
      processedPaths,
    )
    attachments.push(
      ...memoryFilesToAttachments(managedUserRules, toolUseContext),
    )

    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(
      filePath,
      originalCwd,
    )

    for (const dir of nestedDirs) {
      const memoryFiles = await getInstructionFilesForNestedDirectory(dir, filePath, processedPaths)
      attachments.push(
        ...memoryFilesToAttachments(memoryFiles, toolUseContext),
      )
    }

    for (const dir of cwdLevelDirs) {
      const conditionalRules = await getConditionalInstructionRulesForCwdLevelDirectory(
        dir,
        filePath,
        processedPaths,
      )
      attachments.push(
        ...memoryFilesToAttachments(conditionalRules, toolUseContext),
      )
    }
  } catch (error) {
    logError(error)
  }

  return attachments
}

export async function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const triggers = toolUseContext.nestedMemoryAttachmentTriggers
  if (!triggers?.size) return []
  const appState = toolUseContext.getAppState()
  const loads: Attachment[][] = []
  for (const touched of triggers) {
    loads.push(await getNestedMemoryAttachmentsForFile(touched, toolUseContext, appState))
  }
  triggers.clear()
  return loads.flat()
}
