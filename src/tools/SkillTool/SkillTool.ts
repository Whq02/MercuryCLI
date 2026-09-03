import uniqBy from 'lodash-es/uniqBy.js'
import { z } from 'zod/v4'

import { clearInvokedSkillsForAgent, getProjectRoot } from '../../bootstrap/state.js'
import { INTERRUPT_MESSAGE } from '../../utils/messages/rejectionText.js'
import { findCommand, getMcpSkillCommands, getSkillToolCommands } from '../../commands.js'
import { COMMAND_MESSAGE_TAG } from '../../constants/xml.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
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
} from '../../utils/forkedAgent.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { normalizeMessages } from '../../utils/messages.js'
import { resolveSkillModelOverride } from '../../utils/model/model.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'
import { suggestionForExactCommand, suggestionForPrefix } from '../../utils/permissions/shellRuleMatching.js'
import { recordSkillUsage } from '../../utils/suggestions/skillUsageTracking.js'
import { createAgentId } from '../../utils/uuid.js'
import { runAgent } from '../AgentTool/runAgent.js'
import { evaluateLaunchAuthority } from '../../services/switchboard/launchAuthority.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { getToolUseIDFromParentMessage, tagMessagesWithToolUseID } from '../utils.js'
import { SKILL_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
} from './UI.js'


export type { SkillToolProgress as Progress }

