
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
import { forgetAgentEffortWord, noteAgentEffortWord, parseEffortValue, type EffortValue } from '../../utils/effort.js'
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
import {
  chargeRecoveryWait,
  makeRecoveryBudget,
  recoveryBudgetSpentLine,
  recoveryNoticeFacts,
  retryWaitWords,
} from '../../services/api/recoveryBudget.js'
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
  flushSessionStorage,
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
  seatHolder?: string
  transcriptSubdir?: string
  effortOverride?: string
  instructionProfileOverride?: string
  onQueryProgress?: (message: Message) => void
  onWait?: (words: string | null) => void
  onPendingAsks?: (count: number) => void
  onResolvedIdentity?: (identity: { model: string; effort?: string }) => void
  structuredOutputSpec?: {
    schema: Record<string, unknown>
    mode: 'permissive' | 'strict'
    source: 'dispatch' | 'agent-definition'
  }
}

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

function slimAgentGateOn(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('mercury_slim_subagent_instructions', true)
}

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

  const catalogueByName = new Map<string, MCPServerConnection>()
  for (const row of parentCatalogue) {
    if (!catalogueByName.has(row.name)) catalogueByName.set(row.name, row)
  }

  const dispatchNonce = randomUUID()

  const connected: MCPServerConnection[] = []
  const dynamicCleanups: Array<() => Promise<void>> = []
  const tools: Tool[] = []
  for (const spec of specs) {
    try {
      if (typeof spec === 'string') {
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
      const inlineConfig = spec[name] as Record<string, unknown>
      if ((inlineConfig as { type?: string }).type === 'sdk') {
        logForDebugging(
          `runAgent: inline MCP server '${name}' refused — sdk-typed servers connect only over the SDK control transport, which agent dispatch does not hold`,
        )
        continue
      }
      if (!(name in filterMcpServersByPolicy({ [name]: inlineConfig }).allowed)) {
        logForDebugging(
          `runAgent: inline MCP server '${name}' refused — blocked by managed policy (allowedMcpServers/deniedMcpServers)`,
        )
        continue
      }
      if (doesEnterpriseMcpConfigExist() && !areMcpConfigsAllowedWithEnterpriseMcpConfig({ [name]: inlineConfig } as never)) {
        logForDebugging(
          `runAgent: inline MCP server '${name}' refused — an enterprise MCP configuration exists and owns the server set`,
        )
        continue
      }
      if (catalogueByName.get(name)?.type === 'disabled') {
        logForDebugging(
          `runAgent: inline MCP server '${name}' refused — the session's catalogue excludes this name (parent-catalogue ∩ grant)`,
        )
        continue
      }
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

async function preloadSkills(
  definition: AgentDefinition,
  toolUseContext: ToolUseContext,
): Promise<Message[]> {
  const skillNames = definition.skills
  if (!skillNames || skillNames.length === 0) return []
  const commands = await getSkillToolCommands(getProjectRoot())
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

export const DEFAULT_AGENT_IDLE_MINUTES = 15
export function agentIdleLimitMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_AGENT_IDLE_MINUTES'), DEFAULT_AGENT_IDLE_MINUTES)
}

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

export function agentStalledError(args: { agentType: string; agentId: string; limitMs: number; elapsedMs: number; events: number; toolUses: number }): DeadlineExceededError {
  return new DeadlineExceededError(
    `sub-agent ${args.agentType} (${args.agentId})`,
    args.limitMs,
    args.elapsedMs,
    args.events,
    `${args.toolUses === 0 ? 'it never used a tool' : `${args.toolUses} tool use${args.toolUses === 1 ? '' : 's'} before the silence`}; the agent was stopped — re-dispatch with a narrower task, or tune MERCURY_AGENT_IDLE_MINUTES (0 disables)`,
  )
}

export function resolveAgentEffort(facts: {
  effortOverride: string | undefined
  useExactTools: boolean | undefined
  definitionEffort: EffortValue | undefined
  sessionEffort: EffortValue | undefined
}): EffortValue | undefined {
  return agentOwnEffortWord(facts) ?? facts.sessionEffort
}

export function agentOwnEffortWord(facts: {
  effortOverride: string | undefined
  useExactTools: boolean | undefined
  definitionEffort: EffortValue | undefined
}): EffortValue | undefined {
  const pin =
    facts.effortOverride !== undefined && !facts.useExactTools
      ? parseEffortValue(facts.effortOverride)
      : undefined
  return pin ?? facts.definitionEffort
}

export async function landAgentTranscriptRows(
  messages: Message[],
  agentId: AgentId,
  parentUuid?: string | null,
): Promise<void> {
  try {
    await recordSidechainTranscript(messages, agentId, parentUuid as never)
    await flushSessionStorage()
  } catch {
  }
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
    seatHolder,
    transcriptSubdir,
    effortOverride,
    instructionProfileOverride,
    onQueryProgress,
    onWait,
    onPendingAsks,
    onResolvedIdentity,
    structuredOutputSpec,
  } = params

  const permissionModeForModel = (agentDefinition.permissionMode ??
    toolUseContext.getAppState?.().toolPermissionContext.mode) as never
  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model as never,
    permissionModeForModel,
  )
  const resolvedEffort = resolveAgentEffort({
    effortOverride,
    useExactTools,
    definitionEffort: agentDefinition.effort,
    sessionEffort: (toolUseContext.getAppState?.() as { effortValue?: EffortValue } | undefined)?.effortValue,
  })
  onResolvedIdentity?.({ model: resolvedAgentModel, ...(resolvedEffort !== undefined ? { effort: String(resolvedEffort) } : {}) })

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
  const recovery = makeRecoveryBudget()
  let throttled: Error | null = null
  let budgetCut: ReturnType<typeof setTimeout> | null = null
  let retryWordsStanding = false
  const cutAtBudget = (): void => {
    throttled = new Error(recoveryBudgetSpentLine(recovery))
    abortController.abort(throttled)
  }

  const askHeartbeatMs = Math.max(1_000, Math.min(30_000, Math.floor(idleLimitMs / 4)))
  let pendingAsks = 0
  let askHeartbeat: ReturnType<typeof setInterval> | null = null
  const canUseToolAskLively: typeof canUseTool = canUseTool
    ? (async (...args: Parameters<NonNullable<typeof canUseTool>>) => {
        pendingAsks++
        onPendingAsks?.(pendingAsks)
        watchdog.touch()
        if (askHeartbeat === null) {
          askHeartbeat = setInterval(() => watchdog.touch(), askHeartbeatMs)
          askHeartbeat.unref?.()
        }
        try {
          return await canUseTool(...args)
        } finally {
          pendingAsks--
          onPendingAsks?.(pendingAsks)
          if (pendingAsks === 0 && askHeartbeat !== null) {
            clearInterval(askHeartbeat)
            askHeartbeat = null
          }
          watchdog.touch()
        }
      }) as NonNullable<typeof canUseTool>
    : canUseTool

  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const claim = Symbol('agent-executor')
  executorClaims.set(agentId, claim)
  noteAgentEffortWord(agentId, agentOwnEffortWord({ effortOverride, useExactTools, definitionEffort: agentDefinition.effort }))

  if (transcriptSubdir) setAgentTranscriptSubdir(agentId, transcriptSubdir)

  const filteredContext = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  const initialMessages: Message[] = [...filteredContext, ...promptMessages]

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
    let userContext = override?.userContext ?? (await getUserContext())
    const systemContext = { ...(override?.systemContext ?? (await getSystemContext())) }

    if (
      agentDefinition.omitProjectInstructions &&
      slimAgentGateOn() &&
      !override?.userContext
    ) {
      userContext = withoutInstructionBlob(userContext)
    }

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
            userContext['claudeMd'] = slice.instructionPrompt
          } else {
            userContext = withoutInstructionBlob(userContext)
          }
          instructionCapture = {
            profile: requestedProfile,
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

    if (
      agentDefinition.agentType === 'mercury-scout' ||
      agentDefinition.agentType === 'mercury-architect'
    ) {
      for (const key of Object.keys(systemContext)) {
        if (/gitstatus/i.test(key)) delete systemContext[key]
      }
    }

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
      parentChannel: toolUseContext.options.permissionChannel,
    })
    const avoidPrompts = posture.avoidPrompts
    const agentGetAppState: typeof parentGetAppState = () => {
      const state = parentGetAppState()
      return composeAgentAppState(state, {
        definitionMode,
        avoidPrompts,
        isAsync,
        allowedTools,
        effortValue: resolveAgentEffort({
          effortOverride,
          useExactTools,
          definitionEffort: agentDefinition.effort,
          sessionEffort: state.effortValue,
        }),
      })
    }

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
        `agent:${agentDefinition.agentType}`,
        true,
      )
    }

    const skillMessages = await preloadSkills(agentDefinition, toolUseContext)

    const agentMcp = await connectAgentMcpServers(
      agentDefinition.mcpServers,
      agentDefinition,
      [
        ...toolUseContext.options.mcpClients,
        ...(toolUseContext.getAppState?.().mcp.clients ?? []),
      ],
    )
    mcp.clients = agentMcp.clients
    mcp.tools = agentMcp.tools
    mcp.cleanup = agentMcp.cleanup

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

    const parentOptions = toolUseContext.options
    const isNonInteractiveSession = posture.isNonInteractiveSession

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
      shareSetAppState: !isAsync,
      shareSetResponseLength: true,
      options: {
        isNonInteractiveSession,
        ...(posture.permissionChannel !== undefined ? { permissionChannel: posture.permissionChannel } : {}),
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
    childContext.seatHolder = seatHolder ?? description ?? agentDefinition.agentType
    if (onWait !== undefined) childContext.onSeatWait = onWait
    if (preserveToolUseResults) {
      ;(childContext as { preserveToolResults?: boolean }).preserveToolResults =
        true
    }
    childContext.setSDKStatus = (status: unknown) => {
      if (status !== null && typeof status === 'object' && 'wait' in status) {
        onQueryProgress?.({ type: 'request_wait', wait: (status as { wait?: unknown }).wait ?? null } as never)
      }
    }

    const messages: Message[] = [
      ...initialMessages,
      ...hookContextMessages,
      ...skillMessages,
    ]

    if (onCacheSafeParams) {
      onCacheSafeParams({
        systemPrompt: asSystemPrompt(systemPrompt),
        userContext,
        systemContext,
        toolUseContext: childContext,
        forkContextMessages: messages,
      })
    }

    try {
      registerAgentTranscriptDestination(
        agentId,
        getAgentTranscriptPath(agentId),
      )
    } catch {
    }
    await landAgentTranscriptRows(messages, agentId)

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

    let lastRecordedUuid: string | undefined = messages[messages.length - 1]?.uuid
    const effectiveMaxTurns = maxTurns ?? agentDefinition.maxTurns

    const queryParams: QueryParams = {
      messages,
      systemPrompt: asSystemPrompt(systemPrompt),
      userContext,
      systemContext,
      canUseTool: canUseToolAskLively,
      toolUseContext: childContext,
      querySource,
      ...(effectiveMaxTurns !== undefined ? { maxTurns: effectiveMaxTurns } : {}),
    }

    for await (const message of query(queryParams)) {
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
      const notice = recoveryNoticeFacts(message)
      if (notice !== null) {
        const { honoredMs, spent } = chargeRecoveryWait(recovery, notice.declaredMs, notice.status)
        retryWordsStanding = true
        onWait?.(
          retryWaitWords({
            attempt: notice.attempt ?? recovery.waits,
            of: notice.of,
            declaredMs: notice.declaredMs,
            honoredMs,
            status: notice.status,
            budget: recovery,
          }),
        )
        if (budgetCut !== null) clearTimeout(budgetCut)
        budgetCut = null
        if (spent && honoredMs <= 0) cutAtBudget()
        else if (spent) {
          budgetCut = setTimeout(cutAtBudget, honoredMs)
          budgetCut.unref?.()
        }
      } else if (retryWordsStanding && (message as { type?: string }).type !== 'progress') {
        retryWordsStanding = false
        if (budgetCut !== null) clearTimeout(budgetCut)
        budgetCut = null
        onWait?.(null)
      }
      if ((message as { type?: string }).type === 'assistant') {
        const content = (message as { message?: { content?: unknown } }).message?.content
        if (Array.isArray(content) && content.some(block => (block as { type?: string })?.type === 'tool_use')) {
          toolUsesSeen++
        }
      }
      onQueryProgress?.(message as Message)

      const anyMessage = message as Message & {
        subtype?: string
        attachment?: { type?: string }
      }
      if (anyMessage.type === 'stream_event' as never) continue
      if (anyMessage.type === 'attachment') {
        await landAgentTranscriptRows(
          [message as Message],
          agentId,
          lastRecordedUuid as never,
        )
        lastRecordedUuid = (message as { uuid?: string }).uuid
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
      const subtype = (anyMessage as { subtype?: string }).subtype
      const recordable =
        anyMessage.type === 'assistant' ||
        anyMessage.type === 'user' ||
        anyMessage.type === 'progress' ||
        (anyMessage.type === 'system' &&
          (subtype === 'compact_boundary' || subtype === 'informational' || subtype === 'api_error'))
      if (!recordable) continue

      await landAgentTranscriptRows(
        [message as Message],
        agentId,
        lastRecordedUuid as never,
      )
      if (anyMessage.type !== 'progress') {
        lastRecordedUuid = (message as { uuid?: string }).uuid
      }
      yield message as Message
    }

    if (watchdog.fired) {
      throw stalledError()
    }
    if (throttled !== null) throw throttled
    if (abortController.signal.aborted) {
      throw new AbortError()
    }
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      void agentDefinition.callback()
    }
  } catch (error) {
    if (watchdog.fired && !(error instanceof DeadlineExceededError)) {
      throw stalledError()
    }
    if (throttled !== null && error !== throttled) throw throttled
    throw error
  } finally {
    watchdog.cancel()
    if (budgetCut !== null) clearTimeout(budgetCut)
    if (retryWordsStanding) onWait?.(null)
    if (askHeartbeat !== null) {
      clearInterval(askHeartbeat)
      askHeartbeat = null
    }
    if (deferredTouch !== null) clearTimeout(deferredTouch)
    await mcp.cleanup()
    readFileState.clear?.()
    initialMessages.length = 0

    if (executorClaims.get(agentId) === claim) {
      executorClaims.delete(agentId)
      forgetAgentEffortWord(agentId)
      if (agentDefinition.hooks) {
        clearSessionHooks(rootSetAppState, agentId)
      }
      clearAgentTranscriptSubdir(agentId)
      rootSetAppState(prev => {
        if (!(agentId in prev.todos)) return prev
        const todos = { ...prev.todos }
        delete todos[agentId]
        return { ...prev, todos }
      })
      killShellTasksForAgent(
        agentId,
        toolUseContext.getAppState,
        rootSetAppState,
      )
      await disposeBrowserOwner(processOwnerForLane(agentId))
    }
  }
}
