import { isWholeRecordedComposition } from '../../prompt/recordedComposition.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  fineGrainedToolStreamingEnabled,
  resolveModelCapabilities,
  toolDeferralEnabled,
} from '../../utils/model/capabilities.js'
import { getEngineModel } from '../model/model.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import { deferralWireFormFor, toolReferenceWireAccepted } from '../providers/deferralWire.js'
import { localPromptProfileApplies, localToolForm } from '../../constants/localPromptProfile.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { inlineLocalSchemaRefs } from '../../utils/inlineSchemaRefs.js'
import { normalizeToolSchemaFor, rememberRenamedArgumentKeys, schemaLaneFor } from '../../utils/normalizeToolSchema.js'
import { userContextReminderBody } from '../../utils/userContextReminder.js'

import { BASH_TOOL_NAME } from '../../constants/tools/bash.js'
import { FILE_EDIT_TOOL_NAME } from '../../constants/tools/fileEdit.js'
import { editFormCacheMark } from '../../utils/editForm.js'
import { normalizeFileEditInput } from '../../utils/fileEditUtils.js'
import { FILE_WRITE_TOOL_NAME } from '../../constants/tools/fileWrite.js'
import { resolveShellCwd } from '../../utils/Shell.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { rememberedPlatform } from '../../utils/platform/host.js'
import { hostPathSpellings } from '../../utils/platform/paths.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getConversationToolSchemas, getToolSchemaCache } from '../../utils/toolSchemaCache.js'
import type { Tool, Tools, ToolPermissionContext } from '../../Tool.js'
import type { AgentDefinition } from '../../types/agent.js'
import type { ApiTool, ApiToolUnion, ToolInputSchema } from '../../types/wire.js'
import type { Message } from '../../types/message.js'


type SystemPromptBlock = { text: string; cached: boolean }

function joinGroup(blocks: string[]): string {
  return blocks.filter(block => block).join('\n\n')
}

export function splitSystemPromptBlocks(systemPrompt: readonly string[]): SystemPromptBlock[] {
  const billingPrefix = 'x-anthropic-billing-header'
  if (isWholeRecordedComposition(systemPrompt)) {
    return systemPrompt.map(text => ({ text, cached: !text.startsWith(billingPrefix) }))
  }
  let attribution: string | undefined
  const others: string[] = []
  for (const segment of systemPrompt) {
    if (!segment) continue
    if (segment.startsWith(billingPrefix)) {
      attribution = segment
    } else {
      others.push(segment)
    }
  }
  const blocks: SystemPromptBlock[] = []
  if (attribution !== undefined) {
    blocks.push({ text: attribution, cached: false })
  }
  const joined = joinGroup(others)
  if (joined) {
    blocks.push({ text: joined, cached: true })
  }
  return blocks
}


export function appendSystemContext(
  systemPrompt: readonly string[],
  context: Record<string, string>,
  model?: string,
): string[] {
  if (isWholeRecordedComposition(systemPrompt)) {
    return [...systemPrompt]
  }
  const localProfile = model !== undefined && localPromptProfileApplies(model)
  const segments = localProfile
    ? systemPrompt.filter(segment => !firstTurnSegment(segment))
    : [...systemPrompt]
  const contextLines: string[] = []
  for (const [name, value] of Object.entries(context)) {
    if (localProfile && name === 'gitStatus') continue
    contextLines.push(`${name}: ${value}`)
  }
  const contextSegment = contextLines.join('\n')
  return [...segments, contextSegment].filter(segment => segment !== '')
}

function firstTurnSegment(segment: string): boolean {
  const { isFirstTurnSegment } = require('../../constants/prompts.js') as typeof import('../../constants/prompts.js')
  return isFirstTurnSegment(segment)
}

function firstUserPrompt(messages: readonly Message[] | undefined): string | undefined {
  for (const message of messages ?? []) {
    if (message.type !== 'user' || message.isMeta === true) continue
    const content = message.message.content
    if (typeof content === 'string') return content
    const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (text !== '') return text
  }
  return undefined
}

