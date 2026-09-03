// The agent run loop: context assembly, per-agent MCP servers,
// hooks, skills preload, transcript recording, metadata persistence, and
// teardown. Mercury layers: instruction-profile capture, the
// executor-claim teardown guard, the per-agent effort pin, and the
// liveness callback.
//
// OMITTED BY RULING: the
// performance-trace registration and its teardown release — the tracer
// module is deleted; the run path proceeds as if the guard were false.
// The snapshot's two dead imports (prompt-dump path helper, cache-break
// cleanup) are likewise not re-derived (note).

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import { getSkillToolCommands } from '../../commands.js'
import type { Command, PromptCommand } from '../../types/command.js'
import {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
} from '../../constants/prompts.js'
import { query, type QueryParams } from '../../query.js'
import { randomUUID } from 'node:crypto'
import { connectToServer, fetchToolsForClient } from '../../services/mcp/client.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
} from '../../services/mcp/config.js'
import {
  getInstructionSliceForProfile,
} from '../../services/instructions/engine.js'
import {
  isInstructionProfile,
  resolveRequestedInstructionProfile,
} from '../../services/instructions/profile.js'
import type { InstructionProfile } from '../../services/instructions/contracts.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import { disposeBrowserOwner } from '../../services/browser/browserSession.js'
import { processOwnerForLane } from '../../services/run/resolveOwner.js'
import type { Message } from '../../types/message.js'
import type { AgentId } from '../../types/ids.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { generateTaskId } from '../../Task.js'
import { getUserContext, getSystemContext, isInstructionDiscoveryDisabled } from '../../context.js'
import { parseEffortValue, type EffortValue } from '../../utils/effort.js'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { registerFrontmatterHooks } from '../../utils/hooks/registerFrontmatterHooks.js'
import { executeSubagentStartHooks } from '../../utils/hooks.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  getSchemaBoundStructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from '../WorkflowTool/structuredOutputTool.js'
import { armInactivityDeadline, DeadlineExceededError, formatLimit, minutesKnobToMs } from '../../utils/deadline.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { delegationDispatchBlocker } from '../../services/providers/providerUsability.js'
import { classifyModelRoute } from '../../services/providers/callModelRouter.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { QuerySource } from '../../constants/querySource.js'
import {
  clearAgentTranscriptSubdir,
  getAgentTranscriptPath,
  recordSidechainTranscript,
  registerAgentTranscriptDestination,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import { asSystemPrompt, type SystemPrompt } from '../../utils/systemPromptType.js'
import {
  isRestrictedToExtensionsOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/extensionOnlyPolicy.js'
import { modelSupportsAdaptiveThinking } from '../../utils/thinking.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { buildSubagentMercurySections } from '../../constants/subagentDoctrine.js'
import type { AgentDefinition, AgentMcpServerSpec } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import {
  composeAgentAppState,
  resolveAgentPromptPosture,
} from './agentPermissionPosture.js'

/**
 * Drop assistant messages containing a tool-use block with no matching tool
 * result anywhere in the list — orphaned tool calls cause provider errors.
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  const resolvedToolUseIds = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_result') {
        resolvedToolUseIds.add(block.tool_use_id)
      }
    }
  }
  return messages.filter(message => {
    if (message.type !== 'assistant') return true
    const content = message.message.content
    if (!Array.isArray(content)) return true
    for (const block of content) {
      if (block.type === 'tool_use' && !resolvedToolUseIds.has(block.id)) {
        return false
      }
    }
    return true
  })
}

/**
 * Executor claims: backgrounding a foreground agent starts a SECOND
 * executor under the SAME agent id while the first may still be unwinding.
 * Shared-state teardown runs only while the claim is still held; without
 * the guard a predecessor that outlives the handover tears down its
 * successor's session hooks, transcript grouping, todos entry, and
 * background shell tasks.
 */
const executorClaims = new Map<string, symbol>()

type RunAgentOverride = {
  userContext?: { [k: string]: string }
  systemContext?: { [k: string]: string }
  systemPrompt?: string[]
  abortController?: AbortController
  agentId?: string
}

export type RunAgentParams = {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: RunAgentOverride
  model?: string
  maxTurns?: number
  preserveToolUseResults?: boolean
  availableTools: Tools
  allowedTools?: string[]
  onCacheSafeParams?: (params: CacheSafeParams) => void
  contentReplacementState?: ContentReplacementState
  useExactTools?: boolean
  worktreePath?: string
  description?: string
  transcriptSubdir?: string
  effortOverride?: string
  instructionProfileOverride?: string
  onQueryProgress?: (message: Message) => void
  /** Fires once, as soon as the run's model and effort are RESOLVED (the
   *  definition's pin, the caller's choice and the session default folded
   *  by the one resolver) — the state a badge shows is the state that is
   *  (sweep #2, packet 63). */
  onResolvedIdentity?: (identity: { model: string; effort?: string }) => void
  /** Structured output (spec 03-C1): the resolved schema + mode + source.
   *  Present ⇒ the child gains the ONE schema-bound finalization tool (the
   *  workflow engine's — never a second validator) and a system-prompt
   *  line asking to finalize through it. */
  structuredOutputSpec?: {
    schema: Record<string, unknown>
    mode: 'permissive' | 'strict'
    source: 'dispatch' | 'agent-definition'
  }
}

/** Drop user-context keys carrying the repository-instruction blob — the
 *  `claudeMd` user-context key, the spelling the model receives (see
 *  getUserContext in context.ts). */
function withoutInstructionBlob(context: {
  [k: string]: string
}): { [k: string]: string } {
  const next: { [k: string]: string } = {}
  for (const [key, value] of Object.entries(context)) {
    if (/claudemd/i.test(key)) continue
    next[key] = value
  }
  return next
}

/** The slim-agent kill-switch gate (default on). */
function slimAgentGateOn(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('mercury_slim_subagent_instructions', true)
}

/** Agent-scoped MCP resolution. NAME references obey the ∩ law — they
 *  resolve only within the parent's effective catalogue (parent-catalogue ∩
 *  grant): an outside name, a 'disabled' row, or an sdk-typed row refuses
 *  with a firm line instead of connecting; a lawful member connects through
 *  the PARENT ROW's own config, so the memoized connector shares the
 *  parent's live connection instead of opening a same-name-different-config
 *  second one. INLINE definitions are the open reconcile question (Q2) and
 *  keep today's behavior untouched. Exported as the fence's proof seam. */
export async function connectAgentMcpServers(
  specs: readonly AgentMcpServerSpec[] | undefined,
  definition: AgentDefinition,
  parentCatalogue: readonly MCPServerConnection[],
): Promise<{
  clients: MCPServerConnection[]
  tools: Tool[]
  cleanup: () => Promise<void>
}> {
  if (!specs || specs.length === 0) {
    return { clients: [], tools: [], cleanup: async () => {} }
  }
  // Where policy restricts MCP to extension-supplied servers, definitions the
  // USER controls lose their declared servers; extension/built-in/policy
  // sources count as administrator-approved surface.
  if (
    isRestrictedToExtensionsOnly('mcp') &&
    !isSourceAdminTrusted(definition.source) &&
    !isBuiltInAgent(definition) &&
    definition.source !== 'extension'
  ) {
    logForDebugging(
      `runAgent: ${definition.agentType} declared MCP servers dropped by the extensions-only policy`,
    )
    return { clients: [], tools: [], cleanup: async () => {} }
  }

  // The parent's effective catalogue, by name. First spelling wins: the
  // dispatch-context rows (options.mcpClients — which carry a parent
  // AGENT's own grants at depth ≥ 2) outrank the app-state rows (the REPL
  // hands tool contexts an EMPTY options.mcpClients, so the session's
  // seeded roster answers there).
  const catalogueByName = new Map<string, MCPServerConnection>()
  for (const row of parentCatalogue) {
    if (!catalogueByName.has(row.name)) catalogueByName.set(row.name, row)
  }

  // ONE nonce per dispatch: every inline dial of this grant keys apart from
  // the parent's rows and from other dispatches (the no-parent-teardown
  // law below); inline siblings WITHIN the grant lawfully share it — one
  // owner cleans them up.
  const dispatchNonce = randomUUID()

  const connected: MCPServerConnection[] = []
  const dynamicCleanups: Array<() => Promise<void>> = []
  const tools: Tool[] = []
  for (const spec of specs) {
    try {
      if (typeof spec === 'string') {
        // Name reference: the ∩ law. Resolves only within the parent's
        // effective catalogue, through the shared memoized connector, and
        // is NOT cleaned up (the parent shares it). Before this fence the
        // name resolved against the WHOLE config-file universe
        // (getMcpConfigByName) with no membership or disabled consult — an
        // agent definition could widen a subagent past its parent.
        const row = catalogueByName.get(spec)
        if (!row) {
          logForDebugging(
            `runAgent: MCP server '${spec}' refused — outside the parent session's catalogue (parent-catalogue ∩ grant)`,
          )
          continue
        }
        if (row.type === 'disabled') {
          logForDebugging(
            `runAgent: MCP server '${spec}' refused — disabled in this project's record (parent-catalogue ∩ grant)`,
          )
          continue
        }
        if (row.config.type === 'sdk') {
          logForDebugging(
            `runAgent: MCP server '${spec}' refused — sdk-typed servers connect only over the SDK control transport, which agent dispatch does not hold`,
          )
          continue
        }
        // The PARENT ROW's config is the dial: identical config ⇒ the
        // memoized connector answers the parent's own connection.
        const client = await connectToServer(spec, row.config)
        connected.push(client)
        tools.push(...(await fetchToolsForClient(client)))
        continue
      }
      const keys = Object.keys(spec)
      if (keys.length !== 1) {
        logForDebugging(
          'runAgent: inline MCP spec must have exactly one key — skipped',
        )
        continue
      }
      const name = keys[0]!
      // THE INLINE SIDE DOOR (the operator's Q2 ruling: "the
      // frontier option — allowed THROUGH the house rules"): an inline
      // {name: config} is the GRANT'S OWN member — allowed — but it passes
      // the SAME gates as every other member first:
      const inlineConfig = spec[name] as Record<string, unknown>
      //   · sdk-typed inline refuses like the sdk name-ref (the child path
      //     cannot construct the SDK transport);
      if ((inlineConfig as { type?: string }).type === 'sdk') {
        logForDebugging(
          `runAgent: inline MCP server '${name}' refused — sdk-typed servers connect only over the SDK control transport, which agent dispatch does not hold`,
        )
        continue
      }
      //   · managed policy deny/allow (the same filter main.tsx applies to
      //     --mcp-config — user-controlled injection paths gate alike);
      if (!(name in filterMcpServersByPolicy({ [name]: inlineConfig }).allowed)) {
        logForDebugging(
          `runAgent: inline MCP server '${name}' refused — blocked by managed policy (allowedMcpServers/deniedMcpServers)`,
        )
        continue
      }
      //   · enterprise exclusivity (the managed file owns ALL servers; the
      //     narrow mercury-editor carve-out is sdk-only, refused above);
      if (doesEnterpriseMcpConfigExist() && !areMcpConfigsAllowedWithEnterpriseMcpConfig({ [name]: inlineConfig } as never)) {
        logForDebugging(
          `runAgent: inline MCP server '${name}' refused — an enterprise MCP configuration exists and owns the server set`,
        )
        continue
      }
      //   · the parent's kit (parent-∩-grant): an inline spelling of a name
      //     the session EXCLUDED (a truthful 'disabled' catalogue row) is a
      //     bypass, not a grant — no re-enabling an excluded server from an
      //     agent definition.
      if (catalogueByName.get(name)?.type === 'disabled') {
        logForDebugging(
          `runAgent: inline MCP server '${name}' refused — the session's catalogue excludes this name (parent-catalogue ∩ grant)`,
        )
        continue
      }
      // Inline definitions get a dynamic scope, are newly created, and ARE
      // cleaned up when the agent finishes. THE NO-PARENT-TEARDOWN LAW: the
      // dial's memo key carries a per-dispatch nonce, so a byte-identical
      // inline config can never cache-hit the PARENT row's connection (nor
      // a sibling dispatch's) — before this, an identical inline config
      // shared the parent's live client and this cleanup TORE IT DOWN at
      // agent finish; now the cleanup closes exactly the
      // client this dispatch opened.
      const client = await connectToServer(name, {
        ...inlineConfig,
        scope: 'dynamic',
        inlineDispatchId: dispatchNonce,
      } as never)
      connected.push(client)
      dynamicCleanups.push(async () => {
        try {
          const closable = client as { cleanup?: () => Promise<void>; close?: () => Promise<void> }
          if (typeof closable.cleanup === 'function') await closable.cleanup()
          else if (typeof closable.close === 'function') await closable.close()
        } catch (error) {
          logForDebugging(
            `runAgent: MCP cleanup error for ${name}: ${errorMessage(error)}`,
          )
        }
      })
      tools.push(...(await fetchToolsForClient(client)))
    } catch (error) {
      logForDebugging(
        `runAgent: MCP connection failed for an agent-scoped server: ${errorMessage(error)}`,
      )
    }
  }
  return {
    clients: connected,
    tools,
    cleanup: async () => {
      for (const cleanupOne of dynamicCleanups) await cleanupOne()
    },
  }
}

function isPromptCommand(command: Command): command is Command & PromptCommand {
  return command.type === 'prompt'
}

/** Skills preload: frontmatter skills resolve against the
 *  skill-command OWNER for the project root — exact name, then extension
 *  prefix, then a namespace-suffix match. Each resolved prompt-type skill
 *  becomes ONE isMeta user message: a text block carrying the skill-loading
 *  metadata, then the skill's own prompt blocks UNFLATTENED (non-text
 *  blocks preserved). */
async function preloadSkills(
  definition: AgentDefinition,
  toolUseContext: ToolUseContext,
): Promise<Message[]> {
  const skillNames = definition.skills
  if (!skillNames || skillNames.length === 0) return []
  const commands = await getSkillToolCommands(getProjectRoot())
  // The formatter's home is loaded dynamically — the import graph requires
  // it (the processor module reaches back into the agent run path).
  const { formatSkillLoadingMetadata } = await import(
    '../../utils/processUserInput/processSlashCommand.js'
  )
  const extensionPrefix =
    definition.source === 'extension' && 'extensionName' in definition
      ? String((definition as { extensionName?: string }).extensionName ?? '')
      : ''
  const loads: Promise<Message | null>[] = []
  for (const skillName of skillNames) {
    const command =
      commands.find(c => c.name === skillName) ??
      (extensionPrefix
        ? commands.find(c => c.name === `${extensionPrefix}:${skillName}`)
        : undefined) ??
      commands.find(c => c.name.endsWith(`:${skillName}`))
    if (!command) {
      logForDebugging(
        `runAgent: skill '${skillName}' declared by ${definition.agentType} is not a registered skill command — skipped`,
      )
      continue
    }
    if (!isPromptCommand(command)) {
      logForDebugging(
        `runAgent: skill '${skillName}' resolves to a non-prompt command — skipped`,
      )
      continue
    }
    loads.push(
      (async () => {
        try {
          const blocks = await command.getPromptForCommand('', toolUseContext)
          const message = createUserMessage({
            content: [
              {
                type: 'text' as const,
                text: formatSkillLoadingMetadata(
                  command.name,
                  command.progressMessage,
                ),
              },
              ...blocks,
            ],
            isMeta: true,
          })
          logForDebugging(`runAgent: skill '${skillName}' preloaded`)
          return message
        } catch (error) {
          logForDebugging(
            `runAgent: skill '${skillName}' failed to load: ${errorMessage(error)}`,
          )
          return null
        }
      })(),
    )
  }
  const loaded = await Promise.all(loads)
  return loaded.filter((message): message is Message => message !== null)
}

/** Build the definition's system prompt with doctrine + env details
 *  (the run loop's fallback build — names the child's tools too). */
async function buildAgentSystemPrompt(
  definition: AgentDefinition,
  toolUseContext: ToolUseContext,
  resolvedAgentModel: string,
  enabledToolNames: ReadonlySet<string>,
): Promise<string[]> {
  let ownPrompt: string
  try {
    ownPrompt = isBuiltInAgent(definition)
      ? definition.getSystemPrompt({ toolUseContext })
      : definition.getSystemPrompt()
  } catch (error) {
    // The run loop's fallback build swallows silently: the child runs on
    // the shared default agent prompt with env details still appended.
    logForDebugging(
      `runAgent: system prompt build failed for ${definition.agentType}: ${errorMessage(error)}`,
    )
    ownPrompt = DEFAULT_AGENT_PROMPT
  }
  const doctrine = buildSubagentMercurySections({
    agentDefinition: definition,
    toolUseContext,
  })
  return enhanceSystemPromptWithEnvDetails(
    [...doctrine, ownPrompt],
    resolvedAgentModel,
    Array.from(
      toolUseContext.getAppState().toolPermissionContext.additionalWorkingDirectories.keys(),
    ),
    enabledToolNames,
  )
}

/**
 * Run one agent to completion, yielding every recordable message.
 */
/**
 * The sub-agent inactivity limit (sweep #2, B5.5 + rider R1): an
 * agent that produces NO event — not a stream delta, not a tool use, not a
 * provider recovery notice — for this long is wedged (a bootstrap that never
 * reaches its first event, a request on a black-holed socket, a turn parked
 * at zero tool uses) and settles as a typed failure instead of a forever
 * spinner. Fifteen minutes sits strictly above the longest silent tool the
 * agent can run (the shell ceiling is ten) so a quiet long command never
 * trips it. Registered knob MERCURY_AGENT_IDLE_MINUTES (0 disables).
 */
export const DEFAULT_AGENT_IDLE_MINUTES = 15
export function agentIdleLimitMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_AGENT_IDLE_MINUTES'), DEFAULT_AGENT_IDLE_MINUTES)
}

/** A declared provider recovery window is not silence: the watchdog's clock
 *  is bumped again when the declared wait (capped) has elapsed, so a
 *  throttled agent is only judged on the request that follows. */
const DECLARED_RECOVERY_CAP_MS = 10 * 60_000
export function declaredRecoveryWaitMs(message: unknown): number {
  const m = message as { type?: string; subtype?: string; retryInMs?: unknown; recoveryTimeoutMs?: unknown } | null
  if (!m || m.type !== 'system' || m.subtype !== 'api_error') return 0
  const declared =
    typeof m.retryInMs === 'number' && m.retryInMs > 0
      ? m.retryInMs
      : typeof m.recoveryTimeoutMs === 'number' && m.recoveryTimeoutMs > 0
        ? m.recoveryTimeoutMs
        : 0
  return Math.min(declared, DECLARED_RECOVERY_CAP_MS)
}

/** The typed failure an expired agent watchdog surfaces (the actionable
 *  half names the tool-use count the rider asked for). Exported for the
 *  parity prover. */
export function agentStalledError(args: { agentType: string; agentId: string; limitMs: number; elapsedMs: number; events: number; toolUses: number }): DeadlineExceededError {
  return new DeadlineExceededError(
    `sub-agent ${args.agentType} (${args.agentId})`,
    args.limitMs,
    args.elapsedMs,
    args.events,
    `${args.toolUses === 0 ? 'it never used a tool' : `${args.toolUses} tool use${args.toolUses === 1 ? '' : 's'} before the silence`}; the agent was stopped — re-dispatch with a narrower task, or tune MERCURY_AGENT_IDLE_MINUTES (0 disables)`,
  )
}

/** THE ONE agent-effort ladder (FN-018 rank 2): the per-run pin (a
 *  workflow step's override — never on an exact-tools run), else the
 *  definition's declared effort, else the session's. Both consumers derive
 *  from this expression — the identity readout (what the operator is told)
 *  and the agent-scoped app state (what dispatch reads as effortValue) —
 *  so a readout can never describe a request that was not sent: the two
 *  used to be spelled twice, and the dispatch half wrote its answer under a
 *  key nothing reads. A pin off the ladder is not a tier; it yields to the
 *  next rung instead of riding the wire raw. PURE — the prover drives it. */
export function resolveAgentEffort(facts: {
  effortOverride: string | undefined
  useExactTools: boolean | undefined
  definitionEffort: EffortValue | undefined
  sessionEffort: EffortValue | undefined
}): EffortValue | undefined {
  const pin =
    facts.effortOverride !== undefined && !facts.useExactTools
      ? parseEffortValue(facts.effortOverride)
      : undefined
  return pin ?? facts.definitionEffort ?? facts.sessionEffort
}

export async function* runAgent(
  params: RunAgentParams,
): AsyncGenerator<Message, void> {
  const {
    agentDefinition,
    promptMessages,
    toolUseContext,
    canUseTool,
    isAsync,
    canShowPermissionPrompts,
    forkContextMessages,
    querySource,
    override,
    model,
    maxTurns,
    preserveToolUseResults,
    availableTools,
    allowedTools,
    onCacheSafeParams,
    contentReplacementState,
    useExactTools,
    worktreePath,
    description,
    transcriptSubdir,
    effortOverride,
    instructionProfileOverride,
    onQueryProgress,
    onResolvedIdentity,
    structuredOutputSpec,
  } = params

  // ── Identity ────────────────────────────────────────────────────────────
  const permissionModeForModel = (agentDefinition.permissionMode ??
    toolUseContext.getAppState?.().toolPermissionContext.mode) as never
  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model as never,
    permissionModeForModel,
  )
  // The effort the run will carry — THE ONE ladder the agent-scoped state
  // below dispatches on (resolveAgentEffort: pin, then the definition's,
  // then the session's), so the readout and the wire cannot drift.
  const resolvedEffort = resolveAgentEffort({
    effortOverride,
    useExactTools,
    definitionEffort: agentDefinition.effort,
    sessionEffort: (toolUseContext.getAppState?.() as { effortValue?: EffortValue } | undefined)?.effortValue,
  })
  onResolvedIdentity?.({ model: resolvedAgentModel, ...(resolvedEffort !== undefined ? { effort: String(resolvedEffort) } : {}) })

  // Usage-aware dispatch: a lane whose usage
  // window is observed REJECTED refuses delegated work HERE — once, honestly,
  // before any id is minted, claim taken, or API request burned (the
  // worktree-preflight principle). The resolver owns the truth; dispatch
  // never silently reroutes across providers — the refusal names the lanes
  // that ARE usable so the caller can choose one explicitly. The
  // incident shape: a capped Anthropic window ate the guide dispatch with a
  // generic failure instead of this refusal.
  const agentRouteVerdict = classifyModelRoute(resolvedAgentModel)
  const dispatchBlocker =
    agentRouteVerdict.kind === 'route' ? delegationDispatchBlocker(agentRouteVerdict.route) : null
  if (dispatchBlocker) {
    throw new Error(`Agent dispatch refused: ${dispatchBlocker}`)
  }

  const agentId = (override?.agentId ?? generateTaskId('local_agent')) as AgentId
  const ownerAbortController =
    override?.abortController ??
    (isAsync ? new AbortController() : toolUseContext.abortController)
  // The run's OWN controller: the owner's abort (Esc, a kill, the parent
  // turn ending) flows down; the watchdog stops only this run, never the
  // parent turn a foreground agent shares its controller with.
  const abortController = createChildAbortController(ownerAbortController)
  const startedAt = Date.now()
  let eventsSeen = 0
  let toolUsesSeen = 0
  let deferredTouch: ReturnType<typeof setTimeout> | null = null
  const idleLimitMs = agentIdleLimitMs()
  const watchdog = armInactivityDeadline({
    seam: `sub-agent ${agentDefinition.agentType} (${agentId})`,
    limitMs: idleLimitMs,
    onExpire: error => {
      logForDebugging(`runAgent: ${agentId} stalled — ${error.message}`)
      abortController.abort(error)
    },
  })
  const stalledError = (): DeadlineExceededError =>
    agentStalledError({
      agentType: agentDefinition.agentType,
      agentId,
      limitMs: idleLimitMs,
      elapsedMs: Date.now() - startedAt,
      events: eventsSeen,
      toolUses: toolUsesSeen,
    })

  // A PENDING PERMISSION ASK IS NOT SILENCE. A tool ask waiting on the
  // operator streams no events, so the inactivity watchdog read a patient
  // operator as a stalled agent: at the limit it killed the asking run and
  // the consent card silently self-removed (abort-bound), then the retry
  // ladder re-asked — the operator's flip-flopping "1 ask"/"running" chip
  // (~16 minutes ≈ this 15-minute default). While any ask this
  // run raised is unanswered, the watchdog is touched on a heartbeat; the
  // decision itself still travels the normal permission path (headless asks
  // keep their own fail-closed ceiling in the workflow channel).
  const askHeartbeatMs = Math.max(1_000, Math.min(30_000, Math.floor(idleLimitMs / 4)))
  let pendingAsks = 0
  let askHeartbeat: ReturnType<typeof setInterval> | null = null
  const canUseToolAskLively: typeof canUseTool = canUseTool
    ? (async (...args: Parameters<NonNullable<typeof canUseTool>>) => {
        pendingAsks++
        watchdog.touch()
        if (askHeartbeat === null) {
          askHeartbeat = setInterval(() => watchdog.touch(), askHeartbeatMs)
          askHeartbeat.unref?.()
        }
        try {
          return await canUseTool(...args)
        } finally {
          pendingAsks--
          if (pendingAsks === 0 && askHeartbeat !== null) {
            clearInterval(askHeartbeat)
            askHeartbeat = null
          }
          watchdog.touch()
        }
      }) as NonNullable<typeof canUseTool>
    : canUseTool

  // Session-scoped writes (hooks, todos, shell tasks) go through the
  // task-scoped ROOT setter — an in-process teammate's own setAppState is
  // a no-op and would silently lose all four behaviours.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  // ── Executor claim ──────────────────────────────────────────────────────
  const claim = Symbol('agent-executor')
  executorClaims.set(agentId, claim)

  // ── Optional transcript grouping ────────────────────────────────────────
  if (transcriptSubdir) setAgentTranscriptSubdir(agentId, transcriptSubdir)

  // ── Context messages ────────────────────────────────────────────────────
  const filteredContext = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  const initialMessages: Message[] = [...filteredContext, ...promptMessages]

  // ── File-state cache ────────────────────────────────────────────────────
  const readFileState =
    forkContextMessages && toolUseContext.readFileState
      ? cloneFileStateCache(toolUseContext.readFileState)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  const isFork = agentDefinition.agentType === 'fork'
  const mcp = {
    clients: [] as MCPServerConnection[],
    tools: [] as Tool[],
    cleanup: async () => {},
  }

  try {
    // ── User/system context ───────────────────────────────────────────────
    let userContext = override?.userContext ?? (await getUserContext())
    const systemContext = { ...(override?.systemContext ?? (await getSystemContext())) }

    // Slim agents: drop the repository-instruction blob (kill-switch gate
    // default on; only without an explicit user-context override).
    if (
      agentDefinition.omitProjectInstructions &&
      slimAgentGateOn() &&
      !override?.userContext
    ) {
      userContext = withoutInstructionBlob(userContext)
    }

    // Instruction-profile capture: resume override > definition >
    // session resolution. A differing profile composes its own frozen
    // slice for this agent only; hard-off suppresses everything.
    const sessionResolution = resolveRequestedInstructionProfile()
    const requestedProfile =
      (instructionProfileOverride &&
      isInstructionProfile(instructionProfileOverride)
        ? instructionProfileOverride
        : undefined) ??
      agentDefinition.instructionProfile ??
      sessionResolution.profile
    let instructionCapture:
      | { profile: InstructionProfile; digest: string }
      | undefined
    if (
      !agentDefinition.omitProjectInstructions &&
      !isInstructionDiscoveryDisabled() &&
      isInstructionProfile(requestedProfile)
    ) {
      if (requestedProfile !== sessionResolution.profile) {
        try {
          const slice = await getInstructionSliceForProfile(requestedProfile)
          userContext = { ...userContext }
          if (slice.instructionPrompt) {
            // The user-context key the model receives (context.ts).
            userContext['claudeMd'] = slice.instructionPrompt
          } else {
            userContext = withoutInstructionBlob(userContext)
          }
          instructionCapture = {
            profile: requestedProfile,
            // The bundle's field is bundleDigest; the structural cast that
            // read `.digest` always answered '' and the sidecar never
            // carried instructionDigest, so resume and /health could never
            // report drift under a running agent (FN-017 rank 15).
            digest: slice.bundle.bundleDigest,
          }
        } catch (error) {
          logForDebugging(
            `runAgent: instruction slice for '${requestedProfile}' failed: ${errorMessage(error)}`,
          )
        }
      } else {
        instructionCapture = { profile: requestedProfile, digest: '' }
      }
    }

    // Recon agents drop the stale session-start git status.
    if (
      agentDefinition.agentType === 'mercury-scout' ||
      agentDefinition.agentType === 'mercury-architect'
    ) {
      for (const key of Object.keys(systemContext)) {
        if (/gitstatus/i.test(key)) delete systemContext[key]
      }
    }

    // ── Permission posture ─────────────────────────────────────────
    // ONE owner (agentPermissionPosture.ts): the child inherits its
    // parent's ask road — a background run of a session that can ask uses
    // that session's card, the way the main thread does; a caller's
    // explicit answer or a bubble definition overrides; a prompt-less
    // parent stays prompt-less.
    const parentGetAppState = toolUseContext.getAppState
    const definitionMode = agentDefinition.permissionMode as
      | PermissionMode
      | undefined
    const posture = resolveAgentPromptPosture({
      isAsync,
      canShowPermissionPrompts,
      definitionMode,
      parentAvoidsPrompts:
        parentGetAppState?.()?.toolPermissionContext
          .shouldAvoidPermissionPrompts === true,
      parentNonInteractive: toolUseContext.options.isNonInteractiveSession,
    })
    const avoidPrompts = posture.avoidPrompts
    const agentGetAppState: typeof parentGetAppState = () => {
      const state = parentGetAppState()
      return composeAgentAppState(state, {
        definitionMode,
        avoidPrompts,
        isAsync,
        allowedTools,
        // Effort: THE ONE ladder (resolveAgentEffort — the per-agent PIN, a
        // read-only override scoped to this run and never on an exact-tools
        // agent; else the definition's; else the session's), written to
        // effortValue: THE key dispatch reads (turn-machine reads
        // iter.appState.effortValue through this agent-scoped view; the
        // shared session store is never mutated). It used to land under a
        // key nothing reads, so every child dispatched the parent session's
        // tier while every readout named the declared one (FN-018 rank 2).
        effortValue: resolveAgentEffort({
          effortOverride,
          useExactTools,
          definitionEffort: agentDefinition.effort,
          sessionEffort: state.effortValue,
        }),
      })
    }

    // ── Hooks ─────────────────────────────────────────────────────────────
    const hookContextMessages: Message[] = []
    try {
      for await (const hookResult of executeSubagentStartHooks(
        agentId,
        agentDefinition.agentType,
        abortController.signal,
      )) {
        for (const extra of hookResult.additionalContexts ?? []) {
          hookContextMessages.push(
            createUserMessage({ content: extra, isMeta: true }),
          )
        }
      }
    } catch (error) {
      logForDebugging(
        `runAgent: subagent-start hooks failed: ${errorMessage(error)}`,
      )
    }

    if (
      agentDefinition.hooks &&
      (!isRestrictedToExtensionsOnly('hooks') ||
        isSourceAdminTrusted(agentDefinition.source))
    ) {
      registerFrontmatterHooks(
        rootSetAppState,
        agentId,
        agentDefinition.hooks,
        // Agent-scoped source label — the display form names it as an agent.
        `agent:${agentDefinition.agentType}`,
        true,
      )
    }

    // ── Skills preload ────────────────────────────────────────────────────
    const skillMessages = await preloadSkills(agentDefinition, toolUseContext)

    // ── Agent-scoped MCP ──────────────────────────────────────────────────
    const agentMcp = await connectAgentMcpServers(
      agentDefinition.mcpServers,
      agentDefinition,
      // The parent's effective catalogue: dispatch-context rows first (they
      // carry a parent agent's own grants at depth ≥ 2), app-state rows as
      // the fallback (the REPL hands tool contexts an empty
      // options.mcpClients; the print world hands the same rows in both).
      [
        ...toolUseContext.options.mcpClients,
        ...(toolUseContext.getAppState?.().mcp.clients ?? []),
      ],
    )
    mcp.clients = agentMcp.clients
    mcp.tools = agentMcp.tools
    mcp.cleanup = agentMcp.cleanup

    // Agent MCP tools merge with the resolved tools, de-duplicated by name
    // the merge is skipped entirely when there are none.
    let tools = availableTools
    if (mcp.tools.length > 0) {
      const merged = [...availableTools]
      for (const mcpTool of mcp.tools) {
        if (!merged.some(existing => existing.name === mcpTool.name)) {
          merged.push(mcpTool)
        }
      }
      tools = merged
    }

    // Structured output (spec 03-C1): the schema-bound finalization tool
    // joins the child's catalogue — the workflow engine's OWN bound tool,
    // so validation has exactly one owner. The dispatch already refused an
    // Ajv-invalid schema, so a bind failure here is unreachable; guarded
    // anyway (never a silent drop).
    if (structuredOutputSpec !== undefined) {
      const bound = getSchemaBoundStructuredOutputTool(structuredOutputSpec.schema)
      if (bound.tool !== undefined) {
        tools = [...tools.filter(t => t.name !== bound.tool.name), bound.tool]
      } else {
        logForDebugging(
          `runAgent: structured-output schema failed to bind (${bound.error ?? 'unknown'}) — dispatch proceeds without the tool`,
          { level: 'error' },
        )
      }
    }

    // ── System prompt ─────────────────────────────────────────────────────
    const enabledToolNames = new Set(tools.map(tool => tool.name))
    const systemPrompt: string[] =
      override?.systemPrompt ??
      (await buildAgentSystemPrompt(
        agentDefinition,
        toolUseContext,
        resolvedAgentModel,
        enabledToolNames,
      ))
    if (structuredOutputSpec !== undefined) {
      systemPrompt.push(
        `When the task is COMPLETE, deliver the final answer by calling the ${STRUCTURED_OUTPUT_TOOL_NAME} tool with data matching its schema${
          structuredOutputSpec.mode === 'strict'
            ? ' — the dispatch FAILS without a conforming call'
            : ' — prose alone is accepted but the caller loses the parsed data'
        }. Prose before the call is welcome; the structured payload is the contract.`,
      )
    }

    // ── Agent options + child context ─────────────────────────────────────
    const parentOptions = toolUseContext.options
    // Non-interactivity follows the parent (the posture owner): a
    // background child of an interactive session can put a card in front
    // of the operator exactly as the main thread can.
    const isNonInteractiveSession = posture.isNonInteractiveSession

    // Thinking configuration: fork children inherit the parent's
    // configuration untouched. Every other child gets a DEFINITE config —
    // the API layer reads `thinkingConfig.type` unconditionally, and a
    // parent context (headless/runner hosts) may carry none: adaptive ONLY
    // when a per-agent effort override is present (workflow effort pin) AND
    // the resolved model supports it; otherwise disabled — regular
    // subagents run with thinking disabled to control output cost.
    const thinkingOverride = isFork
      ? parentOptions.thinkingConfig !== undefined
        ? { thinkingConfig: parentOptions.thinkingConfig }
        : {}
      : effortOverride !== undefined &&
          modelSupportsAdaptiveThinking(resolvedAgentModel)
        ? { thinkingConfig: { type: 'adaptive' as const } }
        : { thinkingConfig: { type: 'disabled' as const } }

    const childContext = createSubagentContext(toolUseContext, {
      agentId,
      agentType: agentDefinition.agentType,
      abortController,
      getAppState: agentGetAppState,
      // Sync runs share the parent's state setter (a nested async parent's
      // own setter is inert); async runs isolate. The response-length sink
      // is shared in both cases.
      shareSetAppState: !isAsync,
      shareSetResponseLength: true,
      // The child's options are a CURATED record — the parent's other
      // options (querySource on bare-stamp children, customSystemPrompt,
      // maxThinkingTokens, and anything future) must not leak through.
      options: {
        isNonInteractiveSession,
        appendSystemPrompt: parentOptions.appendSystemPrompt,
        tools,
        commands: [],
        debug: parentOptions.debug,
        verbose: parentOptions.verbose,
        mainLoopModel: resolvedAgentModel,
        ...thinkingOverride,
        mcpClients: [...parentOptions.mcpClients, ...mcp.clients],
        mcpResources: parentOptions.mcpResources,
        agentDefinitions: parentOptions.agentDefinitions,
        ...(isFork ? { querySource } : {}),
      },
      readFileState,
      ...(agentDefinition.criticalSystemReminder_EXPERIMENTAL
        ? {
            criticalSystemReminder_EXPERIMENTAL:
              agentDefinition.criticalSystemReminder_EXPERIMENTAL,
          }
        : {}),
      ...(contentReplacementState ? { contentReplacementState } : {}),
    })
    if (preserveToolUseResults) {
      ;(childContext as { preserveToolResults?: boolean }).preserveToolResults =
        true
    }

    const messages: Message[] = [
      ...initialMessages,
      ...hookContextMessages,
      ...skillMessages,
    ]

    // ── Cache-safe parameters ─────────────────────────────────────────────
    if (onCacheSafeParams) {
      onCacheSafeParams({
        systemPrompt: asSystemPrompt(systemPrompt),
        userContext,
        systemContext,
        toolUseContext: childContext,
        forkContextMessages: messages,
      })
    }

    // ── Transcript registration (once at launch) ──────────────────────────
    try {
      registerAgentTranscriptDestination(
        agentId,
        getAgentTranscriptPath(agentId),
      )
    } catch {
      // No session storage at all (headless probe): per-write derivation
      // simply stands.
    }
    void recordSidechainTranscript(messages, agentId).catch(() => {})

    // ── Metadata (fire-and-forget) ────────────────────────────────────────
    void writeAgentMetadata(agentId, {
      agentType: agentDefinition.agentType,
      ...(worktreePath ? { worktreePath } : {}),
      ...(description ? { description } : {}),
      model: resolvedAgentModel,
      ...(effortOverride !== undefined && { effortOverride }),
      ...(resolvedEffort !== undefined ? { effort: String(resolvedEffort) } : {}),
      ...(instructionCapture
        ? {
            instructionProfile: instructionCapture.profile,
            ...(instructionCapture.digest
              ? { instructionDigest: instructionCapture.digest }
              : {}),
          }
        : {}),
    }).catch(() => {})

    // ── Streaming ─────────────────────────────────────────────────────────
    let lastRecordedUuid: string | undefined
    const effectiveMaxTurns = maxTurns ?? agentDefinition.maxTurns

    const queryParams: QueryParams = {
      messages,
      systemPrompt: asSystemPrompt(systemPrompt),
      userContext,
      systemContext,
      // Ask-lively wrapper: a pending permission ask heartbeats the
      // inactivity watchdog (see its declaration above).
      canUseTool: canUseToolAskLively,
      toolUseContext: childContext,
      querySource,
      ...(effectiveMaxTurns !== undefined ? { maxTurns: effectiveMaxTurns } : {}),
    }

    for await (const message of query(queryParams)) {
      // Liveness: every event is progress for the watchdog; a declared
      // provider recovery window is honored by a deferred bump so the wait
      // it announces is not judged as silence.
      eventsSeen++
      watchdog.touch()
      const declaredWaitMs = declaredRecoveryWaitMs(message)
      if (declaredWaitMs > 0) {
        if (deferredTouch !== null) clearTimeout(deferredTouch)
        deferredTouch = setTimeout(() => {
          deferredTouch = null
          watchdog.touch()
        }, declaredWaitMs)
        deferredTouch.unref?.()
      }
      if ((message as { type?: string }).type === 'assistant') {
        const content = (message as { message?: { content?: unknown } }).message?.content
        if (Array.isArray(content) && content.some(block => (block as { type?: string })?.type === 'tool_use')) {
          toolUsesSeen++
        }
      }
      // The callback sees EVERYTHING, stream deltas and provider
      // error/recovery system messages included.
      onQueryProgress?.(message as Message)

      const anyMessage = message as Message & {
        subtype?: string
        attachment?: { type?: string }
      }
      if (anyMessage.type === 'stream_event' as never) continue
      if (anyMessage.type === 'attachment') {
        if (
          (anyMessage as { attachment?: { type?: string } }).attachment
            ?.type === 'max_turns_reached'
        ) {
          logForDebugging(
            `runAgent: ${agentId} hit its max-turns limit — stopping`,
          )
          yield message as Message
          break
        }
        yield message as Message
        continue
      }
      const recordable =
        anyMessage.type === 'assistant' ||
        anyMessage.type === 'user' ||
        anyMessage.type === 'progress' ||
        (anyMessage.type === 'system' &&
          (anyMessage as { subtype?: string }).subtype === 'compact_boundary')
      if (!recordable) continue

      void recordSidechainTranscript(
        [message as Message],
        agentId,
        lastRecordedUuid as never,
      ).catch(() => {})
      if (anyMessage.type !== 'progress') {
        lastRecordedUuid = (message as { uuid?: string }).uuid
      }
      yield message as Message
    }

    if (watchdog.fired) {
      throw stalledError()
    }
    if (abortController.signal.aborted) {
      throw new AbortError()
    }
    // Fire-and-forget at stream end — deliberately not awaited.
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      void agentDefinition.callback()
    }
  } catch (error) {
    // A watchdog stop surfaces as an abort on the way out; the truth is the
    // typed stall, never a "killed" that looks like the operator's choice.
    if (watchdog.fired && !(error instanceof DeadlineExceededError)) {
      throw stalledError()
    }
    throw error
  } finally {
    watchdog.cancel()
    if (askHeartbeat !== null) {
      clearInterval(askHeartbeat)
      askHeartbeat = null
    }
    if (deferredTouch !== null) clearTimeout(deferredTouch)
    // ── Teardown (always; throws escape — no per-step catch) ──────────────
    await mcp.cleanup()
    readFileState.clear?.()
    initialMessages.length = 0

    // Only while the claim is still held (the successor's shared state must
    // survive a predecessor's late unwind).
    if (executorClaims.get(agentId) === claim) {
      executorClaims.delete(agentId)
      if (agentDefinition.hooks) {
        clearSessionHooks(rootSetAppState, agentId)
      }
      clearAgentTranscriptSubdir(agentId)
      // Todos leak repair: a todos key survives even when its list is
      // empty; drop this agent's entry.
      rootSetAppState(prev => {
        if (!(agentId in prev.todos)) return prev
        const todos = { ...prev.todos }
        delete todos[agentId]
        return { ...prev, todos }
      })
      // Shell leak repair: a background shell the agent launched would be
      // reparented and outlive the session.
      killShellTasksForAgent(
        agentId,
        toolUseContext.getAppState,
        rootSetAppState,
      )
      // Browser leak repair: the agent's own browser child (sessions are
      // owner-keyed) dies with the agent — its origin grants with it. The
      // same lane key the Browser tool derived during the run.
      await disposeBrowserOwner(processOwnerForLane(agentId))
    }
  }
}
