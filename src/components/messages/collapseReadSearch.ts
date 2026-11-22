import type { UUID } from 'crypto'

import { findToolByName, safeSearchOrReadClassification, type Tools } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../constants/tools/bash.js'
import { extractBashCommentLabel } from '../../tools/BashTool/commentLabel.js'
import { FILE_EDIT_TOOL_NAME } from '../../constants/tools/fileEdit.js'
import { FILE_WRITE_TOOL_NAME } from '../../constants/tools/fileWrite.js'
import {
  detectGitOperation,
  type BranchAction,
  type CommitKind,
  type PrAction,
} from '../../tools/shared/gitOperationTracking.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import { TASK_CREATE_TOOL_NAME } from '../../constants/tools/taskCreate.js'
import { TASK_GET_TOOL_NAME } from '../../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../constants/tools/taskUpdate.js'
import type {
  CollapsedReadSearchGroup,
  CollapsibleMessage,
  GroupedToolUseMessage,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
  RenderableMessage,
} from '../../types/message.js'
import type { ToolUseBlock } from '../../types/wire.js'
import { getDisplayPath } from '../../utils/file.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import {
  isAutoManagedMemoryFile,
  isAutoManagedMemoryPattern,
  isMnemeFile,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
} from '../../utils/memoryFileDetection.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


type SearchOrReadResult = Unbuilt

const NOT_COLLAPSIBLE: SearchOrReadResult = unbuilt('src/components/messages/collapseReadSearch.ts:50')

function inputPath(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const record = toolInput as { file_path?: unknown; path?: unknown }
  if (typeof record.file_path === 'string') return record.file_path
  if (typeof record.path === 'string') return record.path
  return undefined
}

function inputField(toolInput: unknown, field: string): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const value = (toolInput as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

export function getToolSearchOrReadInfo(
  toolName: string,
  toolInput: unknown,
  tools: Tools,
): SearchOrReadResult {
  if (toolName === FILE_WRITE_TOOL_NAME || toolName === FILE_EDIT_TOOL_NAME) {
    const targetPath = inputPath(toolInput)
    if (targetPath !== undefined && isAutoManagedMemoryFile(targetPath) && !isMnemeFile(targetPath)) {
      return { ...NOT_COLLAPSIBLE, isCollapsible: true, isMemoryWrite: true }
    }
  }
  const fullscreen = isFullscreenEnvEnabled()
  if (fullscreen && toolName === TOOL_SEARCH_TOOL_NAME) {
    return { ...NOT_COLLAPSIBLE, isCollapsible: true, absorbSilently: true }
  }
  const tool = findToolByName(tools, toolName)
  const flags = safeSearchOrReadClassification(tool, toolInput)
  if (!tool || !flags) {
    return NOT_COLLAPSIBLE
  }
  const isBash = toolName === BASH_TOOL_NAME
  const isCollapsible =
    flags.isSearch || flags.isRead || Boolean(flags.isList) || (fullscreen && isBash)
  const mcpServerName =
    tool.isMcp && tool.mcpInfo?.serverName ? tool.mcpInfo.serverName : undefined
  return {
    isCollapsible,
    isSearch: flags.isSearch,
    isRead: flags.isRead,
    isList: Boolean(flags.isList),
    isMemoryWrite: false,
    absorbSilently: false,
    isBashCommand: fullscreen && isBash && !(flags.isSearch || flags.isRead),
    mcpServerName,
  }
}


type ToolUseMember = { toolUseId: string; input: unknown }

function firstAssistantBlock(message: NormalizedAssistantMessage): { type?: string } | undefined {
  return message.message.content[0] as { type?: string } | undefined
}

function toolUseFromAssistant(message: NormalizedAssistantMessage): ToolUseBlock | null {
  const block = firstAssistantBlock(message)
  if (block && block.type === 'tool_use') return block as ToolUseBlock
  return null
}

function describeToolUse(
  message: NormalizedAssistantMessage | GroupedToolUseMessage,
): { toolName: string; firstInput: unknown; members: ToolUseMember[] } | null {
  if (message.type === 'grouped_tool_use') {
    const members: ToolUseMember[] = []
    for (const member of message.messages) {
      const block = toolUseFromAssistant(member)
      if (block) members.push({ toolUseId: block.id, input: block.input })
    }
    const first = members[0]
    if (!first) return null
    return { toolName: message.toolName, firstInput: first.input, members }
  }
  const block = toolUseFromAssistant(message)
  if (!block) return null
  return { toolName: block.name, firstInput: block.input, members: [{ toolUseId: block.id, input: block.input }] }
}

function toolResultBlocks(message: NormalizedUserMessage): Array<{ tool_use_id: string }> {
  const blocks: Array<{ tool_use_id: string }> = []
  for (const block of message.message.content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'tool_result' &&
      typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
    ) {
      blocks.push(block as { tool_use_id: string })
    }
  }
  return blocks
}


