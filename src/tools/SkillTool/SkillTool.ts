import uniqBy from 'lodash-es/uniqBy.js'
import { z } from 'zod/v4'

import { clearInvokedSkillsForAgent, getProjectRoot } from '../../bootstrap/state.js'
import { INTERRUPT_MESSAGE } from '../../utils/messages/rejectionText.js'
import { findCommand, getMcpSkillCommands, getSkillToolCommands } from '../../commands.js'
import { COMMAND_MESSAGE_TAG } from '../../constants/xml.js'
import type { CanUseToolFn } from '../../Tool.js'
import {
  buildTool,
  type ToolCallProgress,
  type ToolDef,
  type ToolUseContext,
  type ValidationResult,
} from '../../Tool.js'
import { getCommandName, type Command, type PromptCommand } from '../../types/command.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { SkillToolProgress } from '../../types/tools.js'
import {
  createGetAppStateWithAllowedTools,
  extractResultText,
  prepareForkedCommandContext,
} from '../../services/agents/forkedAgent.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { normalizeMessages } from '../../services/messages.js'
import { resolveSkillModelOverride } from '../../services/model/model.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import { recordSkillUsage } from '../../utils/suggestions/skillUsageTracking.js'
import { createAgentId } from '../../utils/uuid.js'
import { runAgent } from '../AgentTool/runAgent.js'
import { evaluateLaunchAuthority } from '../../services/switchboard/launchAuthority.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tools/fileRead.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { getToolUseIDFromParentMessage, tagMessagesWithToolUseID } from '../utils.js'
import { SKILL_TOOL_NAME } from '../../constants/tools/skill.js'
import { getPrompt } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
} from './UI.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


export const inputSchema: Unbuilt = unbuilt('src/tools/SkillTool/SkillTool.ts:50')

export const outputSchema: Unbuilt = unbuilt('src/tools/SkillTool/SkillTool.ts:61')
export type Output = Unbuilt


export const READ_ONLY_SKILL_TOOLS: ReadonlySet<string> = new Set([
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
])

const SAFE_COMMAND_PROPERTIES: ReadonlySet<string> = unbuilt('src/tools/SkillTool/SkillTool.ts:99')

function isEmptyPlainObject(value: unknown): boolean {
  return notBuilt('src/tools/SkillTool/SkillTool.ts:133')
}

export function skillHasOnlySafeProperties(command: Command): boolean {
  for (const [key, value] of Object.entries(command)) {
    if (SAFE_COMMAND_PROPERTIES.has(key)) continue
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (isEmptyPlainObject(value)) continue
    if (
      key === 'allowedTools' &&
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(entry => typeof entry === 'string' && READ_ONLY_SKILL_TOOLS.has(entry))
    ) {
      continue
    }
    return false
  }
  return true
}


function normalizeSkillName(raw: string): string {
  return raw.trim().replace(/^\//, '')
}

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]!
}

function nearestSkillNames(name: string, commands: Command[]): string[] {
  const target = name.toLowerCase()
  const candidates = commands
    .filter(c => !(c as { disableModelInvocation?: boolean }).disableModelInvocation)
    .map(c => getCommandName(c))
  const scored = candidates
    .map(candidate => {
      const lower = candidate.toLowerCase()
      const affix = lower.startsWith(target) || target.startsWith(lower) || lower.includes(target) || target.includes(lower)
      const distance = editDistance(target, lower)
      const threshold = Math.max(2, Math.floor(Math.max(lower.length, target.length) / 3))
      return { candidate, affix, distance, near: affix || distance <= threshold }
    })
    .filter(entry => entry.near)
    .sort((a, b) => Number(b.affix) - Number(a.affix) || a.distance - b.distance)
  return scored.slice(0, 5).map(entry => entry.candidate)
}

function unknownSkillMessage(name: string, commands: Command[]): string {
  const nearest = nearestSkillNames(name, commands)
  if (nearest.length > 0) {
    return `Unknown skill: ${name}. Did you mean: ${nearest.join(', ')}? The available skills ride in system-reminder messages in this conversation.`
  }
  const total = commands.filter(c => !(c as { disableModelInvocation?: boolean }).disableModelInvocation).length
  return `Unknown skill: ${name}. No skill by that name is available${total > 0 ? ` (${total} skill${total === 1 ? '' : 's'} exist — they ride in system-reminder messages in this conversation)` : ''}.`
}

async function getCommandUniverse(context: ToolUseContext): Promise<Command[]> {
  const local = await getSkillToolCommands(getProjectRoot())
  const mcpSkills = getMcpSkillCommands(context.getAppState().mcp.commands)
  if (mcpSkills.length === 0) return local
  return uniqBy([...local, ...mcpSkills], 'name')
}

function ruleMatchesSkill(ruleContent: string, commandName: string): boolean {
  const content = ruleContent.replace(/^\//, '')
  if (content === commandName) return true
  if (content.endsWith('*') && content.length > 1) {
    return commandName.startsWith(content.slice(0, -1))
  }
  return false
}

function isPromptCommand(command: Command): command is Command & PromptCommand {
  return command.type === 'prompt'
}

export function expansionBodyOf(message: Message): string | null {
  if (message.type !== 'user' || message.isMeta !== true || !Array.isArray(message.message.content)) return null
  const text = message.message.content
    .map(block => (block.type === 'text' ? (block as { text: string }).text : ''))
    .join('\n')
  return text.trim() === '' ? null : text
}

function messageCarriesToolActivity(message: Message): boolean {
  if (message.type !== 'assistant' && message.type !== 'user') return false
  const content = message.message.content
  if (!Array.isArray(content)) return false
  return content.some(block => {
    const type = (block as { type?: string }).type
    return type === 'tool_use' || type === 'tool_result'
  })
}


export function refusedExpansionError(
  name: string,
  processed: { messages: ReadonlyArray<{ type: string; message?: { content?: unknown } }>; resultText?: string },
): Error {
  const texts = processed.messages
    .filter(message => message.type === 'user')
    .map(message => (typeof message.message?.content === 'string' ? message.message.content : ''))
    .filter(text => text !== '' && !text.startsWith('<command-name>'))
  if (texts.includes(INTERRUPT_MESSAGE)) {
    const error = new Error(`Skill /${name} was interrupted before it finished.`)
    error.name = 'AbortError'
    return error
  }
  const reason = [...texts, ...(processed.resultText !== undefined ? [processed.resultText] : [])].join('\n').trim()
  return new Error(reason === '' ? `Skill /${name} did not run (the processor answered nothing to query and gave no reason).` : `Skill /${name} failed: ${reason}`)
}

const FORK_CONTEXT_REFUSAL = 'Fork-context skills run only in the main session. Report what you checked to the session that launched you; it runs any independent verification.'

export const SkillTool: Unbuilt = unbuilt('src/tools/SkillTool/SkillTool.ts:270')
