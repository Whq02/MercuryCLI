import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { getSkillToolCommands } from '../../commands.js'
import type { Command, PromptCommand } from '../../types/command.js'
import {
  enhanceSystemPromptWithEnvDetails,
} from '../../constants/prompts.js'
import type { QueryParams } from '../../run-core/turn-machine.js'
import { productionDeps } from '../../query/deps.js'
import type { LegacyQueryYield } from '../../run-core/project-legacy.js'
import { randomUUID, type UUID } from 'node:crypto'
import { connectToServer, fetchToolsForClient } from '../../services/mcp/client.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
} from '../../services/mcp/config.js'
import type { CacheSafeParams } from '../../services/agents/forkedAgent.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import { endEngineSessionFor } from '../../utils/shell/engineSession.js'
import { INSTRUCTIONS_CONTEXT_KEY } from '../../utils/userContextReminder.js'
import { releaseDiagnosticsWriter } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { disposeOwnerProcesses } from '../../utils/run/ownerLifecycle.js'
import { processOwnerForLane } from '../../utils/run/resolveOwner.js'
import { beginAgentProjectLeases } from '../../services/vulcan/engine/leases.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { AgentId } from '../../types/ids.js'
import { asAgentId } from '../../types/ids.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { McpServerConfigSchema, type MCPServerConnection } from '../../utils/mcp/types.js'
import { generateTaskId } from '../../Task.js'
import { forgetAgentEffortWord, noteAgentEffortWord, parseEffortValue, type EffortValue } from '../../utils/effort.js'
import { subagentDefaultEffort } from '../../utils/agentDefaults.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import { removeSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { EMPTY_USAGE } from '../../utils/api/emptyUsage.js'
import { accumulateUsage, updateUsage } from '../../services/providers/anthropic/cacheAndUsage.js'
import { OUTCOME_SENTENCES, type OutcomeStatus } from '../../rows/vocabulary.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { DeadlineExceededError, minutesKnobToMs } from '../../utils/deadline.js'
import { honourRecoveryWait, makeRecoveryBudget, retryWaitWords, settleRecoveryWait, type RecoveryBudget, type RecoveryNoticeFacts, type RecoveryReservation } from '../../services/api/recoveryBudget.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import { createUserMessage, extractTextContent } from '../../services/messages.js'
import { isCompactBoundaryMessage } from '../../utils/messages/systemMessages.js'
import { refusalRetryRowOf } from './refusalRetry.js'
import { getAgentModel } from '../../services/model/agent.js'
import { readCatalogueIfPending } from '../../services/providers/catalogueOnDemand.js'
import { delegationDispatchBlocker } from '../../services/providers/providerUsability.js'
import { classifyModelRoute } from '../../services/providers/callModelRouter.js'
import type { CanUseToolFn } from '../../Tool.js'
import type { QuerySource } from '../../constants/querySource.js'
import { flushSessionStorage, recordSidechainTranscript, writtenChainTail } from '../../utils/sessionStorage.js'
import { settledSidechainMessages } from '../../utils/sessionStorage/settledSidechainMessages.js'
import { closeAgentTranscript } from '../../utils/sessionStorage/writer.js'
import { latchSwarmAgent, settleSwarmAgent } from '../../services/crewBoard/seam.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import {
  isRestrictedToExtensionsOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/extensionOnlyPolicy.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { buildSubagentMercurySectionsWithOutcome, subagentMemoryLoadNote } from '../../constants/subagentDoctrine.js'
import { enqueueAgentReceiptRow } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { MercuryAgentSeat } from '../../prompt/mercuryContract.js'
import type { AgentDefinition, AgentMcpServerSpec } from '../../types/agent.js'
import { isBuiltInAgent } from '../../types/agent.js'
import { canonicalReviewerReceipt } from './reviewerPolicy.js'
import { MERCURY_SCOUT_AGENT } from './built-in/mercuryScoutAgent.js'

import { fireCrewmateEndOf } from './runAgent/crewmateEnd.js'
import { armWatchdogOf, askLivelyOf, callModelOf, cutAtBudgetOf, observeProgressOf, stalledErrorOf, touchThroughOf, unarmedAgentRun } from './runAgent/watch.js'
import { prepareAgentRun } from './runAgent/prepare.js'
import { passedOver } from '../../utils/passedOver.js'
import { startTimeout, stopInterval, stopTimeout } from '../../utils/timers.js'

