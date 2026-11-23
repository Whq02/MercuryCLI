import type { RenderableMessage } from '../types/message.js'
import { isRecord } from './isRecord.js'
import { isTurnCutText } from './messages/rejectionText.js'
import { passedOver } from './passedOver.js'

type SearchTextTool = { name: string; extractSearchText?(output: unknown): string }
type ResolveSearchTool = (toolUseId: string) => SearchTextTool | undefined


const searchTextCache = new WeakMap<object, string>()

function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
}

function isInterruptionSentinel(text: string): boolean {
  return isTurnCutText(text)
}

type ToolUseLike = {
  name?: string
  input?: unknown
}

function ownSearchText(tool: SearchTextTool | undefined, result: unknown): string | undefined {
  if (tool === undefined) return undefined
  if (NON_INDEXING_TOOLS.has(tool.name)) return ''
  if (typeof tool.extractSearchText !== 'function') return undefined
  try {
    const text = tool.extractSearchText(result)
    return typeof text === 'string' ? text : ''
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function extractTextBlocks(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const rawBlock of blocks) {
    if (!isRecord(rawBlock)) continue
    if (rawBlock.type === 'text' && typeof rawBlock.text === 'string' && rawBlock.text !== '') {
      parts.push(rawBlock.text)
    }
  }
  return parts.join('\n')
}

function extractToolInputSearchText(block: ToolUseLike): string {
  const parts: string[] = []
  if (typeof block.name === 'string' && block.name !== '') parts.push(block.name)
  if (isRecord(block.input)) {
    for (const key of [
      'command',
      'description',
      'file_path',
      'path',
      'notebook_path',
      'filePath',
      'pattern',
      'query',
      'url',
      'prompt',
      'old_string',
      'new_string',
      'content',
    ] as const) {
      const value = block.input[key]
      if (typeof value === 'string' && value !== '') parts.push(value)
    }
    if (Array.isArray(block.input.files)) {
      for (const entry of block.input.files) {
        if (typeof entry === 'string' && entry !== '') parts.push(entry)
      }
    }
  }
  return parts.join(' ')
}

function extractToolResultSearchText(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return extractTextBlocks(result)
  if (!isRecord(result)) return ''
  const parts: string[] = []
  for (const key of ['stdout', 'stderr', 'result', 'filePath', 'oldString', 'newString'] as const) {
    const value = result[key]
    if (typeof value === 'string' && value !== '') parts.push(value)
  }
  if (typeof result.content === 'string' && result.content !== '') {
    parts.push(result.content)
  } else if (Array.isArray(result.content)) {
    const nested = extractTextBlocks(result.content)
    if (nested !== '') parts.push(nested)
  }
  if (isRecord(result.file)) {
    if (typeof result.file.filePath === 'string' && result.file.filePath !== '') parts.push(result.file.filePath)
    if (typeof result.file.content === 'string' && result.file.content !== '') parts.push(result.file.content)
  }
  if (Array.isArray(result.filenames)) {
    for (const name of result.filenames) {
      if (typeof name === 'string' && name !== '') parts.push(name)
    }
  }
  return parts.join('\n')
}

function computeSearchText(message: RenderableMessage, resolveTool?: ResolveSearchTool): string {
  switch (message.type) {
    case 'user': {
      const content = message.message.content
      if (typeof content === 'string') {
        return isInterruptionSentinel(content) ? '' : content
      }
      if (!Array.isArray(content)) return ''
      const parts: string[] = []
      for (const block of content) {
        if (block.type === 'text') {
          if (!isInterruptionSentinel(block.text)) parts.push(block.text)
        } else if (block.type === 'tool_result') {
          const tool = resolveTool !== undefined ? resolveTool(block.tool_use_id) : undefined
          const own = ownSearchText(tool, message.toolUseResult)
          const text = own !== undefined ? own : extractToolResultSearchText(message.toolUseResult)
          if (text !== '') parts.push(text)
        }
      }
      return parts.join('\n')
    }
    case 'assistant': {
      const content = message.message.content
      if (!Array.isArray(content)) return ''
      const parts: string[] = []
      for (const block of content) {
        if (block.type === 'text') {
          if (block.text !== '') parts.push(block.text)
        } else if (block.type === 'tool_use') {
          const text = extractToolInputSearchText(block)
          if (text !== '') parts.push(text)
        }
      }
      return parts.join('\n')
    }
    case 'attachment': {
      const attachment = message.attachment
      if (attachment.type !== 'queued_command') return ''
      if (attachment.isMeta === true || attachment.commandMode === 'task-notification') return ''
      if (typeof attachment.prompt === 'string') return attachment.prompt
      if (!Array.isArray(attachment.prompt)) return ''
      const parts: string[] = []
      for (const block of attachment.prompt) {
        if (block.type === 'text') parts.push(block.text)
      }
      return parts.join('\n')
    }
    case 'collapsed_read_search': {
      const memories = message.relevantMemories
      if (!Array.isArray(memories) || memories.length === 0) return ''
      return memories
        .map(memory => (typeof memory?.content === 'string' ? memory.content : ''))
        .join('\n')
    }
    default:
      return ''
  }
}

export function renderableSearchText(msg: RenderableMessage, resolveTool?: ResolveSearchTool): string {
  const cached = searchTextCache.get(msg)
  if (cached !== undefined) return cached
  const text = stripSystemReminders(computeSearchText(msg, resolveTool)).toLowerCase()
  searchTextCache.set(msg, text)
  return text
}


export const NON_INDEXING_TOOLS: ReadonlySet<string> = new Set([
  'ApolloReview',
  'Checkpoint',
  'Correct',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterWorktree',
  'ExitWorktree',
  'Eval',
  'Journal',
  'ListMcpResources',
  'Monitor',
  'NotebookEdit',
  'Recall',
  'RecordConvention',
  'Reflect',
  'Retain',
  'Rewind',
  'ScheduleWakeup',
  'SendMessage',
  'ResumeCrewmate',
  'Skill',
  'Sleep',
  'StructuredOutput',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
  'ToolSearch',
  'Workflow',
  'Contract',
])

export type TranscriptFacets = {
  tools: string[]
  files: string[]
  failed: boolean
}

export const EMPTY_FACETS: TranscriptFacets = { tools: [], files: [], failed: false }

export function toolInputFiles(input: unknown): string[] {
  if (!isRecord(input)) return []
  const files: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path', 'filePath'] as const) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) files.push(value)
  }
  if (Array.isArray(input.files)) {
    for (const entry of input.files) {
      if (typeof entry === 'string' && entry.length > 0) files.push(entry)
    }
  }
  return files
}

