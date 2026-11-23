import uniqBy from 'lodash-es/uniqBy.js'
import { z } from 'zod/v4'

import { clearInvokedSkillsForAgent, getProjectRoot } from '../../bootstrap/state.js'
import { INTERRUPT_MESSAGE } from '../../utils/messages/rejectionText.js'
import { findCommand, getMcpSkillCommands, getSkillToolCommands } from '../../commands.js'
import { COMMAND_MESSAGE_TAG } from '../../constants/xml.js'
import type { CanUseToolFn } from '../../Tool.js'
import {
  buildTool,
  type Tool,
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
import { processPromptSlashCommand } from '../../services/processUserInput/processSlashCommand.js'
import type { PermissionUpdate } from '../../types/permissions.js'


export const inputSchema = lazySchema(() =>
  z.object({
    skill: z.string().describe('The skill\'s name, or "<extension>:<skill>" for an extension skill'),
    args: z.string().optional().describe('Optional arguments passed to the skill'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.union([
    z.object({
      success: z.boolean().describe('Whether the skill loaded'),
      commandName: z.string().describe('The resolved skill command name'),
      allowedTools: z.array(z.string()).optional().describe('Tools the skill grants for its run'),
      model: z.string().optional().describe('The model the skill pins'),
      status: z.literal('inline').optional().describe('The skill expanded inline into the conversation'),
      alreadyLoaded: z.literal(true).optional().describe('The same expansion is already in the conversation; the body was not sent again'),
    }),
    z.object({
      success: z.boolean().describe('Whether the skill run completed'),
      commandName: z.string().describe('The resolved skill command name'),
      status: z.literal('forked').describe('The skill ran in a forked crewmate'),
      agentId: z.string().describe("The forked runner's agent id"),
      result: z.string().describe("The forked run's result text"),
    }),
  ]),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>


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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  return Object.keys(value).length === 0
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

type Input = z.infer<InputSchema>

async function runForkedSkill(
  command: Command & PromptCommand,
  commandName: string,
  args: string,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentAssistantMessage: AssistantMessage,
  parentToolUseID: string | undefined,
  onProgress?: ToolCallProgress<SkillToolProgress>,
): Promise<{ data: Output }> {
  const authority = evaluateLaunchAuthority('subagents')
  if (!authority.allowed) {
    throw new Error(authority.reason)
  }
  const agentId = createAgentId()
  try {
    const { skillContent, modifiedGetAppState, baseAgent, promptMessages } =
      await prepareForkedCommandContext(command, args, context)
    const agentDefinition =
      command.effort !== undefined
        ? { ...baseAgent, effort: command.effort }
        : baseAgent
    const forkContext: ToolUseContext = {
      ...context,
      getAppState: modifiedGetAppState,
    }
    const collected: Message[] = []
    const progressToolUseID = parentToolUseID ?? parentAssistantMessage.uuid
    for await (const emitted of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: forkContext,
      canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      ...(command.model ? { model: command.model } : {}),
      availableTools: context.options.tools,
      override: { agentId },
    })) {
      collected.push(emitted)
      if (onProgress) {
        const normalized = normalizeMessages([emitted])
        for (const row of normalized) {
          if (
            (row.type === 'assistant' || row.type === 'user') &&
            messageCarriesToolActivity(row)
          ) {
            onProgress({
              toolUseID: progressToolUseID,
              data: {
                type: 'skill_progress',
                message: row,
                prompt: skillContent,
                agentId,
              },
            })
          }
        }
      }
    }
    const result = extractResultText(collected, 'Skill execution completed.')
    return {
      data: {
        success: true,
        commandName,
        status: 'forked',
        agentId,
        result,
      },
    }
  } finally {
    clearInvokedSkillsForAgent(agentId)
  }
}

async function runInlineSkill(
  name: string,
  command: Command & PromptCommand,
  commandName: string,
  args: string,
  commands: Command[],
  context: ToolUseContext,
  parentToolUseID: string | undefined,
): Promise<{
  data: Output
  newMessages: Message[]
  contextModifier: (ctx: ToolUseContext) => ToolUseContext
}> {
  const processed = await processPromptSlashCommand(name, args, commands, context)
  if (!processed.shouldQuery) {
    throw refusedExpansionError(name, processed)
  }
  const allowedTools: string[] = processed.allowedTools ?? []
  const model: string | undefined = processed.model
  const effort = command.effort
  const commandOpenTag = `<${COMMAND_MESSAGE_TAG}>`
  const filtered: Message[] = (processed.messages as Message[]).filter(msg => {
    if (msg.type === 'progress') return false
    if (
      msg.type === 'user' &&
      typeof msg.message.content === 'string' &&
      msg.message.content.includes(commandOpenTag)
    ) {
      return false
    }
    return true
  })
  const existingBodies = new Set<string>()
  for (const msg of context.messages) {
    const body = expansionBodyOf(msg)
    if (body !== null) existingBodies.add(body)
  }
  let alreadyLoaded = false
  const deduped: Message[] = []
  for (const msg of filtered) {
    const body = expansionBodyOf(msg)
    if (body !== null && existingBodies.has(body)) {
      alreadyLoaded = true
      continue
    }
    deduped.push(msg)
  }
  const newMessages = tagMessagesWithToolUseID(deduped, parentToolUseID)
  const contextModifier = (ctx: ToolUseContext): ToolUseContext => {
    if (allowedTools.length === 0 && !model && effort === undefined) {
      return ctx
    }
    let nextGetAppState = ctx.getAppState
    if (allowedTools.length > 0) {
      nextGetAppState = createGetAppStateWithAllowedTools(nextGetAppState, allowedTools)
    }
    if (effort !== undefined) {
      const prevGetAppState = nextGetAppState
      nextGetAppState = () => ({
        ...prevGetAppState(),
        effortValue: effort,
      })
    }
    return {
      ...ctx,
      getAppState: nextGetAppState,
      ...(model
        ? {
            options: {
              ...ctx.options,
              engineModel: resolveSkillModelOverride(model, ctx.options.engineModel),
            },
          }
        : {}),
    }
  }
  return {
    data: {
      success: true,
      commandName,
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
      ...(model ? { model } : {}),
      ...(alreadyLoaded ? { alreadyLoaded: true as const } : {}),
    },
    newMessages,
    contextModifier,
  }
}

export const SkillTool: Tool<InputSchema, Output, SkillToolProgress> = buildTool({
  name: SKILL_TOOL_NAME,
  searchHint: 'invoke a slash-command skill by name',
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description(input?: Partial<Input>) {
    return `Execute the ${input?.skill ?? ''} skill`
  },
  async prompt() {
    return getPrompt(getProjectRoot())
  },
  async validateInput(input: Input, context: ToolUseContext): Promise<ValidationResult> {
    const name = normalizeSkillName(input.skill)
    if (name === '') {
      return {
        result: false,
        message: `Skill name is required (got "${input.skill}").`,
        errorCode: 1,
      }
    }
    const commands = await getCommandUniverse(context)
    const command = findCommand(name, commands)
    if (!command) {
      return {
        result: false,
        message: unknownSkillMessage(name, commands),
        errorCode: 2,
      }
    }
    if (command.disableModelInvocation) {
      return {
        result: false,
        message: `Skill "${name}" cannot be invoked through Skill: it sets disable-model-invocation in its frontmatter.`,
        errorCode: 4,
      }
    }
    if (!isPromptCommand(command)) {
      return {
        result: false,
        message: `Skill "${name}" is not a prompt-based skill and cannot be invoked.`,
        errorCode: 5,
      }
    }
    if (context.agentId !== undefined && command.context === 'fork') {
      return {
        result: false,
        message: FORK_CONTEXT_REFUSAL,
        errorCode: 6,
      }
    }
    return { result: true }
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    const name = normalizeSkillName(input.skill)
    const commands = await getCommandUniverse(context)
    const command = findCommand(name, commands)
    const namesToCheck: string[] = [name]
    if (command) {
      if (!namesToCheck.includes(command.name)) namesToCheck.push(command.name)
      const displayed = getCommandName(command)
      if (!namesToCheck.includes(displayed)) namesToCheck.push(displayed)
      for (const alias of command.aliases ?? []) {
        if (!namesToCheck.includes(alias)) namesToCheck.push(alias)
      }
    }
    const permCtx = context.getAppState().toolPermissionContext
    const denyRules = getRuleByContentsForToolName(permCtx, SKILL_TOOL_NAME, 'deny')
    for (const candidate of namesToCheck) {
      for (const [ruleContent, rule] of denyRules) {
        if (ruleMatchesSkill(ruleContent, candidate)) {
          return {
            behavior: 'deny' as const,
            message: ruleSentence(`The ${name} skill`, 'deny', rule),
            decisionReason: { type: 'rule' as const, rule },
          }
        }
      }
    }
    const allowRules = getRuleByContentsForToolName(permCtx, SKILL_TOOL_NAME, 'allow')
    for (const candidate of namesToCheck) {
      for (const [ruleContent, rule] of allowRules) {
        if (ruleMatchesSkill(ruleContent, candidate)) {
          return {
            behavior: 'allow' as const,
            updatedInput: input,
            decisionReason: { type: 'rule' as const, rule },
          }
        }
      }
    }
    if (command && isPromptCommand(command) && skillHasOnlySafeProperties(command)) {
      return {
        behavior: 'allow' as const,
        updatedInput: input,
      }
    }
    const suggestions: PermissionUpdate[] = [
      ...suggestionForExactCommand(SKILL_TOOL_NAME, name),
      {
        type: 'addRules',
        rules: [{ toolName: SKILL_TOOL_NAME, ruleContent: `${name}*` }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ]
    return {
      behavior: 'ask' as const,
      message: `Run skill "${name}"?`,
      ...(command ? { metadata: { command } } : {}),
      suggestions,
    }
  },
  async call(
    input: Input,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentAssistantMessage: AssistantMessage,
    onProgress?: ToolCallProgress<SkillToolProgress>,
  ) {
    const name = normalizeSkillName(input.skill)
    const commands = await getCommandUniverse(context)
    const command = findCommand(name, commands)
    if (!command || !isPromptCommand(command)) {
      throw new Error(unknownSkillMessage(name, commands))
    }
    if (context.agentId !== undefined && command.context === 'fork') {
      throw new Error(FORK_CONTEXT_REFUSAL)
    }
    recordSkillUsage(name)
    const parentToolUseID = getToolUseIDFromParentMessage(parentAssistantMessage, SKILL_TOOL_NAME)
    const args = input.args ?? ''
    const commandName = getCommandName(command)
    if (command.context === 'fork') {
      return runForkedSkill(
        command,
        commandName,
        args,
        context,
        canUseTool,
        parentAssistantMessage,
        parentToolUseID,
        onProgress,
      )
    }
    return runInlineSkill(name, command, commandName, args, commands, context, parentToolUseID)
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    if (output.status === 'forked') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `Skill "${output.commandName}" completed as a forked execution.\n\n${output.result}`,
      }
    }
    if (output.alreadyLoaded) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `Skill "${output.commandName}" is already loaded in this conversation; follow the instructions it gave above.`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `Launching skill: ${output.commandName}`,
    }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output, SkillToolProgress>)
