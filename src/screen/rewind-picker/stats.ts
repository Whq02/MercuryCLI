import { basename } from 'path'
import { isRemotePath } from '../../platform/remote-file-target/target.js'
import { safeSearchOrReadClassification, type Tool } from '../../tools/kit/tool.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/kit/names/powershell.js'
import { getAllBaseTools } from '../../tools/kit/toolList.js'
import { isSqliteRowTarget } from '../../tools/write/structuredTargets.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export type CodeStats = { filesChanged: string[]; insertions: number; deletions: number }

const SHELL_TOOL_NAMES = new Set(['Bash', POWERSHELL_TOOL_NAME])

type ShellCall = {
  id: string
  tool: string
  input: Record<string, unknown>
}

function shellCallsInRange(messages: Message[], start: number, end: number): ShellCall[] {
  const calls: ShellCall[] = []
  for (let i = start; i < end; i++) {
    const message = messages[i]!
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      if (!SHELL_TOOL_NAMES.has(block.name)) continue
      const input = block.input
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue
      const record = input as Record<string, unknown>
      if (typeof record.command !== 'string') continue
      calls.push({
        id: block.id,
        tool: block.name,
        input: record,
      })
    }
  }
  return calls
}

function countMutatingShellInRange(
  messages: Message[],
  start: number,
  end: number,
  mutatingShellIds: ReadonlySet<string> | null | undefined,
): number {
  if (!mutatingShellIds || mutatingShellIds.size === 0 || start < 0) return 0
  let count = 0
  for (let i = start; i < end; i++) {
    const message = messages[i]!
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use' && mutatingShellIds.has(block.id)) count += 1
    }
  }
  return count
}

export async function findMutatingShellToolUseIds(messages: Message[]): Promise<ReadonlySet<string>> {
  const calls = shellCallsInRange(messages, 0, messages.length)
  if (calls.length === 0) return new Set()
  const toolsByName = new Map<string, Tool>()
  for (const tool of getAllBaseTools()) {
    if (SHELL_TOOL_NAMES.has(tool.name)) toolsByName.set(tool.name, tool)
  }
  const mutating = new Set<string>()
  for (const call of calls) {
    const tool = toolsByName.get(call.tool)
    if (tool === undefined) {
      mutating.add(call.id)
      continue
    }
    if (typeof tool.prepare === 'function') {
      try {
        await tool.prepare(call.input)
      } catch (error) {
        passedOver(error)
      }
    }
    try {
      if (tool.isReadOnly(call.input) === true) continue
      if (call.tool === POWERSHELL_TOOL_NAME) {
        const classified = safeSearchOrReadClassification(tool, call.input)
        if (classified?.isRead || classified?.isSearch) continue
      }
      mutating.add(call.id)
    } catch (error) {
      passedOver(error)
      mutating.add(call.id)
    }
  }
  return mutating
}

export function mutatingShellCountAfter(
  messages: Message[],
  fromUuid: string,
  mutatingShellIds: ReadonlySet<string> | null | undefined,
): number {
  const start = messages.findIndex(message => message.uuid === fromUuid)
  if (start === -1) return 0
  return countMutatingShellInRange(messages, start + 1, messages.length, mutatingShellIds)
}

type PatchHunk = { lines?: string[] }
type EditResult = {
  filePath?: string
  file_path?: string
  structuredPatch?: PatchHunk[]
  type?: string
  content?: string
  outcome?: string
  changeView?: { state?: string; files?: Array<{ file: string; added: number; removed: number }> }
}

function createdLineCount(content: string): number {
  if (content === '') return 0
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
}

export function statsBetween(
  messages: Message[],
  fromUuid: string,
  toUuid: string | undefined,
  mutatingShellIds?: ReadonlySet<string> | null,
): { files: string[]; insertions: number; deletions: number; shellCommands: number } {
  const start = messages.findIndex(message => message.uuid === fromUuid)
  const end =
    toUuid === undefined
      ? messages.length
      : messages.findIndex(message => message.uuid === toUuid)
  const limit = end === -1 ? messages.length : end
  const files = new Set<string>()
  let insertions = 0
  let deletions = 0
  for (let i = start + 1; i < limit; i++) {
    const message = messages[i]!
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content) || content[0]?.type !== 'tool_result') continue
    const result = (message as { toolUseResult?: unknown }).toolUseResult as
      | EditResult
      | undefined
    if (!result || typeof result !== 'object') continue
    if (result.changeView !== undefined && Array.isArray(result.changeView.files)) {
      if (result.changeView.state === 'applied' && result.outcome === 'succeeded') {
        for (const changed of result.changeView.files) {
          files.add(changed.file)
          insertions += changed.added
          deletions += changed.removed
        }
      }
      continue
    }
    const filePath = result.filePath ?? result.file_path
    if (typeof filePath !== 'string') continue
    if (isSqliteRowTarget(filePath)) continue
    if (result.type === 'create' && typeof result.content === 'string') {
      files.add(filePath)
      insertions += createdLineCount(result.content)
      continue
    }
    if (!Array.isArray(result.structuredPatch)) continue
    files.add(filePath)
    for (const hunk of result.structuredPatch) {
      if (!Array.isArray(hunk.lines)) continue
      for (const line of hunk.lines) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) insertions += 1
        else if (line.startsWith('-')) deletions += 1
      }
    }
  }
  const shellCommands =
    start === -1 ? 0 : countMutatingShellInRange(messages, start + 1, limit, mutatingShellIds)
  return { files: [...files], insertions, deletions, shellCommands }
}

export function writtenElsewhereLine(messages: Message[], fromUuid: string): string | null {
  const written = new Set<string>()
  for (const message of messages.slice(messages.findIndex(candidate => candidate.uuid === fromUuid) + 1)) {
    const result = (message as { toolUseResult?: unknown }).toolUseResult as EditResult | null | undefined
    if (typeof result !== 'object' || result === null || typeof result.filePath !== 'string' || !isRemotePath(result.filePath)) continue
    if (result.type === 'create' || (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0)) written.add(result.filePath)
  }
  const far = [...written]
  if (far.length === 0) return null
  const named = far.length <= 2 ? far.join(' and ') : `${far[0]}, ${far[1]} and ${far.length - 2} more`
  return `Stays as written on another machine: ${named}.`
}

export function describeFiles(files: string[]): string {
  if (files.length === 0) return ''
  if (files.length === 1) return basename(files[0]!)
  if (files.length === 2) {
    return `${basename(files[0]!)} and ${basename(files[1]!)}`
  }
  return `${basename(files[0]!)} and ${files.length - 1} others`
}