export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  const resolvedToolUseIds = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
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

export type AgentQueryProgressEvent =
  | Message
  | { type: 'stream_activity'; atMs: number }
  | { type: 'request_wait'; wait: unknown }

export type RunAgentParams = {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  querySource: QuerySource
  availableTools: Tools
  resumed?: boolean
  agentKind?: 'crewmate'
  seat?: MercuryAgentSeat
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: string[]
    swarmBrief?: string
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: string
  maxTurns?: number
  preserveToolUseResults?: boolean
  allowedTools?: string[]
  onCacheSafeParams?: (params: CacheSafeParams) => void
  contentReplacementState?: ContentReplacementState
  useExactTools?: boolean
  worktreePath?: string
  cwd?: string
  reviewReceipt?: string
  description?: string
  name?: string
  team?: string
  captain?: boolean
  launchedAt?: number
  seatHolder?: string
  effortOverride?: string
  thinkingConfigOverride?: ThinkingConfig
  instructionProfileOverride?: string
  onQueryProgress?: (event: AgentQueryProgressEvent) => void
  onWait?: (line: string | null) => void
  onPendingAsks?: (count: number) => void
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
    if (key === INSTRUCTIONS_CONTEXT_KEY) continue
    next[key] = value
  }
  return next
}

function slimAgentGateOn(): boolean {
  return true
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
      const inlineConfig = spec[name]!
      if (!McpServerConfigSchema().safeParse(inlineConfig).success) {
        logForDebugging(
          `runAgent: inline MCP server '${name}' refused — not a server configuration the one validator accepts`,
        )
        continue
      }
      if (!(name in filterMcpServersByPolicy({ [name]: inlineConfig }).allowed)) {
        logForDebugging(
          `runAgent: inline MCP server '${name}' refused — blocked by managed policy (kit.permit/kit.deny)`,
        )
        continue
      }
      if (doesEnterpriseMcpConfigExist() && !areMcpConfigsAllowedWithEnterpriseMcpConfig({ [name]: inlineConfig })) {
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
      })
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

async function buildAgentSystemPrompt(
  definition: AgentDefinition,
  toolUseContext: ToolUseContext,
  resolvedAgentModel: string,
  enabledToolNames: ReadonlySet<string>,
  agentId: AgentId,
  seat: MercuryAgentSeat,
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
    ownPrompt = ''
  }
  const doctrine = buildSubagentMercurySectionsWithOutcome({
    agentDefinition: definition,
    toolUseContext,
    toolNames: enabledToolNames,
    seat,
  })
  if (doctrine.memoryLoadError !== undefined) {
    enqueueAgentReceiptRow({
      taskId: agentId,
      description: definition.agentType,
      status: 'running',
      summary: subagentMemoryLoadNote(doctrine.memoryLoadError),
    })
  }
  return enhanceSystemPromptWithEnvDetails(
    [...doctrine.sections, ownPrompt],
    resolvedAgentModel,
    enabledToolNames,
    agentId,
  )
}

export const DEFAULT_AGENT_IDLE_MINUTES = 15
export function agentIdleLimitMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_AGENT_IDLE_MINUTES'), DEFAULT_AGENT_IDLE_MINUTES)
}

export interface RecoveryAccountant {
  wait(facts: RecoveryNoticeFacts, loud: boolean, nowMs?: number): { honoredMs: number; spent: boolean }
  spoke(nowMs?: number): void
  end(nowMs?: number): void
  standing(): boolean
}

