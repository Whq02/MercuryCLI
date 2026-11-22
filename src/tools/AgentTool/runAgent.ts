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
import { notBuilt, type Unbuilt } from '../../pi/holes.js'
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  return notBuilt('src/tools/AgentTool/runAgent.ts:81')
}

const executorClaims = new Map<string, symbol>()

export type AgentQueryProgressEvent = Unbuilt
export type RunAgentParams = Unbuilt

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

async function preloadSkills(
  definition: AgentDefinition,
  toolUseContext: ToolUseContext,
): Promise<Message[]> {
  const skillNames = definition.skills
  if (!skillNames || skillNames.length === 0) return []
  const commands = await getSkillToolCommands(getProjectRoot())
  const { formatSkillLoadingMetadata } = await import(
    '../../services/processUserInput/processSlashCommand.js'
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

export async function* runAgent(
  params: RunAgentParams,
): AsyncGenerator<Message, void> {
  return notBuilt('src/tools/AgentTool/runAgent.ts:541')
}
