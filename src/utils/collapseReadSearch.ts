import type { UUID } from 'crypto'

import { findToolByName, safeSearchOrReadClassification, type Tools } from '../Tool.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { extractBashCommentLabel } from '../tools/BashTool/commentLabel.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { getReplPrimitiveTools } from '../tools/REPLTool/primitiveTools.js'
import { REPL_TOOL_NAME } from '../tools/REPLTool/constants.js'
import {
  detectGitOperation,
  type BranchAction,
  type CommitKind,
  type PrAction,
} from '../tools/shared/gitOperationTracking.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/prompt.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import type {
  AttachmentMessage,
  CollapsedReadSearchGroup,
  CollapsibleMessage,
  GroupedToolUseMessage,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
  RenderableMessage,
  StopHookInfo,
  SystemStopHookSummaryMessage,
} from '../types/message.js'
import type { ToolUseBlock } from '../types/wire.js'
import { getDisplayPath } from './file.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import {
  isAutoManagedMemoryFile,
  isAutoManagedMemoryPattern,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
} from './memoryFileDetection.js'


export type SearchOrReadResult = {
  isCollapsible: boolean
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  isMemoryWrite: boolean
  absorbSilently: boolean
  isBashCommand: boolean
  mcpServerName?: string
}

const NOT_COLLAPSIBLE: SearchOrReadResult = {
  isCollapsible: false,
  isSearch: false,
  isRead: false,
  isList: false,
  isREPL: false,
  isMemoryWrite: false,
  absorbSilently: false,
  isBashCommand: false,
}

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
  if (toolName === REPL_TOOL_NAME) {
    return { ...NOT_COLLAPSIBLE, isCollapsible: true, isREPL: true, absorbSilently: true }
  }
  if (toolName === FILE_WRITE_TOOL_NAME || toolName === FILE_EDIT_TOOL_NAME) {
    const targetPath = inputPath(toolInput)
    if (targetPath !== undefined && isAutoManagedMemoryFile(targetPath)) {
      return { ...NOT_COLLAPSIBLE, isCollapsible: true, isMemoryWrite: true }
    }
  }
  const fullscreen = isFullscreenEnvEnabled()
  if (fullscreen && toolName === TOOL_SEARCH_TOOL_NAME) {
    return { ...NOT_COLLAPSIBLE, isCollapsible: true, absorbSilently: true }
  }
  const tool = findToolByName(tools, toolName) ?? findToolByName(getReplPrimitiveTools(), toolName)
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
    isREPL: false,
    isMemoryWrite: false,
    absorbSilently: false,
    isBashCommand: fullscreen && isBash && !(flags.isSearch || flags.isRead),
    mcpServerName,
  }
}