export function makeRecoveryAccountant(args: {
  budget: RecoveryBudget
  cut: (cutting: { declaredMs: number; honoredMs: number }) => void
  words?: (line: string | null) => void
}): RecoveryAccountant {
  let budgetCut: ReturnType<typeof setTimeout> | null = null
  let reservation: RecoveryReservation | null = null
  let wordsStanding = false
  let heldStanding = false
  const clearCut = (): void => {
    if (budgetCut !== null) stopTimeout(budgetCut)
    budgetCut = null
  }
  return {
    wait(facts, loud, nowMs = Date.now()) {
      settleRecoveryWait(args.budget, reservation, nowMs)
      const honoured = honourRecoveryWait(args.budget, facts, nowMs)
      reservation = honoured.reservation
      const cutting = { declaredMs: facts.declaredMs, honoredMs: honoured.honoredMs }
      if (loud) {
        wordsStanding = true
        args.words?.(retryWaitWords({ facts, honoredMs: honoured.honoredMs, budget: args.budget }))
      } else {
        heldStanding = true
      }
      clearCut()
      if (honoured.spent && honoured.honoredMs <= 0) args.cut(cutting)
      else if (honoured.spent) {
        budgetCut = startTimeout(() => args.cut(cutting), honoured.honoredMs)
        budgetCut.unref?.()
      }
      return { honoredMs: honoured.honoredMs, spent: honoured.spent }
    },
    spoke(nowMs = Date.now()) {
      settleRecoveryWait(args.budget, reservation, nowMs)
      reservation = null
      clearCut()
      if (wordsStanding) args.words?.(null)
      wordsStanding = false
      heldStanding = false
    },
    end(nowMs = Date.now()) {
      clearCut()
      settleRecoveryWait(args.budget, reservation, nowMs)
      if (wordsStanding) args.words?.(null)
      wordsStanding = false
      heldStanding = false
    },
    standing: () => wordsStanding || heldStanding,
  }
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

export function agentStalledError(args: { agentType: string; agentId: string; limitMs: number; elapsedMs: number; events: number; toolUses: number; retried?: boolean }): DeadlineExceededError {
  return new DeadlineExceededError(
    `crewmate ${args.agentType} (${args.agentId})`,
    args.limitMs,
    args.elapsedMs,
    args.events,
    `${args.toolUses === 0 ? 'it never used a tool' : `${args.toolUses} tool use${args.toolUses === 1 ? '' : 's'} before the silence`}; ${args.retried ? 'the first and second attempts of the same request stalled; ' : ''}the crewmate was stopped — re-dispatch with a narrower task, or tune MERCURY_AGENT_IDLE_MINUTES (0 disables)`,
  )
}

export function resolveAgentEffort(facts: {
  effortOverride: string | undefined
  useExactTools: boolean | undefined
  definitionEffort: EffortValue | undefined
  defaultEffort: EffortValue | undefined
}): EffortValue | undefined {
  return agentOwnEffortWord(facts) ?? facts.defaultEffort
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
  parentUuid?: UUID | null,
): Promise<UUID | undefined> {
  try {
    await recordSidechainTranscript(messages, agentId, parentUuid)
    await flushSessionStorage()
  } catch {
    return parentUuid ?? undefined
  }
  return writtenChainTail(messages, parentUuid)
}

function recordableRow(anyMessage: Message & { subtype?: string; attachment?: { type?: string } }): boolean {
  const subtype = (anyMessage as { subtype?: string }).subtype
  const recordable =
    anyMessage.type === 'assistant' ||
    anyMessage.type === 'user' ||
    anyMessage.type === 'progress' ||
    (anyMessage.type === 'system' &&
      (subtype === 'compact_boundary' || subtype === 'informational' || subtype === 'api_error' || subtype === 'stream_cut' || subtype === 'busy_recovery'))
  return recordable
}

async function preloadSkills(
  definition: AgentDefinition,
  toolUseContext: ToolUseContext,
): Promise<Message[]> {
  if (!definition.skills || definition.skills.length === 0) return []
  const commands: Command[] = await getSkillToolCommands(getProjectRoot())
  const byName = new Map<string, Command>()
  for (const cmd of commands) {
    byName.set(cmd.name, cmd)
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        if (!byName.has(alias)) byName.set(alias, cmd)
      }
    }
  }
  const messages: Message[] = []
  for (const skillName of definition.skills) {
    const command = byName.get(skillName)
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
    try {
      const blocks = await command.getPromptForCommand('', toolUseContext)
      if (blocks.length > 0) {
        messages.push(createUserMessage({ content: blocks, isMeta: true }))
      }
    } catch (error) {
      logError(error)
    }
  }
  return messages
}

