
import { dirname, parse, relative, resolve } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getAddedDirectories, getOriginalCwd } from '../../bootstrap/state.js'
import type { InstructionSourceEntry } from '../../services/instructions/contracts.js'
import {
  getConditionalInstructionRulesForCwdLevelDirectory,
  getManagedAndUserConditionalInstructionRules,
  getInstructionFilesForNestedDirectory,
  instructionRootForPath,
} from '../../services/instructions/engine.js'
import {
  executeInstructionsLoadedHooks,
  hasInstructionsLoadedHook,
  type InstructionsMemoryType,
} from '../hooks.js'
import { logError } from '../log.js'
import { pathInAllowedWorkingPath } from '../permissions/filesystem.js'
import type { Attachment } from './types.js'

export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
  addedRoots: readonly string[] = [],
): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  const targetDir = dirname(resolve(targetPath))
  const root = instructionRootForPath(targetDir, originalCwd, addedRoots)
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

function isInstructionsMemoryType(
  type: InstructionSourceEntry['type'],
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

export function memoryFilesToAttachments(
  memoryFiles: InstructionSourceEntry[],
  toolUseContext: ToolUseContext,
  triggerFilePath?: string,
): Attachment[] {
  const attachments: Attachment[] = []
  const shouldFireHook = hasInstructionsLoadedHook()

  for (const memoryFile of memoryFiles) {
    if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) {
      continue
    }
    if (!toolUseContext.readFileState.has(memoryFile.path)) {
      attachments.push({
        type: 'nested_memory',
        path: memoryFile.path,
        content: memoryFile,
        displayPath: relative(getCwd(), memoryFile.path),
      })
      toolUseContext.loadedNestedMemoryPaths?.add(memoryFile.path)

      toolUseContext.readFileState.set(memoryFile.path, {
        content: memoryFile.contentDiffersFromDisk
          ? (memoryFile.rawContent ?? memoryFile.content)
          : memoryFile.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: memoryFile.contentDiffersFromDisk,
      })


      if (shouldFireHook && isInstructionsMemoryType(memoryFile.type)) {
        const loadReason = memoryFile.globs
          ? 'path_glob_match'
          : memoryFile.parent
            ? 'include'
            : 'nested_traversal'
        void executeInstructionsLoadedHooks(
          memoryFile.path,
          memoryFile.type,
          loadReason,
          {
            globs: memoryFile.globs,
            triggerFilePath,
            parentFilePath: memoryFile.parent,
          },
        )
      }
    }
  }

  return attachments
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
      ...memoryFilesToAttachments(managedUserRules, toolUseContext, filePath),
    )

    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(
      filePath,
      originalCwd,
      getAddedDirectories(),
    )

    const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE(
      'mercury_paper_halyard',
      false,
    )

    for (const dir of nestedDirs) {
      const memoryFiles = (
        await getInstructionFilesForNestedDirectory(dir, filePath, processedPaths)
      ).filter(
        f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'),
      )
      attachments.push(
        ...memoryFilesToAttachments(memoryFiles, toolUseContext, filePath),
      )
    }

    for (const dir of cwdLevelDirs) {
      const conditionalRules = (
        await getConditionalInstructionRulesForCwdLevelDirectory(
          dir,
          filePath,
          processedPaths,
        )
      ).filter(
        f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'),
      )
      attachments.push(
        ...memoryFilesToAttachments(conditionalRules, toolUseContext, filePath),
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
  if (
    !toolUseContext.nestedMemoryAttachmentTriggers ||
    toolUseContext.nestedMemoryAttachmentTriggers.size === 0
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const attachments: Attachment[] = []

  for (const filePath of toolUseContext.nestedMemoryAttachmentTriggers) {
    const nestedAttachments = await getNestedMemoryAttachmentsForFile(
      filePath,
      toolUseContext,
      appState,
    )
    attachments.push(...nestedAttachments)
  }

  toolUseContext.nestedMemoryAttachmentTriggers.clear()

  return attachments
}
