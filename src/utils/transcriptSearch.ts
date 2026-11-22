import type { RenderableMessage } from '../types/message.js'
import { isTurnCutText } from './messages/rejectionText.js'
import { passedOver } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'

type SearchTextTool = { name: string; extractSearchText?(output: unknown): string }
type ResolveSearchTool = (toolUseId: string) => SearchTextTool | undefined


const searchTextCache = new WeakMap<object, string>()

function stripSystemReminders(text: string): string {
  return notBuilt('src/utils/transcriptSearch.ts:56')
}

function isInterruptionSentinel(text: string): boolean {
  return isTurnCutText(text)
}

type BlockLike = {
  type?: string
  text?: string
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

function computeSearchText(message: RenderableMessage, resolveTool?: ResolveSearchTool): string {
  return notBuilt('src/utils/transcriptSearch.ts:93')
}

export function renderableSearchText(msg: RenderableMessage, resolveTool?: ResolveSearchTool): string {
  const cached = searchTextCache.get(msg as object)
  if (cached !== undefined) return cached
  const text = stripSystemReminders(computeSearchText(msg, resolveTool)).toLowerCase()
  searchTextCache.set(msg as object, text)
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
  return notBuilt('src/utils/transcriptSearch.ts:208')
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