async function preflightAgentRun(params: RunAgentParams): Promise<{
  reviewReceipt: string | undefined
  resolvedAgentModel: string
  resolvedEffort: EffortValue | undefined
}> {
  const { agentDefinition, toolUseContext, model, effortOverride, useExactTools, worktreePath } =
    params
  let reviewReceipt: string | undefined
  if (params.reviewReceipt !== undefined) {
    if (!worktreePath) {
      throw new Error(
        'review_receipt requires a frozen worktree: launch the review with isolation worktree and worktree_at',
      )
    }
    reviewReceipt = canonicalReviewerReceipt(params.reviewReceipt, worktreePath)
  }

  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.engineModel,
    model,
  )
  const resolvedEffort = resolveAgentEffort({
    effortOverride,
    useExactTools,
    definitionEffort: agentDefinition.effort,
    defaultEffort: subagentDefaultEffort(),
  })
  const routeVerdict = classifyModelRoute(resolvedAgentModel)
  if (routeVerdict.kind === 'route') {
    if (routeVerdict.route === 'openai') {
      await readCatalogueIfPending('openai')
    }
    const dispatchBlocker = delegationDispatchBlocker(
      routeVerdict.route,
      undefined,
      resolvedAgentModel,
    )
    if (dispatchBlocker !== null) {
      throw new Error(`Crewmate dispatch refused: ${dispatchBlocker}`)
    }
  }
  return { reviewReceipt, resolvedAgentModel, resolvedEffort }
}

function historyFromLatestCompactBoundary(rows: readonly Message[]): Message[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isCompactBoundaryMessage(rows[i]!)) {
      return rows.slice(i)
    }
  }
  return [...rows]
}

type PrepareRecord = Parameters<typeof prepareAgentRun>[0]

type RunMade = Pick<
  PrepareRecord,
  | 'agentId'
  | 'swarm'
  | 'abortController'
  | 'slimAgentGateOn'
  | 'withoutInstructionBlob'
  | 'readOnlyScout'
  | 'resolveAgentEffort'
  | 'hookScope'
  | 'resolvedAgentModel'
  | 'rootSetAppState'
  | 'preloadSkills'
  | 'connectAgentMcpServers'
  | 'mcp'
  | 'reviewReceipt'
  | 'buildAgentSystemPrompt'
  | 'seat'
  | 'isFork'
  | 'readFileState'
  | 'childContextRef'
  | 'agentKind'
  | 'run'
  | 'accountant'
  | 'touchThrough'
  | 'initialMessages'
  | 'landAgentTranscriptRows'
  | 'resolvedEffort'
>

function prepareRecordOf(params: RunAgentParams, made: RunMade): PrepareRecord {
  return {
    agentId: made.agentId,
    name: params.name,
    description: params.description,
    swarm: made.swarm,
    abortController: made.abortController,
    override: params.override,
    agentDefinition: params.agentDefinition,
    slimAgentGateOn: made.slimAgentGateOn,
    withoutInstructionBlob: made.withoutInstructionBlob,
    instructionProfileOverride: params.instructionProfileOverride,
    readOnlyScout: made.readOnlyScout,
    toolUseContext: params.toolUseContext,
    isAsync: params.isAsync,
    canShowPermissionPrompts: params.canShowPermissionPrompts,
    allowedTools: params.allowedTools,
    effortOverride: params.effortOverride,
    useExactTools: params.useExactTools,
    resolveAgentEffort: made.resolveAgentEffort,
    hookScope: made.hookScope,
    promptMessages: params.promptMessages,
    resolvedAgentModel: made.resolvedAgentModel,
    cwd: params.cwd,
    rootSetAppState: made.rootSetAppState,
    preloadSkills: made.preloadSkills,
    connectAgentMcpServers: made.connectAgentMcpServers,
    mcp: made.mcp,
    availableTools: params.availableTools,
    structuredOutputSpec: params.structuredOutputSpec,
    reviewReceipt: made.reviewReceipt,
    worktreePath: params.worktreePath,
    buildAgentSystemPrompt: made.buildAgentSystemPrompt,
    seat: made.seat,
    thinkingConfigOverride: params.thinkingConfigOverride,
    isFork: made.isFork,
    querySource: params.querySource,
    readFileState: made.readFileState,
    contentReplacementState: params.contentReplacementState,
    childContextRef: made.childContextRef,
    agentKind: made.agentKind,
    seatHolder: params.seatHolder,
    onWait: params.onWait,
    preserveToolUseResults: params.preserveToolUseResults,
    run: made.run,
    onQueryProgress: params.onQueryProgress,
    accountant: made.accountant,
    touchThrough: made.touchThrough,
    initialMessages: made.initialMessages,
    onCacheSafeParams: params.onCacheSafeParams,
    landAgentTranscriptRows: made.landAgentTranscriptRows,
    model: params.model,
    launchedAt: params.launchedAt,
    resolvedEffort: made.resolvedEffort,
  }
}

