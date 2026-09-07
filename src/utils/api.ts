import { isEnvTruthy } from './envUtils.js'
import { logForDebugging } from './debug.js'
import { isAnalyticsDisabled } from '../services/analytics/config.js'
import {
  fineGrainedToolStreamingEnabled,
  resolveModelCapabilities,
  shouldUseGlobalCacheScope,
  toolDeferralEnabled,
} from './model/capabilities.js'
import { getMainLoopModel } from './model/model.js'
import { declaredRouteOf } from '../services/providers/routeLaw.js'
import { deferralWireFormFor, toolReferenceWireAccepted } from '../services/providers/deferralWire.js'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../constants/prompts.js'
import { CLI_SYSPROMPT_PREFIXES } from '../constants/system.js'
import { getSystemContext, getUserContext } from '../context.js'
import { userContextReminderBody } from './userContextReminder.js'
import { prefetchAllMcpResources } from '../services/mcp/client.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import { getTools } from '../tools.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { normalizeFileEditInput } from '../tools/FileEditTool/utils.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { TASK_OUTPUT_TOOL_NAME } from '../tools/TaskOutputTool/constants.js'
import { getCwd } from './cwd.js'
import { createUserMessage } from './messages.js'
import { getFileReadIgnorePatterns, normalizePatternsToPath } from './permissions/filesystem.js'
import { getPlan, getPlanFilePath } from './plans.js'
import { getPlatform } from './platform.js'
import { countFilesRoundedRg } from './ripgrep.js'
import { jsonStringify } from './slowOperations.js'
import { getToolSchemaCache } from './toolSchemaCache.js'
import { windowsPathToPosixPath } from './windowsPaths.js'
import type { Tool, Tools, ToolPermissionContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { ApiTool, ApiToolUnion, ToolInputSchema } from '../types/wire.js'
import type { Message } from '../types/message.js'


export type CacheScope = 'global' | 'org'
export type SystemPromptBlock = { text: string; cacheScope: CacheScope | null }

const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header'

function classifyBlock(text: string): 'attribution' | 'prefix' | 'rest' {
  if (text.startsWith(BILLING_HEADER_PREFIX)) return 'attribution'
  if (CLI_SYSPROMPT_PREFIXES.has(text)) return 'prefix'
  return 'rest'
}

function joinGroup(blocks: string[]): string {
  return blocks.filter(block => block).join('\n\n')
}

export function splitSysPromptPrefix(
  systemPrompt: readonly string[],
  options?: { skipGlobalCacheForSystemPrompt?: boolean },
): SystemPromptBlock[] {
  const skipGlobal = options?.skipGlobalCacheForSystemPrompt === true
  const globalCacheOn = shouldUseGlobalCacheScope()
  const hasBoundary = systemPrompt.some(block => block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY)

  let attribution: string | undefined
  let prefix: string | undefined
  const rest: string[] = []
  const staticGroup: string[] = []
  const dynamicGroup: string[] = []

  if (globalCacheOn && hasBoundary && !skipGlobal) {
    let seenBoundary = false
    for (const block of systemPrompt) {
      if (!block) continue
      if (block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) {
        seenBoundary = true
        continue
      }
      const kind = classifyBlock(block)
      if (kind === 'attribution') {
        attribution = block
        continue
      }
      if (kind === 'prefix') {
        prefix = block
        continue
      }
      if (seenBoundary) dynamicGroup.push(block)
      else staticGroup.push(block)
    }
    const blocks: SystemPromptBlock[] = []
    if (attribution) blocks.push({ text: attribution, cacheScope: null })
    if (prefix) blocks.push({ text: prefix, cacheScope: null })
    const staticText = joinGroup(staticGroup)
    if (staticText) blocks.push({ text: staticText, cacheScope: 'global' })
    const dynamicText = joinGroup(dynamicGroup)
    if (dynamicText) blocks.push({ text: dynamicText, cacheScope: null })
    return blocks
  }

  const dropBoundary = skipGlobal && globalCacheOn
  for (const block of systemPrompt) {
    if (!block) continue
    if (block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY && dropBoundary) continue
    const kind = classifyBlock(block)
    if (kind === 'attribution') attribution = block
    else if (kind === 'prefix') prefix = block
    else rest.push(block)
  }
  const blocks: SystemPromptBlock[] = []
  if (attribution) blocks.push({ text: attribution, cacheScope: null })
  if (prefix) blocks.push({ text: prefix, cacheScope: 'org' })
  const restText = joinGroup(rest)
  if (restText) blocks.push({ text: restText, cacheScope: 'org' })
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


const FILE_COUNT_TIMEOUT_MS = 1000

export async function logContextMetrics(
  mcpConfigs: Record<string, ScopedMcpServerConfig>,
  toolPermissionContext: ToolPermissionContext,
): Promise<void> {
  if (isAnalyticsDisabled()) return
  const ignorePatterns = normalizePatternsToPath(
    getFileReadIgnorePatterns(toolPermissionContext),
    getCwd(),
  )
  await Promise.all([
    prefetchAllMcpResources(mcpConfigs),
    Promise.resolve(getTools(toolPermissionContext)),
    getUserContext(),
    getSystemContext(),
    countFilesRoundedRg(getCwd(), AbortSignal.timeout(FILE_COUNT_TIMEOUT_MS), ignorePatterns),
  ])
}


const SWARM_ONLY_FIELDS: Record<string, string[]> = {
  [EXIT_PLAN_MODE_V2_TOOL_NAME]: ['launchSwarm', 'teammateCount'],
  [AGENT_TOOL_NAME]: ['name', 'team_name', 'mode'],
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

function stripSwarmFields(toolName: string, schema: Record<string, unknown>): Record<string, unknown> {
  const fields = SWARM_ONLY_FIELDS[toolName]
  if (fields === undefined || fields.length === 0) return schema
  if (isAgentSwarmsEnabled()) return schema
  const copy = { ...schema }
  const properties = { ...((copy.properties as Record<string, unknown>) ?? {}) }
  for (const field of fields) delete properties[field]
  copy.properties = properties
  return copy
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
  },
): Promise<ApiToolUnion> {
  const cache = getToolSchemaCache()
  const promptModel = options.model ?? getMainLoopModel()
  const caps = resolveModelCapabilities(promptModel)
  const fingerprint = `${declaredRouteOf(promptModel) ?? 'unrecognised'}:${caps.media.pdf ? 'p' : ''}${caps.media.images ? 'i' : ''}:${deferralWireFormFor(promptModel).form}`
  const key = `${toolCacheKey(tool)}@${fingerprint}`
  let base = cache.get(key)
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
    const input_schema = stripSwarmFields(tool.name, rawSchema) as ToolInputSchema

    const built: ApiTool = { name: tool.name, description, input_schema }
    if (fineGrainedToolStreamingEnabled()) {
      built.eager_input_streaming = true
    }
    cache.set(key, built)
    base = built
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema: Record<string, any> = {
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
      return {
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
  agentId?: string,
): Input {
  switch (tool.name) {
    case EXIT_PLAN_MODE_V2_TOOL_NAME: {
      const plan = getPlan(agentId)
      if (plan === null) return input
      return { ...input, plan, planFilePath: getPlanFilePath(agentId) }
    }
    case BASH_TOOL_NAME: {
      const parsed = reparse<{
        command: string
        description?: string
        timeout?: number
        run_in_background?: boolean
        dangerouslyDisableSandbox?: boolean
        inherit_session_env?: boolean
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
      return rebuilt as unknown as Input
    }
    case FILE_EDIT_TOOL_NAME: {
      const parsed = reparse<{
        file_path: string
        old_string: string
        new_string: string
        replace_all?: boolean
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
      return {
        file_path: normalized.file_path,
        old_string: edit.old_string,
        new_string: edit.new_string,
        replace_all: edit.replace_all,
      } as unknown as Input
    }
    case FILE_WRITE_TOOL_NAME: {
      const parsed = reparse<{ file_path: string; content: string }>(tool, input)
      const isMarkdown = MARKDOWN_EXTENSIONS.some(ext => parsed.file_path.toLowerCase().endsWith(ext))
      const content = isMarkdown ? parsed.content : parsed.content.replace(/[ \t]+$/gm, '')
      return { ...parsed, content } as unknown as Input
    }
    case TASK_OUTPUT_TOOL_NAME: {
      const raw = input as Record<string, unknown>
      const task_id = raw.task_id ?? raw.agentId ?? raw.bash_id ?? ''
      const timeout =
        typeof raw.timeout === 'number'
          ? raw.timeout
          : typeof raw.wait_up_to === 'number'
            ? raw.wait_up_to * 1000
            : 30_000
      const block = raw.block ?? true
      return { task_id, block, timeout } as unknown as Input
    }
    default:
      return input
  }
}

export function normalizeToolInputForAPI<Input extends Record<string, unknown>>(
  tool: Tool,
  input: Input,
): Input {
  if (tool.name === EXIT_PLAN_MODE_V2_TOOL_NAME) {
    const { plan, planFilePath, ...rest } = input as Record<string, unknown>
    void plan
    void planFilePath
    return rest as unknown as Input
  }
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
