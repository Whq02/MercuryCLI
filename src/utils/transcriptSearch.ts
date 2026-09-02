import type { RenderableMessage, Message } from '../types/message.js'
import { INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE } from './messages.js'


const searchTextCache = new WeakMap<object, string>()

export function toolUseSearchText(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const record = input as Record<string, unknown>
  const parts: string[] = []
  for (const field of ['command', 'pattern', 'file_path', 'path', 'prompt', 'description', 'query', 'url', 'skill']) {
    const value = record[field]
    if (typeof value === 'string') parts.push(value)
  }
  for (const field of ['args', 'files']) {
    const value = record[field]
    if (Array.isArray(value) && value.every(element => typeof element === 'string')) {
      parts.push((value as string[]).join(' '))
    }
  }
  return parts.join('\n')
}

export function toolResultSearchText(result: unknown): string {
  if (typeof result === 'string') return result
  if (typeof result !== 'object' || result === null) return ''
  const record = result as Record<string, unknown>
  if (typeof record.stdout === 'string') {
    return typeof record.stderr === 'string' && record.stderr !== ''
      ? `${record.stdout}\n${record.stderr}`
      : record.stdout
  }
  const file = record.file
  if (typeof file === 'object' && file !== null && typeof (file as { content?: unknown }).content === 'string') {
    return (file as { content: string }).content
  }
  const parts: string[] = []
  for (const field of ['content', 'output', 'result', 'text', 'message']) {
    const value = record[field]
    if (typeof value === 'string') parts.push(value)
  }
  for (const field of ['filenames', 'lines', 'results']) {
    const value = record[field]
    if (Array.isArray(value) && value.every(element => typeof element === 'string')) {
      parts.push((value as string[]).join('\n'))
    }
  }
  return parts.join('\n')
}

function stripSystemReminders(text: string): string {
  const OPEN = '<system-reminder>'
  const CLOSE = '</system-reminder>'
  let result = text
  for (;;) {
    const openIndex = result.indexOf(OPEN)
    if (openIndex === -1) return result
    const closeIndex = result.indexOf(CLOSE, openIndex)
    if (closeIndex === -1) return result
    result = result.slice(0, openIndex) + result.slice(closeIndex + CLOSE.length)
  }
}

function isInterruptionSentinel(text: string): boolean {
  return text === INTERRUPT_MESSAGE || text === INTERRUPT_MESSAGE_FOR_TOOL_USE
}

type BlockLike = {
  type?: string
  text?: string
  name?: string
  input?: unknown
}

function computeSearchText(message: RenderableMessage): string {
  if (message.type === 'user') {
    const content = message.message.content
    if (typeof content === 'string') {
      return isInterruptionSentinel(content) ? '' : content
    }
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    const toolUseResult = (message as { toolUseResult?: unknown }).toolUseResult
    for (const block of content as BlockLike[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (!isInterruptionSentinel(block.text)) parts.push(block.text)
      } else if (block.type === 'tool_result') {
        parts.push(toolResultSearchText(toolUseResult))
      }
    }
    return parts.join('\n')
  }

  if (message.type === 'assistant') {
    const content = message.message.content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const block of content as BlockLike[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      } else if (block.type === 'tool_use') {
        parts.push(toolUseSearchText(block.input))
      }
    }
    return parts.join('\n')
  }

  if (message.type === 'attachment') {
    const attachment = (message as { attachment?: { type?: string } }).attachment
    if (!attachment) return ''
    if (attachment.type === 'relevant_memories') {
      const memories = (attachment as { memories?: Array<{ content?: unknown }> }).memories
      if (!Array.isArray(memories)) return ''
      return memories
        .map(memory => (typeof memory.content === 'string' ? memory.content : ''))
        .join('\n')
    }
    if (attachment.type === 'queued_command') {
      const queued = attachment as { prompt?: unknown; commandMode?: string; isMeta?: boolean }
      if (queued.commandMode === 'task-notification') return ''
      if (queued.isMeta === true) return ''
      if (typeof queued.prompt === 'string') return queued.prompt
      if (Array.isArray(queued.prompt)) {
        return (queued.prompt as BlockLike[])
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text as string)
          .join('\n')
      }
      return ''
    }
    return ''
  }

  if ((message as { type?: string }).type === 'collapsed_read_search') {
    const memories = (message as { relevantMemories?: Array<{ content?: unknown }> }).relevantMemories
    if (!Array.isArray(memories)) return ''
    return memories.map(memory => (typeof memory.content === 'string' ? memory.content : '')).join('\n')
  }

  return ''
}

export function renderableSearchText(msg: RenderableMessage): string {
  const cached = searchTextCache.get(msg as object)
  if (cached !== undefined) return cached
  const text = stripSystemReminders(computeSearchText(msg)).toLowerCase()
  searchTextCache.set(msg as object, text)
  return text
}


export const NON_INDEXING_TOOLS: ReadonlySet<string> = new Set([
  'ApolloReview',
  'ArtifactsList',
  'Checkpoint',
  'Correct',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Eval',
  'LaunchFleet',
  'ListMcpResourcesTool',
  'Monitor',
  'NotebookEdit',
  'PushNotification',
  'REPL',
  'Recall',
  'RecordConvention',
  'Reflect',
  'RememberLesson',
  'Retain',
  'Rewind',
  'ScheduleWakeup',
  'SendMessage',
  'SendUserFile',
  'SetTier',
  'Skill',
  'Sleep',
  'StructuredOutput',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
  'TeamBrief',
  'TeamDelete',
  'TodoWrite',
  'ToolSearch',
  'Workflow',
  'contract',
])

export type TranscriptFacets = {
  tools: string[]
  files: string[]
  failed: boolean
}

export const EMPTY_FACETS: TranscriptFacets = { tools: [], files: [], failed: false }

export function toolInputFiles(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []
  const record = input as Record<string, unknown>
  const paths: string[] = []
  for (const field of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const value = record[field]
    if (typeof value === 'string' && value !== '') paths.push(value)
  }
  const files = record.files
  if (Array.isArray(files)) {
    for (const element of files) {
      if (typeof element === 'string') paths.push(element)
    }
  }
  return paths
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