export async function* runAgent(
  params: RunAgentParams,
): AsyncGenerator<Message, void> {
  const { reviewReceipt, resolvedAgentModel, resolvedEffort } = await preflightAgentRun(params)
  const {
    agentDefinition,
    promptMessages,
    toolUseContext,
    canUseTool,
    isAsync,
    querySource,
    resumed,
    agentKind = 'crewmate',
    seat = 'a crewmate',
    forkContextMessages,
    override,
    maxTurns,
    useExactTools,
    worktreePath,
    description,
    name,
    team,
    effortOverride,
    onQueryProgress,
    onWait,
    onPendingAsks,
  } = params

  const agentId: AgentId = override?.agentId ?? asAgentId(generateTaskId('local_agent'))
  const parentAbort =
    override?.abortController ?? (isAsync ? new AbortController() : toolUseContext.abortController)
  const abortController = createChildAbortController(parentAbort)
  const startedAt = Date.now()
  const idleLimitMs = agentIdleLimitMs()
  const run = unarmedAgentRun()
  const stalledError = stalledErrorOf(run, {
    agentDefinition,
    agentId,
    idleLimitMs,
    startedAt,
    agentStalledError,
  })
  const armWatchdog = armWatchdogOf(run, {
    agentDefinition,
    agentId,
    idleLimitMs,
    stalledError,
    abortController,
  })
  run.watchdog = armWatchdog()
  const recovery = makeRecoveryBudget()
  const cutAtBudget = cutAtBudgetOf(run, { recovery, abortController })
  const accountant = makeRecoveryAccountant({
    budget: recovery,
    cut: cutAtBudget,
    words: onWait,
  })
  const touchThrough = touchThroughOf(run)
  const readOnlyScout = agentDefinition.agentType === MERCURY_SCOUT_AGENT.agentType
  const canUseToolAskLively = askLivelyOf(run, canUseTool, {
    idleLimitMs,
    reviewReceipt,
    worktreePath,
    readOnlyScout,
    onPendingAsks,
  })

  const executorToken = Symbol(agentId)
  executorClaims.set(agentId, executorToken)
  const endProjectLeases = beginAgentProjectLeases(agentId, abortController.signal)
  const ownEffort = agentOwnEffortWord({
    effortOverride,
    useExactTools,
    definitionEffort: agentDefinition.effort,
  })
  noteAgentEffortWord(agentId, ownEffort)

  const isFork = forkContextMessages !== undefined && forkContextMessages.length > 0
  const initialMessages: Message[] = isFork
    ? [...filterIncompleteToolCalls(forkContextMessages), ...promptMessages]
    : [...promptMessages]
  const readFileState = isFork
    ? cloneFileStateCache(toolUseContext.readFileState)
    : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  const rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const hookScope = { sessionId: String(getSessionId()), crewmateId: agentId }
  const mcp: { clients: MCPServerConnection[]; tools: Tool[]; cleanup: () => Promise<void> } = {
    clients: [],
    tools: [],
    cleanup: async () => {},
  }
  const childContextRef: { current: ToolUseContext | undefined } = { current: undefined }
  const crewmateRun: {
    usage: typeof EMPTY_USAGE
    steps: number
    answer: string | undefined
    endedBy: OutcomeStatus
    reason: string | undefined
  } = {
    usage: { ...EMPTY_USAGE },
    steps: 0,
    answer: undefined,
    endedBy: 'completed',
    reason: undefined,
  }
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null

  try {
    const runDeadline = toolUseContext.options.runDeadline
    if (runDeadline !== undefined) {
      const remainingMs = runDeadline.at - Date.now()
      if (remainingMs <= 0) {
        abortController.abort(OUTCOME_SENTENCES.time_limit)
        throw new AbortError()
      }
      deadlineTimer = startTimeout(() => {
        abortController.abort(OUTCOME_SENTENCES.time_limit)
      }, remainingMs)
      deadlineTimer.unref?.()
    }

    const swarm = await latchSwarmAgent(
      agentId,
      name ?? description ?? agentDefinition.agentType,
      Boolean(resumed),
      team,
      abortController.signal,
    )

    const prepared = await prepareAgentRun(
      prepareRecordOf(params, {
        agentId,
        swarm,
        abortController,
        slimAgentGateOn,
        withoutInstructionBlob,
        readOnlyScout,
        resolveAgentEffort,
        hookScope,
        resolvedAgentModel,
        rootSetAppState,
        preloadSkills,
        connectAgentMcpServers,
        mcp,
        reviewReceipt,
        buildAgentSystemPrompt,
        seat,
        isFork,
        readFileState,
        childContextRef,
        agentKind,
        run,
        accountant,
        touchThrough,
        initialMessages,
        landAgentTranscriptRows,
        resolvedEffort,
      }),
    )

    const { userContext, systemContext, systemPrompt, childContext, messages: preparedMessages } =
      prepared
    let currentMessages: Message[] = [...preparedMessages]
    let lastRecordedUuid: UUID | undefined = writtenChainTail(currentMessages)
    const effectiveMaxTurns = maxTurns ?? agentDefinition.maxTurns
    const baseDeps = productionDeps()
    const wrappedDeps = {
      ...baseDeps,
      callModel: callModelOf(run, { deps: baseDeps, agentId }),
    }
    const observeProgress = observeProgressOf(run, {
      recovery,
      accountant,
      onQueryProgress,
      touchThrough,
      declaredRecoveryWaitMs,
    })
    const brandedSystemPrompt = asSystemPrompt(systemPrompt)
    const retriedRefusals = new Set<string>()
    let stoppedEarly = false

    for (;;) {
      const queryParams: QueryParams = {
        messages: currentMessages,
        systemPrompt: brandedSystemPrompt,
        userContext,
        systemContext,
        canUseTool: canUseToolAskLively,
        toolUseContext: childContext,
        querySource,
        ...(effectiveMaxTurns !== undefined ? { maxTurns: effectiveMaxTurns } : {}),
        deps: wrappedDeps,
      }
      const turnStream = toolUseContext.startTurn(queryParams)
      const settled = settledSidechainMessages(turnStream, observeProgress)
      let lastAssistant: Message | undefined
      const conversationRows: Message[] = [...currentMessages]
      try {
        for await (const raw of settled) {
          if (raw.type === 'stream_event' || raw.type === 'stream_request_start' || raw.type === 'tombstone') continue
          const message: Message = raw
          if (message.type === 'attachment') {
            lastRecordedUuid = await landAgentTranscriptRows([message], agentId, lastRecordedUuid)
            conversationRows.push(message)
            yield message
            if (message.attachment.type === 'max_turns_reached' || message.attachment.type === 'loop_stopped') {
              if (message.attachment.type === 'max_turns_reached') {
                logForDebugging(`runAgent: ${agentId} hit its max-turns limit — stopping`)
                crewmateRun.endedBy = 'turn_limit'
              } else {
                logForDebugging(`runAgent: ${agentId} was ended by the loop guard — stopping`)
                crewmateRun.endedBy = 'loop_stopped'
              }
              stoppedEarly = true
              break
            }
            continue
          }
          if (!recordableRow(message)) continue
          lastRecordedUuid = await landAgentTranscriptRows([message], agentId, lastRecordedUuid)
          if (message.type !== 'progress') conversationRows.push(message)
          if (message.type === 'assistant') {
            lastAssistant = message
            recordAssistantStats(crewmateRun, message)
          }
          yield message
        }
      } finally {
        await settled.return(undefined).catch(passedOver)
      }

      if (stoppedEarly || run.watchdog.fired || run.throttled !== null || abortController.signal.aborted) break

      const retry = refusalRetryRowOf(lastAssistant, retriedRefusals, resolvedAgentModel)
      if (retry === null) break
      logForDebugging(
        `runAgent: ${agentId} ended on a refused ${retry.refusalClass} — one retry from its transcript`,
      )
      retriedRefusals.add(retry.refusalClass)
      lastRecordedUuid = await landAgentTranscriptRows([retry.row], agentId, lastRecordedUuid)
      yield retry.row
      currentMessages = [...historyFromLatestCompactBoundary(conversationRows), retry.row]
    }

    if (run.throttled !== null) throw run.throttled
    if (run.watchdog.fired) throw stalledError()
    if (abortController.signal.aborted) throw new AbortError()
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback !== undefined) {
      void Promise.resolve(agentDefinition.callback()).catch(logError)
    }
  } catch (error) {
    let normalized: unknown = error
    if (run.throttled !== null) {
      normalized = run.throttled
    } else if (run.watchdog.fired && !(error instanceof DeadlineExceededError)) {
      normalized = stalledError()
    }
    if (!(normalized instanceof AbortError)) {
      crewmateRun.endedBy = 'failed'
      crewmateRun.reason = errorMessage(normalized)
    }
    throw normalized
  } finally {
    if (deadlineTimer !== null) {
      stopTimeout(deadlineTimer)
      deadlineTimer = null
    }
    await teardownAgentRun({
      endProjectLeases,
      abortController,
      crewmateRun,
      startedAt,
      hookScope,
      toolUseContext,
      rootSetAppState,
      agentId,
      executorToken,
      childContextRef,
      agentDefinition,
      name,
      worktreePath,
      run,
      accountant,
      mcp,
      readFileState,
      initialMessages,
    })
  }
}

