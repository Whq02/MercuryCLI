import type { Tool } from '../../Tool.js'
import { expandLspFamily } from '../../services/lsp/toolFamily.js'
import { discoverRunnerProfiles, hasPythonSignal } from '../../services/ide/projectRunners.js'
import type { Message } from '../../types/message.js'
import type { DeferralWireForm } from '../../services/providers/deferralWire.js'
import { qualifiedIdSpaceOf } from '../../services/providers/idSpaces.js'
import { isUnattendedRun } from '../../utils/cockpit/runtimePosture.js'
import { TOOL_SEARCH_TOOL_NAME } from './constants.js'
import {
  isSaturnExemptEnabled,
  SATURN_EXEMPT_TOOL,
} from '../saturnExemptTools.js'

export { TOOL_SEARCH_TOOL_NAME }

export const STRIPPED_ADMISSION_RECORD_TEXT = "[Tool references removed — every tool's full schema is in this request's tool list; call the tools directly]"

function isMcpToolLike(tool: Tool): boolean {
  return 'isMcp' in tool && tool.isMcp === true
}

export function isDeferredTool(tool: Tool, permissionMode?: string): boolean {
  void permissionMode
  if (tool.alwaysLoad) return false
  if (isMcpToolLike(tool)) return true
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false
  if (tool.name === 'Test' && (discoverRunnerProfiles().profiles.some(profile => profile.kind === 'test') || hasPythonSignal())) return false
  if (tool.name === SATURN_EXEMPT_TOOL && isSaturnExemptEnabled()) return false
  return Boolean(tool.shouldDefer)
}

export function loadsInFullFor(tool: Tool, model: string | undefined): boolean {
  if (tool.loadInFullOnCloud !== true) return false
  if (model === undefined || model.trim() === '') return false
  return qualifiedIdSpaceOf(model)?.route !== 'local'
}

type HistoryMarks = { model: string | undefined; length: number; marks: ReadonlyMap<string, boolean> | null; carried: ReadonlySet<string> }
const marksByHistory = new WeakMap<readonly Message[], HistoryMarks>()

function historyMarks(messages: readonly Message[], model: string | undefined): HistoryMarks {
  const cached = marksByHistory.get(messages)
  if (cached !== undefined && cached.model === model && cached.length === messages.length) return cached
  let marks: Map<string, boolean> | null = null
  const carried = new Set<string>()
  let first: string | null = null
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (first === null && (message.type === 'assistant' || (message.type === 'user' && message.isMeta !== true))) first = message.uuid
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
      const names = (message as { compactMetadata?: { preCompactDiscoveredTools?: unknown } }).compactMetadata?.preCompactDiscoveredTools
      if (Array.isArray(names)) for (const name of names) if (typeof name === 'string') carried.add(name)
      continue
    }
    if (model === undefined || message.type !== 'attachment' || message.attachment.type !== 'bound_prefix') continue
    const record = message.attachment
    if (!record.boundKey.endsWith(`|${first ?? 'empty'}|${model}`)) continue
    marks = new Map(record.roster.flatMap(item => {
      const family = expandLspFamily(item.name)
      return family.map(name => [name, record.rosterEnabled && (family.length > 1 && name !== 'LspRead' ? true : item.deferred)] as const)
    }))
  }
  const computed = { model, length: messages.length, marks, carried }
  marksByHistory.set(messages, computed)
  return computed
}

export function isDeferredToolFor(tool: Tool, model: string | undefined, permissionMode?: string, messages: readonly Message[] = []): boolean {
  if (messages.length > 0) {
    const history = historyMarks(messages, model)
    const recorded = history.marks?.get(tool.name)
    if (recorded !== undefined) return recorded
    if (history.carried.has(tool.name)) return false
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

export function getPrompt(wireForm: DeferralWireForm = 'block', unattended: boolean = isUnattendedRun()): string {
  const head = `Load the full schemas of deferred tools so they become callable.

`
  const location = unattended
    ? `Deferred tools are listed in <system-reminder> messages that begin "Deferred tools:", one name per line, optionally followed by a hint. Keyword search matches names and descriptions even when only names are listed.`
    : `Deferred tools are listed in <system-reminder> messages that begin "Deferred tools:", one per line: the name, then what the tool is for.`
  const hold = ` Before that fetch, the name and its line are all you hold — without a parameter schema the tool stays uncallable. Hand it a query; it matches against the deferred roster and `
  const direct = ` A tool already in your tool list needs no fetch: call it directly.`
  const miss = ` A select that names a tool this session does not have loads nothing; the result names the miss.`
  const queryForms = `

Query forms:
- \`select:WebFetch,Sleep\` — names spelled as the list spells them
- \`notebook jupyter\` — keyword search
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