export async function firstTurnUserContext(
  userContext: Record<string, string>,
  systemContext: Record<string, string> | (() => Promise<Record<string, string>>),
  model: string | undefined,
  agentId?: string,
  messages?: readonly Message[],
  input?: string | null,
): Promise<Record<string, string>> {
  if (model === undefined || !localPromptProfileApplies(model)) return userContext
  const { localFirstTurnFacts } = require('../../constants/prompts.js') as typeof import('../../constants/prompts.js')
  const system = typeof systemContext === 'function' ? await systemContext() : systemContext
  const prompt = firstUserPrompt(messages) ?? (input ? input : undefined)
  const facts = await localFirstTurnFacts(agentId, prompt === undefined ? undefined : { prompt })
  return { ...userContext, ...facts, ...(system.gitStatus ? { gitStatus: system.gitStatus } : {}) }
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
  const explicit = tool.inputJSONSchema
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
    cacheControl?: ApiTool['cache_control']
    conversationKey?: string
    bound?: boolean
  },
): Promise<ApiToolUnion> {
  const model = options.model ?? getEngineModel()
  const conversationMap =
    options.conversationKey !== undefined
      ? getConversationToolSchemas(options.conversationKey)
      : undefined
  const initialStored = conversationMap?.get(tool.name)
  if (
    initialStored !== undefined &&
    (typeof tool.prompt !== 'function' || options.bound !== false)
  ) {
    const parsed = JSON.parse(initialStored) as ApiTool
    return options.cacheControl !== undefined
      ? { ...parsed, cache_control: options.cacheControl }
      : parsed
  }

  const route = declaredRouteOf(model)
  const capabilities = resolveModelCapabilities(model)
  const mediaPart = `${capabilities.media.pdf ? 'p' : ''}${capabilities.media.images ? 'i' : ''}`
  const wireForm = deferralWireFormFor(model).form
  const localPart = localPromptProfileApplies(model) ? ':local-profile' : ''
  const editMark = editFormCacheMark()
  const rosterPart = options.tools.map(entry => entry.name).sort().join(',')
  const cacheKey = `${toolCacheKey(tool)}@${route ?? 'unrecognised'}:${mediaPart}:${wireForm}${localPart}${editMark}|${rosterPart}`

  const cache = getToolSchemaCache()
  let base = cache.get(cacheKey)
  if (base === undefined) {
    const promptText = await tool.prompt({
      getToolPermissionContext: options.getToolPermissionContext,
      tools: options.tools,
      agents: options.agents,
      allowedAgentTypes: options.allowedAgentTypes,
      model,
    })
    const explicit = tool.inputJSONSchema
    let schema: ToolInputSchema
    if (explicit !== undefined) {
      const serialized =
        typeof explicit === 'object' && explicit !== null ? serializedSchemaKeys.get(explicit) : undefined
      const inlined = inlineLocalSchemaRefs(explicit, serialized)
      const lane = schemaLaneFor(route)
      const normalized = normalizeToolSchemaFor(
        lane,
        inlined,
        inlined === explicit ? serialized : undefined,
      )
      if (lane === 'anthropic-strict') {
        rememberRenamedArgumentKeys(tool.name, normalized.renamed)
      }
      schema = normalized.schema as ToolInputSchema
    } else {
      const fromZod = zodToJsonSchema(tool.inputSchema) as Record<string, unknown>
      schema = inlineLocalSchemaRefs(fromZod) as ToolInputSchema
    }
    const rawDescription =
      typeof tool.wireDescription === 'function' ? tool.wireDescription(promptText) : promptText
    const { description, input_schema } = localToolForm(tool.name, model, rawDescription, schema)
    base = {
      name: tool.name,
      description,
      input_schema,
      ...(fineGrainedToolStreamingEnabled() ? { eager_input_streaming: true } : {}),
    }
    cache.set(cacheKey, base)
  }

  let definition: ApiTool = {
    name: base.name,
    description: base.description,
    input_schema: base.input_schema,
    ...(base.eager_input_streaming !== undefined
      ? { eager_input_streaming: base.eager_input_streaming }
      : {}),
    ...(options.deferLoading ? { defer_loading: true } : {}),
    ...(options.cacheControl !== undefined ? { cache_control: options.cacheControl } : {}),
  }

  const allowEager = fineGrainedToolStreamingEnabled()
  const allowDefer = toolDeferralEnabled() && toolReferenceWireAccepted()
  const allowedFields = new Set<string>(['name', 'description', 'input_schema', 'cache_control'])
  if (allowEager) allowedFields.add('eager_input_streaming')
  if (allowDefer) allowedFields.add('defer_loading')
  const stripped = Object.keys(definition).filter(key => !allowedFields.has(key))
  if (stripped.length > 0) {
    logStrippedFieldsOnce(stripped)
    definition = {
      name: definition.name,
      description: definition.description,
      input_schema: definition.input_schema,
      ...(definition.cache_control !== undefined ? { cache_control: definition.cache_control } : {}),
      ...(allowEager && definition.eager_input_streaming ? { eager_input_streaming: true } : {}),
      ...(allowDefer && definition.defer_loading ? { defer_loading: true } : {}),
    }
  }

  if (conversationMap !== undefined) {
    const currentStored = conversationMap.get(tool.name)
    if (currentStored === undefined || (options.bound === false && currentStored === initialStored)) {
      const { cache_control: _cacheControl, ...withoutCacheControl } = definition
      conversationMap.set(tool.name, jsonStringify(withoutCacheControl))
    }
    const finalStored = conversationMap.get(tool.name)!
    const parsed = JSON.parse(finalStored) as ApiTool
    return options.cacheControl !== undefined
      ? { ...parsed, cache_control: options.cacheControl }
      : parsed
  }

  return definition
}

