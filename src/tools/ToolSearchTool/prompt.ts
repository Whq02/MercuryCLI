import type { Tool } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { DeferralWireForm } from '../../services/providers/deferralWire.js'
import { qualifiedIdSpaceOf } from '../../services/providers/idSpaces.js'
import { TOOL_SEARCH_TOOL_NAME } from './constants.js'
import { APOLLO_REVIEW_TOOL_NAME } from '../ApolloReviewTool/constants.js'
import {
  isSaturnExemptEnabled,
  SATURN_EXEMPT_TOOL,
} from '../saturnExemptTools.js'
import { isDeferredToolsDeltaEnabled } from '../../utils/toolSearchFlags.js'

export { TOOL_SEARCH_TOOL_NAME }

export const STRIPPED_ADMISSION_RECORD_TEXT = "[Tool references removed — every tool's full schema is in this request's tool list; call the tools directly]"

function isMcpToolLike(tool: Tool): boolean {
  return 'isMcp' in tool && tool.isMcp === true
}

export function isDeferredTool(tool: Tool, permissionMode?: string): boolean {
  void permissionMode
  void APOLLO_REVIEW_TOOL_NAME
  if (tool.alwaysLoad) return false
  if (isMcpToolLike(tool)) return true
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false
  if (tool.name === SATURN_EXEMPT_TOOL && isSaturnExemptEnabled()) return false
  return Boolean(tool.shouldDefer)
}

export function loadsInFullFor(tool: Tool, model: string | undefined): boolean {
  if (tool.loadInFullOnCloud !== true) return false
  if (model === undefined || model.trim() === '') return false
  return qualifiedIdSpaceOf(model)?.route !== 'local'
}

type RecordedMarks = { model: string; length: number; marks: ReadonlyMap<string, boolean> | null }
const recordedMarksByHistory = new WeakMap<readonly Message[], RecordedMarks>()

function recordedDeferralMarks(messages: readonly Message[], model: string): ReadonlyMap<string, boolean> | null {
  const cached = recordedMarksByHistory.get(messages)
  if (cached !== undefined && cached.model === model && cached.length === messages.length) return cached.marks
  let marks: Map<string, boolean> | null = null
  const first = messages.find(message => message.type === 'assistant' || (message.type === 'user' && message.isMeta !== true))
  const suffix = `|${first?.uuid ?? 'empty'}|${model}`
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'attachment' || message.attachment.type !== 'bound_prefix') continue
    const record = message.attachment
    if (!record.boundKey.endsWith(suffix)) continue
    marks = new Map(record.roster.map(item => [item.name, record.rosterEnabled && item.deferred]))
    break
  }
  recordedMarksByHistory.set(messages, { model, length: messages.length, marks })
  return marks
}

export function isDeferredToolFor(tool: Tool, model: string | undefined, permissionMode?: string, messages: readonly Message[] = []): boolean {
  if (model !== undefined && messages.length > 0) {
    const recorded = recordedDeferralMarks(messages, model)?.get(tool.name)
    if (recorded !== undefined) return recorded
  }
  return isDeferredTool(tool, permissionMode) && !loadsInFullFor(tool, model)
}

const ANNOUNCEMENT_LINE_HINT_LIMIT = 100

export function formatDeferredToolLine(tool: Tool): string {
  const hint = (tool.searchHint ?? '').replace(/\s+/g, ' ').trim()
  if (hint === '') return tool.name
  if (hint.length <= ANNOUNCEMENT_LINE_HINT_LIMIT) return `${tool.name} — ${hint}`
  const space = hint.lastIndexOf(' ', ANNOUNCEMENT_LINE_HINT_LIMIT)
  const cut = hint.slice(0, space === -1 ? ANNOUNCEMENT_LINE_HINT_LIMIT : space).replace(/[ ,;:—]+$/u, '')
  return `${tool.name} — ${cut}…`
}

export function getPrompt(wireForm: DeferralWireForm = 'block'): string {
  const head = `Load the full schemas of deferred tools so they become callable.

`
  const location = isDeferredToolsDeltaEnabled()
    ? `Deferred tools are listed in <system-reminder> messages that begin "Deferred tools:", one per line: the name, then what the tool is for.`
    : `Deferred tools are listed in <available-deferred-tools> messages, one per line: the name, then what the tool is for.`
  const hold = ` Before that fetch, the name and its line are all you hold — without a parameter schema the tool stays uncallable. Hand it a query; it matches against the deferred roster and `
  const direct = ` A tool already in your tool list needs no fetch: call it directly.`
  const miss = ` A select that names a tool this session does not have loads nothing; the result names the miss.`
  const queryForms = `

Query forms:
- \`select:WebFetch,Sleep\` — pull exactly the tools named, spelled as the list spells them
- \`notebook jupyter\` — keyword search returning the best matches, max_results at most
- \`+slack send\` — "slack" must appear in the name; remaining terms only rank`
  if (wireForm === 'text-append') {
    const admits = `admits each match: the result names the admitted tools, and their complete definitions are appended to the conversation right after it, callable from then on, no different from the tools the prompt opened with.`
    return head + location + hold + admits + direct + miss + queryForms
  }
  if (wireForm !== 'block') {
    const admits = `admits each match: the result names the admitted tools, and from that request on their complete definitions are in your tool list, no different from the tools the prompt opened with.`
    return head + location + hold + admits + direct + miss + queryForms
  }
  const answers = `answers with the complete JSONSchema definition of each match, inside a <functions> block. A schema landing in that result makes its tool callable, no different from the tools the prompt opened with.`
  const shape = `

Shape of the result: every match lands as its own \`<function>{"description": "...", "name": "...", "parameters": {...}}</function>\` line inside the <functions> block, encoded the way the opening tool list is.`
  return head + location + hold + answers + direct + shape + miss + queryForms
}
