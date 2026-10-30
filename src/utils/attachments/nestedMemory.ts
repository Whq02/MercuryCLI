import { dirname, parse, relative, resolve } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import type { InstructionSourceEntry } from '../../services/instructions/contracts.js'
import { getConditionalInstructionRulesForCwdLevelDirectory, getManagedAndUserConditionalInstructionRules, getInstructionFilesForNestedDirectory, getMaxMemoryCharacterCount } from '../../services/instructions/engine.js'
import type { FileState } from '../fileStateCache.js'
import { logError } from '../log.js'
import { pathInAllowedWorkingPath } from '../permissions/filesystem.js'
import type { Attachment } from './types.js'

export async function getNestedMemoryAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
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

export async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  context: ToolUseContext,
  state: { toolPermissionContext: ToolPermissionContext },
): Promise<Attachment[]> {
  const delivered: Attachment[] = []
  try {
    if (pathInAllowedWorkingPath(filePath, state.toolPermissionContext)) {
      for await (const entries of instructionBatches(filePath)) {
        delivered.push(...memoryFilesToAttachments(entries, context))
      }
    }
  } catch (failure) {
    logError(failure)
  }
  return delivered
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
  return {
    nestedDirs: [...ancestors(dirname(resolve(targetPath)), originalCwd)].filter(directory => directory.startsWith(originalCwd)).reverse(),
    cwdLevelDirs: [...ancestors(originalCwd)].reverse(),
  }
}

function contextRecordOf(entry: InstructionSourceEntry, clipped: boolean): FileState {
  const content = entry.contentDiffersFromDisk ? entry.rawContent ?? entry.content : entry.content
  return { content, timestamp: Date.now(), offset: undefined, limit: undefined, isPartialView: clipped || entry.contentDiffersFromDisk }
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