let strippedFieldsLogged = false
function logStrippedFieldsOnce(fields: string[]): void {
  if (strippedFieldsLogged) return
  strippedFieldsLogged = true
  logForDebugging(`beta-strip: removed tool schema field(s) ${fields.join(', ')}`)
}


const MARKDOWN_EXTENSIONS = ['.md', '.mdx']

function reparse<T>(tool: Tool, input: unknown): T {
  return tool.inputSchema.parse(input)
}

function stripCwdChangePrefix(command: string, cwd: string): string {
  const strip = (text: string, prefix: string): string => (text.startsWith(prefix) ? text.slice(prefix.length) : text)
  let result = command
  for (const spelling of hostPathSpellings(cwd, rememberedPlatform())) {
    result = strip(result, `cd ${spelling} && `)
  }
  return result
}

export function normalizeToolInput(
  tool: Tool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (tool.name) {
    case BASH_TOOL_NAME: {
      const parsed = reparse<{
        command: string
        cwd?: string
        description?: string
        timeout?: number
        run_in_background?: boolean
        inherit_session_env?: boolean
        max_output_chars?: number
      }>(tool, input)
      const command = stripCwdChangePrefix(parsed.command, resolveShellCwd(parsed.cwd))
        .replaceAll('\\\\;', '\\;')
      const rebuilt: Record<string, unknown> = { command, description: parsed.description }
      if (parsed.cwd !== undefined) rebuilt.cwd = parsed.cwd
      if (parsed.timeout !== undefined) rebuilt.timeout = parsed.timeout
      if ('run_in_background' in parsed && parsed.run_in_background !== undefined) {
        rebuilt.run_in_background = parsed.run_in_background
      }
      if (parsed.inherit_session_env !== undefined) {
        rebuilt.inherit_session_env = parsed.inherit_session_env
      }
      if (parsed.max_output_chars !== undefined) {
        rebuilt.max_output_chars = parsed.max_output_chars
      }
      return rebuilt
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
      if ('replace_all' in input) rebuilt.replace_all = edit.replace_all
      if (parsed.expected_anchor !== undefined) rebuilt.expected_anchor = parsed.expected_anchor
      if (parsed.hunks !== undefined) rebuilt.hunks = parsed.hunks
      if (parsed.append !== undefined) rebuilt.append = parsed.append
      if (parsed.section !== undefined) rebuilt.section = parsed.section
      return rebuilt
    }
    case FILE_WRITE_TOOL_NAME: {
      const parsed = reparse<{ file_path: string; content: string }>(tool, input)
      const isMarkdown = MARKDOWN_EXTENSIONS.some(ext => parsed.file_path.toLowerCase().endsWith(ext))
      const content = isMarkdown ? parsed.content : parsed.content.replace(/[ \t]+$/gm, '')
      return { ...parsed, content }
    }
    default:
      return input
  }
}

export function normalizeToolInputForAPI(
  tool: Tool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (tool.name === FILE_EDIT_TOOL_NAME && Array.isArray(input.edits)) {
    const { old_string: _old, new_string: _new, replace_all: _all, ...rest } = input
    return rest
  }
  return input
}
