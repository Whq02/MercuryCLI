/**
 * Tool → API schema conversion, system-prompt block splitting / cache
 * scoping, context injection, and tool-input normalization.
 *
 * The beta-strip choke point (§H1) is the one place every tool schema passes
 * through: the experimental-betas fold is baked at source, so
 * every field outside a four-field base allowlist is stripped, with exactly
 * two provider-aware carve-outs (eager input streaming, defer loading).
 */
import { isEnvTruthy } from './envUtils.js'
import { logForDebugging } from './debug.js'
import { isAnalyticsDisabled } from '../services/analytics/config.js'
import { checkFeatureGate_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import {
  fineGrainedToolStreamingEnabled,
  modelSupportsStructuredOutputs,
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

// ---------------------------------------------------------------------------
// System-prompt block splitting (§H2)
// ---------------------------------------------------------------------------

export type CacheScope = 'global' | 'org'
export type SystemPromptBlock = { text: string; cacheScope: CacheScope | null }

const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header'

/** The boundary marker and the CLI system-prompt prefix set are IMPORTED
 *  from their owners; recognition of the prefix is a set comparison, not a
 *  prefix test. */
function classifyBlock(text: string): 'attribution' | 'prefix' | 'rest' {
  if (text.startsWith(BILLING_HEADER_PREFIX)) return 'attribution'
  if (CLI_SYSPROMPT_PREFIXES.has(text)) return 'prefix'
  return 'rest'
}

function joinGroup(blocks: string[]): string {
  return blocks.filter(block => block).join('\n\n')
}

/**
 * Split the system prompt into cache-scoped blocks. Three modes: MCP-tools-
 * present (the caller sets the skip-global flag) with the global-cache
 * feature on; global-cache with a boundary marker; and the default. The
 * global-cache mode is selected by reading the LIVE global-cache feature
 * helper inside the function. Classification wins over position.
 */
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

  // Mode 2: global-cache + boundary present → split by index into static /
  // dynamic, extracting attribution + prefix wherever they sit.
  if (globalCacheOn && hasBoundary && !skipGlobal) {
    let seenBoundary = false
    for (const block of systemPrompt) {
      if (!block) continue
      if (block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) {
        seenBoundary = true
        continue // the boundary block itself is dropped
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

  // Mode 1 (MCP tools + global cache): drop boundary blocks, up to three
  // org-scoped blocks. Mode 3 (default): identical, but a boundary block is
  // NOT filtered out.
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

/** Inert (§H2): computes the first split block and emits nothing. */
export function logAPIPrefix(systemPrompt: readonly string[]): void {
  void splitSysPromptPrefix(systemPrompt)[0]
}

// ---------------------------------------------------------------------------
// Context injection (§H3)
// ---------------------------------------------------------------------------

/** Append ONE extra block with one `key: value` line per entry (every entry
 *  rendered, empty values included); the trailing falsy filter drops empty
 *  blocks. */
export function appendSystemContext(
  systemPrompt: readonly string[],
  context: Record<string, string>,
): string[] {
  const line = Object.entries(context)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return [...systemPrompt, line].filter(block => block)
}

/** Prepend one synthetic meta user message (built by the user-message
 *  factory, whose identity fields are part of the message contract) with a
 *  system-reminder element. The per-request form: agent threads and
 *  one-shots ride it; the main conversation carries the same body as a
 *  PERSISTED user_context attachment instead (utils/attachments/
 *  userContext.ts), because a prefix rebuilt per request invalidates every
 *  later thinking block under the preserved-thinking check. */
export function prependUserContext(
  messages: Message[],
  context: Record<string, string>,
): Message[] {
  if (process.env.NODE_ENV === 'test') return messages
  const body = userContextReminderBody(context)
  if (body === null) return messages
  return [createUserMessage({ content: body, isMeta: true }), ...messages]
}

// ---------------------------------------------------------------------------
// Context metrics (§H4) — computed then discarded (the emission is absent)
// ---------------------------------------------------------------------------

const FILE_COUNT_TIMEOUT_MS = 1000

/**
 * Returns immediately when analytics are disabled; otherwise the OBSERVABLE
 * work is kept: the MCP resources, the tool list, the user context and the
 * system context are prefetched concurrently (warming the caches other code
 * reads), and the privacy-rounded file count runs through the ripgrep
 * counter with a 1000 ms abort and the normalized ignore patterns. The
 * emission call is intentionally absent; no destination is invented.
 */
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

// ---------------------------------------------------------------------------
// Tool → API schema (§H1)
// ---------------------------------------------------------------------------

/** Per-tool swarm-only fields removed when swarms are disabled, keyed by the
 *  REAL tool-name constants. */
const SWARM_ONLY_FIELDS: Record<string, string[]> = {
  [EXIT_PLAN_MODE_V2_TOOL_NAME]: ['launchSwarm', 'teammateCount'],
  [AGENT_TOOL_NAME]: ['name', 'team_name', 'mode'],
}

/** Serialized-key memo for explicit tool schemas, keyed by the schema
 *  OBJECT's identity: MCP tools all carry an explicit inputJSONSchema, and
 *  re-stringifying every one of them on every request just to LOOK UP a
 *  cache hit was the remaining per-request schema work. Invalidation is by
 *  identity — schema objects are assigned once at tool construction (the
 *  MCP client builds a fresh object per tools-list fetch) and never mutated
 *  in place, so a replaced schema is a new object and misses naturally;
 *  entries die with their objects. The key embeds no auth-dependent bytes
 *  (name + schema only), so the auth-boundary clear of the SCHEMA cache
 *  does not need to reach it. */
const serializedSchemaKeys = new WeakMap<object, string>()

/** The session-stable tool bases live in the SHARED tool-schema cache so the
 *  exported cache-clear (called after OAuth writes) reaches them. Serialized
 *  with the instrumented stringify. */
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

/** Remove swarm-only properties (shallow-copying the schema and its
 *  properties map) when swarms are disabled. */
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
  // Per-model prompt truth rides a capability FINGERPRINT in the cache key
  // (tool-compat pass): prompt text may condition on the model's
  // capability record (the Read tool's media lines), and one session serves
  // several lanes at once — main loop plus differently-routed subagents.
  // Keying by the derived posture (route + media bits) keeps bytes stable
  // per lane (the prompt-cache invariant) without one lane's truth
  // first-writer-winning every other lane's.
  const promptModel = options.model ?? getMainLoopModel()
  const caps = resolveModelCapabilities(promptModel)
  // The deferral wire form rides the fingerprint too: the ToolSearch tool's
  // prompt tells the truth per form (a gateway in the text form and the
  // first-party block form share a route), and the key must keep them apart.
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
    // The strict flag: only when the gate is on AND the tool declares
    // strictness AND a model was supplied AND that model supports structured
    // outputs.
    const declaresStrict = (tool as { strict?: boolean }).strict === true
    if (
      checkFeatureGate_CACHED_MAY_BE_STALE('mercury_tool_pear') &&
      declaresStrict &&
      options.model !== undefined &&
      modelSupportsStructuredOutputs(options.model)
    ) {
      built.strict = true
    }
    if (fineGrainedToolStreamingEnabled()) {
      built.eager_input_streaming = true
    }
    cache.set(key, built)
    base = built
  }

  // Per-request overlay rebuilt from the cached base field by field (the base
  // is never mutated). Typed loosely so the beta-strip's `&&`-guarded field
  // rebuilds (below) type-check as object spreads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema: Record<string, any> = {
    name: base.name,
    description: base.description,
    input_schema: base.input_schema,
    ...(base.strict !== undefined ? { strict: base.strict } : {}),
    ...(base.eager_input_streaming !== undefined && base.eager_input_streaming !== null
      ? { eager_input_streaming: base.eager_input_streaming }
      : {}),
    ...(options.deferLoading ? { defer_loading: true } : {}),
    ...(options.cacheControl !== undefined ? { cache_control: options.cacheControl } : {}),
  }

  // The beta-strip choke point. The env is baked on in the build.
  if (isEnvTruthy('1')) {
    const allowed = new Set(['name', 'description', 'input_schema', 'cache_control'])
    if (fineGrainedToolStreamingEnabled()) {
      allowed.add('eager_input_streaming')
    }
    // defer_loading survives only where the wire carries the beta block
    // form (first-party by contract, a gateway by probe evidence); a
    // text-form wire never sees the field, deferral on or off.
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

// ---------------------------------------------------------------------------
// Tool input normalization (§H5)
// ---------------------------------------------------------------------------

const MARKDOWN_EXTENSIONS = ['.md', '.mdx']

/** Re-parse an input with the tool's own declarative schema. */
function reparse<T>(tool: Tool, input: unknown): T {
  return (tool.inputSchema as unknown as { parse: (value: unknown) => T }).parse(input)
}

/** The shell tool's working-directory-change prefix for the current
 *  directory ("cd <cwd> && "), removed as a plain first-occurrence substring
 *  — and on Windows, the POSIX-converted spelling of the same directory too. */
function stripCwdChangePrefix(command: string): string {
  const cwd = getCwd()
  let result = command.replace(`cd ${cwd} && `, '')
  if (getPlatform() === 'windows') {
    result = result.replace(`cd ${windowsPathToPosixPath(cwd)} && `, '')
  }
  return result
}

/** Toward execution/hooks/SDK, by tool (keyed by the real name constants). */
export function normalizeToolInput<Input extends Record<string, unknown>>(
  tool: Tool,
  input: Input,
  agentId?: string,
): Input {
  switch (tool.name) {
    case EXIT_PLAN_MODE_V2_TOOL_NAME: {
      // Inject the current plan text and plan file path for the given agent
      // so hooks and the SDK see the plan; pass through when there is none.
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
      }>(tool, input)
      const command = stripCwdChangePrefix(parsed.command)
        // Every doubled escaped semicolon becomes a single escaped semicolon
        // (find -exec patterns).
        .replaceAll('\\\\;', '\\;')
      const rebuilt: Record<string, unknown> = { command, description: parsed.description }
      if (parsed.timeout !== undefined) rebuilt.timeout = parsed.timeout
      // The background flag may be absent from the schema entirely — test
      // presence, never assume.
      if ('run_in_background' in parsed && parsed.run_in_background !== undefined) {
        rebuilt.run_in_background = parsed.run_in_background
      }
      if (parsed.dangerouslyDisableSandbox !== undefined) {
        rebuilt.dangerouslyDisableSandbox = parsed.dangerouslyDisableSandbox
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
      // Route through the shared edit-input normalizer: a single-edit list
      // in, a single edit out.
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
      // Legacy spellings are contract data (resumed transcripts); the output
      // is rebuilt with exactly the tool's three current field names.
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

/** Toward the API (stripping fields the schema does not declare). */
export function normalizeToolInputForAPI<Input extends Record<string, unknown>>(
  tool: Tool,
  input: Input,
): Input {
  if (tool.name === EXIT_PLAN_MODE_V2_TOOL_NAME) {
    // Drop the two injected plan fields.
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
