import { isEnvTruthy } from './envUtils.js'
import { logForDebugging } from './debug.js'
import {
  fineGrainedToolStreamingEnabled,
  resolveModelCapabilities,
  toolDeferralEnabled,
} from './model/capabilities.js'
import { getEngineModel } from './model/model.js'
import { declaredRouteOf } from '../services/providers/routeLaw.js'
import { deferralWireFormFor, toolReferenceWireAccepted } from '../services/providers/deferralWire.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'
import { CLI_SYSPROMPT_PREFIXES } from '../constants/system.js'
import { userContextReminderBody } from './userContextReminder.js'

import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { normalizeFileEditInput } from '../tools/FileEditTool/utils.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { getCwd } from './cwd.js'
import { createUserMessage } from './messages.js'
import { getPlatform } from './platform.js'
import { jsonStringify } from './slowOperations.js'
import { getConversationToolSchemas, getToolSchemaCache, requestedToolSchemaChange, settleToolSchemaChange } from './toolSchemaCache.js'
import { declareLawfulPrefixChange } from '../services/providers/lawfulPrefixChange.js'
import { windowsPathToPosixPath } from './windowsPaths.js'
import type { Tool, Tools, ToolPermissionContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { ApiTool, ApiToolUnion, ToolInputSchema } from '../types/wire.js'
import type { Message } from '../types/message.js'


type SystemPromptBlock = { text: string; cached: boolean }

const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header'

function classifyBlock(text: string): 'attribution' | 'prefix' | 'rest' {
  if (text.startsWith(BILLING_HEADER_PREFIX)) return 'attribution'
  if (CLI_SYSPROMPT_PREFIXES.has(text)) return 'prefix'
  return 'rest'
}

function joinGroup(blocks: string[]): string {
  return blocks.filter(block => block).join('\n\n')
}

export function splitSysPromptPrefix(systemPrompt: readonly string[]): SystemPromptBlock[] {
  let attribution: string | undefined
  let prefix: string | undefined
  const rest: string[] = []
  for (const block of systemPrompt) {
    if (!block) continue
    const kind = classifyBlock(block)
    if (kind === 'attribution') attribution = block
    else if (kind === 'prefix') prefix = block
    else rest.push(block)
  }
  const blocks: SystemPromptBlock[] = []
  if (attribution) blocks.push({ text: attribution, cached: false })
  if (prefix) blocks.push({ text: prefix, cached: true })
  const restText = joinGroup(rest)
  if (restText) blocks.push({ text: restText, cached: true })
  return blocks
}

export function logAPIPrefix(systemPrompt: readonly string[]): void {
  void splitSysPromptPrefix(systemPrompt)[0]
}


export function appendSystemContext(
  systemPrompt: readonly string[],
  context: Record<string, string>,
): string[] {
  const line = Object.entries(context)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return [...systemPrompt, line].filter(block => block)
}

export function prependUserContext(
  messages: Message[],
  context: Record<string, string>,
): Message[] {
  if (process.env.NODE_ENV === 'test') return messages
  const body = userContextReminderBody(context)
  if (body === null) return messages
  return [createUserMessage({ content: body, isMeta: true }), ...messages]
}


const serializedSchemaKeys = new WeakMap<object, string>()

function toolCacheKey(tool: Tool): string {
  const explicit = (tool as { inputJSONSchema?: unknown }).inputJSONSchema
  if (explicit === undefined) return tool.name
  if (typeof explicit !== 'object' || explicit === null) {
    return `${tool.name}:${jsonStringify(explicit)}`
  }
  let serialized = serializedSchemaKeys.get(explicit)
  if (serialized === undefined) {
    serialized = jsonStringify(explicit)
    serializedSchemaKeys.set(explicit, serialized)
  }
  return `${tool.name}:${serialized}`
}

export async function toolToAPISchema(
  tool: Tool,
  options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
    model?: string
    deferLoading?: boolean
    cacheControl?: unknown
    conversationKey?: string
  },
): Promise<ApiToolUnion> {
  const snapshots = options.conversationKey === undefined ? undefined : getConversationToolSchemas(options.conversationKey)
  const previous = snapshots?.get(tool.name)
  const requested = options.conversationKey === undefined ? undefined : requestedToolSchemaChange(options.conversationKey, tool)
  if (previous !== undefined && requested === undefined) {
    return { ...JSON.parse(previous), ...(options.cacheControl !== undefined ? { cache_control: options.cacheControl } : {}) } as ApiToolUnion
  }
  const cache = getToolSchemaCache()
  const promptModel = options.model ?? getEngineModel()
  const caps = resolveModelCapabilities(promptModel)
  const fingerprint = `${declaredRouteOf(promptModel) ?? 'unrecognised'}:${caps.media.pdf ? 'p' : ''}${caps.media.images ? 'i' : ''}:${deferralWireFormFor(promptModel).form}`
  const pool = options.tools.map(item => item.name).sort().join(',')
  const key = `${toolCacheKey(tool)}@${fingerprint}|${pool}`
  let base = requested === undefined ? cache.get(key) : undefined
  if (base === undefined) {
    const description = await tool.prompt({
      getToolPermissionContext: options.getToolPermissionContext,
      tools: options.tools,
      agents: options.agents,
      allowedAgentTypes: options.allowedAgentTypes,
      model: promptModel,
    })
    const explicit = (tool as { inputJSONSchema?: Record<string, unknown> }).inputJSONSchema
    const rawSchema =
      explicit ?? (zodToJsonSchema(tool.inputSchema as never) as Record<string, unknown>)
    const input_schema = rawSchema as ToolInputSchema

    const built: ApiTool = { name: tool.name, description, input_schema }
    if (fineGrainedToolStreamingEnabled()) {
      built.eager_input_streaming = true
    }
    cache.set(key, built)
    base = built
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let schema: Record<string, any> = {
    name: base.name,
    description: base.description,
    input_schema: base.input_schema,
    ...(base.eager_input_streaming !== undefined && base.eager_input_streaming !== null
      ? { eager_input_streaming: base.eager_input_streaming }
      : {}),
    ...(options.deferLoading ? { defer_loading: true } : {}),
    ...(options.cacheControl !== undefined ? { cache_control: options.cacheControl } : {}),
  }

  if (isEnvTruthy('1')) {
    const allowed = new Set(['name', 'description', 'input_schema', 'cache_control'])
    if (fineGrainedToolStreamingEnabled()) {
      allowed.add('eager_input_streaming')
    }
    if (toolDeferralEnabled() && toolReferenceWireAccepted()) {
      allowed.add('defer_loading')
    }
    const extraKeys = Object.keys(schema).filter(k => !allowed.has(k))
    if (extraKeys.length > 0) {
      logStrippedFieldsOnce(extraKeys)
      schema = {
        name: schema.name,
        description: schema.description,
        input_schema: schema.input_schema,
        ...(schema.cache_control !== undefined ? { cache_control: schema.cache_control } : {}),
        ...(allowed.has('eager_input_streaming') &&
          schema.eager_input_streaming && { eager_input_streaming: true }),
        ...(allowed.has('defer_loading') &&
          schema.defer_loading && { defer_loading: true }),
      } as unknown as ApiToolUnion
    }
  }
  if (snapshots !== undefined) {
    const { cache_control, ...definition } = schema
    const serialized = JSON.stringify(definition)
    if (requested !== undefined && settleToolSchemaChange(options.conversationKey!, requested)) {
      snapshots.set(tool.name, serialized)
      if (serialized !== requested.previous) declareLawfulPrefixChange(requested.scope, requested.reason)
    } else if (!snapshots.has(tool.name)) snapshots.set(tool.name, serialized)
    return { ...JSON.parse(snapshots.get(tool.name)!), ...(options.cacheControl !== undefined ? { cache_control: options.cacheControl } : {}) } as ApiToolUnion
  }
  return schema as unknown as ApiToolUnion
}

let strippedFieldsLogged = false
function logStrippedFieldsOnce(fields: string[]): void {
  if (strippedFieldsLogged) return
  strippedFieldsLogged = true
  logForDebugging(`beta-strip: removed tool schema field(s) ${fields.join(', ')}`)
}


const MARKDOWN_EXTENSIONS = ['.md', '.mdx']

function reparse<T>(tool: Tool, input: unknown): T {
  return (tool.inputSchema as unknown as { parse: (value: unknown) => T }).parse(input)
}

function stripCwdChangePrefix(command: string): string {
  const cwd = getCwd()
  let result = command.replace(`cd ${cwd} && `, '')
  if (getPlatform() === 'windows') {
    result = result.replace(`cd ${windowsPathToPosixPath(cwd)} && `, '')
  }
  return result
}

export function normalizeToolInput<Input extends Record<string, unknown>>(
  tool: Tool,
  input: Input,
): Input {
  switch (tool.name) {
    case BASH_TOOL_NAME: {
      const parsed = reparse<{
        command: string
        description?: string
        timeout?: number
        run_in_background?: boolean
        dangerouslyDisableSandbox?: boolean
        inherit_session_env?: boolean
        max_output_chars?: number
      }>(tool, input)
      const command = stripCwdChangePrefix(parsed.command)
        .replaceAll('\\\\;', '\\;')
      const rebuilt: Record<string, unknown> = { command, description: parsed.description }
      if (parsed.timeout !== undefined) rebuilt.timeout = parsed.timeout
      if ('run_in_background' in parsed && parsed.run_in_background !== undefined) {
        rebuilt.run_in_background = parsed.run_in_background
      }
      if (parsed.dangerouslyDisableSandbox !== undefined) {
        rebuilt.dangerouslyDisableSandbox = parsed.dangerouslyDisableSandbox
      }
      if (parsed.inherit_session_env !== undefined) {
        rebuilt.inherit_session_env = parsed.inherit_session_env
      }
      if (parsed.max_output_chars !== undefined) {
        rebuilt.max_output_chars = parsed.max_output_chars
      }
      return rebuilt as unknown as Input
    }
    case FILE_EDIT_TOOL_NAME: {
      const parsed = reparse<{
        file_path: string
        old_string?: string
        new_string?: string
        replace_all?: boolean
        expected_anchor?: string
        hunks?: unknown
        append?: string
        section?: string
      }>(tool, input)
      const normalized = normalizeFileEditInput({
        file_path: parsed.file_path,
        edits: [
          {
            old_string: parsed.old_string,
            new_string: parsed.new_string,
            replace_all: parsed.replace_all,
          },
        ],
      })
      const edit = normalized.edits[0] ?? {}
      const rebuilt: Record<string, unknown> = { file_path: normalized.file_path }
      if (edit.old_string !== undefined) rebuilt.old_string = edit.old_string
      if (edit.new_string !== undefined) rebuilt.new_string = edit.new_string
      if (edit.replace_all !== undefined) rebuilt.replace_all = edit.replace_all
      if (parsed.expected_anchor !== undefined) rebuilt.expected_anchor = parsed.expected_anchor
      if (parsed.hunks !== undefined) rebuilt.hunks = parsed.hunks
      if (parsed.append !== undefined) rebuilt.append = parsed.append
      if (parsed.section !== undefined) rebuilt.section = parsed.section
      return rebuilt as unknown as Input
    }
    case FILE_WRITE_TOOL_NAME: {
      const parsed = reparse<{ file_path: string; content: string }>(tool, input)
      const isMarkdown = MARKDOWN_EXTENSIONS.some(ext => parsed.file_path.toLowerCase().endsWith(ext))
      const content = isMarkdown ? parsed.content : parsed.content.replace(/[ \t]+$/gm, '')
      return { ...parsed, content } as unknown as Input
    }
    default:
      return input
  }
}

export function normalizeToolInputForAPI<Input extends Record<string, unknown>>(
  tool: Tool,
  input: Input,
): Input {
  if (tool.name === FILE_EDIT_TOOL_NAME) {
    if (Array.isArray((input as { edits?: unknown }).edits)) {
      const { old_string, new_string, replace_all, ...rest } = input as Record<string, unknown>
      void old_string
      void new_string
      void replace_all
      return rest as unknown as Input
    }
  }
  return input
}