export const inputSchema = lazySchema(() =>
  z.object({
    skill: z
      .string()
      .describe('The skill name (e.g. "commit", "review", or an extension-namespaced "<extension>:skill")'),
    args: z.string().optional().describe('Optional arguments passed to the skill'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const outputSchema = lazySchema(() =>
  z.union([
    z.object({
      success: z.boolean().describe('Whether the skill loaded'),
      commandName: z.string().describe('The resolved skill command name'),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe('Tools the skill grants for its run'),
      model: z.string().optional().describe('The model the skill pins'),
      status: z
        .literal('inline')
        .optional()
        .describe('The skill expanded inline into the conversation'),
    }),
    z.object({
      success: z.boolean().describe('Whether the skill run completed'),
      commandName: z.string().describe('The resolved skill command name'),
      status: z.literal('forked').describe('The skill ran in a forked subagent'),
      agentId: z.string().describe('The forked runner\'s agent id'),
      result: z.string().describe('The forked run\'s result text'),
    }),
  ]),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.input<OutputSchema>


export const READ_ONLY_SKILL_TOOLS: ReadonlySet<string> = new Set([
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
])

const SAFE_COMMAND_PROPERTIES: ReadonlySet<string> = new Set([
  'type',
  'progressMessage',
  'contentLength',
  'argNames',
  'model',
  'effort',
  'source',
  'extensionInfo',
  'disableNonInteractive',
  'skillRoot',
  'context',
  'agent',
  'getPromptForCommand',
  'frontmatterKeys',
  'name',
  'description',
  'hasUserSpecifiedDescription',
  'isEnabled',
  'isHidden',
  'aliases',
  'isMcp',
  'argumentHint',
  'whenToUse',
  'pathFilters',
  'menuDescription',
  'version',
  'disableModelInvocation',
  'userInvocable',
  'loadedFrom',
  'immediate',
  'userFacingName',
])

function isEmptyPlainObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 0
  )
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
  if (content.endsWith(':*')) {
    return commandName.startsWith(content.slice(0, -2))
  }
  return false
}

function isPromptCommand(command: Command): command is Command & PromptCommand {
  return command.type === 'prompt'
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

export const SkillTool = buildTool({
  name: SKILL_TOOL_NAME,
  searchHint: 'invoke a slash-command skill by name',
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input: Input): string {
    return input.skill ?? ''
  },
  async description(input?: Partial<Input>) {
    return `Execute the ${input?.skill ?? ''} skill`
  },
  async prompt() {
    return getPrompt(getProjectRoot())
  },
  async validateInput(input: Input, context: ToolUseContext): Promise<ValidationResult> {
    const name = normalizeSkillName(input.skill ?? '')
    if (name.length === 0) {
      return { result: false, message: `Skill name is required (got "${input.skill}").`, errorCode: 1 }
    }
    const commands = await getCommandUniverse(context)
    const command = findCommand(name, commands)
    if (!command) {
      return { result: false, message: unknownSkillMessage(name, commands), errorCode: 2 }
    }
    if ((command as { disableModelInvocation?: boolean }).disableModelInvocation) {
      return {
        result: false,
        message: `Skill "${name}" cannot be invoked through ${SKILL_TOOL_NAME}: it sets disable-model-invocation in its frontmatter.`,
        errorCode: 4,
      }
    }
    if (!isPromptCommand(command)) {
      return { result: false, message: `Skill "${name}" is not a prompt-based skill and cannot be invoked.`, errorCode: 5 }
    }
    return { result: true }
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    const name = normalizeSkillName(input.skill ?? '')
    const commands = await getCommandUniverse(context)
    const command = findCommand(name, commands)
    const permissionContext = context.getAppState().toolPermissionContext

    for (const [content, rule] of getRuleByContentsForToolName(permissionContext, SKILL_TOOL_NAME, 'deny')) {
      if (ruleMatchesSkill(content, name)) {
        return {
          behavior: 'deny' as const,
          message: 'Skill blocked by permission rules',
          decisionReason: { type: 'rule' as const, rule },
        }
      }
    }
    for (const [content, rule] of getRuleByContentsForToolName(permissionContext, SKILL_TOOL_NAME, 'allow')) {
      if (ruleMatchesSkill(content, name)) {
        return {
          behavior: 'allow' as const,
          updatedInput: input,
          decisionReason: { type: 'rule' as const, rule },
        }
      }
    }
    if (command && isPromptCommand(command) && skillHasOnlySafeProperties(command)) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    return {
      behavior: 'ask' as const,
      message: `Run skill "${name}"?`,
      ...(command ? { metadata: { command } } : {}),
      suggestions: [...suggestionForExactCommand(SKILL_TOOL_NAME, name), ...suggestionForPrefix(SKILL_TOOL_NAME, name)],
    }
  },
  async call(
    input: Input,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<SkillToolProgress>,
  ) {
    const name = normalizeSkillName(input.skill ?? '')
    const args = input.args ?? ''
    const commands = await getCommandUniverse(context)
    const command = findCommand(name, commands)
    if (!command || !isPromptCommand(command)) {
      throw new Error(unknownSkillMessage(name, commands))
    }

    recordSkillUsage(name)

    const parentToolUseId = getToolUseIDFromParentMessage(parentMessage, SKILL_TOOL_NAME)

    if (command.context === 'fork') {
      const authority = evaluateLaunchAuthority('subagents')
      if (!authority.allowed) throw new Error(authority.reason)
      const agentId = createAgentId()
      try {
        const prepared = await prepareForkedCommandContext(command, args, context)
        const agentDefinition =
          command.effort !== undefined ? { ...prepared.baseAgent, effort: command.effort } : prepared.baseAgent
        const collected: Message[] = []
        for await (const message of runAgent({
          agentDefinition,
          promptMessages: prepared.promptMessages,
          toolUseContext: { ...context, getAppState: prepared.modifiedGetAppState },
          canUseTool,
          isAsync: false,
          querySource: 'agent:custom',
          ...(command.model ? { model: command.model } : {}),
          availableTools: context.options.tools,
          override: { agentId },
        })) {
          collected.push(message)
          if (message.type === 'assistant' || message.type === 'user') {
            for (const normalized of normalizeMessages([message])) {
              if (!messageCarriesToolActivity(normalized as Message)) continue
              onProgress?.({
                toolUseID: parentToolUseId ?? parentMessage.uuid,
                data: {
                  type: 'skill_progress',
                  message: normalized as SkillToolProgress['message'],
                  prompt: prepared.skillContent,
                  agentId,
                },
              })
            }
          }
        }
        const result = extractResultText(collected, 'Skill execution completed.')
        collected.length = 0
        return {
          data: {
            success: true,
            commandName: name,
            status: 'forked' as const,
            agentId,
            result,
          } satisfies Output,
        }
      } finally {
        clearInvokedSkillsForAgent(agentId as never)
      }
    }

    const { processPromptSlashCommand } = await import('../../utils/processUserInput/processSlashCommand.js')
    const processed = await processPromptSlashCommand(name, args, commands, context)
    if (!processed.shouldQuery) {
      throw refusedExpansionError(name, processed)
    }
    const allowedTools = processed.allowedTools ?? []
    const model = processed.model
    const effort = command.effort

    const survivors = processed.messages.filter(message => {
      if (message.type === 'progress') return false
      if (
        message.type === 'user' &&
        typeof message.message.content === 'string' &&
        message.message.content.includes(`<${COMMAND_MESSAGE_TAG}>`)
      ) {
        return false
      }
      return true
    })
    const newMessages = tagMessagesWithToolUseID(survivors as never[], parentToolUseId) as unknown as Message[]

    const data: Output = {
      success: true,
      commandName: name,
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
      ...(model ? { model } : {}),
    }

    return {
      data,
      newMessages,
      contextModifier: (current: ToolUseContext): ToolUseContext => {
        let next = current
        if (allowedTools.length > 0) {
          next = { ...next, getAppState: createGetAppStateWithAllowedTools(next.getAppState, allowedTools) }
        }
        if (model) {
          next = {
            ...next,
            options: { ...next.options, mainLoopModel: resolveSkillModelOverride(model, next.options.mainLoopModel) },
          }
        }
        if (effort !== undefined) {
          const previousGetAppState = next.getAppState
          next = { ...next, getAppState: () => ({ ...previousGetAppState(), effortValue: effort }) }
        }
        return next
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const content =
      output.status === 'forked'
        ? `Skill "${output.commandName}" completed as a forked execution.\n\n${output.result}`
        : `Launching skill: ${output.commandName}`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output, SkillToolProgress>)