const MAX_HINT_LENGTH = 300

function formatCommandHint(command: string): string {
  const lines = command
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
  const hint = `$ ${lines.join('\n')}`
  if (hint.length > MAX_HINT_LENGTH) {
    return `${hint.slice(0, MAX_HINT_LENGTH - 1)}…`
  }
  return hint
}


type OpenGroup = Unbuilt

function emptyGroup(): OpenGroup {
  return notBuilt('src/components/messages/collapseReadSearch.ts:199')
}

const STATUS_UPDATE_TOOLS: ReadonlySet<string> = new Set([
  TASK_CREATE_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
])

export function isStatusUpdateTool(toolName: string): boolean {
  return STATUS_UPDATE_TOOLS.has(toolName)
}

function absorbToolUse(
  group: OpenGroup,
  info: SearchOrReadResult,
  described: { toolName: string; firstInput: unknown; members: ToolUseMember[] },
): void {
  return notBuilt('src/components/messages/collapseReadSearch.ts:238')
}

function buildCollapsedRow(group: OpenGroup): CollapsedReadSearchGroup {
  return notBuilt('src/components/messages/collapseReadSearch.ts:324')
}

function toolUseIdsOfAssistant(message: RenderableMessage): string[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((block): block is { type: 'tool_use'; id: string } => (block as { type?: string })?.type === 'tool_use' && typeof (block as { id?: unknown }).id === 'string')
    .map(block => block.id)
}

function isSkippable(message: RenderableMessage): boolean {
  if (message.type === 'attachment' || message.type === 'system') return true
  if (message.type === 'assistant') {
    const block = firstAssistantBlock(message)
    return block?.type === 'thinking' || block?.type === 'redacted_thinking'
  }
  return false
}

function scanForGitOperations(group: OpenGroup, message: NormalizedUserMessage): void {
  return notBuilt('src/components/messages/collapseReadSearch.ts:388')
}