export function getSearchOrReadFromContent(
  content: unknown,
  tools: Tools,
): SearchOrReadResult | null {
  if (typeof content !== 'object' || content === null) return null
  const block = content as { type?: unknown; name?: unknown; input?: unknown }
  if (block.type !== 'tool_use' || typeof block.name !== 'string') return null
  const info = getToolSearchOrReadInfo(block.name, block.input, tools)
  if (!info.isCollapsible && !info.isREPL) return null
  return info
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


type OpenGroup = {
  messages: CollapsibleMessage[]
  toolUseIds: Set<string>
  searchCount: number
  listCount: number
  readOperationCount: number
  readFilePaths: Set<string>
  memoryReadPaths: Set<string>
  memorySearchCount: number
  memoryWriteCount: number
  searchArgs: string[]
  latestDisplayHint: string | undefined
  mcpCallCount: number
  mcpServerNames: string[]
  bashCount: number
  bashCommandsByToolUseId: Map<string, string>
  gitOpBashCount: number
  commits: Array<{ sha: string; kind: CommitKind }>
  pushes: Array<{ branch: string }>
  branches: Array<{ ref: string; action: BranchAction }>
  prs: Array<{ number: number; url?: string; action: PrAction }>
  hookTotalMs: number
  hookCount: number
  hookInfos: StopHookInfo[]
  relevantMemories: Array<{ path: string; content: string; mtimeMs: number }>
  deferred: RenderableMessage[]
  deferredStatusToolUseIds: Set<string>
}

function emptyGroup(): OpenGroup {
  return {
    messages: [],
    toolUseIds: new Set(),
    searchCount: 0,
    listCount: 0,
    readOperationCount: 0,
    readFilePaths: new Set(),
    memoryReadPaths: new Set(),
    memorySearchCount: 0,
    memoryWriteCount: 0,
    searchArgs: [],
    latestDisplayHint: undefined,
    mcpCallCount: 0,
    mcpServerNames: [],
    bashCount: 0,
    bashCommandsByToolUseId: new Map(),
    gitOpBashCount: 0,
    commits: [],
    pushes: [],
    branches: [],
    prs: [],
    hookTotalMs: 0,
    hookCount: 0,
    hookInfos: [],
    relevantMemories: [],
    deferred: [],
    deferredStatusToolUseIds: new Set(),
  }
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
  const memberCount = described.members.length
  for (const member of described.members) {
    group.toolUseIds.add(member.toolUseId)
  }

  if (info.isMemoryWrite) {
    group.memoryWriteCount += memberCount
    return
  }
  if (info.absorbSilently) {
    return
  }
  if (info.mcpServerName) {
    group.mcpCallCount += memberCount
    if (!group.mcpServerNames.includes(info.mcpServerName)) {
      group.mcpServerNames.push(info.mcpServerName)
    }
    const query = inputField(described.firstInput, 'query')
    if (query !== undefined) {
      group.latestDisplayHint = `"${query}"`
    }
    return
  }
  if (info.isBashCommand) {
    group.bashCount += memberCount
    const command = inputField(described.firstInput, 'command')
    if (command !== undefined) {
      const label = extractBashCommentLabel(command)
      group.latestDisplayHint = label !== undefined ? label : formatCommandHint(command)
      for (const member of described.members) {
        group.bashCommandsByToolUseId.set(member.toolUseId, command)
      }
    }
    return
  }
  if (info.isList) {
    group.listCount += memberCount
    const command = inputField(described.firstInput, 'command')
    if (command !== undefined) {
      group.latestDisplayHint = formatCommandHint(command)
    }
    return
  }
  if (info.isSearch) {
    group.searchCount += memberCount
    const path = inputField(described.firstInput, 'path')
    const pattern = inputField(described.firstInput, 'pattern')
    const command = inputField(described.firstInput, 'command')
    const targetsMemory =
      (path !== undefined && (isAutoManagedMemoryFile(path) || isMemoryDirectory(path))) ||
      (pattern !== undefined && isAutoManagedMemoryPattern(pattern)) ||
      (command !== undefined && isShellCommandTargetingMemory(command))
    if (targetsMemory) {
      group.memorySearchCount += memberCount
      return
    }
    if (pattern !== undefined) {
      group.searchArgs.push(pattern)
      group.latestDisplayHint = `"${pattern}"`
    }
    return
  }
  for (const member of described.members) {
    const filePath = inputField(member.input, 'file_path')
    if (filePath !== undefined) {
      group.readFilePaths.add(filePath)
      if (isAutoManagedMemoryFile(filePath)) {
        group.memoryReadPaths.add(filePath)
      } else {
        group.latestDisplayHint = getDisplayPath(filePath)
      }
    } else {
      group.readOperationCount += 1
      const command = inputField(member.input, 'command')
      if (command !== undefined) {
        group.latestDisplayHint = formatCommandHint(command)
      }
    }
  }
}

function buildCollapsedRow(group: OpenGroup): CollapsedReadSearchGroup {
  const first = group.messages[0] as CollapsibleMessage
  const fullscreen = isFullscreenEnvEnabled()

  const totalReadCount =
    group.readFilePaths.size > 0 ? group.readFilePaths.size : group.readOperationCount
  const reportedReadCount = Math.max(0, totalReadCount - group.memoryReadPaths.size)
  const memoryReadCount = group.memoryReadPaths.size + group.relevantMemories.length
  const reportedSearchCount = Math.max(0, group.searchCount - group.memorySearchCount)
  const nonMemoryReadPaths = [...group.readFilePaths].filter(
    path => !group.memoryReadPaths.has(path),
  )

  const row: CollapsedReadSearchGroup = {
    type: 'collapsed_read_search',
    searchCount: reportedSearchCount,
    readCount: reportedReadCount,
    listCount: group.listCount,
    replCount: 0,
    memorySearchCount: group.memorySearchCount,
    memoryReadCount,
    memoryWriteCount: group.memoryWriteCount,
    readFilePaths: nonMemoryReadPaths,
    searchArgs: group.searchArgs,
    latestDisplayHint: group.latestDisplayHint,
    messages: group.messages,
    displayMessage: first,
    uuid: `collapsed-${first.uuid}` as UUID,
    timestamp: first.timestamp,
  }
  if (group.mcpCallCount > 0) {
    row.mcpCallCount = group.mcpCallCount
    row.mcpServerNames = group.mcpServerNames
  }
  if (fullscreen && group.bashCount > 0) {
    row.bashCount = group.bashCount
    row.gitOpBashCount = group.gitOpBashCount
    if (group.commits.length > 0) row.commits = group.commits
    if (group.pushes.length > 0) row.pushes = group.pushes
    if (group.branches.length > 0) row.branches = group.branches
    if (group.prs.length > 0) row.prs = group.prs
  }
  if (group.hookCount > 0) {
    row.hookTotalMs = group.hookTotalMs
    row.hookCount = group.hookCount
    row.hookInfos = group.hookInfos
  }
  if (group.relevantMemories.length > 0) {
    row.relevantMemories = group.relevantMemories
  }
  return row
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
  if (group.bashCommandsByToolUseId.size === 0) return
  const result = (message as { toolUseResult?: unknown }).toolUseResult as
    | { stdout?: string; stderr?: string }
    | undefined
  const stdout = result?.stdout ?? ''
  const stderr = result?.stderr ?? ''
  if (!stdout && !stderr) return
  const output = `${stdout}\n${stderr}`
  for (const block of toolResultBlocks(message)) {
    const command = group.bashCommandsByToolUseId.get(block.tool_use_id)
    if (command === undefined) continue
    const detected = detectGitOperation(command, output)
    let producedAny = false
    if (detected.commit) {
      group.commits.push(detected.commit)
      producedAny = true
    }
    if (detected.push) {
      group.pushes.push(detected.push)
      producedAny = true
    }
    if (detected.branch) {
      group.branches.push(detected.branch)
      producedAny = true
    }
    if (detected.pr) {
      group.prs.push(detected.pr)
      producedAny = true
    }
    if (producedAny) group.gitOpBashCount += 1
  }
}

function absorbHookSummary(group: OpenGroup, message: SystemStopHookSummaryMessage): void {
  group.hookCount += message.hookCount
  const duration =
    message.totalDurationMs ??
    message.hookInfos.reduce((total, info) => total + (info.durationMs ?? 0), 0)
  group.hookTotalMs += duration
  group.hookInfos.push(...message.hookInfos)
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
        if (info.isCollapsible && (running || unresolved)) {
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

    if (
      message.type === 'system' &&
      message.subtype === 'stop_hook_summary' &&
      message.hookLabel === 'PreToolUse' &&
      groupOpen()
    ) {
      absorbHookSummary(group, message)
      continue
    }

    if (message.type === 'attachment') {
      const attachment = message.attachment as { type?: string }
      if (attachment.type === 'relevant_memories' && groupOpen()) {
        const memories = (
          message as AttachmentMessage<{
            type: 'relevant_memories'
            memories: Array<{ path: string; content: string; mtimeMs: number }>
          }>
        ).attachment.memories
        group.relevantMemories.push(
          ...memories.map(memory => ({
            path: memory.path,
            content: memory.content,
            mtimeMs: memory.mtimeMs,
          })),
        )
        continue
      }
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
  replCount?: number,
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
  if (replCount !== undefined && replCount > 0) {
    addClause("REPL'ing", "REPL'd", `${replCount} ${pluralize(replCount, 'time', 'times')}`, false)
  }

  const text = clauses.join(', ')
  return isActive ? `${text}…` : text
}

type RecentActivity = {
  activityDescription?: string
  isSearch?: boolean
  isRead?: boolean
}

export function summarizeRecentActivities(
  activities: readonly RecentActivity[],
): string | undefined {
  let searches = 0
  let reads = 0
  let runLength = 0
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i] as RecentActivity
    if (activity.isSearch) {
      searches++
      runLength++
    } else if (activity.isRead) {
      reads++
      runLength++
    } else {
      break
    }
  }
  if (runLength >= 2) {
    return getSearchReadSummaryText(searches, reads, true)
  }
  for (let i = activities.length - 1; i >= 0; i--) {
    const description = (activities[i] as RecentActivity).activityDescription
    if (description) return description
  }
  return undefined
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

export function hasAnyToolInProgress(
  message: CollapsedReadSearchGroup,
  inProgressToolUseIDs: Set<string>,
): boolean {
  return getToolUseIdsFromCollapsedGroup(message).some(id => inProgressToolUseIDs.has(id))
}

export function getDisplayMessageFromCollapsed(
  message: CollapsedReadSearchGroup,
): NormalizedAssistantMessage | NormalizedUserMessage {
  const display = message.displayMessage
  if (display.type === 'grouped_tool_use') {
    return display.displayMessage
  }
  return display
}
