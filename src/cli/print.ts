import { requestShellBackground } from '../tools/BashTool/backgroundRequest.js'
import { randomUUID, type UUID } from 'node:crypto'
import { keepTurnLiveWhileHostAnswers, type HostAskLiveness } from './headless/hostAskLiveness.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import type { PermissionChannel } from '../Tool.js'
import { readFile, stat } from 'node:fs/promises'
import { liveSkillRootsOf, pruneSkillSessionHooks } from '../utils/hooks/sessionHooks.js'
import {
  getMainLoopModelOverride,
  getSessionId,
  setInitJsonSchema,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  getMainThreadAgentType,
  setSdkAgentProgressSummariesEnabled,
  getFlagSettingsInline,
  setFlagSettingsInline,
  getTotalAPIDuration,
  getTotalCostUSD,
  getTotalUnpricedTurns,
  getTotalDuration,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
  hasUnknownModelCost,
  getOriginalCwd,
  getProjectRoot,
  isSessionPersistenceDisabled,
  setAskChannel,
  switchSession,
} from '../bootstrap/state.js'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionId } from '../types/ids.js'
import { loadConversationForResume } from '../utils/conversationRecovery.js'
import { reconstructContentReplacementState } from '../utils/toolResultStorage.js'
import { resetSessionFilePointer, restoreSessionMetadata } from '../utils/sessionStorage.js'
import { flushSessionStorage, peekProject, recordTranscript } from '../utils/sessionStorage/writer.js'
import { RunnerQuiescence } from '../daemon/runnerQuiescence.js'
import { capabilityHoldWords, runnerCapabilityHolds } from '../daemon/runnerCapabilityCensus.js'
import type { PermissionMode as WirePermissionMode } from '../types/permissions.js'
import { consumeSessionHomePin } from '../utils/sessionStorage/sessionHomePin.js'
import { SPAWN_SWITCH_LABEL, setSpawnSwitch, spawnSwitchFacts, spawnSwitchTransitionLine } from '../services/switchboard/spawnSwitches.js'
import { boxReading, refreshBoxReading } from '../utils/boxLock.js'
import { declareLawfulPrefixChangeForEveryOwner, requestDeliberateToolChange } from '../services/providers/lawfulPrefixChange.js'
import { createRosterTransitionMessage } from '../utils/messages/systemMessages.js'
import { dropCredentialMemos, is1PApiCustomer } from '../utils/auth.js'
import { noteCrewAccountChange } from '../utils/crew/crewAccountChange.js'
import { hasClaudeAiBillingAccess, hasConsoleBillingAccess } from '../utils/billing.js'
import { anthropicSignInEmail } from '../services/providers/providerUsage.js'
import { getCurrentProjectConfig, readGlobalConfigAgain } from '../utils/config.js'
import { mcpRosterEntriesOf, skillsRosterOf } from '../services/engine-connector/rosterTerms.js'
import type { SessionFactsAnswerV1 } from '../services/engine-connector/seatProjections.js'
import { effortSentOf } from '../services/engine-connector/seatProjections.js'
import {
  openaiCatalogueFromWire,
  rewindOutcomeToWire,
  sessionFactsToWire,
  sessionKitFromWire,
} from '../services/engine-connector/seatWire.js'
import { openaiObservedUsage } from '../services/providers/openai/openaiLimitState.js'
import { openaiWindowFact } from '../services/providers/openai/openaiWindowFact.js'
import { laneWindowFact } from '../services/providers/laneWindowFact.js'
import { jevLedgerSnapshot } from '../services/jev/jevLedger.js'
import { jevFactsOf } from '../services/jev/jevSessionFacts.js'
import { jevStatus } from '../services/jev/jevStatus.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { asAgentId } from '../types/ids.js'
import { ask, sessionFactsOf } from '../rows/turn.js'
import { commandOutputRow, compactionClearedRow, compactionRow, heartbeatRow, missionUpdatedRow, modeRow, outcomeRow, rateLimitRow, samplesUpdatedRow, sessionRow, taskRow, turnStartedRow, turnWaitingRow, waitRow, type RowDraft, type RowScope } from '../rows/project.js'
import { exitCodeOf, OUTCOME_SENTENCES, type CompactionRow, type OutcomeRow } from '../rows/vocabulary.js'
import { isOutcome, turnOpened } from '../rows/read.js'
import type { FoldStatusV1 } from '../services/compact/foldStatus.js'
import type { RequestWaitV1 } from '../services/providers/streamIdleBudget.js'
import { getCommands, findCommand, clearCommandMemoizationCaches, formatDescriptionWithSource } from '../commands.js'
import { collectContextData } from '../commands/context/context-noninteractive.js'
import {
  handleInitializeRequest,
  handleMcpSetServers,
  handleOrphanedPermissionResponse,
  handleRewindFiles,
  handleRewindSession,
  handleSetPermissionMode,
  reconcileMcpServers,
  resolvePermissionModeTransition,
  type DynamicMcpState,
  type SdkMcpState,
} from './headless/controlHandlers.js'
import {
  createCanUseToolWithPermissionPrompt,
  getCanUseToolFn,
} from './headless/permissionChannel.js'
import {
  emitLoadError,
  loadInitialMessages,
  removeInterruptedMessage,
} from './headless/resume.js'
import {
  canBatchWith,
  createTurnDriver,
  joinPromptValues,
  type PromptValue,
  type TurnDriver,
} from './headless/turnDriver.js'
import { isBrokenPipeError, StructuredIO, type OutboundLine } from './structuredIO.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
  StdinMessage,
} from '../entrypoints/sdk/controlTypes.js'
import { anthropicWindowFact, resetLimitsForCredentialSwitch, statusListeners, type ClaudeAILimits } from '../services/claudeAiLimits.js'
import { sessionLaneWall } from '../tools/MonitorTool/laneWall.js'
import { providerLimitWarning } from '../services/providers/limitWarning.js'
import {
  clearServerCache,
  connectToServer,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  setupSdkMcpClients,
} from '../services/mcp/client.js'
import { withElicitationEntered } from '../services/mcp/elicitationHandler.js'
import { getMcpPrefix } from '../services/mcp/mcpStringUtils.js'
import { isMcpCatalogueMember } from '../services/mcp/membership.js'
import { applyProcessSessionKitEdit, completeProcessSessionKit, sessionKitOf, setProcessSessionKit } from '../services/mcp/sessionKitPin.js'
import { kitDialCandidates, kitEditMcpDelta, dropMcpServerFromAppState } from '../services/mcp/kitDial.js'
import { validateSessionKit } from '../daemon/sessionKit.js'
import { seatVerbAppliedFrame } from '../daemon/runnerFrames.js'
import { sampleRowsOf } from '../services/samples/facts.js'
import { subscribeSampleChanges } from '../services/samples/store.js'
import {
  latchSessionScheduleRoster,
  markScheduleSeatObserved,
  registerLocalWakeSink,
  takePendingScheduleEdits,
} from '../services/saturn/sessionScheduleBridge.js'
import { saturnQueueStamp } from '../utils/messages/noticeRows.js'
import { advisorFacts, advisorMainRound, advisorMainTurnSettled, createAdvisorQuietMessage, type AdvisorQuiet, type AdvisorRoad } from '../services/advisor/index.js'
import { localWakeStep, type LocalWakeFacts } from '../tools/ScheduleWakeupTool/localWake.js'
import { offSkillNamesOf } from '../skills/kitGovernance.js'
import { disabledMcpServerNamesIn } from '../services/mcp/disabledRecord.js'
import {
  getMcpConfigByName,
} from '../services/mcp/config.js'
import { revokeServerTokens } from '../services/mcp/auth.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  McpSdkServerConfig,
  McpServerConfig,
  ScopedMcpServerConfig,
} from '../services/mcp/types.js'
import { OAuthService } from '../services/oauth/index.js'
import { installOAuthTokens } from './handlers/auth.js'
import type { AppState } from '../state/AppStateStore.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import { noteHeadlessActivity } from '../utils/activityLedger.js'
import { getAccountInformation } from '../utils/auth.js'
import { logForDebugging } from '../utils/debug.js'
import { fileHistoryEnabled } from '../utils/fileHistory.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { isBareMode, isEnvTruthy, isEnvDefinedFalsy } from '../utils/envUtils.js'
import { toError, errorMessage } from '../utils/errors.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
  type FileStateCache,
  type FileState,
} from '../utils/fileStateCache.js'
import { saveCacheSafeParams, getLastCacheSafeParams } from '../utils/forkedAgent.js'
import { SandboxManager } from '../utils/sandbox/sandbox-adapter.js'
import { GLYPH } from '../components/mercury-ui/glyphs.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import { gracefulShutdown, gracefulShutdownSync, isShuttingDown, markPrintModeSignalsOwned } from '../utils/gracefulShutdown.js'
import { saveCurrentSessionCosts } from '../cost-tracker.js'
import {
  headlessProfilerCheckpoint,
  headlessProfilerStartTurn,
  logHeadlessProfilerTurn,
} from '../utils/headlessProfiler.js'
import { registerHookEventHandler } from '../utils/hooks/hookEvents.js'
import { executeElicitationHooks, executeElicitationResultHooks, executeNotificationHooks } from '../utils/hooks.js'
import { processSetupHooks, takeInitialUserMessage, type processSessionStartHooks } from '../utils/sessionStart.js'
import { createIdleTimeoutManager } from '../utils/idleTimeout.js'
import { armInactivityDeadline, DeadlineExceededError, minutesKnobToMs } from '../utils/deadline.js'
import { flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'
import { AGENT_MESSAGE_STATUS } from '../constants/agentMessage.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'

const DEFAULT_HEADLESS_IDLE_MINUTES = 20
const SIGNAL_SETTLE_MS = 5_000
import { getInMemoryErrors, logError } from '../utils/log.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { getRunSnapshot, reconcileOnResume } from '../services/run/runCoordinator.js'
import { toSDKContextUsage } from '../utils/messages/mappers.js'
import type { Message } from '../types/message.js'
import type { ContentBlockParam } from '../types/wire.js'
import type { ModelInfo } from '../entrypoints/agentSdkTypes.js'
import type { JSONRPCMessage } from '../services/mcp/sdk.js'
import {
  dequeue,
  enqueue,
  peek,
  popById,
  remove as removeQueuedCommands,
  subscribeToCommandQueue,
  getCommandQueue,
  holdQueuedWordsForTurnEnd,
} from '../utils/messageQueueManager.js'
import type { BatchedPrompt, QueuedCommand } from '../types/textInputTypes.js'
import { isHeldNotice, isOperatorLine, subscribeQueueConsumption } from '../input-core/command-queue.js'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { agentRecipientState, MAIN_THREAD_AGENT, noticeDeadlineMs, noticeRecipientTask, nudgeWords, startIdleNudge } from '../services/notices/idleNudge.js'
import { noticeRows, type NoticeRecord } from '../services/notices/unreadLedger.js'
import { injectUserMessageToCrewmate } from '../tasks/InProcessCrewmateTask/InProcessCrewmateTask.js'
import { isInProcessCrewmateTask } from '../tasks/InProcessCrewmateTask/types.js'
import { isLocalShellTask } from '../tasks/LocalShellTask/guards.js'
import { killTask } from '../tasks/LocalShellTask/killShellTasks.js'
import {
  getDefaultMainLoopModelSetting,
  getMainLoopModel,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import {
  getModelOptions,
} from '../utils/model/modelOptions.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsAutoMode,
  modelSupportsEffort,
} from '../utils/model/capabilities.js'
import { isEffortLevel, resolveEffortTruth } from '../utils/effort.js'
import { registerProcessOutputErrorHandlers } from '../utils/process.js'
import { notePrintPhase, printPhaseReport } from '../utils/printPhases.js'
import { getPerformance } from '../utils/profilerBase.js'
import { runSideQuestion } from '../utils/sideQuestion.js'
import { buildSideQuestionFallbackParams } from '../utils/queryContext.js'
import { armLocalWarm } from '../services/providers/local/localWarm.js'
import { extractReadFilesFromMessages } from '../utils/queryHelpers.js'
import {
  cacheSessionTitle,
  doesMessageExistInSession,
  saveAdvisorSwitch,
  saveAgentSetting,
} from '../utils/sessionStorage.js'
import { restoreAgentFromSession, restoreConversationModelFromMessages, restoreSessionStateFromLog } from '../utils/sessionRestore.js'
import {
  notifySessionStateChanged,
  setPermissionModeChangedListener,
  type RequiresActionDetails,
} from '../utils/sessionState.js'
import { generateSessionTitle } from '../utils/sessionTitle.js'
import { getSettingsWithSources } from '../utils/settings/settings.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { applySettingsChange } from '../utils/settings/applySettingsChange.js'
import { getSettingsSnapshot, settingsRevision } from '../utils/settings/snapshot.js'
import { skillChangeDetector } from '../utils/skills/skillChangeDetector.js'
import { armRunnerAgentFreshness } from './agentFreshness.js'
import { installStreamJsonStdoutGuard } from '../utils/streamJsonStdoutGuard.js'
import { getRunningTasks, POLL_INTERVAL_MS } from '../utils/task/framework.js'
import { AGENT_INTERRUPT_BY_OPERATOR, AGENT_RESUME_NOTE, enqueueAgentReceiptRow, isLocalAgentTask, queueOperatorMessage } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { stopAgentByOperator } from '../services/agents/operatorStop.js'
import { openaiCatalogueFact, primeOpenaiCatalogue, readOpenaiAccountAgain } from '../services/providers/openai/openaiCatalogue.js'
import { markSessionBootRules, markSessionNonInteractive } from '../utils/cockpit/runtimePosture.js'
import { windowsShellRoadNotice } from '../utils/shell/windowsShellRoad.js'
import { drainRows, subscribeRows } from '../utils/sdkEventQueue.js'
import { projectWorkRoster } from '../utils/task/workRoster.js'
import { listSessionMission, onTasksUpdated } from '../utils/tasks.js'
import { operatorPauseGate } from '../run-core/pauseGate.js'

function missionLedgerOf(metadata: Record<string, unknown> | undefined): string | undefined {
  const ledger = metadata?.ledger
  if (typeof ledger === 'string' && ledger.trim() !== '') return ledger.trim()
  const mission = metadata?.missionId
  if (typeof mission === 'string' && mission.trim() !== '') return mission.trim()
  return undefined
}
import type { ThinkingConfig } from '../utils/thinking.js'
import { createSyntheticOutputTool, isSyntheticOutputToolEnabled } from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { filterToolsByDenyRules, getAllBaseTools, getTools } from '../tools.js'
import { getCrewName, isCrewLead, isCrewmate } from '../utils/crewmate.js'
import { acknowledgeLiveDelivery, subscribeLiveMessagesFor, prepareLiveDelivery, wasLiveDeliveryHandled, type LiveDelivery, type LiveCommsMessageV1 } from '../services/crew/liveComms.js'
import { formatCrewmateMessages, isShutdownApproved, resolveShutdownApprovedVictim } from '../services/crew/liveMessages.js'
import { CREW_LEAD_NAME } from '../utils/swarm/constants.js'
import { removeCrewmateFromCrewFile } from '../utils/swarm/crewHelpers.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { expandPath } from '../utils/path.js'
import { getCwd } from '../utils/cwd.js'
import { providerFamilyOfSetting } from '../utils/model/modelTransition.js'
import { streamIdleTimeoutMsForRoute } from '../services/providers/streamIdleBudget.js'
import { runWithWorkload } from '../utils/workloadContext.js'

export { joinPromptValues, canBatchWith }
export { createCanUseToolWithPermissionPrompt, getCanUseToolFn }
export { removeInterruptedMessage }
export {
  handleOrphanedPermissionResponse,
  handleMcpSetServers,
  reconcileMcpServers,
}
export type { DynamicMcpState, SdkMcpState }
export type { McpSetServersResult } from './headless/controlHandlers.js'

const MAILBOX_REFUSAL_NOTICE_AFTER = 20
const CONCOURSE_INTERRUPT_PREFIX = 'concourse-interrupt-'
const INTERRUPT_DEDUPE_CAP = 200
const RECEIVED_UUID_CAP = 10_000

type HeadlessOptions = {
  continue?: boolean
  resume?: string | boolean
  resumeSessionAt?: string
  outputFormat?: string
  syntaxInput?: string
  jsonSchema?: Record<string, unknown>
  permissionPromptToolName?: string
  permissionChannel?: PermissionChannel
  allowedTools?: string[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  systemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  includePartialMessages?: boolean
  forkSession?: boolean
  rewindFiles?: string
  agent?: string
  workload?: string
  advise?: boolean
  setupTrigger?: 'init' | 'maintenance'
  bootSessionIdPinned?: boolean
  subscribeAppState?: (listener: () => void) => () => void
  sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
  setSDKStatus?: unknown
}

type GetAppState = () => AppState
type SetAppState = (updater: (previous: AppState) => AppState) => void

class BoundedUuidSet {
  readonly #order: string[] = []
  readonly #set = new Set<string>()
  constructor(private readonly cap: number) {}
  add(value: string): void {
    if (this.#set.has(value)) return
    this.#set.add(value)
    this.#order.push(value)
    while (this.#order.length > this.cap) {
      const oldest = this.#order.shift()
      if (oldest !== undefined) this.#set.delete(oldest)
    }
  }
  has(value: string): boolean {
    return this.#set.has(value)
  }
}

type ModelCatalogueEntry = {
  value: string
  display_name?: string
  description?: string
  supports_effort?: boolean
  supported_effort_levels?: string[]
  supports_adaptive_thinking?: boolean
  supports_auto_mode?: boolean
}

function buildModelCatalogue(): ModelCatalogueEntry[] {
  const options = getModelOptions()
  return options.map(option => {
    const resolved = parseUserSpecifiedModel(option.value) ?? option.value
    const entry: ModelCatalogueEntry = {
      value: option.value,
      display_name: option.label,
      description: option.description,
    }
    if (modelSupportsEffort(resolved)) {
      entry.supports_effort = true
      entry.supported_effort_levels = [...resolveEffortTruth(resolved, undefined).selectable]
    }
    if (modelSupportsAdaptiveThinking(resolved)) entry.supports_adaptive_thinking = true
    if (modelSupportsAutoMode(resolved)) entry.supports_auto_mode = true
    return entry
  })
}

function normalizeInputPrompt(
  inputPrompt: string | AsyncIterable<string>,
): AsyncIterable<string> {
  if (typeof inputPrompt !== 'string') return inputPrompt
  const raw = inputPrompt
  return {
    async *[Symbol.asyncIterator]() {
      if (raw.trim().length === 0) return
      yield `${jsonStringify({
        type: 'user',
        message: { role: 'user', content: raw },
        parent_tool_use_id: null,
        session_id: '',
      })}\n`
    },
  }
}


export async function runHeadless(
  inputPrompt: string | AsyncIterable<string>,
  getAppState: GetAppState,
  setAppState: SetAppState,
  commands: import('../commands.js').Command[],
  tools: Tool[],
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  agents: AgentDefinition[],
  options: HeadlessOptions,
): Promise<void> {
  setAskChannel(options.permissionChannel !== undefined || options.permissionPromptToolName !== undefined ? 'sdk' : 'none')
  markSessionNonInteractive(getAppState().toolPermissionContext?.mode)
  markSessionBootRules(getAppState().toolPermissionContext)
  const shellRoadNotice = windowsShellRoadNotice()
  if (shellRoadNotice !== null) process.stderr.write(`${shellRoadNotice}\n`)
  const streamingInput = typeof inputPrompt !== 'string'
  noteHeadlessActivity(
    options.outputFormat === 'stream-json' && streamingInput ? 'sdk' : 'print',
  )
  settingsChangeDetector.subscribe(source => {
    applySettingsChange(source, setAppState)
  })
  if (process.versions.bun) {
    const bunGc = (globalThis as { Bun?: { gc?: (full: boolean) => void } }).Bun
    setInterval(() => bunGc?.gc?.(true), 1000).unref?.()
  }
  headlessProfilerStartTurn()
  notePrintPhase('graph_load', getPerformance().getEntriesByName('cli_entry')[0]?.startTime)
  notePrintPhase('cli_parse')

  if (options.resumeSessionAt !== undefined && !options.resume) {
    process.stderr.write('--replay-to requires --resume\n')
    gracefulShutdownSync(1)
    return
  }
  if (options.rewindFiles !== undefined && !options.resume) {
    process.stderr.write('--restore-files requires --resume\n')
    gracefulShutdownSync(1)
    return
  }
  if (
    options.rewindFiles !== undefined &&
    typeof inputPrompt === 'string' &&
    inputPrompt.trim().length > 0
  ) {
    process.stderr.write('--restore-files is a standalone operation and cannot be combined with a prompt\n')
    gracefulShutdownSync(1)
    return
  }

  const io = new StructuredIO(normalizeInputPrompt(inputPrompt))
  let turnsRun = 0
  let currentTurn: number | null = null
  let currentTurnId: string | null = null
  let sessionRowFor: string | null = null
  const liveScope = (): RowScope => ({ session_id: getSessionId(), ...(currentTurn !== null ? { turn: currentTurn } : {}) })
  const enqueueRow = (row: RowDraft): void => io.outbound.enqueue(row)
  let openFold: CompactionRow['trigger'] | null = null
  const foldRow = (fold: FoldStatusV1 | null): RowDraft => {
    const row = compactionRow(liveScope(), fold)
    openFold = row.state === 'ended' ? null : row.trigger
    return row
  }
  const statusRowOf = (status: unknown): RowDraft | null => {
    if (status === 'compacting') return foldRow(null)
    if (status === null) {
      if (openFold === null) return null
      const row = compactionClearedRow(liveScope(), openFold)
      openFold = null
      return row
    }
    if (typeof status !== 'object') return null
    const record = status as { wait?: RequestWaitV1 | null; streamActivity?: number; compacting?: FoldStatusV1 | string | null }
    if ('wait' in record) {
      const wait = record.wait ?? null
      if (wait !== null && wait.kind === 'retry') return null
      return waitRow(liveScope(), wait)
    }
    if ('streamActivity' in record) return heartbeatRow(liveScope())
    if ('compacting' in record) {
      const fold = record.compacting
      return foldRow(fold !== null && typeof fold === 'object' ? fold : null)
    }
    return null
  }
  {
    let missionTimer: NodeJS.Timeout | null = null
    onTasksUpdated(() => {
      if (missionTimer !== null) return
      missionTimer = setTimeout(() => {
        missionTimer = null
        enqueueRow(missionUpdatedRow(liveScope()))
      }, 50)
      missionTimer.unref?.()
    })
  }
  {
    let samplesTimer: NodeJS.Timeout | null = null
    subscribeSampleChanges(() => {
      if (samplesTimer !== null) return
      samplesTimer = setTimeout(() => {
        samplesTimer = null
        enqueueRow(samplesUpdatedRow(liveScope()))
      }, 50)
      samplesTimer.unref?.()
    })
  }
  if (options.outputFormat === 'stream-json') {
    installStreamJsonStdoutGuard()
  }
  notePrintPhase('invocation_resolution')

  {
    const unavailableReason = SandboxManager.getSandboxUnavailableReason()
    if (unavailableReason && SandboxManager.isSandboxRequired()) {
      process.stderr.write(
        `${GLYPH.fail} Sandbox is unavailable (${unavailableReason}) and the failIfUnavailable sandbox setting requires it\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    if (unavailableReason) {
      process.stderr.write(
        `${GLYPH.warn} Warning: sandboxing is OFF for this session (${unavailableReason}) — commands run with no network or filesystem confinement\n`,
      )
    } else if (SandboxManager.isSandboxingEnabled()) {
      try {
        await SandboxManager.initialize(io.createSandboxAskCallback())
      } catch (error) {
        process.stderr.write(
          `${GLYPH.fail} Sandbox initialization failed: ${errorMessage(error)}\n`,
        )
        gracefulShutdownSync(1, 'other')
        return
      }
    }
  }

  if (options.setupTrigger) {
    await processSetupHooks(options.setupTrigger, { forceSyncExecution: true })
  }

  const loaded = await loadInitialMessages(setAppState, {
    continue: options.continue,
    resume: typeof options.resume === 'string' ? options.resume : options.resume,
    resumeSessionAt: options.resumeSessionAt,
    forkSession: options.forkSession,
    outputFormat: options.outputFormat,
    sessionStartHooksPromise: options.sessionStartHooksPromise,
  })
  const messages: Message[] = loaded.messages
  let contentReplacementState = {
    ...reconstructContentReplacementState(messages, loaded.contentReplacements ?? []),
    budgetChars: Infinity,
  }

  const isConcourseWorker = flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  let awaitingSessionClaim = isConcourseWorker && !options.continue && !options.resume && options.bootSessionIdPinned !== true
  let sessionFactsHoldSpent = false
  let runnerRestartReason: string | undefined = flagEnv('MERCURY_RUNNER_RESTART_REASON')
  let recoveredCommandIds: string[] = []
  if (isConcourseWorker) void refreshBoxReading()
  const sessionWiringModules = (): Promise<
    [
      typeof import('../utils/hooks/wardsHook.js'),
      typeof import('../services/crew/identity.js'),
    ]
  > =>
    Promise.all([
      import('../utils/hooks/wardsHook.js'),
      import('../services/crew/identity.js'),
    ])
  const armSessionRunnerWiring = async (sid: string): Promise<void> => {
    const [wards, crew] = await sessionWiringModules()
    wards.registerWardsHook(setAppState, sid)
    const mission = await import('../utils/hooks/missionHook.js')
    mission.rearmMissionFromCard(setAppState, { cardSessionId: sid, armSessionId: sid })
    void crew.bootCrewIdentity({ sessionId: sid, worktreeRef: getCwd() }).catch(e => {
      logForDebugging(`[session-runner] crew identity boot failed (non-blocking): ${e}`)
    })
  }
  if (isConcourseWorker && !awaitingSessionClaim) {
    await armSessionRunnerWiring(String(getSessionId()))
  } else if (awaitingSessionClaim) {
    void sessionWiringModules().catch(() => {})
  }

  try {
    const { initializeSwarmSession } = await import('../utils/swarm/crewmateInit.js')
    initializeSwarmSession(setAppState, String(getSessionId()), messages as ReadonlyArray<{ crewName?: string; agentName?: string }>)
  } catch (error) {
    logForDebugging(`[session-runner] swarm init failed (non-blocking): ${error}`)
  }

  const hookInitialMessage = takeInitialUserMessage()
  if (hookInitialMessage) {
    io.prependUserMessage(hookInitialMessage)
  }

  if ((options.continue || options.resume) && !getMainLoopModelOverride()) {
    const recorded = restoreConversationModelFromMessages(messages)
    if (recorded && !options.userSpecifiedModel) {
      setMainLoopModelOverride(recorded)
    }
  }

  const hydrateResumedRun = async (): Promise<void> => {
    if (messages.length === 0) return
    try {
      const { runBootRecovery } = await import('../substrate/recoveryOrchestrator.js')
      const recovered = await runBootRecovery({
        scope: 'session',
        sessionId: getSessionId(),
        projectDir: getCwd(),
      })
      const led = recovered.leaderProjection
      if (led) {
        setAppState(prev =>
          prev.crewContext
            ? prev
            : {
                ...prev,
                crewContext: {
                  crewName: led.crewName,
                  crewFilePath: led.crewFilePath,
                  leadAgentId: led.leadAgentId,
                  crewmates: led.crewmates,
                },
              },
        )
      }
    } catch (error) {
      logError(error)
    }
    try {
      const owner = processMainOwner()
      if (getRunSnapshot(owner) === null) {
        await reconcileOnResume(owner, getCwd())
      }
    } catch (error) {
      logError(error)
    }
    try {
      const { coerceRestartReason: carriedReasonOf } = await import('../tasks/LocalAgentTask/launchReceipts.js')
      const carriedReason = carriedReasonOf(runnerRestartReason)
      if (carriedReason === 'crash' || carriedReason === 'stop') {
        const { carryRunnerAcrossRestart } = await import('./headless/restartCarry.js')
        const carried = await carryRunnerAcrossRestart({
          reason: carriedReason,
          messages,
          getAppState,
          setAppState,
          canUseTool: getCanUseToolFn(
            options.permissionChannel,
            options.permissionPromptToolName,
            io,
            () => getAppState().mcp.tools as Tool[],
            () => notifySessionStateChanged('requires_action'),
          ),
          relaunchContext: async () => {
            const { toolUseContext } = await buildSideQuestionFallbackParams({
              tools,
              commands,
              mcpClients: [...getAppState().mcp.clients],
              messages,
              readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
              getAppState,
              setAppState,
              customSystemPrompt: options.systemPrompt,
              appendSystemPrompt: options.appendSystemPrompt,
              agents,
            })
            return {
              ...toolUseContext,
              options: {
                ...toolUseContext.options,
                ...(options.permissionChannel === undefined ? {} : { permissionChannel: options.permissionChannel }),
              },
            }
          },
        })
        recoveredCommandIds = carried.recoveredCommandIds
        logForDebugging(`[session-runner] resume after ${carriedReason}: ${carried.requeued} line(s) re-queued, ${carried.relaunched} agent(s) relaunched, ${carried.delivered} delivered from the queue log, ${carried.stopped} stopped`)
      }
    } catch (error) {
      logError(error)
    }
    try {
      const { reconcileBackgroundLaunchesOnResume, coerceRestartReason } = await import('../tasks/LocalAgentTask/launchReceipts.js')
      const settledLaunches = reconcileBackgroundLaunchesOnResume(messages, getAppState, setAppState, Date.now(), coerceRestartReason(runnerRestartReason))
      if (settledLaunches.length > 0) {
        logForDebugging(`[session-runner] resume: ${settledLaunches.length} background launch(es) without a live record — stop notices written`)
      }
    } catch (error) {
      logError(error)
    }
    try {
      const { reconcileWatchesOnResume } = await import('../tools/MonitorTool/watchReceipts.js')
      const { coerceRestartReason } = await import('../tasks/LocalAgentTask/launchReceipts.js')
      const deadWatches = reconcileWatchesOnResume(messages, new Set(Object.keys(getAppState().tasks ?? {})), coerceRestartReason(runnerRestartReason))
      if (deadWatches.length > 0) {
        logForDebugging(`[session-runner] resume: ${deadWatches.length} watch(es) without a live process — dead-watch notices written`)
      }
    } catch (error) {
      logError(error)
    }
  }
  if (options.continue || options.resume) await hydrateResumedRun()
  if (!awaitingSessionClaim) (await import('../utils/crew/crewBirth.js')).birthSessionCrew(String(getSessionId()), setAppState)

  if (!options.agent && !getMainThreadAgentType() && loaded.agentSetting) {
    const restored = restoreAgentFromSession(loaded.agentSetting, undefined, {
      activeAgents: agents,
      allAgents: agents,
    })
    if (restored.agentType && restored.agentDefinition) {
      if (
        !isBuiltInAgent(restored.agentDefinition) &&
        options.systemPrompt === undefined
      ) {
        const agentPrompt = restored.agentDefinition.getSystemPrompt()
        if (agentPrompt) options.systemPrompt = agentPrompt
      }
      saveAgentSetting(restored.agentType)
    }
  }
  if (options.advise === true) saveAdvisorSwitch(true)

  if (messages.length === 0 && process.exitCode !== undefined && process.exitCode !== 0) {
    return
  }

  if (options.rewindFiles !== undefined) {
    const target = messages.find(
      message => (message as { uuid?: string }).uuid === options.rewindFiles,
    )
    if (!target || target.type !== 'user') {
      process.stderr.write(
        `Cannot rewind files to ${options.rewindFiles}: ${target ? 'the target is not a user message (file snapshots are only taken at user messages)' : 'no message with that uuid exists in the loaded session'}\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    const rewindResult = await handleRewindFiles(
      options.rewindFiles as UUID,
      getAppState(),
      setAppState,
      false,
    )
    if (rewindResult && rewindResult.can_rewind === false) {
      process.stderr.write(
        `${rewindResult.error ?? 'An unexpected error prevented the rewind'}\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    process.stdout.write(`Rewound files to message ${options.rewindFiles}\n`)
    gracefulShutdownSync(0)
    return
  }

  const resumeTargetValid =
    typeof options.resume === 'string' &&
    (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.resume) ||
      options.resume.endsWith('.jsonl'))
  if (
    typeof inputPrompt === 'string' &&
    inputPrompt.length === 0 &&
    !resumeTargetValid
  ) {
    emitLoadError(
      'No prompt reached run: give one as the argument or on stdin',
      options.outputFormat,
    )
    gracefulShutdownSync(1)
    return
  }

  const denyRules = getAppState().toolPermissionContext.alwaysDenyRules
  const startingMcpTools = (getAppState().mcp.tools as Tool[]).filter(tool => {
    const rules = Object.values(denyRules ?? {}).flat()
    return !rules.some(rule => rule === tool.name)
  })
  let sessionTools: Tool[] = [...tools, ...startingMcpTools]
  const canUseTool = getCanUseToolFn(
    options.permissionChannel,
    options.permissionPromptToolName,
    io,
    () => getAppState().mcp.tools as Tool[],
    () => notifySessionStateChanged('requires_action'),
  )
  if (options.permissionPromptToolName) {
    sessionTools = sessionTools.filter(
      tool => tool.name !== options.permissionPromptToolName,
    )
  }
  registerProcessOutputErrorHandlers()
  notePrintPhase('config_auth')

  const streamingOptions = options
  let sessionInitialized = false
  let activeModel: string | undefined =
    options.userSpecifiedModel === undefined
      ? undefined
      : parseUserSpecifiedModel(options.userSpecifiedModel)
  let thinkingConfig: ThinkingConfig | undefined = options.thinkingConfig
  let initializeJsonSchema: Record<string, unknown> | undefined
  let activeCommands = commands
  let activeAgents: AgentDefinition[] = agents
  const receivedUuids = new BoundedUuidSet(RECEIVED_UUID_CAP)
  const seenInterruptIds = new BoundedUuidSet(INTERRUPT_DEDUPE_CAP)
  let inputClosed = false
  let inFlightAbort: AbortController | null = null
  let hostAsks: HostAskLiveness | null = null
  io.setOnControlRequestSent(() => hostAsks?.noteParked())
  io.setOnControlRequestResolved(() => hostAsks?.noteSettled())
  let deferredModelBreadcrumb: string | null = null
  let heldSeatModel: { requestId: string; model: string } | null = null
  let heldSeatEffort: { requestId: string; effort: string } | null = null
  let deferredSpawnSwitches: Array<{ kind: 'subagents' | 'workflows'; on: boolean; requestId: string }> = []
  let deferredAdvisorQuiet: AdvisorQuiet[] = []
  const landAdvisorQuiet = (quiet: AdvisorQuiet): void => {
    const row = createAdvisorQuietMessage(quiet)
    messages.push(row)
    void recordTranscript([row], undefined, undefined, messages).catch((error: unknown) => {
      logForDebugging(`advisor: the quiet row was not recorded — ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const advisorRoad: AdvisorRoad = {
    onQuiet: quiet => {
      if (inputClosed) return
      if (inFlightAbort !== null) deferredAdvisorQuiet.push(quiet)
      else landAdvisorQuiet(quiet)
    },
  }
  const landSpawnSwitch = (kind: 'subagents' | 'workflows', on: boolean): void => {
    const landed = setSpawnSwitch(kind, on)
    if (!landed.changed) return
    messages.push(createRosterTransitionMessage(kind, on, spawnSwitchTransitionLine(kind, on)))
    declareLawfulPrefixChangeForEveryOwner(`the operator toggled ${SPAWN_SWITCH_LABEL[kind]} ${on ? 'on' : 'off'}`)
  }

  const dynamicMcp: DynamicMcpState = {
    configs: {},
    clients: [],
    tools: [],
  }
  const sdkMcp: SdkMcpState = {
    configs: Object.assign(Object.create(null), sdkMcpConfigs) as Record<string, McpSdkServerConfig>,
    clients: [],
    tools: [],
  }
  let mcpChangeChain: Promise<unknown> = Promise.resolve()
  const serializeMcpChange = <T,>(operation: () => Promise<T>): Promise<T> => {
    const next = mcpChangeChain.then(operation, operation)
    mcpChangeChain = next.catch(() => {})
    return next
  }

  const pendingSeeds = new Map<string, FileState>()
  let readFileCache: FileStateCache =
    messages.length > 0
      ? extractReadFilesFromMessages(messages, getCwd(), READ_FILE_STATE_CACHE_SIZE)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
  const getReadFileCache = (): FileStateCache => {
    if (pendingSeeds.size === 0) return readFileCache
    const merged = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    for (const [key, value] of pendingSeeds) merged.set(key, value)
    for (const key of readFileCache.keys()) {
      const value = readFileCache.get(key)
      if (value !== undefined) merged.set(key, value)
    }
    return merged
  }
  const setReadFileCache = (cache: FileStateCache): void => {
    readFileCache = cache
    for (const [key, seed] of pendingSeeds) {
      const existing = readFileCache.get(key)
      if (!existing || seed.timestamp > existing.timestamp) {
        readFileCache.set(key, seed)
      }
    }
    pendingSeeds.clear()
  }

  const rateLimitListener = (limits: ClaudeAILimits): void => {
    enqueueRow(rateLimitRow(liveScope(), limits))
  }
  statusListeners.add(rateLimitListener)

  const elicitationRegistered = new Set<string>()
  const registerPerTurnHandlers = (clients: MCPServerConnection[]): void => {
    for (const client of clients) {
      if (client.type !== 'connected') continue
      if (elicitationRegistered.has(client.name)) continue
      if (client.config.type === 'host') continue
      try {
        void registerElicitationHandlersForClient(client, client.name)
        elicitationRegistered.add(client.name)
      } catch {
      }
    }
  }
  const registerElicitationHandlersForClient = async (
    client: ConnectedMCPServer,
    serverName: string,
  ): Promise<void> => {
    client.client.setRequestHandler(
      'elicitation/create',
      (request, ctx) => withElicitationEntered(client.client, async () => {
        const params = request.params
        const mode = params.mode === 'url' ? 'url' : 'form'
        const requestedSchema = params.mode === 'url' ? undefined : params.requestedSchema
        const url = params.mode === 'url' ? params.url : undefined
        const elicitationId = params.mode === 'url' ? params.elicitationId : undefined
        const hookResult = await executeElicitationHooks({
          serverName,
          message: params.message,
          requestedSchema,
          signal: ctx.mcpReq.signal,
          mode,
          url,
          elicitationId,
        })
        if (hookResult.elicitationResponse !== undefined) {
          logForDebugging(`elicitation for ${serverName} answered by hook`)
          return hookResult.elicitationResponse
        }
        logForDebugging(`elicitation for ${serverName} forwarded to the host`)
        const hostResult = await io.handleElicitation(
          serverName,
          params.message,
          requestedSchema,
          ctx.mcpReq.signal,
          mode,
          url,
          elicitationId,
        )
        const resultHook = await executeElicitationResultHooks({
          serverName,
          action: hostResult.action,
          content: hostResult.content,
          mode,
          elicitationId,
        })
        if (resultHook.elicitationResultResponse !== undefined) {
          return resultHook.elicitationResultResponse
        }
        return hostResult
      }),
    )
    client.client.setNotificationHandler(
      'notifications/elicitation/complete',
      async notification => {
        const elicitationId = notification.params.elicitationId
        await executeNotificationHooks({
          message: `MCP server ${serverName} completed elicitation ${elicitationId}`,
          notificationType: 'elicitation_complete',
        }).catch(() => {})
        io.outbound.enqueue({
          type: 'system',
          subtype: 'elicitation_complete',
          mcp_server_name: serverName,
          elicitation_id: elicitationId,
          uuid: randomUUID(),
          session_id: getSessionId(),
        })
      },
    )
  }

  const baseToolNames = new Set(getAllBaseTools().map(tool => tool.name))
  const assembleTools = (state: AppState): Tool[] => {
    const mcpPartition = filterToolsByDenyRules(
      [...(state.mcp.tools as Tool[]), ...sdkMcp.tools, ...dynamicMcp.tools],
      state.toolPermissionContext,
    ).filter(tool => tool.mcpInfo?.effectiveMaxPermission !== 'blocked')
    const pool: Tool[] = [
      ...getTools(state.toolPermissionContext),
      ...sessionTools.filter(tool => !baseToolNames.has(tool.name) && !tool.isMcp),
      ...mcpPartition,
    ]
    const seen = new Set<string>()
    const deduped: Tool[] = []
    for (const tool of pool) {
      if (seen.has(tool.name)) continue
      if (options.permissionPromptToolName && tool.name === options.permissionPromptToolName) continue
      seen.add(tool.name)
      deduped.push(tool)
    }
    if (initializeJsonSchema && !options.jsonSchema) {
      if (isSyntheticOutputToolEnabled({ isNonInteractiveSession: true })) {
        try {
          const synthetic = createSyntheticOutputTool(initializeJsonSchema)
          if ('tool' in synthetic) deduped.push(synthetic.tool)
        } catch {
        }
      }
    }
    return deduped
  }

  const injectModelSwitchBreadcrumbs = async (toModel: string): Promise<void> => {
    const { createModelSwitchBreadcrumbs } = await import('../utils/messages/factories.js')
    const display = modelInfos.find(info => info.value === toModel)?.display_name ?? toModel
    const breadcrumbs = createModelSwitchBreadcrumbs(toModel, display)
    for (const breadcrumb of breadcrumbs) {
      messages.push(breadcrumb)
      const content = breadcrumb.message.content
      if (typeof content === 'string' && content.includes('local-command-stdout')) {
        enqueueRow(commandOutputRow(liveScope(), content, '/model'))
      }
    }
  }

  const applySeatModel = async (model: string): Promise<void> => {
    const previous = activeModel ?? getMainLoopModel()
    activeModel = model
    setMainLoopModelOverride(model)
    notifySessionStateChanged('idle')
    if (model !== previous) await injectModelSwitchBreadcrumbs(model)
  }
  const applySeatEffort = (effort: string): void => {
    if (!isEffortLevel(effort)) return
    setFlagEnv('MERCURY_EFFORT_LEVEL', effort)
    setAppState(previous => ({ ...previous, effortValue: effort }))
  }
  armLocalWarm(() => buildSideQuestionFallbackParams({ tools: assembleTools(getAppState()), commands: activeCommands, mcpClients: [...getAppState().mcp.clients, ...sdkMcp.clients, ...dynamicMcp.clients], messages, readFileState: getReadFileCache(), getAppState, setAppState, customSystemPrompt: options.systemPrompt, appendSystemPrompt: options.appendSystemPrompt, thinkingConfig, agents: activeAgents }), { live: () => !awaitingSessionClaim && inFlightAbort === null })

  const SDK_MODES = new Set(['default', 'implement', 'sovereign', 'flow', 'dontAsk'])
  setPermissionModeChangedListener(mode => {
    if (!SDK_MODES.has(mode)) return
    enqueueRow(modeRow(liveScope(), mode))
  })

  const updateSdkMcp = async (): Promise<void> => {
    await serializeMcpChange(async () => {
      const configuredNames = new Set(Object.keys(sdkMcp.configs))
      const clients = sdkMcp.clients
      const connectedNames = new Set(clients.map(client => client.name))
      const needsRefresh =
        [...configuredNames].some(name => !connectedNames.has(name)) ||
        [...connectedNames].some(name => !configuredNames.has(name)) ||
        clients.some(client => client.type === 'pending' || client.type === 'failed')
      if (!needsRefresh) return
      const oldNames = [...connectedNames]
      for (const client of clients) {
        if (!configuredNames.has(client.name) && client.type === 'connected') {
          await client.cleanup().catch(() => {})
        }
      }
      const { clients: freshClients, tools: freshTools } = await setupSdkMcpClients(
        sdkMcp.configs,
        io.sendMcpMessage.bind(io),
      )
      sdkMcp.clients = freshClients
      sdkMcp.tools = freshTools
      const staleNames = new Set([...oldNames, ...configuredNames])
      setAppState(previous => ({
        ...previous,
        mcp: {
          ...previous.mcp,
          tools: [
            ...previous.mcp.tools.filter(
              tool =>
                ![...staleNames].some(name => tool.name.startsWith(getMcpPrefix(name))),
            ),
            ...freshTools,
          ],
        },
      }))
      registerPerTurnHandlers(freshClients)
    }).catch((error: unknown) => logForDebugging(`sdk mcp refresh failed: ${errorMessage(error)}`))
  }
  void updateSdkMcp()

  const refreshExtensionState = async (): Promise<{ errorCount: number; extensions: Array<{ name: string; path: string; source: string }> }> => {
    const { reloadExtensions, noteReloaded } = await import('../extensions/boot.js')
    const pending = reloadExtensions({
      onServersChanged: () =>
        setAppState(prev => ({ ...prev, mcp: { ...prev.mcp, extensionReconnectKey: prev.mcp.extensionReconnectKey + 1 } })),
    })
    noteReloaded(pending)
    const outcome = await pending
    const refreshed = await getCommands(getCwd())
    activeCommands = refreshed
    const { getAgentDefinitionsWithOverrides } = await import('../tools/AgentTool/loadAgentsDir.js')
    const fresh = await getAgentDefinitionsWithOverrides(getCwd())
    const sdkInjected = activeAgents.filter(agent => agent.source === 'flagSettings')
    activeAgents = [...fresh.activeAgents, ...sdkInjected]
    return {
      errorCount: outcome.counts.broken,
      extensions: outcome.set.active.map(ext => ({ name: ext.manifest.name, path: ext.root, source: ext.entry.id })),
    }
  }

  skillChangeDetector.subscribe(() => {
    clearCommandMemoizationCaches()
    void getCommands(getCwd()).then(refreshed => {
      activeCommands = refreshed
    })
  })

  const disarmAgentFreshness = armRunnerAgentFreshness({
    cwd: () => getCwd(),
    getActive: () => activeAgents,
    setActive: next => {
      activeAgents = next
    },
  })


  const isMainThreadCommand = (command: QueuedCommand): boolean =>
    command.agentId === undefined
  const takeMainThread = (): QueuedCommand | undefined => {
    const next = peek()
    if (next && isMainThreadCommand(next)) return dequeue()
    return undefined
  }

  const taskNotificationPayloads = (command: QueuedCommand): string[] => {
    const texts =
      typeof command.value === 'string'
        ? [command.value]
        : Array.isArray(command.value)
          ? command.value.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
          : []
    if (command.mode !== 'task-notification' && !texts.some(text => text.includes('<task-notification>'))) return []
    return texts.flatMap(text => text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? [text])
  }

  const executeTurn = async (
    command: QueuedCommand,
    batch: QueuedCommand[],
    onMessage: (message: RowDraft) => void,
    initialNotices: QueuedCommand[] = [],
  ): Promise<void> => {
    const batchUuids = batch.map(member => member.uuid).filter((uuid): uuid is UUID => uuid !== undefined)
    const batchTail: BatchedPrompt[] =
      command.mode === 'prompt'
        ? batch.slice(1).map(member => ({
            value: member.value,
            ...(member.uuid !== undefined ? { uuid: member.uuid } : {}),
            ...(member.origin !== undefined ? { origin: member.origin } : {}),
          }))
        : []
    emitCommandNotifications([...initialNotices, command])
    const turnAbort = new AbortController()
    inFlightAbort = turnAbort
    turnsRun += 1
    currentTurn = turnsRun
    currentTurnId = null
    const turnIdleLimitMs = headlessTurnIdleLimitMs()
    const turnWatchdog = armInactivityDeadline({
      seam: 'unattended turn',
      limitMs: turnIdleLimitMs,
      advice: 'the turn was aborted and the run exits non-zero; MERCURY_HEADLESS_IDLE_MINUTES tunes the limit (0 disables)',
      onExpire: error => {
        logForDebugging(`print: ${error.message}`)
        turnAbort.abort(error)
      },
    })
    hostAsks = keepTurnLiveWhileHostAnswers({
      watchdog: turnWatchdog,
      limitMs: turnIdleLimitMs,
      parkedWithHost: () => io.pendingControlRequestCount(),
      parkedAsks: () => io.getPendingPermissionRequests().length,
      settleParkedAsks: cause => io.denyPendingPermissionRequests(cause),
    })
    const workload = command.workload ?? options.workload
    try {
      await runWithWorkload(workload, async () => {
        const state = getAppState()
        const turnClients: MCPServerConnection[] = [
          ...state.mcp.clients,
          ...sdkMcp.clients,
          ...dynamicMcp.clients,
        ]
        registerPerTurnHandlers(turnClients)
        const assembledTools = assembleTools(state)
        const mcpCommands = state.mcp.commands
        const dedupedCommands = [
          ...activeCommands,
          ...mcpCommands.filter(
            mcpCommand => !activeCommands.some(existing => existing.name === mcpCommand.name),
          ),
        ]
        if (sessionRowFor !== String(getSessionId())) {
          sessionRowFor = String(getSessionId())
          const facts = await sessionFactsOf(
            { cwd: getCwd(), tools: assembledTools, mcpClients: turnClients, commands: dedupedCommands, agents: activeAgents },
            activeModel ?? getMainLoopModel(),
            state.toolPermissionContext.mode,
          )
          enqueueRow(sessionRow({ session_id: getSessionId() }, facts))
        }
        for await (const message of ask({
          commands: dedupedCommands,
          prompt: command.value,
          ...(options.syntaxInput !== undefined && command.value === inputPrompt ? { syntaxInput: options.syntaxInput } : {}),
          promptUuid: command.uuid,
          ...(batchUuids.length > 0 ? { batchUuids } : {}),
          ...(batchTail.length > 0 ? { batchTail } : {}),
          ...(initialNotices.length > 0 ? { initialNotices } : {}),
          isMeta: command.isMeta,
          ...(command.origin !== undefined ? { origin: command.origin } : {}),
          ...(command.skipSlashCommands === true ? { skipSlashCommands: true } : {}),
          ...(command.mode === 'bash' ? { promptMode: 'bash' as const } : {}),
          cwd: getCwd(),
          tools: assembledTools,
          mcpClients: turnClients,
          thinkingConfig,
          maxTurns: options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd,
          canUseTool,
          ...(options.permissionChannel === undefined ? {} : { permissionChannel: options.permissionChannel }),
          userSpecifiedModel: activeModel,
          fallbackModel: options.fallbackModel,
          jsonSchema: initializeJsonSchema ?? options.jsonSchema,
          mutableMessages: messages,
          contentReplacementState,
          getReadFileCache,
          setReadFileCache,
          customSystemPrompt: options.systemPrompt,
          appendSystemPrompt: options.appendSystemPrompt,
          getAppState,
          setAppState,
          abortController: turnAbort,
          partialRows: options.includePartialMessages,
          turn: currentTurn ?? undefined,
          onLiveness: () => turnWatchdog.touch(),
          onToolRoundSettled: rows => {
            void advisorMainRound(String(getSessionId()), rows, advisorRoad)
          },
          handleElicitation: (
            serverName: string,
            params: { message: string; mode?: 'form' | 'url'; url?: string; elicitationId?: string },
            elicitSignal?: AbortSignal,
          ) =>
            io.handleElicitation(
              serverName,
              params.message,
              undefined,
              elicitSignal,
              params.mode,
              params.url,
              params.elicitationId,
            ),
          agents: activeAgents,
          ...(command.orphanedPermission
            ? { orphanedPermission: command.orphanedPermission }
            : {}),
          setSDKStatus: (status: unknown) => {
            const row = statusRowOf(status)
            if (row !== null) enqueueRow(row)
          },
        })) {
          turnWatchdog.touch()
          if (turnOpened(message as never)) currentTurnId = (message as unknown as { turn_id: string }).turn_id
          onMessage(message)
        }
      })
    } finally {
      hostAsks?.stop()
      hostAsks = null
      turnWatchdog.cancel()
      inFlightAbort = null
      currentTurn = null
      if (heldSeatModel !== null) {
        const held = heldSeatModel
        heldSeatModel = null
        await applySeatModel(held.model)
        io.outbound.enqueue(seatVerbAppliedFrame(getSessionId(), held.requestId, { verb: 'set_model', model: held.model }, randomUUID()))
      }
      if (heldSeatEffort !== null) {
        const held = heldSeatEffort
        heldSeatEffort = null
        applySeatEffort(held.effort)
        io.outbound.enqueue(seatVerbAppliedFrame(getSessionId(), held.requestId, { verb: 'set_effort', effort: held.effort }, randomUUID()))
      }
      holdQueuedWordsForTurnEnd(false)
      if (deferredModelBreadcrumb !== null) {
        const toModel = deferredModelBreadcrumb
        deferredModelBreadcrumb = null
        await injectModelSwitchBreadcrumbs(toModel)
      }
      if (deferredSpawnSwitches.length > 0) {
        const toggles = deferredSpawnSwitches
        deferredSpawnSwitches = []
        for (const toggle of toggles) {
          landSpawnSwitch(toggle.kind, toggle.on)
          io.outbound.enqueue(seatVerbAppliedFrame(getSessionId(), toggle.requestId, { verb: 'spawn_switch', switch: toggle.kind, on: toggle.on }, randomUUID()))
        }
      }
      if (deferredAdvisorQuiet.length > 0) {
        const quiets = deferredAdvisorQuiet
        deferredAdvisorQuiet = []
        for (const quiet of quiets) landAdvisorQuiet(quiet)
      }
    }
    if (turnWatchdog.fired) {
      throw new DeadlineExceededError('unattended turn', turnIdleLimitMs, turnIdleLimitMs, turnWatchdog.progressCount, 'no engine event for the whole limit — the turn was aborted; MERCURY_HEADLESS_IDLE_MINUTES tunes the limit (0 disables)')
    }
  }

  function headlessTurnIdleLimitMs(): number {
    return minutesKnobToMs(flagEnv('MERCURY_HEADLESS_IDLE_MINUTES'), DEFAULT_HEADLESS_IDLE_MINUTES)
  }

  const crewShutdownPromptInjected = { value: false }
  const injectCrewShutdownPrompt = (): void => {
    if (crewShutdownPromptInjected.value) return
    crewShutdownPromptInjected.value = true
    enqueue({
      value: `<system-reminder>You are running non-interactively and your final answer is blocked while a crewmate is still running. Ask each crewmate to shut down gracefully and wait for their shutdown approvals. Only after every crewmate has shut down may you produce your final answer.</system-reminder>\nShut your crewmates down now and prepare your final answer.`,
      mode: 'prompt',
      uuid: randomUUID(),
    })
  }

  const stopShellsForClose = async (): Promise<void> => {
    const shells = getRunningTasks(getAppState()).filter(task => isLocalShellTask(task))
    if (shells.length === 0) return
    logForDebugging(`[session-runner] the input closed with ${shells.length} shell task(s) running: every watch and background shell ends with its seat`)
    await Promise.all(shells.map(task => killTask(task.id, setAppState).catch(() => undefined)))
  }

  const leadCrewName = (): string | null => {
    const crewContext = getAppState().crewContext
    if (!crewContext || !isCrewLead(crewContext) || isCrewmate()) return null
    return crewContext.crewName
  }

  const applyShutdownApprovals = (crewName: string, unread: LiveCommsMessageV1[]): void => {
    for (const message of unread) {
      const approval = isShutdownApproved(message.text)
      if (!approval) continue
      const victim = resolveShutdownApprovedVictim(message.from, approval)
      if (!victim) continue
      const roster = getAppState().crewContext?.crewmates ?? {}
      const victimId = Object.entries(roster).find(
        ([, crewmate]) => crewmate.name === victim,
      )?.[0]
      removeCrewmateFromCrewFile(crewName, { agentId: victimId, name: victim })
      setAppState(previous => {
        const crewmates = previous.crewContext?.crewmates
        if (!previous.crewContext || !crewmates) return previous
        const remaining = Object.fromEntries(
          Object.entries(crewmates).filter(
            ([id, crewmate]) => id !== victimId && crewmate.name !== victim,
          ),
        )
        return {
          ...previous,
          crewContext: { ...previous.crewContext, crewmates: remaining },
        }
      })
    }
  }

  let refusedAcknowledgements = 0
  let enqueuedLeadDelivery: string | null = null
  const deliverLeadMailOnce = async (): Promise<'queued' | 'none'> => {
    for (;;) {
      const crewName = leadCrewName()
      if (crewName === null) return 'none'
      let delivery: LiveDelivery | null
      try {
        delivery = await prepareLiveDelivery(crewName, CREW_LEAD_NAME, getSessionId())
        if (delivery !== null && await wasLiveDeliveryHandled(delivery, messages)) {
          await flushSessionStorage()
          await acknowledgeLiveDelivery(crewName, CREW_LEAD_NAME, delivery.id)
          refusedAcknowledgements = 0
          if (enqueuedLeadDelivery === delivery.id) enqueuedLeadDelivery = null
          continue
        }
      } catch (error) {
        refusedAcknowledgements += 1
        logForDebugging(`mailbox: delivery awaits durable state: ${errorMessage(error)}`)
        if (refusedAcknowledgements === MAILBOX_REFUSAL_NOTICE_AFTER) {
          logError(new Error(`mailbox: ${refusedAcknowledgements} consecutive acknowledgements refused — later crewmate reports wait until the crew state can be written (${errorMessage(error)})`))
        }
        return 'none'
      }
      if (delivery === null) return 'none'
      if (enqueuedLeadDelivery === delivery.id || getCommandQueue().some(command => command.uuid === delivery.id)) return 'queued'
      applyShutdownApprovals(crewName, delivery.messages)
      enqueuedLeadDelivery = delivery.id
      enqueue({ value: formatCrewmateMessages(delivery.messages), mode: 'prompt', uuid: delivery.id as UUID })
      return 'queued'
    }
  }

  let leadMailDelivery: Promise<'queued' | 'none'> | null = null
  let leadMailAgain = false
  const deliverLeadMail = (): Promise<'queued' | 'none'> => {
    if (leadMailDelivery !== null) {
      leadMailAgain = true
      return leadMailDelivery
    }
    const run = (async (): Promise<'queued' | 'none'> => {
      let verdict: 'queued' | 'none' = 'none'
      do {
        leadMailAgain = false
        verdict = await deliverLeadMailOnce()
      } while (leadMailAgain && verdict === 'none')
      return verdict
    })()
    leadMailDelivery = run
    void run.finally(() => {
      leadMailDelivery = null
    })
    return run
  }

  const leadContext = AsyncLocalStorage.snapshot()
  let leadMailboxWake: { crewName: string; unsubscribe: () => void } | null = null
  const syncLeadMailboxWake = (): void => leadContext(() => {
    const crewName = Object.keys(getAppState().crewContext?.crewmates ?? {}).length === 0 ? null : leadCrewName()
    if (crewName === (leadMailboxWake?.crewName ?? null)) return
    leadMailboxWake?.unsubscribe()
    leadMailboxWake = null
    if (crewName === null) return
    const unsubscribe = subscribeLiveMessagesFor(crewName, CREW_LEAD_NAME, () => {
      void leadContext(deliverLeadMail)
    }, { immediate: true })
    leadMailboxWake = { crewName, unsubscribe }
  })
  const stopLeadStateWake = options.subscribeAppState?.(syncLeadMailboxWake)
  syncLeadMailboxWake()

  const leadSettle: { wake: (() => void) | null } = { wake: null }
  const leadEvent = (crewName: string | null): Promise<void> =>
    new Promise<void>(resolve => {
      let settled = false
      const unsubscribes: Array<() => void> = []
      const done = (): void => {
        if (settled) return
        settled = true
        leadSettle.wake = null
        for (const unsubscribe of unsubscribes) unsubscribe()
        resolve()
      }
      leadSettle.wake = done
      if (crewName !== null) unsubscribes.push(subscribeLiveMessagesFor(crewName, CREW_LEAD_NAME, done, { immediate: false }))
      if (options.subscribeAppState) unsubscribes.push(options.subscribeAppState(done))
      unsubscribes.push(subscribeToCommandQueue(done), onTasksUpdated(done))
    })

  const settleIdle = async (): Promise<'reenter' | 'close' | 'stay'> => {
    for (let crewName = leadCrewName(); crewName !== null; crewName = leadCrewName()) {
      const changed = leadEvent(crewName)
      try {
        const next = peek()
        if (next && isMainThreadCommand(next) && driver.hasDueQueued()) return 'reenter'
        if ((await deliverLeadMail()) === 'queued') return 'reenter'
        const current = getAppState()
        const inProcessActive = getRunningTasks(current).some(task => task.type === 'in_process_crewmate')
        const listed = Boolean(Object.keys(current.crewContext?.crewmates ?? {}).length)
        if (!inProcessActive && !listed) break
        if (inputClosed && !crewShutdownPromptInjected.value) {
          injectCrewShutdownPrompt()
          return 'reenter'
        }
        await changed
      } finally {
        leadSettle.wake?.()
      }
    }
    if (inputClosed) {
      for (;;) {
        const changed = leadEvent(null)
        try {
          const running = getRunningTasks(getAppState()).some(task => task.type === 'in_process_crewmate' && !task.isIdle)
          if (!running) break
          await changed
        } finally {
          leadSettle.wake?.()
        }
      }
      const current = getAppState()
      const swarmRemains =
        Boolean(Object.keys(current.crewContext?.crewmates ?? {}).length) ||
        getRunningTasks(current).some(task => task.type === 'in_process_crewmate')
      if (swarmRemains) {
        injectCrewShutdownPrompt()
        return 'reenter'
      }
      await stopShellsForClose()
      return 'close'
    }
    return 'stay'
  }

  const idleTimeout = createIdleTimeoutManager(() => !driver.isRunning())

  const quiescence = new RunnerQuiescence({
    refusal: () => {
      if (driver.isRunning()) return 'a turn is running'
      if (getCommandQueue().some(isMainThreadCommand)) return 'a prompt is queued'
      const busy = getRunningTasks(getAppState()).filter(task => task.type !== 'in_process_crewmate')
      if (busy.length > 0) return `${busy.length} background task(s) still running`
      return capabilityHoldWords(runnerCapabilityHolds(io))
    },
    flush: () => flushSessionStorage(),
  })
  subscribeToCommandQueue(() => {
    if (getCommandQueue().length > 0) quiescence.invalidate()
  })

  let lastOutcome: OutcomeRow | null = null
  let lastOutcomeWritten: Promise<unknown> = Promise.resolve()
  const routeOutbound = (message: OutboundLine): void => {
    if (options.outputFormat === 'stream-json') {
      const written = io.write(message)
      if (isOutcome(message as never)) {
        lastOutcomeWritten = written.then(line => {
          if (line !== null) lastOutcome = line as OutcomeRow
        })
      }
      void written
      return
    }
    if (isOutcome(message as never)) lastOutcome = io.rows.stamp(message as never) as OutcomeRow
  }

  const emitTaskNotificationFrames = (payloads: readonly string[]): void => {
    for (const payload of payloads) {
      const pick = (tag: string): string | undefined => {
        const match = payload.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
        return match?.[1]?.trim()
      }
      const statusRaw = pick('status')
      if (statusRaw !== undefined) {
        const normalized =
          statusRaw === AGENT_MESSAGE_STATUS
            ? undefined
            : ['completed', 'failed', 'stopped', 'killed'].includes(statusRaw)
              ? statusRaw === 'killed'
                ? 'stopped'
                : statusRaw
              : 'completed'
        const totalTokens = Number(pick('total-tokens') ?? pick('total_tokens'))
        const toolUses = Number(pick('tool-uses') ?? pick('tool_uses'))
        const callId = pick('tool-use-id')
        enqueueRow(
          taskRow(liveScope(), {
            state: normalized !== undefined ? 'ended' : 'progress',
            taskId: pick('task-id') ?? pick('task_id') ?? '',
            ...(callId !== undefined ? { callId } : {}),
            outputFile: pick('output-file') ?? pick('output_file') ?? '',
            ...(normalized !== undefined ? { status: normalized as 'completed' | 'failed' | 'stopped' } : {}),
            summary: pick('summary') ?? '',
            ...(Number.isFinite(totalTokens) && Number.isFinite(toolUses)
              ? { usage: { tokens: totalTokens, toolUses, durationMs: Number(pick('duration-ms') ?? pick('duration_ms')) || 0 } }
              : {}),
          }),
        )
      }
    }
  }

  const announcedNotifications = new WeakSet<QueuedCommand>()
  const emitCommandNotifications = (commands: readonly QueuedCommand[]): void => {
    for (const command of commands) {
      if (announcedNotifications.has(command)) continue
      announcedNotifications.add(command)
      emitTaskNotificationFrames(taskNotificationPayloads(command))
    }
  }

  let retiringQueuedCommands = false
  const retireQueuedCommands = (commands: QueuedCommand[]): void => {
    retiringQueuedCommands = true
    try {
      removeQueuedCommands(commands)
    } finally {
      retiringQueuedCommands = false
    }
  }
  const stopDrainedNotificationFrames = subscribeQueueConsumption(event => {
    if (event.kind !== 'removed' || retiringQueuedCommands) return
    for (const drained of event.commands) {
      if (drained.mode !== 'task-notification' || drained.agentId !== undefined) continue
      emitCommandNotifications([drained])
    }
  })

  const driver: TurnDriver = createTurnDriver({
    dequeue: takeMainThread,
    dequeueCommand: command => dequeue(queued => queued === command),
    peek: () => {
      const next = peek()
      return next && isMainThreadCommand(next) ? next : undefined
    },
    notifyLifecycle: notifyCommandLifecycle,
    enqueueOutput: message => io.outbound.enqueue(message),
    writeDirect: async message => {
      await io.write(message)
    },
    drainRows: () => drainRows().map(row => ({ ...row, ...(currentTurn !== null ? { turn: currentTurn } : {}) }) as RowDraft),
    beforeCycle: async () => {
      await updateSdkMcp()
    },
    onTurnStart: () => {
      currentTurnId = null
    },
    turnIdOf: () => {
      if (currentTurnId === null) currentTurnId = randomUUID()
      return currentTurnId
    },
    openTurnRow: messageIds => {
      if (currentTurnId === null) currentTurnId = randomUUID()
      return turnStartedRow({ session_id: getSessionId(), turn: currentTurn ?? turnsRun }, { turnId: currentTurnId, messageIds, model: activeModel ?? getMainLoopModel() })
    },
    executeTurn: (command, batch, onMessage, initialNotices) =>
      executeTurn(command, batch, message => {
        onMessage(message)
      }, initialNotices),
    onTurnSettled: command => {
      void deliverLeadMail()
      logHeadlessProfilerTurn()
      headlessProfilerStartTurn()
      void advisorMainTurnSettled(String(getSessionId()), command, messages, advisorRoad)
    },
    hasWaitableBackgroundTasks: () =>
      getRunningTasks(getAppState()).some(task => task.type !== 'in_process_crewmate' && !(inputClosed && isLocalShellTask(task))),
    hasHoldableBackgroundAgents: () =>
      getRunningTasks(getAppState()).some(
        task => task.type === 'local_agent' || task.type === 'local_workflow',
      ),
    waitableBackgroundTaskCount: () =>
      getRunningTasks(getAppState()).filter(task => task.type !== 'in_process_crewmate' && !(inputClosed && isLocalShellTask(task))).length,
    onAgentWait: (count, turnId) => {
      enqueueRow(turnWaitingRow({ session_id: getSessionId(), turn: turnsRun }, { turnId, agents: count }))
    },
    settleIdle,
    wakeSettle: () => leadSettle.wake?.(),
    closeOutput: async () => {
      const { finalizePendingAsyncHooks } = await import('../utils/hooks/AsyncHookRegistry.js')
      await finalizePendingAsyncHooks().catch(() => {})
      skillChangeDetector.dispose()
      stopLeadStateWake?.()
      leadMailboxWake?.unsubscribe()
      leadSettle.wake?.()
      disarmAgentFreshness()
      stopDrainedNotificationFrames()
      stopIdleSdkDrain()
      statusListeners.delete(rateLimitListener)
      notePrintPhase('flush_exit')
      logForDebugging(`[print-phases] ${jsonStringify(printPhaseReport(getTotalAPIDuration()))}`)
      io.outbound.done()
    },
    notifySessionState: state => notifySessionStateChanged(state),
    isShuttingDown,
    idleTimerStop: () => idleTimeout.stop?.(),
    idleTimerStart: () => idleTimeout.start?.(),
    onCycleError: (error, turnId) =>
      outcomeRow(
        { session_id: getSessionId(), turn: currentTurn ?? 1 },
        {
          turnId,
          status: 'failed',
          steps: 0,
          wallMs: 0,
          usage: EMPTY_USAGE,
          models: {},
          denials: [],
          error: { message: errorMessage(error), class: 'internal', detail: getInMemoryErrors().map(entry => entry.error) },
        },
      ),
    shutdown: code => void gracefulShutdown(code),
    clock: { sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
    queuedMainThread: () => getCommandQueue().filter(isMainThreadCommand),
    settleWindowMs: POLL_INTERVAL_MS,
    wall: () => sessionLaneWall(),
  })

  const stopIdleSdkDrain = subscribeRows(() => {
    if (driver.isRunning()) return
    for (const row of drainRows()) enqueueRow(row)
  })
  subscribeToCommandQueue(() => {
    const queued = getCommandQueue()
    if (queued.some(command => command.priority === 'now')) {
      inFlightAbort?.abort()
    }
    if (!inputClosed && sessionInitialized && !driver.isRunning() && queued.some(isMainThreadCommand)) {
      driver.kick()
      if (!driver.isRunning()) emitCommandNotifications(queued.filter(isMainThreadCommand))
    }
  })

  const carriersOf = (notices: readonly NoticeRecord[]): QueuedCommand[] => {
    const keys = new Set<string>()
    for (const notice of notices) {
      keys.add(notice.key)
      if (notice.altKey !== undefined) keys.add(notice.altKey)
    }
    return getCommandQueue().filter(
      command => (command.queueId !== undefined && keys.has(command.queueId)) || (command.uuid !== undefined && keys.has(String(command.uuid))),
    )
  }
  const idleNudge = startIdleNudge({
    recipient: agentId => {
      if (agentId !== MAIN_THREAD_AGENT) return agentRecipientState(getAppState().tasks, agentId)
      if (isShuttingDown()) return { state: 'gone', why: 'the session is shutting down' }
      if (inputClosed) return { state: 'gone', why: "the session's input closed" }
      if (sessionLaneWall().closed) return { state: 'busy' }
      return !sessionInitialized || driver.isRunning() ? { state: 'busy' } : { state: 'idle' }
    },
    wake: (agentId, notices) => {
      const waitedMs = Date.now() - Math.min(...notices.map(notice => notice.deliveredAtMs))
      if (agentId === MAIN_THREAD_AGENT) {
        enqueue({ value: nudgeWords(notices, waitedMs), mode: 'prompt', priority: 'later', isMeta: true, uuid: randomUUID() })
        return true
      }
      const task = noticeRecipientTask(getAppState().tasks, agentId)
      if (task === undefined) return false
      const carriers = carriersOf(notices)
      const bodies = carriers.map(command => (typeof command.value === 'string' ? command.value : '')).filter(body => body !== '')
      if (!injectUserMessageToCrewmate(task.id, nudgeWords(notices, waitedMs, bodies), setAppState)) return false
      if (carriers.length > 0) retireQueuedCommands(carriers)
      return true
    },
    discard: notices => {
      const carriers = carriersOf(notices)
      if (carriers.length > 0) retireQueuedCommands(carriers)
    },
  })

  let signalCode: number | null = null
  const settleOnSignal = async (code: number): Promise<void> => {
    signalCode = code
    const running = inFlightAbort !== null
    inFlightAbort?.abort()
    if (running) {
      const deadline = new Promise<void>(resolve => setTimeout(resolve, SIGNAL_SETTLE_MS).unref?.())
      await Promise.race([outcomeAfterAbort(), deadline])
    }
    void gracefulShutdown(code)
  }
  const outcomeAfterAbort = async (): Promise<void> => {
    while (driver.isRunning()) await new Promise(resolve => setTimeout(resolve, 20))
    await lastOutcomeWritten
  }
  process.on('SIGINT', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGINT' })
    void settleOnSignal(130)
  })
  process.on('SIGTERM', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGTERM' })
    void settleOnSignal(143)
  })
  markPrintModeSignalsOwned()
  process.on('exit', () => saveCurrentSessionCosts())
  const { registerCleanup } = await import('../utils/cleanupRegistry.js')
  registerCleanup(async () => {
    idleNudge.stop()
    logForDiagnosticsNoPII('info', 'headless_sigterm_state', {
      cycle_running: driver.isRunning(),
      phase: driver.phase(),
      background_tasks: getRunningTasks(getAppState()).length,
    })
  })

  if (streamingInput) {
    const deliverLocalWake = (prompt: string, facts: LocalWakeFacts | undefined, firedAt: string, heldSince: string | undefined): void => {
      if (inputClosed) return
      const nowMs = Date.now()
      const next = localWakeStep(sessionLaneWall(nowMs), nowMs, firedAt, heldSince, facts)
      if (next.step === 'wait') {
        const recheck = setTimeout(() => deliverLocalWake(prompt, facts, firedAt, next.heldSince), next.delayMs)
        recheck.unref?.()
        return
      }
      enqueue({
        value: prompt,
        mode: 'prompt',
        uuid: randomUUID(),
        priority: 'later',
        skipSlashCommands: true,
        ...saturnQueueStamp(next.origin),
      })
      driver.kick()
    }
    registerLocalWakeSink((prompt: string, facts?: LocalWakeFacts) => {
      deliverLocalWake(prompt, facts, new Date().toISOString(), undefined)
    })
  }


  const handledOrphans = new Set<string>()
  io.setUnexpectedResponseCallback(async response => {
    const enqueued = await handleOrphanedPermissionResponse({
      message: { type: 'control_response', response },
      setAppState,
      handledToolUseIds: handledOrphans,
    })
    if (enqueued) driver.kick()
  })

  const modelInfos = buildModelCatalogue()
  const activeOAuth: {
    service: InstanceType<typeof OAuthService> | null
    flow: Promise<unknown> | null
  } = { service: null, flow: null }
  const mcpOAuth = new Map<
    string,
    { controller: AbortController; promise: Promise<unknown>; manualUsed: boolean; submitter: ((url: string) => void) | null }
  >()

  const respondSuccess = (requestId: string, payload?: Record<string, unknown>): void => {
    io.outbound.enqueue({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        ...(payload !== undefined ? { response: payload } : {}),
      },
    })
  }
  const respondError = (requestId: string, error: string): void => {
    io.outbound.enqueue({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    })
  }

  const resolveServerConfigFromAllSources = (
    serverName: string,
  ): ScopedMcpServerConfig | null => {
    const configured = getMcpConfigByName(serverName)
    if (configured) return configured
    const fromClients = [
      ...getAppState().mcp.clients,
      ...sdkMcp.clients,
      ...dynamicMcp.clients,
    ].find(client => client.name === serverName)
    return fromClients?.config ?? null
  }

  const applyReconnectedClient = async (
    serverName: string,
    client: MCPServerConnection,
    refreshDefinitions = false,
  ): Promise<void> => {
    const [tools, commandsForServer, resources] = await Promise.all([
      fetchToolsForClient(client),
      fetchCommandsForClient(client),
      fetchResourcesForClient(client),
    ])
    if (refreshDefinitions && client.type === 'connected') {
      requestDeliberateToolChange(String(processMainOwner()), tools, `the MCP server ${serverName} was manually reconnected`)
    }
    const prefix = getMcpPrefix(serverName)
    setAppState(previous => ({
      ...previous,
      mcp: {
        ...previous.mcp,
        clients: previous.mcp.clients.some(existing => existing.name === serverName)
          ? previous.mcp.clients.map(existing =>
              existing.name === serverName ? client : existing,
            )
          : [...previous.mcp.clients, client],
        tools: [
          ...previous.mcp.tools.filter(tool => !tool.name.startsWith(prefix)),
          ...tools,
        ],
        commands: [
          ...previous.mcp.commands.filter(existing => !existing.name.startsWith(prefix)),
          ...commandsForServer,
        ],
        resources: {
          ...Object.fromEntries(
            Object.entries(previous.mcp.resources ?? {}).filter(([key]) => key !== serverName),
          ),
          ...(resources.length > 0 ? { [serverName]: resources } : {}),
        },
      },
    }))
    const dynamicIndex = dynamicMcp.clients.findIndex(
      existing => existing.name === serverName,
    )
    if (dynamicIndex >= 0) {
      dynamicMcp.clients[dynamicIndex] = client
      dynamicMcp.tools = [
        ...dynamicMcp.tools.filter(tool => !tool.name.startsWith(prefix)),
        ...tools,
      ]
    }
  }

  const handleControlRequest = async (message: SDKControlRequest & { uuid?: string }): Promise<void> => {
    const requestId = message.request_id
    const request = message.request
    try {
      switch (request.subtype) {
        case 'initialize': {
          for (const name of request.host_mcp_servers ?? []) {
            sdkMcp.configs[name] = { type: 'host', name }
          }
          await handleInitializeRequest(
            request,
            requestId,
            sessionInitialized,
            io.outbound,
            commands,
            modelInfos as ModelInfo[],
            io,
            {
              systemPrompt: options.systemPrompt,
              appendSystemPrompt: options.appendSystemPrompt,
              agent: options.agent,
              userSpecifiedModel: options.userSpecifiedModel,
              ...streamingOptions,
            },
            agents,
            getAppState,
          )
          const wantsSummaries = Boolean(
            request.agent_progress_summaries,
          )
          if (wantsSummaries) {
            setSdkAgentProgressSummariesEnabled(true)
          }
          const initSchema = request.json_schema
          if (initSchema) {
            initializeJsonSchema = initSchema
            setInitJsonSchema(initSchema)
          }
          sessionInitialized = true
          if (getCommandQueue().length > 0) driver.kick()
          return
        }
        case 'interrupt': {
          if (requestId.startsWith(CONCOURSE_INTERRUPT_PREFIX)) {
            if (seenInterruptIds.has(requestId)) {
              respondSuccess(requestId)
              return
            }
            seenInterruptIds.add(requestId)
          }
          inFlightAbort?.abort()
          driver.releaseHold()
          if ((request as { hard?: boolean }).hard === true) {
            for (const task of Object.values(getAppState().tasks)) {
              if (isLocalShellTask(task) && task.status === 'running') void killTask(task.id, setAppState)
            }
          }
          respondSuccess(requestId)
          return
        }
        case 'withdraw_send': {
          const popped = popById(String(request.client_message_id ?? ''))
          respondSuccess(requestId, popped.popped ? { withdrawn: true, text: popped.text } : { withdrawn: false, reason: popped.reason })
          return
        }
        case 'end_session': {
          logForDebugging(
            `end_session: ${String(request.reason ?? 'unspecified')}`,
          )
          inFlightAbort?.abort()
          respondSuccess(requestId)
          throw new EndSessionSignal()
        }
        case 'set_permission_mode': {
          const updatedContext = handleSetPermissionMode(
            request,
            requestId,
            getAppState().toolPermissionContext,
            io.outbound,
          )
          setAppState(previous => ({ ...previous, toolPermissionContext: updatedContext }))
          return
        }
        case 'set_model': {
          const requested = request.model
          const resolved =
            requested === undefined || requested === 'default'
              ? (getDefaultMainLoopModelSetting() ?? getMainLoopModel())
              : parseUserSpecifiedModel(requested)
          if (inFlightAbort !== null) {
            heldSeatModel = { requestId, model: String(resolved) }
            holdQueuedWordsForTurnEnd(true)
            respondSuccess(requestId, { model: String(resolved), at: 'turn-boundary' })
            return
          }
          await applySeatModel(String(resolved))
          respondSuccess(requestId, { model: String(resolved), at: 'now' })
          return
        }
        case 'claim_session': {
          if (!awaitingSessionClaim) {
            respondError(requestId, 'claim refused — this runner already carries a session identity')
            return
          }
          const sid = String(request.session_id ?? '')
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
            respondError(requestId, `claim refused — session_id must be a UUID (got ${JSON.stringify(sid)})`)
            return
          }
          const claimedMode = typeof request.permission_mode === 'string' && request.permission_mode !== '' ? request.permission_mode : undefined
          const claimedEffort = typeof request.effort === 'string' && request.effort !== '' ? request.effort : undefined
          let claimedContext: AppState['toolPermissionContext'] | undefined
          if (claimedMode !== undefined) {
            const transition = resolvePermissionModeTransition(
              claimedMode as WirePermissionMode,
              getAppState().toolPermissionContext,
              'claim',
            )
            if (!transition.ok) {
              respondError(requestId, `claim refused — ${transition.error}`)
              return
            }
            claimedContext = transition.context
          }
          if (claimedEffort !== undefined && !isEffortLevel(claimedEffort)) {
            respondError(requestId, `claim refused — effort '${claimedEffort}' is not on the shared ladder`)
            return
          }
          dropCredentialMemos()
          if (request.openai_catalogue !== undefined) {
            primeOpenaiCatalogue(openaiCatalogueFromWire(request.openai_catalogue) as Parameters<typeof primeOpenaiCatalogue>[0])
          }
          const claimedHome = consumeSessionHomePin()
          clearSystemPromptSections()
          if (request.resume === true) {
            const pinnedFile = claimedHome !== null ? join(claimedHome, `${sid}.jsonl`) : undefined
            let resumed: Awaited<ReturnType<typeof loadConversationForResume>> = null
            try {
              resumed = await loadConversationForResume(sid, pinnedFile !== undefined && existsSync(pinnedFile) ? pinnedFile : undefined)
            } catch (error) {
              logError(error)
            }
            if (!resumed || resumed.messages.length === 0) {
              if (claimedHome !== null) setFlagEnv('MERCURY_SESSION_HOME', claimedHome)
              respondError(requestId, `claim refused — no conversation found for session ${sid}`)
              return
            }
            switchSession(sid as SessionId, resumed.fullPath ? dirname(resumed.fullPath) : claimedHome)
            if (!isSessionPersistenceDisabled()) await resetSessionFilePointer()
            await restoreSessionStateFromLog(resumed, setAppState)
            restoreSessionMetadata(resumed)
            messages.splice(0, messages.length, ...resumed.messages)
            contentReplacementState = {
              ...reconstructContentReplacementState(messages, resumed.contentReplacements ?? []),
              budgetChars: Infinity,
            }
          } else {
            switchSession(sid as SessionId, claimedHome)
          }
          const claimedModel = typeof request.model === 'string' && request.model !== '' ? request.model : undefined
          if (claimedModel !== undefined) {
            activeModel = parseUserSpecifiedModel(claimedModel)
            setMainLoopModelOverride(claimedModel)
            setFlagEnv('MERCURY_MODEL', claimedModel)
          }
          if (claimedEffort !== undefined) {
            setFlagEnv('MERCURY_EFFORT_LEVEL', claimedEffort)
            setAppState(previous => ({ ...previous, effortValue: claimedEffort }))
          }
          if (claimedContext !== undefined) {
            const nextContext = claimedContext
            setAppState(previous => ({ ...previous, toolPermissionContext: nextContext }))
          }
          await armSessionRunnerWiring(sid)
          if (typeof request.restart_reason === 'string') runnerRestartReason = request.restart_reason
          if (request.resume === true) await hydrateResumedRun()
          ;(await import('../utils/crew/crewBirth.js')).birthSessionCrew(sid, setAppState)
          awaitingSessionClaim = false
          logForDebugging(`[session-runner] claimed: session ${sid}${claimedModel !== undefined ? ` on ${claimedModel}` : ''}`)
          respondSuccess(requestId, { session_id: sid })
          if (heldNoticeWaits()) driver.kick()
          return
        }
        case 'set_effort': {
          const requestedEffort = String(request.effort ?? '')
          if (!isEffortLevel(requestedEffort)) {
            respondError(requestId, `effort refused ('${requestedEffort}' is not on the shared ladder)`)
            return
          }
          if (inFlightAbort !== null) {
            heldSeatEffort = { requestId, effort: requestedEffort }
            holdQueuedWordsForTurnEnd(true)
            respondSuccess(requestId, { effort: requestedEffort, at: 'turn-boundary' })
            return
          }
          applySeatEffort(requestedEffort)
          respondSuccess(requestId, { effort: requestedEffort, at: 'now' })
          return
        }
        case 'session_facts': {
          if (!sessionFactsHoldSpent) {
            sessionFactsHoldSpent = true
            const holdMs = Number.parseInt(flagEnv('MERCURY_SESSION_FACTS_HOLD_MS') ?? '', 10)
            if (Number.isFinite(holdMs) && holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs))
          }
          const state = getAppState()
          const anthropicWindow = anthropicWindowFact()
          const openaiWindow = openaiWindowFact()
          const geminiWindow = laneWindowFact('gemini')
          const openrouterWindow = laneWindowFact('openrouter')
          const huggingfaceWindow = laneWindowFact('huggingface')
          const openaiCatalogue = openaiCatalogueFact()
          const factsNow = Date.now()
          const answer: SessionFactsAnswerV1 = {
            model: {
              effective: activeModel ?? getMainLoopModel(),
              setting: getMainLoopModelOverride() ?? null,
            },
            usage: {
              totalCostUSD: getTotalCostUSD(),
              totalAPIDurationMs: getTotalAPIDuration(),
              totalDurationMs: getTotalDuration(),
              totalLinesAdded: getTotalLinesAdded(),
              totalLinesRemoved: getTotalLinesRemoved(),
              totalInputTokens: getTotalInputTokens(),
              totalOutputTokens: getTotalOutputTokens(),
              totalCacheReadInputTokens: getTotalCacheReadInputTokens(),
              totalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
              hasUnknownModelCost: hasUnknownModelCost(),
              unpricedTurns: getTotalUnpricedTurns(),
              limitWarning: providerLimitWarning({ model: activeModel ?? getMainLoopModel() }),
              ...(() => {
                const observed = openaiObservedUsage()
                return observed.primary || observed.secondary ? { openaiObserved: observed } : {}
              })(),
              ...(anthropicWindow !== undefined ? { anthropicWindow } : {}),
              ...(openaiWindow !== undefined ? { openaiWindow } : {}),
              ...(geminiWindow !== undefined ? { geminiWindow } : {}),
              ...(openrouterWindow !== undefined ? { openrouterWindow } : {}),
              ...(huggingfaceWindow !== undefined ? { huggingfaceWindow } : {}),
              jev: jevFactsOf(jevLedgerSnapshot(factsNow), jevStatus(undefined, factsNow)),
            },
            identity: {
              firstPartyApi: is1PApiCustomer(),
              consoleBilling: hasConsoleBillingAccess(),
              claudeAiBilling: hasClaudeAiBillingAccess(),
              accountEmail: anthropicSignInEmail() ?? null,
            },
            skills: skillsRosterOf(activeCommands, offSkillNamesOf(sessionKitOf(), activeCommands.map(c => c.name))),
            mcp: mcpRosterEntriesOf(state.mcp.clients, [...sdkMcp.clients, ...dynamicMcp.clients]),
            permissionMode: state.toolPermissionContext.mode,
            ...((): { effortSent?: string | null } => {
              const sent = effortSentOf(resolveEffortTruth(activeModel ?? getMainLoopModel(), state.effortValue))
              return sent === undefined ? {} : { effortSent: sent }
            })(),
            spawnSwitches: spawnSwitchFacts(),
            box: boxReading(),
            ...(openaiCatalogue !== undefined ? { openaiCatalogue } : {}),
            workspace: {
              cwd: getCwd(),
              originalCwd: getOriginalCwd(),
              projectRoot: getProjectRoot(),
            },
            recoveredCommandIds,
            queue: getCommandQueue().filter(command => command.agentId === undefined).map(command => ({
              ...(command.uuid !== undefined ? { uuid: String(command.uuid) } : {}),
              value:
                typeof command.value === 'string'
                  ? command.value
                  : Array.isArray(command.value)
                    ? command.value
                        .map(block => ((block as { type?: string; text?: string }).type === 'text' ? ((block as { text?: string }).text ?? '') : ''))
                        .join('')
                    : '',
              mode: command.mode,
              ...(command.priority !== undefined ? { priority: command.priority } : {}),
            })),
            work: projectWorkRoster(state.tasks),
            pauseGate: { paused: operatorPauseGate.paused(), parked: operatorPauseGate.parked().length },
            advisor: advisorFacts(),
            notices: noticeRows(),
            mission: (await listSessionMission().catch((): Awaited<ReturnType<typeof listSessionMission>> => [])).map(task => ({
              id: task.id,
              subject: task.subject.slice(0, 120),
              ...(task.activeForm !== undefined ? { activeForm: task.activeForm.slice(0, 120) } : {}),
              status: task.status,
              ...(task.blocks.length > 0 ? { blocks: task.blocks } : {}),
              ...(task.blockedBy.length > 0 ? { blockedBy: task.blockedBy } : {}),
              ...(missionLedgerOf(task.metadata) !== undefined ? { ledger: missionLedgerOf(task.metadata) } : {}),
            })),
            samples: await sampleRowsOf(getSessionId()),
            ...(sessionKitOf() !== undefined ? { kit: sessionKitOf() } : {}),
            ...((): Record<string, unknown> => {
              const edits = takePendingScheduleEdits()
              return edits.length > 0 ? { pendingScheduleEdits: edits } : {}
            })(),
            streamIdleTimeoutMs: streamIdleTimeoutMsForRoute(providerFamilyOfSetting(activeModel ?? getMainLoopModel())),
            fileCheckpoints: {
              capture: fileHistoryEnabled(),
              restorable: state.fileHistory.snapshots.map(snapshot => String(snapshot.messageId)),
            },
          }
          markScheduleSeatObserved()
          respondSuccess(requestId, sessionFactsToWire(answer))
          return
        }
        case 'schedule_roster': {
          const rows = Array.isArray(request.schedules)
            ? (request.schedules as unknown[]).flatMap(raw => {
                if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
                const r = raw as Record<string, unknown>
                if (typeof r.id !== 'string' || typeof r.when !== 'string') return []
                const kind: 'fire' | 'birth' | null = r.kind === 'fire' ? 'fire' : r.kind === 'birth' ? 'birth' : null
                if (kind === null) return []
                return [
                  {
                    id: r.id,
                    when: r.when,
                    nextFireMs: typeof r.next_fire_ms === 'number' ? r.next_fire_ms : null,
                    kind,
                    ...(r.paused === true ? { paused: true as const } : {}),
                    ...(typeof r.title === 'string' && r.title !== '' ? { title: r.title } : {}),
                  },
                ]
              })
            : []
          latchSessionScheduleRoster(rows)
          respondSuccess(requestId)
          return
        }
        case 'set_max_thinking_tokens': {
          const tokens = request.max_thinking_tokens
          if (tokens === null || tokens === undefined) thinkingConfig = undefined
          else if (tokens === 0) thinkingConfig = { type: 'disabled' }
          else thinkingConfig = { type: 'enabled', budgetTokens: tokens }
          respondSuccess(requestId)
          return
        }
        case 'mcp_status': {
          respondSuccess(requestId, { mcp_servers: await buildServerStatusList() })
          return
        }
        case 'get_context_usage': {
          try {
            const data = await collectContextData({
              messages,
              getAppState,
              options: {
                mainLoopModel: activeModel ?? getMainLoopModel(),
                tools: assembleTools(getAppState()),
                agentDefinitions: { activeAgents, allAgents: activeAgents },
                customSystemPrompt: options.systemPrompt,
                appendSystemPrompt: options.appendSystemPrompt,
              },
            })
            respondSuccess(requestId, toSDKContextUsage(data))
          } catch (error) {
            respondError(requestId, errorMessage(error))
          }
          return
        }
        case 'mcp_message': {
          const serverName = request.server_name
          const client = sdkMcp.clients.find(candidate => candidate.name === serverName)
          if (client && client.type === 'connected' && client.client.transport?.onmessage) {
            client.client.transport.onmessage(request.message as JSONRPCMessage)
          }
          respondSuccess(requestId)
          return
        }
        case 'rewind_files': {
          const rewind = await handleRewindFiles(
            request.user_message_id as UUID,
            getAppState(),
            setAppState,
            request.dry_run ?? false,
            getReadFileCache(),
          )
          if (rewind.can_rewind || request.dry_run) {
            respondSuccess(requestId, { ...rewind })
          } else {
            respondError(requestId, rewind.error ?? 'rewind is not possible')
          }
          return
        }
        case 'rewind_session': {
          const outcome = await handleRewindSession(request, {
            messages,
            getAppState,
            drift: getReadFileCache(),
            turnActive: inFlightAbort !== null,
          })
          respondSuccess(requestId, rewindOutcomeToWire(outcome))
          return
        }
        case 'cancel_async_message': {
          const uuid = request.message_uuid
          const matching = getCommandQueue().filter(command => command.uuid === uuid)
          if (matching.length > 0) retireQueuedCommands(matching)
          const removed = matching.length > 0
          respondSuccess(requestId, { cancelled: Boolean(removed) })
          return
        }
        case 'seed_read_state': {
          const rawPath = String(request.path ?? '')
          const observedMtime = Number(request.mtime ?? 0)
          try {
            const normalized = expandPath(rawPath)
            const stats = await stat(normalized)
            const diskMtime = Math.floor(stats.mtimeMs)
            if (diskMtime <= observedMtime) {
              let content = await readFile(normalized, 'utf8')
              if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
              content = content.replace(/\r\n/g, '\n')
              pendingSeeds.set(normalized, {
                content,
                timestamp: observedMtime,
                offset: undefined,
                limit: undefined,
              })
            }
          } catch {
          }
          respondSuccess(requestId)
          return
        }
        case 'mcp_set_servers': {
          await serializeMcpChange(async () => {
            const result = await handleMcpSetServers(
              (request.servers ?? {}) as Record<string, McpServerConfig>,
              sdkMcp,
              dynamicMcp,
              setAppState,
            )
            respondSuccess(requestId, { ...result })
            await updateSdkMcp()
          })
          return
        }
        case 'reload_extensions': {
          try {
            const { errorCount, extensions } = await refreshExtensionState()
            respondSuccess(requestId, {
              commands: activeCommands
                .filter(command => command.userInvocable !== false)
                .map(command => ({
                  name: command.name,
                  description: formatDescriptionWithSource(command),
                  argument_hint: command.argumentHint ?? '',
                })),
              agents: activeAgents.map(agent => ({
                name: agent.agentType,
                description: agent.whenToUse,
                model: agent.model === 'inherit' ? undefined : agent.model,
              })),
              extensions,
              mcp_servers: await buildServerStatusList(),
              error_count: errorCount,
            })
          } catch (error) {
            respondError(requestId, errorMessage(error))
          }
          return
        }
        case 'mcp_reconnect': {
          const serverName = request.server_name
          const config = resolveServerConfigFromAllSources(serverName)
          if (!config) {
            respondError(requestId, `MCP server ${serverName} not found`)
            return
          }
          if (!isMcpCatalogueMember(serverName)) {
            respondError(
              requestId,
              `MCP server ${serverName} is disabled — enable it before reconnecting`,
            )
            return
          }
          elicitationRegistered.delete(serverName)
          await clearServerCache(serverName, config).catch(() => {})
          const client = await connectToServer(serverName, config)
          await applyReconnectedClient(serverName, client, true)
          if (client.type === 'connected') {
            registerPerTurnHandlers([client])
            respondSuccess(requestId)
          } else if (client.type === 'failed') {
            respondError(requestId, client.error ?? `failed to reconnect ${serverName}`)
          } else {
            respondError(requestId, `server ${serverName} is ${client.type}`)
          }
          return
        }
        case 'mcp_toggle': {
          const serverName = request.server_name
          const enabled = Boolean(request.enabled)
          const config = resolveServerConfigFromAllSources(serverName)
          if (!config) {
            respondError(requestId, `MCP server ${serverName} not found`)
            return
          }
          const dial = applyProcessSessionKitEdit(
            { mcp: [{ name: serverName, on: enabled }] },
            disabledMcpServerNamesIn(getCurrentProjectConfig()),
          )
          if (dial.outcome === 'refused') {
            respondError(requestId, dial.detail ?? 'kit refused')
            return
          }
          if (!enabled) {
            const existing = getAppState().mcp.clients.find(
              candidate => candidate.name === serverName,
            )
            if (existing?.type === 'connected') {
              await clearServerCache(serverName, config).catch(() => {})
            }
            setAppState(previous => dropMcpServerFromAppState(previous, serverName, config))
            clearCommandMemoizationCaches()
            activeCommands = await getCommands(getCwd())
            respondSuccess(requestId)
          } else {
            const client = await connectToServer(serverName, config)
            await applyReconnectedClient(serverName, client)
            clearCommandMemoizationCaches()
            activeCommands = await getCommands(getCwd())
            if (client.type === 'connected') {
              registerPerTurnHandlers([client])
              respondSuccess(requestId)
            } else {
              respondError(requestId, `failed to enable ${serverName}`)
            }
          }
          return
        }
        case 'spawn_switch': {
          const toggle = { kind: request.switch, on: request.on }
          if (inFlightAbort !== null) {
            deferredSpawnSwitches = [...deferredSpawnSwitches.filter(d => d.kind !== toggle.kind), { ...toggle, requestId }]
            holdQueuedWordsForTurnEnd(true)
            respondSuccess(requestId, { switch: toggle.kind, on: toggle.on, at: 'turn-boundary' })
            return
          }
          landSpawnSwitch(toggle.kind, toggle.on)
          respondSuccess(requestId, { switch: toggle.kind, on: toggle.on, at: 'now' })
          return
        }
        case 'credential_change': {
          readGlobalConfigAgain()
          resetLimitsForCredentialSwitch()
          dropCredentialMemos()
          readOpenaiAccountAgain()
          noteCrewAccountChange()
          respondSuccess(requestId)
          return
        }
        case 'kit_edit': {
          await serializeMcpChange(async () => {
            const verdict = validateSessionKit(sessionKitFromWire(request.kit))
            if (!verdict.ok) {
              respondError(requestId, `kit refused — ${verdict.reason}`)
              return
            }
            const before = sessionKitOf()
            const set = setProcessSessionKit(verdict.kit)
            if (!set.ok) {
              respondError(requestId, `kit refused — ${set.reason}`)
              return
            }
            const rows = getAppState().mcp.clients
            const delta = kitEditMcpDelta(
              before,
              set.kit,
              kitDialCandidates(before, set.kit, rows.map(row => row.name)),
            )
            const connected: string[] = []
            const disconnected: string[] = []
            const errors: Record<string, string> = Object.create(null) as Record<string, string>
            const foreignPlane = (name: string): string | null =>
              name in sdkMcp.configs
                ? 'the SDK hosts this server — its owner manages it'
                : name in dynamicMcp.configs
                  ? 'a dynamic server rides its own wire (mcp_set_servers)'
                  : null
            for (const name of delta.disconnect) {
              const foreign = foreignPlane(name)
              if (foreign !== null) {
                errors[name] = foreign
                continue
              }
              const config =
                rows.find(row => row.name === name)?.config ?? resolveServerConfigFromAllSources(name)
              if (!config) continue
              const existing = getAppState().mcp.clients.find(row => row.name === name)
              if (existing?.type === 'connected') {
                await clearServerCache(name, config).catch(() => {})
              }
              elicitationRegistered.delete(name)
              setAppState(previous => dropMcpServerFromAppState(previous, name, config))
              disconnected.push(name)
            }
            for (const name of delta.connect) {
              const foreign = foreignPlane(name)
              if (foreign !== null) {
                errors[name] = foreign
                continue
              }
              const config = resolveServerConfigFromAllSources(name)
              if (!config) {
                errors[name] = 'no configuration found for this server'
                continue
              }
              try {
                const client = await connectToServer(name, config)
                await applyReconnectedClient(name, client)
                if (client.type === 'connected') {
                  registerPerTurnHandlers([client])
                  connected.push(name)
                } else if (client.type === 'failed') {
                  errors[name] = client.error ?? 'connection failed'
                } else {
                  errors[name] = `server is ${client.type}`
                }
              } catch (error) {
                errors[name] = errorMessage(error)
              }
            }
            clearCommandMemoizationCaches()
            activeCommands = await getCommands(getCwd())
            pruneSkillSessionHooks(setAppState, getSessionId(), liveSkillRootsOf(activeCommands))
            if (sessionKitOf()?.resolved === false) {
              const { completeSessionKitFromRoster } = await import('../services/mcp/kitCompletion.js')
              const { getActiveSet } = await import('../extensions/active.js')
              completeProcessSessionKit(
                completeSessionKitFromRoster(sessionKitOf()!, {
                  mcpNames: [
                    ...getAppState().mcp.clients.map(row => row.name),
                    ...Object.keys(sdkMcp.configs),
                  ],
                  commands: activeCommands,
                  extensions: getActiveSet().active.map(ext => ext.manifest.name),
                }),
              )
            }
            respondSuccess(requestId, { applied: true, connected, disconnected, errors })
          })
          return
        }
        case 'mcp_authenticate': {
          const serverName = request.server_name
          const config = resolveServerConfigFromAllSources(serverName)
          if (!config) {
            respondError(requestId, `MCP server ${serverName} not found`)
            return
          }
          const transport = config.type
          if (transport !== 'sse' && transport !== 'http') {
            respondError(requestId, `transport type ${String(transport)} does not support OAuth`)
            return
          }
          mcpOAuth.get(serverName)?.controller.abort()
          const controller = new AbortController()
          const { performMCPOAuthFlow } = await import('../services/mcp/auth.js')
          let captureResolve: ((url: string) => void) | null = null
          const urlPromise = new Promise<string>(resolve => {
            captureResolve = resolve
          })
          const entry: {
            controller: AbortController
            promise: Promise<unknown>
            manualUsed: boolean
            submitter: ((url: string) => void) | null
          } = { controller, promise: Promise.resolve(), manualUsed: false, submitter: null }
          const flowPromise = performMCPOAuthFlow(
            serverName,
            config,
            url => captureResolve?.(url),
            controller.signal,
            {
              skipBrowserOpen: true,
              onWaitingForCallback: submit => {
                entry.submitter = submit
              },
            },
          )
          entry.promise = flowPromise
          mcpOAuth.set(serverName, entry)
          const raced = await Promise.race([
            urlPromise.then(url => ({ kind: 'url' as const, url })),
            flowPromise.then(() => ({ kind: 'done' as const })),
          ])
          if (raced.kind === 'url') {
            respondSuccess(requestId, { auth_url: raced.url, requires_user_action: true })
          } else {
            respondSuccess(requestId, { requires_user_action: false })
          }
          void flowPromise
            .then(async () => {
              if (!entry.manualUsed) {
                const client = await connectToServer(serverName, config)
                await applyReconnectedClient(serverName, client)
              }
            })
            .catch((error: unknown) => logForDebugging(`mcp oauth for ${serverName}: ${errorMessage(error)}`))
            .finally(() => {
              if (mcpOAuth.get(serverName)?.controller === controller) {
                mcpOAuth.delete(serverName)
              }
            })
          return
        }
        case 'mcp_oauth_callback_url': {
          const serverName = request.server_name
          const entry = mcpOAuth.get(serverName)
          if (!entry?.submitter) {
            respondError(requestId, `no OAuth flow is active for ${serverName}`)
            return
          }
          const url = String(request.callback_url ?? '')
          let parsedUrl: URL | null = null
          try {
            parsedUrl = new URL(url)
          } catch {
            parsedUrl = null
          }
          if (
            !parsedUrl ||
            (!parsedUrl.searchParams.has('code') && !parsedUrl.searchParams.has('error'))
          ) {
            respondError(
              requestId,
              'The redirect URL is missing its authorization code — paste the complete redirect URL including the code parameter',
            )
            return
          }
          entry.manualUsed = true
          entry.submitter(url)
          try {
            await entry.promise
            respondSuccess(requestId)
          } catch (error) {
            respondError(requestId, errorMessage(error))
          }
          return
        }
        case 'mcp_clear_auth': {
          const serverName = request.server_name
          const config = resolveServerConfigFromAllSources(serverName)
          if (!config) {
            respondError(requestId, `MCP server ${serverName} not found`)
            return
          }
          const transport = config.type
          if (transport !== 'sse' && transport !== 'http') {
            respondError(requestId, `auth cannot be cleared for transport type ${String(transport)}`)
            return
          }
          await revokeServerTokens(serverName, config)
          const client = await connectToServer(serverName, config)
          await applyReconnectedClient(serverName, client)
          respondSuccess(requestId, {})
          return
        }
        case 'provider_sign_in': {
          if (request.provider !== 'anthropic') {
            respondError(requestId, `no control-channel sign-in for the ${request.provider} family — sign in from the terminal (auth login) or /logins`)
            return
          }
          activeOAuth.service?.cleanup()
          const service = new OAuthService()
          activeOAuth.service = service
          let manualUrl: string | null = null
          let autoUrl: string | null = null
          let urlResolve: (() => void) | null = null
          const urlReady = new Promise<void>(resolve => {
            urlResolve = resolve
          })
          const flow = service
            .startOAuthFlow(
              async (auto, manual) => {
                autoUrl = auto
                manualUrl = manual ?? auto
                urlResolve?.()
              },
              {
                skipBrowserOpen: true,
                loginWithClaudeAi: request.method !== 'console',
              },
            )
            .then(async tokens => {
              await installOAuthTokens(tokens)
              return tokens
            })
          flow.catch(() => {})
          activeOAuth.flow = flow
          const raced = await Promise.race([
            urlReady.then(() => 'url' as const),
            flow.then(
              () => 'done' as const,
              () => 'failed' as const,
            ),
          ])
          if (raced === 'failed') {
            respondError(requestId, 'authentication failed to start')
            return
          }
          respondSuccess(requestId, {
            auth_url: autoUrl,
            manual_auth_url: manualUrl,
          })
          return
        }
        case 'provider_sign_in_callback':
        case 'provider_sign_in_wait': {
          const service = activeOAuth.service
          const flow = activeOAuth.flow
          if (!service || !flow) {
            respondError(requestId, 'no sign-in flow is active')
            return
          }
          if (request.subtype === 'provider_sign_in_callback') {
            service.handleManualAuthCodeInput({
              authorizationCode: request.authorization_code,
              state: request.state,
            })
          }
          void flow
            .then(() => {
              const account = getAccountInformation()
              respondSuccess(requestId, {
                account: {
                  email: account?.email,
                  organization: account?.organization,
                  subscription_type: account?.subscription,
                  token_source: account?.tokenSource,
                  api_key_source: account?.apiKeySource,
                },
              })
            })
            .catch((error: unknown) => respondError(requestId, errorMessage(error)))
          return
        }
        case 'apply_flag_settings': {
          const incoming = (request.settings ?? {}) as Record<
            string,
            unknown
          >
          const previousModel = activeModel ?? getMainLoopModel()
          const merged: Record<string, unknown> = {
            ...(getFlagSettingsInline() ?? {}),
            ...incoming,
          }
          for (const [key, value] of Object.entries(merged)) {
            if (value === null) delete merged[key]
          }
          setFlagSettingsInline(merged)
          settingsChangeDetector.notifyChange('flagSettings')
          if ('model' in incoming) {
            const model = incoming.model
            setMainLoopModelOverride(typeof model === 'string' ? model : null)
          }
          const resolvedNow = getMainLoopModel()
          if (resolvedNow !== previousModel) {
            activeModel = resolvedNow
            notifySessionStateChanged('idle')
            if (inFlightAbort !== null) deferredModelBreadcrumb = resolvedNow
            else await injectModelSwitchBreadcrumbs(resolvedNow)
          }
          respondSuccess(requestId)
          return
        }
        case 'get_settings': {
          const withSources = getSettingsWithSources()
          const snapshot = getSettingsSnapshot()
          const model = getMainLoopModel()
          const effortValue = getAppState().effortValue
          const effortTruth = resolveEffortTruth(model, effortValue)
          respondSuccess(requestId, {
            ...withSources,
            revision: settingsRevision(),
            provenance: snapshot.provenance,
            applied: {
              model,
              effort: effortTruth.supportsEffort ? (effortTruth.wire ?? null) : undefined,
              effort_requested: effortTruth.requested === undefined ? null : String(effortTruth.requested),
            },
          })
          return
        }
        case 'pause_gate': {
          const changed = request.paused ? operatorPauseGate.pause() : operatorPauseGate.resume()
          respondSuccess(requestId, { paused: operatorPauseGate.paused(), parked: operatorPauseGate.parked().length, changed })
          return
        }
        case 'background_shell': {
          const taken = requestShellBackground()
          if (taken > 0) respondSuccess(requestId, { taken })
          else respondError(requestId, 'no shell command is running in the main conversation')
          return
        }
        case 'stop_task': {
          try {
            const receipt = await stopAgentByOperator(request.task_id, { getAppState, setAppState }, request.note === AGENT_INTERRUPT_BY_OPERATOR ? { reason: AGENT_INTERRUPT_BY_OPERATOR } : {})
            if (receipt.outcome === 'applied') respondSuccess(requestId, { receipt: 'applied', kind: receipt.kind, status: receipt.status })
            else respondError(requestId, receipt.reason)
            for (const row of drainRows()) enqueueRow(row)
          } catch (error) {
            respondError(requestId, errorMessage(error))
          }
          return
        }
        case 'quiesce': {
          const answer = await quiescence.request({ subtype: 'quiesce', action: request.action, token: request.token })
          if (answer.ok) respondSuccess(requestId, { token: answer.token, phase: answer.phase })
          else respondError(requestId, answer.reason)
          if (answer.ok && answer.phase === 'committed') {
            inputClosed = true
            setTimeout(() => gracefulShutdownSync(0, 'other'), 50)
          }
          return
        }
        case 'resume_task': {
          const params = getLastCacheSafeParams()
          if (params === null) {
            respondError(requestId, 'nothing to resume from yet — the session has not run a turn')
            return
          }
          const target = getAppState().tasks[request.task_id]
          if (target !== undefined && target.status === 'running') {
            const note = request.note !== undefined ? request.note.trim() : ''
            if (note === '' || !isLocalAgentTask(target)) {
              respondError(requestId, 'the agent is running — nothing to resume')
              return
            }
            queueOperatorMessage(request.task_id, note, setAppState)
            respondSuccess(requestId, { queued: true, agent_id: request.task_id })
            return
          }
          try {
            const { readAgentMetadata } = await import('../utils/sessionStorage.js')
            if (isInProcessCrewmateTask(target) || (await readAgentMetadata(asAgentId(request.task_id)))?.crewmate !== undefined) {
              const { respawnCrewmateByOperator } = await import('../services/agents/operatorResume.js')
              const respawned = await respawnCrewmateByOperator(request.task_id, { getAppState, toolUseContext: params.toolUseContext, prompt: request.note })
              if (respawned.outcome === 'applied') respondSuccess(requestId, { agent_id: respawned.agentId, task_id: respawned.taskId, output_file: respawned.outputFile })
              else respondError(requestId, respawned.reason)
              for (const row of drainRows()) enqueueRow(row)
              return
            }
            const { resumeAgentBackground } = await import('../tools/AgentTool/resumeAgent.js')
            const { toolUseId: _staleToolUseId, ...lastContext } = params.toolUseContext
            void _staleToolUseId
            const resumed = await resumeAgentBackground({
              agentId: request.task_id,
              prompt: request.note !== undefined && request.note.trim() !== '' ? request.note : AGENT_RESUME_NOTE,
              replyTarget: request.note?.trim() ? 'operator' : 'parent',
              toolUseContext: { ...lastContext, abortController: new AbortController() } as typeof params.toolUseContext,
              canUseTool,
            })
            const { operatorResumeWords } = await import('../services/agents/operatorResume.js')
            if (!request.note?.trim()) enqueueAgentReceiptRow({ taskId: resumed.agentId, description: resumed.description, summary: operatorResumeWords(resumed.description) + (resumed.note ?? '') })
            respondSuccess(requestId, {
              agent_id: resumed.agentId,
              output_file: resumed.outputFile,
              ...(resumed.cwdFallback !== undefined ? { cwd_fallback: resumed.cwdFallback } : {}),
              ...(resumed.recordedCwd !== undefined ? { recorded_cwd: resumed.recordedCwd } : {}),
              ...(resumed.note ? { note: resumed.note } : {}),
            })
          } catch (error) {
            respondError(requestId, errorMessage(error))
          }
          return
        }
        case 'generate_session_title': {
          const description = String(request.description ?? '')
          const persist = Boolean(request.persist)
          const signal =
            inFlightAbort && !inFlightAbort.signal.aborted
              ? inFlightAbort.signal
              : new AbortController().signal
          void (async () => {
            try {
              const title = await generateSessionTitle(description, signal)
              if (title && persist) {
                try {
                  cacheSessionTitle(title)
                } catch (error) {
                  logError(error)
                }
              }
              respondSuccess(requestId, { title })
            } catch (error) {
              respondError(requestId, errorMessage(error))
            }
          })()
          return
        }
        case 'side_question': {
          const question = String(request.question ?? '')
          void (async () => {
            try {
              let params = getLastCacheSafeParams()
              if (params) {
                params = {
                  ...params,
                  toolUseContext: { ...params.toolUseContext, abortController: new AbortController() },
                }
              } else {
                params = await buildSideQuestionFallbackParams({
                  tools: assembleTools(getAppState()),
                  commands: activeCommands,
                  mcpClients: [
                    ...getAppState().mcp.clients,
                    ...sdkMcp.clients,
                    ...dynamicMcp.clients,
                  ],
                  messages,
                  readFileState: getReadFileCache(),
                  getAppState,
                  setAppState,
                  customSystemPrompt: options.systemPrompt,
                  appendSystemPrompt: options.appendSystemPrompt,
                  thinkingConfig,
                  agents: activeAgents,
                })
              }
              const result = await runSideQuestion({
                question,
                cacheSafeParams: params,
              })
              respondSuccess(requestId, { response: result.response })
            } catch (error) {
              respondError(requestId, errorMessage(error))
            }
          })()
          return
        }
        default:
          respondError(requestId, `unsupported control request subtype: ${request.subtype}`)
      }
    } catch (error) {
      if (error instanceof EndSessionSignal) throw error
      respondError(requestId, errorMessage(error))
    }
  }

  const buildServerStatusList = async (): Promise<Record<string, unknown>[]> => {
    const seen = new Set<string>()
    const rows: Record<string, unknown>[] = []
    const pushClient = async (client: MCPServerConnection): Promise<void> => {
      const name = client.name
      if (seen.has(name)) return
      seen.add(name)
      const config = client.config
      const projectedConfig =
        config.type === 'sse' || config.type === 'http'
          ? { type: config.type, url: config.url, headers: config.headers, oauth: config.oauth }
          : config.type === 'claudeai-proxy'
            ? { type: config.type, url: config.url, id: config.id }
            : config.type === 'host'
              ? { type: 'host', name: config.name }
              : {
                type: 'stdio',
                command: 'command' in config ? config.command : undefined,
                args: 'args' in config ? config.args : undefined,
              }
      const row: Record<string, unknown> = {
        name,
        status: client.type,
        scope: config.scope,
        config: projectedConfig,
      }
      if (client.type === 'connected') {
        row.server_info = client.serverInfo
        const tools = await fetchToolsForClient(client)
        const prefix = getMcpPrefix(name)
        row.tools = tools.map(tool => ({
          name: tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name,
          ...(tool.isReadOnly?.(undefined) ? { read_only: true } : {}),
          ...(tool.isDestructive?.(undefined) ? { destructive: true } : {}),
          ...(tool.isOpenWorld?.(undefined) ? { open_world: true } : {}),
        }))
      } else if (client.type === 'failed') {
        row.error = client.error ?? ''
      }
      rows.push(row)
    }
    for (const client of getAppState().mcp.clients) await pushClient(client)
    for (const client of sdkMcp.clients) await pushClient(client)
    for (const client of dynamicMcp.clients) await pushClient(client)
    return rows
  }

  class EndSessionSignal extends Error {}

  async function* claimGatedInput(
    source: AsyncGenerator<StdinMessage, void, unknown>,
  ): AsyncGenerator<StdinMessage, void, unknown> {
    const parked: StdinMessage[] = []
    for await (const frame of source) {
      if (awaitingSessionClaim && frame.type === 'user') {
        logForDebugging('[session-runner] a user frame arrived before the claim — parked until the session identity lands')
        parked.push(frame)
        continue
      }
      yield frame
      while (!awaitingSessionClaim && parked.length > 0) {
        yield parked.shift()!
      }
    }
  }

  const heldNoticeWaits = (): boolean =>
    !sessionInitialized &&
    isConcourseWorker &&
    !awaitingSessionClaim &&
    !inputClosed &&
    !driver.isRunning() &&
    getCommandQueue().some(command => isMainThreadCommand(command) && (isHeldNotice(command) || isOperatorLine(command)))
  subscribeToCommandQueue(() => {
    if (heldNoticeWaits()) driver.kick()
  })
  if (heldNoticeWaits()) driver.kick()

  const stdinLoop = (async (): Promise<void> => {
    try {
      for await (const typed of claimGatedInput(io.structuredInput)) {
        if (
          'uuid' in typed &&
          typed.uuid &&
          typed.type !== 'user' &&
          typed.type !== 'control_response'
        ) {
          notifyCommandLifecycle(typed.uuid, 'completed')
        }
        if (typed.type === 'control_request') {
          try {
            await handleControlRequest(typed)
          } catch (error) {
            if (error instanceof EndSessionSignal) break
            throw error
          }
          continue
        }
        if (typed.type === 'control_response') {
          continue
        }
        if (typed.type === 'assistant' || typed.type === 'system') {
          const { toInternalMessages } = await import('../utils/messages/mappers.js')
          messages.push(...toInternalMessages([typed] as Parameters<typeof toInternalMessages>[0]))
          continue
        }
        if (typed.type === 'user') {
          sessionInitialized = true
          const missionSync = await import('../utils/hooks/missionHook.js')
          missionSync.syncMissionFromCard(setAppState, String(getSessionId()))
          const uuid = typed.uuid
          if (uuid) {
            const historical = await doesMessageExistInSession(
              getSessionId(),
              uuid as UUID,
            ).catch(() => false)
            const runtime = receivedUuids.has(uuid)
            if (historical || runtime) {
              if (historical && !runtime) {
                notifyCommandLifecycle(uuid, 'completed')
              }
              continue
            }
            receivedUuids.add(uuid)
          }
          const content = (typed.message.content ?? '') as string | ContentBlockParam[]
          if (typed.mode === 'task-notification' && typeof typed.agent_id === 'string' && typed.agent_id !== '') {
            enqueue({
              value: content,
              mode: 'task-notification',
              agentId: typed.agent_id as never,
              priority: 'next',
              ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
            })
            continue
          }
          const sentAt = typeof typed.timestamp === 'string' && Number.isFinite(Date.parse(typed.timestamp)) ? typed.timestamp : new Date().toISOString()
          enqueue({
            value: content,
            mode: typed.mode === 'bash' ? 'bash' : 'prompt',
            sentAt,
            ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
            ...(typed.priority !== undefined ? { priority: typed.priority } : {}),
            ...saturnQueueStamp(typed.origin),
          })
          driver.kick()
        }
      }
    } finally {
      inputClosed = true
      leadSettle.wake?.()
      if (!driver.isRunning()) {
        await stopShellsForClose()
        await driver.closeOutputOnce()
      }
    }
  })()

  for await (const outboundMessage of io.outbound) {
    if (isOutcome(outboundMessage as never)) await peekProject()?.flush()
    routeOutbound(outboundMessage)
  }
  await stdinLoop.catch((error: unknown) => {
    logError(error)
  })

  const flushWrite = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
    new Promise((resolve, reject) => {
      stream.write(text, error => {
        if (error) {
          if (isBrokenPipeError(error)) {
            if (stream === process.stdout) io.markStdoutPipeBroken()
            else process.exitCode = 1
            return resolve()
          }
          return reject(error)
        }
        resolve()
      })
    })
  await lastOutcomeWritten
  const last: OutcomeRow =
    lastOutcome ??
    (io.rows.stamp(
      outcomeRow(
        { session_id: getSessionId(), turn: Math.max(1, turnsRun) },
        {
          turnId: currentTurnId ?? randomUUID(),
          status: 'failed',
          steps: 0,
          wallMs: 0,
          usage: EMPTY_USAGE,
          models: {},
          denials: [],
          error: { message: 'The run produced no outcome', class: 'internal' },
        },
      ),
    ) as OutcomeRow)
  if (options.outputFormat === 'json') {
    await flushWrite(process.stdout, `${jsonStringify(last)}\n`)
  } else if (options.outputFormat !== 'stream-json') {
    if (last.status === 'completed') {
      const text = last.answer ?? ''
      await flushWrite(process.stdout, text.endsWith('\n') ? text : `${text}\n`)
    } else {
      const sentence =
        last.status === 'refused' || last.status === 'failed'
          ? (last.error?.message ?? (last.status === 'refused' ? 'The request was refused' : 'The turn failed'))
          : OUTCOME_SENTENCES[last.status]({ maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, message: last.error?.message })
      await flushWrite(process.stderr, `${sentence}\n`)
    }
  }

  logHeadlessProfilerTurn()
  notePrintPhase('flush_exit')
  logForDebugging(`[print-phases] ${jsonStringify(printPhaseReport(getTotalAPIDuration()))}`)
  gracefulShutdownSync(io.stdoutPipeBroken ? 1 : (signalCode ?? exitCodeOf(last.status)))
}