export type SearchQuery = {
  text: string
  tools: string[]
  files: string[]
  failedOnly: boolean
  structured: boolean
}

export function parseSearchQuery(raw: string): SearchQuery {
  const tools: string[] = []
  const files: string[] = []
  const freeTokens: string[] = []
  let failedOnly = false

  const working = raw.replace(/\b(tool|file):"([^"]*)"/gi, (full, operator: string, value: string) => {
    if (value === '') {
      freeTokens.push(full)
    } else if (operator.toLowerCase() === 'tool') {
      tools.push(value.toLowerCase())
    } else {
      files.push(value.toLowerCase())
    }
    return ' '
  })

  for (const token of working.split(/\s+/)) {
    if (token === '') continue
    const lower = token.toLowerCase()
    if (lower.startsWith('tool:') || lower.startsWith('file:')) {
      const value = token.slice(5)
      if (value === '' || value.startsWith('"')) {
        freeTokens.push(token)
        continue
      }
      if (lower.startsWith('tool:')) tools.push(value.toLowerCase())
      else files.push(value.toLowerCase())
      continue
    }
    if (lower.startsWith('failed:')) {
      failedOnly = true
      const trailing = token.slice('failed:'.length)
      if (trailing !== '') freeTokens.push(trailing)
      continue
    }
    freeTokens.push(token)
  }

  const structured = tools.length > 0 || files.length > 0 || failedOnly
  if (!structured) {
    return { text: raw.toLowerCase(), tools, files, failedOnly, structured }
  }
  return { text: freeTokens.join(' ').toLowerCase(), tools, files, failedOnly, structured }
}

export function facetsSatisfy(facets: TranscriptFacets, query: SearchQuery): boolean {
  if (query.failedOnly && !facets.failed) return false
  for (const tool of query.tools) {
    if (!facets.tools.some(name => name.toLowerCase().includes(tool))) return false
  }
  for (const file of query.files) {
    if (!facets.files.some(path => path.toLowerCase().includes(file))) return false
  }
  return true
}
