import { dirname, parse, relative, resolve } from 'path'
import { getCwd } from 'src/platform/files/cwd.js'
import type { ToolPermissionContext, ToolUseContext } from '../../tools/kit/tool.js'
import { getOriginalCwd } from '../../boot/process-state/processState.js'
import type { InstructionSourceEntry } from '../../sessions/instruction-contracts/contracts.js'
import { getConditionalInstructionRulesForCwdLevelDirectory, getManagedAndUserConditionalInstructionRules, getInstructionFilesForNestedDirectory, getMaxMemoryCharacterCount } from '../../sessions/instructions/instructionFiles.js'
import type { FileState } from '../../platform/files/fileStateCache.js'
import { logError } from '../../platform/logs/errorLog.js'
import { pathInAllowedWorkingPath } from '../../permissions/rules/filesystem.js'
import type { Attachment } from '../attachment-shapes/attachmentTypes.js'

export async function getNestedMemoryAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const triggers = toolUseContext.nestedMemoryAttachmentTriggers
  if (!triggers || triggers.size === 0) return []
  const appState = toolUseContext.getAppState()
  const attachments: Attachment[] = []
  for (const filePath of triggers) {
    attachments.push(...(await getNestedMemoryAttachmentsForFile(filePath, toolUseContext, appState)))
  }
  triggers.clear()
  return attachments
}

export async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  context: ToolUseContext,
  state: { toolPermissionContext: ToolPermissionContext },
): Promise<Attachment[]> {
  const attachments: Attachment[] = []
  try {
    if (!pathInAllowedWorkingPath(filePath, state.toolPermissionContext)) return []
    for await (const batch of instructionBatches(filePath)) {
      attachments.push(...memoryFilesToAttachments(batch, context))
    }
  } catch (error) {
    logError(error)
  }
  return attachments
}

async function* instructionBatches(file: string): AsyncGenerator<InstructionSourceEntry[]> {
  const seen = new Set<string>()
  const root = getOriginalCwd()
  yield await getManagedAndUserConditionalInstructionRules(file, seen)
  const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(file, root)
  const phases = [
    { directories: nestedDirs, load: getInstructionFilesForNestedDirectory },
    { directories: cwdLevelDirs, load: getConditionalInstructionRulesForCwdLevelDirectory },
  ]
  for (const phase of phases) {
    for (const directory of phase.directories) yield await phase.load(directory, file, seen)
  }
}

function* ancestors(directory: string, stop?: string): Generator<string> {
  for (let next = directory; next !== stop && next !== parse(next).root; next = dirname(next)) yield next
}

export function getDirectoriesToProcess(targetPath: string, originalCwd: string): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  const nestedDirs = [...ancestors(dirname(resolve(targetPath)), originalCwd)]
    .filter(dir => dir.startsWith(originalCwd))
    .reverse()
  const cwdLevelDirs = [...ancestors(originalCwd)].reverse()
  return { nestedDirs, cwdLevelDirs }
}

function contextRecordOf(entry: InstructionSourceEntry, clipped: boolean): FileState {
  return {
    content: entry.contentDiffersFromDisk ? (entry.rawContent ?? entry.content) : entry.content,
    timestamp: Date.now(),
    offset: undefined,
    limit: undefined,
    isPartialView: clipped ? true : entry.contentDiffersFromDisk,
  }
}

function clipNestedGuide(entry: InstructionSourceEntry, cap: number): InstructionSourceEntry {
  if (entry.content.length <= cap) return entry
  const lastBreak = entry.content.lastIndexOf('\n', cap)
  const kept = entry.content.slice(0, lastBreak > cap / 2 ? lastBreak + 1 : cap)
  const rest = entry.content.length - kept.length
  return { ...entry, content: `${kept}\n[the rest of this file, ${rest} characters, was not loaded: a folder guide is loaded up to ${cap} characters; read ${entry.path} for the rest]` }
}

export function memoryFilesToAttachments(memoryFiles: InstructionSourceEntry[], toolUseContext: ToolUseContext): Attachment[] {
  const { loadedNestedMemoryPaths: ledger, readFileState: cache } = toolUseContext
  const cap = getMaxMemoryCharacterCount()
  return memoryFiles.flatMap(entry => {
    if (ledger?.has(entry.path) || cache.has(entry.path)) return []
    ledger?.add(entry.path)
    const shown = clipNestedGuide(entry, cap)
    cache.set(entry.path, contextRecordOf(entry, shown !== entry))
    return [{ type: 'nested_memory' as const, path: entry.path, content: shown, displayPath: relative(getCwd(), entry.path) }]
  })
}
