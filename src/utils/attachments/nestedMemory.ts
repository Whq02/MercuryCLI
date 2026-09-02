// Nested-memory loading — directory traversal for MERCURY.md + conditional
// rules on file touch (the nestedMemoryAttachmentTriggers seam), with the
// LRU-eviction-proof dedup (loadedNestedMemoryPaths is the non-evicting set;
// readFileState alone re-injects on every eviction cycle). Owned Mercury
// module.

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

/**
 * The two directory ladders a touched file implies, each ordered parent →
 * child, anchored at the file's INSTRUCTION ROOT — the boot cwd when the
 * file lives under it, otherwise the deepest operator-added directory that
 * contains it (an added directory is one more instruction root; a file
 * outside every root anchors at the cwd and climbs nothing). nestedDirs
 * climbs from the root down to the file (these load project guides + every
 * rule kind); cwdLevelDirs — the established name — runs filesystem root →
 * the instruction root (conditional rules only — everything unconditional
 * up there loaded eagerly at boot).
 */
export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
  addedRoots: readonly string[] = [],
): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  const targetDir = dirname(resolve(targetPath))
  const root = instructionRootForPath(targetDir, originalCwd, addedRoots)
  const nestedDirs: string[] = []
  let currentDir = targetDir

  // Climb from the file's directory toward its instruction root, keeping
  // only directories inside it.
  while (currentDir !== root && currentDir !== parse(currentDir).root) {
    if (currentDir.startsWith(root)) {
      nestedDirs.push(currentDir)
    }
    currentDir = dirname(currentDir)
  }

  // Parent-first is the contract; the climb collected child-first.
  nestedDirs.reverse()

  // The second ladder: filesystem root up to (and including) the
  // instruction root.
  const cwdLevelDirs: string[] = []
  currentDir = root

  while (currentDir !== parse(currentDir).root) {
    cwdLevelDirs.push(currentDir)
    currentDir = dirname(currentDir)
  }

  // Same parent-first contract.
  cwdLevelDirs.reverse()

  return { nestedDirs, cwdLevelDirs }
}

/** Narrows an instruction source's type to the hook-input vocabulary. */
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

/**
 * Instruction files → nested_memory attachments, minus everything this
 * session already injected. Exported for testing — the regression guard
 * for LRU-eviction re-injection pins this function directly.
 */
export function memoryFilesToAttachments(
  memoryFiles: InstructionSourceEntry[],
  toolUseContext: ToolUseContext,
  triggerFilePath?: string,
): Attachment[] {
  const attachments: Attachment[] = []
  const shouldFireHook = hasInstructionsLoadedHook()

  for (const memoryFile of memoryFiles) {
    // Two dedup ledgers on purpose: readFileState is a bounded LRU (100
    // entries) that sheds under a busy session, and each shed would
    // re-inject the same guide next cycle — loadedNestedMemoryPaths never
    // evicts, so an injection stays remembered for the session's life.
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

      // The readFileState write doubles as the cross-turn/cross-function
      // half of the dedup (the .has() gate above reads it).
      //
      // Whenever what was injected is NOT what disk holds (comment/
      // frontmatter stripping, a truncated index), the cache entry stores
      // the RAW bytes and flags isPartialView — so Edit/Write demand a
      // real Read before touching the file, while change detection keeps
      // working off true content with a full-read shape (no offset/limit).
      toolUseContext.readFileState.set(memoryFile.path, {
        content: memoryFile.contentDiffersFromDisk
          ? (memoryFile.rawContent ?? memoryFile.content)
          : memoryFile.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: memoryFile.contentDiffersFromDisk,
      })


      // Observability: the InstructionsLoaded event fires per injected file,
      // fire-and-forget (it has no blocking lane).
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

/**
 * Everything one touched file owes the context: walk its directory ladders
 * and attach each project guide and rule that applies but has not loaded
 * yet.
 *
 * The order is contract, not convenience — later phases dedup against
 * earlier ones through processedPaths:
 * 1. Managed/User conditional rules matching the file
 * 2. Nested directories (the file's instruction root → target): guides +
 *    unconditional + conditional rules
 * 3. Root-level directories (filesystem root → the instruction root),
 *    contributing conditional rules alone
 * The instruction root is the boot cwd, or the operator-added directory
 * that contains the file (getDirectoriesToProcess).
 */
export async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  toolUseContext: ToolUseContext,
  appState: { toolPermissionContext: ToolPermissionContext },
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  try {
    // A path outside the allowed working set loads nothing — instruction
    // traversal honors the same boundary the tools do.
    if (!pathInAllowedWorkingPath(filePath, appState.toolPermissionContext)) {
      return attachments
    }

    const processedPaths = new Set<string>()
    const originalCwd = getOriginalCwd()

    // Phase 1 — managed/user conditional rules keyed on this file.
    const managedUserRules = await getManagedAndUserConditionalInstructionRules(
      filePath,
      processedPaths,
    )
    attachments.push(
      ...memoryFilesToAttachments(managedUserRules, toolUseContext, filePath),
    )

    // Phase 2 — the two ladders, anchored at the file's instruction root.
    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(
      filePath,
      originalCwd,
      getAddedDirectories(),
    )

    const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE(
      'mercury_paper_halyard',
      false,
    )

    // Phase 3 — nested directories (instruction root → target): guides +
    // both rule kinds per directory.
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

    // Phase 4 — root-level directories (filesystem root → the instruction
    // root): conditional rules only; their unconditional content loaded
    // eagerly at boot.
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

/**
 * Drain the turn's trigger set (paths the tools touched) into nested-memory
 * attachments. The set lives on ToolUseContext and is cleared on drain.
 */
export async function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // The trigger-set check comes before the state read: getAppState() costs
  // a React render cycle, and most turns have nothing triggered.
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