export function collapseReadSearchGroups(
  messages: RenderableMessage[],
  tools: Tools,
  inProgressToolUseIDs: ReadonlySet<string> = new Set(),
): RenderableMessage[] {
  const out: RenderableMessage[] = []
  const fullscreen = isFullscreenEnvEnabled()
  let group = emptyGroup()
  const settledToolUseIds = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    for (const block of toolResultBlocks(message)) settledToolUseIds.add(block.tool_use_id)
  }

  const groupOpen = (): boolean => group.messages.length > 0

  const flush = (): void => {
    if (group.messages.length > 0) {
      out.push(buildCollapsedRow(group))
      out.push(...group.deferred)
    }
    group = emptyGroup()
  }

  for (const message of messages) {
    if (message.type === 'assistant' || message.type === 'grouped_tool_use') {
      const described =
        message.type === 'grouped_tool_use' || toolUseFromAssistant(message)
          ? describeToolUse(message)
          : null
      if (described) {
        const info = getToolSearchOrReadInfo(described.toolName, described.firstInput, tools)
        const running = described.members.some(m => inProgressToolUseIDs.has(m.toolUseId))
        const unresolved = described.members.some(m => !settledToolUseIds.has(m.toolUseId))
        if (info.isCollapsible && unresolved && !running) {
          flush()
          out.push(message)
        } else if (info.isCollapsible) {
          group.messages.push(message as CollapsibleMessage)
          absorbToolUse(group, info, described)
        } else if (groupOpen() && message.type === 'assistant' && isStatusUpdateTool(described.toolName)) {
          group.deferred.push(message)
          for (const id of toolUseIdsOfAssistant(message)) group.deferredStatusToolUseIds.add(id)
        } else {
          flush()
          out.push(message)
        }
        continue
      }
      if (message.type === 'assistant' && isSkippable(message)) {
        if (groupOpen()) group.deferred.push(message)
        else out.push(message)
        continue
      }
      flush()
      out.push(message)
      continue
    }

    if (message.type === 'user') {
      const results = toolResultBlocks(message)
      if (results.length > 0 && results.every(block => group.toolUseIds.has(block.tool_use_id))) {
        group.messages.push(message)
        if (fullscreen) scanForGitOperations(group, message)
        continue
      }
      if (results.length > 0 && results.every(block => group.deferredStatusToolUseIds.has(block.tool_use_id))) {
        group.deferred.push(message)
        continue
      }
      flush()
      out.push(message)
      continue
    }

    if (message.type === 'attachment') {
      const attachment = message.attachment as { type?: string }
      if (attachment.type === 'nested_memory' && groupOpen()) {
        out.push(message)
        continue
      }
    }

    if (isSkippable(message)) {
      if (groupOpen()) group.deferred.push(message)
      else out.push(message)
      continue
    }

    flush()
    out.push(message)
  }
  flush()
  return out
}


type MemoryCounts = {
  memorySearchCount?: number
  memoryReadCount?: number
  memoryWriteCount?: number
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural
}

export function getSearchReadSummaryText(
  searchCount: number,
  readCount: number,
  isActive: boolean,
  memoryCounts?: MemoryCounts,
  listCount?: number,
): string {
  const clauses: string[] = []
  const addClause = (activeVerb: string, completedVerb: string, rest: string, recase: boolean): void => {
    let verb = isActive ? activeVerb : completedVerb
    if (recase && clauses.length > 0) {
      verb = verb.charAt(0).toLowerCase() + verb.slice(1)
    }
    clauses.push(rest.length > 0 ? `${verb} ${rest}` : verb)
  }

  if (memoryCounts) {
    const recalls = memoryCounts.memoryReadCount ?? 0
    if (recalls > 0) {
      addClause('Recalling', 'Recalled', `${recalls} ${pluralize(recalls, 'memory', 'memories')}`, true)
    }
    const memorySearches = memoryCounts.memorySearchCount ?? 0
    if (memorySearches > 0) {
      addClause('Searching', 'Searched', 'memories', true)
    }
    const memoryWrites = memoryCounts.memoryWriteCount ?? 0
    if (memoryWrites > 0) {
      addClause('Writing', 'Wrote', `${memoryWrites} ${pluralize(memoryWrites, 'memory', 'memories')}`, true)
    }
  }
  if (searchCount > 0) {
    addClause(
      'Searching for',
      'Searched for',
      `${searchCount} ${pluralize(searchCount, 'pattern', 'patterns')}`,
      true,
    )
  }
  if (readCount > 0) {
    addClause('Reading', 'Read', `${readCount} ${pluralize(readCount, 'file', 'files')}`, true)
  }
  if (listCount !== undefined && listCount > 0) {
    addClause(
      'Listing',
      'Listed',
      `${listCount} ${pluralize(listCount, 'directory', 'directories')}`,
      true,
    )
  }

  const text = clauses.join(', ')
  return isActive ? `${text}…` : text
}


export function getToolUseIdsFromCollapsedGroup(message: CollapsedReadSearchGroup): string[] {
  const ids: string[] = []
  for (const member of message.messages) {
    if (member.type === 'grouped_tool_use') {
      for (const inner of member.messages) {
        const block = toolUseFromAssistant(inner)
        if (block) ids.push(block.id)
      }
      continue
    }
    if (member.type === 'assistant') {
      const block = toolUseFromAssistant(member)
      if (block) ids.push(block.id)
    }
  }
  return ids
}