function recordAssistantStats(
  crewmateRun: {
    usage: typeof EMPTY_USAGE
    steps: number
    answer: string | undefined
  },
  message: AssistantMessage,
): void {
  crewmateRun.steps += 1
  const msgUsage = message.message.usage
  if (msgUsage !== undefined) {
    crewmateRun.usage = accumulateUsage(crewmateRun.usage, updateUsage(EMPTY_USAGE, msgUsage))
  }
  const text = extractTextContent(message.message.content, '\n').trim()
  if (text !== '') {
    crewmateRun.answer = text
  }
}

async function teardownAgentRun(args: {
  endProjectLeases: () => Promise<void>
  abortController: AbortController
  crewmateRun: {
    usage: typeof EMPTY_USAGE
    steps: number
    answer: string | undefined
    endedBy: OutcomeStatus
    reason: string | undefined
  }
  startedAt: number
  hookScope: { sessionId: string; crewmateId: AgentId }
  toolUseContext: ToolUseContext
  rootSetAppState: ToolUseContext['setAppState']
  agentId: AgentId
  executorToken: symbol
  childContextRef: { current: ToolUseContext | undefined }
  agentDefinition: AgentDefinition
  name: string | undefined
  worktreePath: string | undefined
  run: ReturnType<typeof unarmedAgentRun>
  accountant: RecoveryAccountant
  mcp: { cleanup: () => Promise<void> }
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>
  initialMessages: Message[]
}): Promise<void> {
  const {
    endProjectLeases,
    abortController,
    crewmateRun,
    startedAt,
    hookScope,
    toolUseContext,
    rootSetAppState,
    agentId,
    executorToken,
    childContextRef,
    agentDefinition,
    name,
    worktreePath,
    run,
    accountant,
    mcp,
    readFileState,
    initialMessages,
  } = args
  await endProjectLeases().catch(passedOver)
  await fireCrewmateEndOf({
    abortController,
    crewmateRun,
    startedAt,
    hookScope,
    toolUseContext,
    agentId,
    childContextRef,
    agentDefinition,
    name,
    worktreePath,
  })
  run.watchdog.cancel()
  accountant.end()
  if (run.askHeartbeat !== null) {
    stopInterval(run.askHeartbeat)
    run.askHeartbeat = null
  }
  if (run.deferredTouch !== null) {
    stopTimeout(run.deferredTouch)
    run.deferredTouch = null
  }
  await mcp.cleanup().catch(passedOver)
  readFileState.clear()
  initialMessages.length = 0

  if (executorClaims.get(agentId) === executorToken) {
    executorClaims.delete(agentId)
    settleSwarmAgent(agentId)
    forgetAgentEffortWord(agentId)
    closeAgentTranscript(agentId)
    if (agentDefinition.hooks !== undefined) {
      removeSessionHooks(rootSetAppState, hookScope)
    }
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
    const owner = processOwnerForLane(agentId)
    await endEngineSessionFor(owner).catch(passedOver)
    await disposeOwnerProcesses(owner).catch(passedOver)
    releaseDiagnosticsWriter(owner, worktreePath)
  }
}
