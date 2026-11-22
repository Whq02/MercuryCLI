import type { Tool } from '../../Tool.js'
import { expandLspFamily } from '../../utils/lsp/toolFamily.js'
import { discoverRunnerProfiles, hasPythonSignal } from '../../services/ide/projectRunners.js'
import type { Message } from '../../types/message.js'
import type { DeferralWireForm } from '../../services/providers/deferralWire.js'
import { qualifiedIdSpaceOf } from '../../services/providers/idSpaces.js'
import { localPromptProfileApplies } from '../../constants/localPromptProfile.js'
import { isUnattendedRun } from '../../utils/cockpit/runtimePosture.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../constants/tools/toolSearch.js'
import {
  isSaturnExemptEnabled,
  SATURN_EXEMPT_TOOL,
} from '../saturnExemptTools.js'
import { notBuilt } from '../../pi/holes.js'

export { TOOL_SEARCH_TOOL_NAME }

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

function onCloudRoute(model: string | undefined): boolean {
  if (model === undefined || model.trim() === '') return false
  return qualifiedIdSpaceOf(model)?.route !== 'local'
}

export function loadsInFullFor(tool: Tool, model: string | undefined): boolean {
  return tool.loadInFullOnCloud === true && onCloudRoute(model)
}

export const ECONOMY_DEFERRED: ReadonlySet<string> = new Set(['Crewmate', 'Skill', 'Test', 'LspRead', 'AstSearch'])

export function isEconomyDeferred(tool: Pick<Tool, 'name'>): boolean {
  return ECONOMY_DEFERRED.has(tool.name)
}

export function defersOnCloudFor(tool: Tool, model: string | undefined): boolean {
  return isEconomyDeferred(tool) && onCloudRoute(model)
}

const LOCAL_CORE: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Glob', 'Grep', TOOL_SEARCH_TOOL_NAME, 'StructuredOutput'])

export function defersOnLocalFor(tool: Pick<Tool, 'name' | 'alwaysLoad'>, model: string | undefined): boolean {
  if (LOCAL_CORE.has(tool.name) || tool.alwaysLoad === true) return false
  if (tool.name === SATURN_EXEMPT_TOOL && isSaturnExemptEnabled()) return false
  return localPromptProfileApplies(model)
}

type HistoryMarks = { model: string | undefined; length: number; marks: ReadonlyMap<string, boolean> | null; carried: ReadonlySet<string> }
const marksByHistory = new WeakMap<readonly Message[], HistoryMarks>()

function historyMarks(messages: readonly Message[], model: string | undefined): HistoryMarks {
  return notBuilt('src/tools/ToolSearchTool/prompt.ts:61')
}

export function isDeferredToolFor(tool: Tool, model: string | undefined, permissionMode?: string, messages: readonly Message[] = []): boolean {
  if (messages.length > 0) {
    const history = historyMarks(messages, model)
    const recorded = history.marks?.get(tool.name)
    if (recorded !== undefined) return recorded
    if (history.carried.has(tool.name)) return false
  }
  return (isDeferredTool(tool, permissionMode) && !loadsInFullFor(tool, model)) || defersOnCloudFor(tool, model) || defersOnLocalFor(tool, model)
}

const ANNOUNCEMENT_LINE_HINT_LIMIT = 100

const ANNOUNCED_WITH_PURPOSE: ReadonlySet<string> = new Set([...ECONOMY_DEFERRED, 'Eval', 'ChangeSet'])

export function formatDeferredToolLine(tool: Tool, unattended: boolean = false, model?: string): string {
  const hint = (tool.searchHint ?? '').replace(/\s+/g, ' ').trim()
  if (hint === '' || ((unattended || localPromptProfileApplies(model)) && !ANNOUNCED_WITH_PURPOSE.has(tool.name))) return tool.name
  if (hint.length <= ANNOUNCEMENT_LINE_HINT_LIMIT) return `${tool.name} — ${hint}`
  const space = hint.lastIndexOf(' ', ANNOUNCEMENT_LINE_HINT_LIMIT)
  const cut = hint.slice(0, space === -1 ? ANNOUNCEMENT_LINE_HINT_LIMIT : space).replace(/[ ,;:—]+$/u, '')
  return `${tool.name} — ${cut}…`
}

export function getPrompt(wireForm: DeferralWireForm = 'block', unattended: boolean = isUnattendedRun()): string {
  const head = `Loads the full definitions of deferred tools so they become callable.

`
  const location = unattended
    ? `Deferred tools are listed in <system-reminder> messages that begin "Deferred tools:", one name per line, optionally followed by a hint; keyword search matches names and descriptions even when only names are listed.`
    : `Deferred tools are listed in <system-reminder> messages that begin "Deferred tools:", one per line: the name, and what the tool is for when it declares one; keyword search also reads each tool's full description.`
  if (wireForm === 'text-append') {
    return head + location + ` The result names the admitted tools, and their complete definitions are appended to the conversation right after it, callable from then on, no different from the tools the prompt opened with.`
  }
  if (wireForm !== 'block') {
    return head + location + ` The result names the admitted tools, and from that request on their complete definitions are in your tool list, no different from the tools the prompt opened with.`
  }
  return head + location + ` The result carries the complete definition of each match inside a <functions> block, callable from then on, no different from the tools the prompt opened with.`
}
