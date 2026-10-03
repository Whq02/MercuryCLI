import { requestShellBackground } from '../tools/BashTool/backgroundRequest.js'
import { randomUUID, type UUID } from 'node:crypto'
import { keepTurnLiveWhileHostAnswers, type HostAskLiveness } from './headless/hostAskLiveness.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import { readFile, stat } from 'node:fs/promises'
import { liveSkillRootsOf, pruneSkillSessionHooks } from '../utils/hooks/sessionHooks.js'
import {
  getMainLoopModelOverride,
  getSessionId,
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
import { declareLawfulPrefixChangeForEveryOwner } from '../services/providers/lawfulPrefixChange.js'
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
import { commandOutputRow, compactionClearedRow, compactionRow, heartbeatRow, missionUpdatedRow, modeRow, noticeRow, outcomeRow, rateLimitRow, samplesUpdatedRow, sessionRow, taskRow, turnStartedRow, turnWaitingRow, waitRow, type RowDraft, type RowScope, type Unstamped } from '../rows/project.js'
import { exitCodeOf, OUTCOME_SENTENCES, type CompactionRow, type InputRow, type OutcomeRow, type Row } from '../rows/vocabulary.js'
import { isOutcome, turnOpened } from '../rows/read.js'
import type { FoldStatusV1 } from '../services/compact/foldStatus.js'
import type { RequestWaitV1 } from '../services/providers/streamIdleBudget.js'
import { getCommands, findCommand, clearCommandMemoizationCaches, formatDescriptionWithSource } from '../commands.js'
import { collectContextData } from '../commands/context/context-noninteractive.js'
import {
  handleRewindFiles,
  handleRewindSession,
  resolvePermissionModeTransition,
} from './headless/controlHandlers.js'
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
import { emptyInputRow, INPUT_REFUSED_CODE, isBrokenPipeError, isRowLine, StructuredIO, type OutboundLine } from './structuredIO.js'
import { createRuleOnlyAsks, createRunnerAsks, type AskHost } from './headless/runnerAsks.js'
import { bindRunnerMethods, checkProtocol, DEFAULT_CAPABILITIES, initializeResultOf, type RequestRef, type RunnerArms } from './headless/runnerMethods.js'
import { createPeer, type Peer } from '../runner/wire/peer.js'
import { invalidParams, isRpcError, refused } from '../runner/wire/errors.js'
import type { Capabilities, ParamsOf } from '../runner/wire/methods.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import { anthropicWindowFact, resetLimitsForCredentialSwitch, statusListeners, type ClaudeAILimits } from '../services/claudeAiLimits.js'
import { sessionLaneWall } from '../tools/MonitorTool/laneWall.js'
import { providerLimitWarning } from '../services/providers/limitWarning.js'
import {
  clearServerCache,
  connectToServer,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from '../services/mcp/client.js'
import { withElicitationEntered } from '../services/mcp/elicitationHandler.js'
import { getMcpPrefix } from '../services/mcp/mcpStringUtils.js'
import { isMcpCatalogueMember } from '../services/mcp/membership.js'
import { applyProcessSessionKitEdit, completeProcessSessionKit, sessionKitOf, setProcessSessionKit } from '../services/mcp/sessionKitPin.js'
import { kitDialCandidates, kitEditMcpDelta, dropMcpServerFromAppState } from '../services/mcp/kitDial.js'
import { validateSessionKit } from '../daemon/sessionKit.js'
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
  McpServerConfig,
  ScopedMcpServerConfig,
} from '../services/mcp/types.js'
import { OAuthService } from '../services/oauth/index.js'
import { installOAuthTokens } from './handlers/auth.js'
import type { AppState } from '../state/AppStateStore.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import { noteHeadlessActivity } from '../utils/activityLedger.js'
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
import type { Message } from '../types/message.js'
import type { ContentBlockParam } from '../types/wire.js'
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
import { installWireStdoutGuard } from '../utils/wireStdoutGuard.js'
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
export { removeInterruptedMessage }

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
  door?: 'rows' | 'wire'
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
      yield `${jsonStringify({ type: 'prompt', content: raw })}\n`
    },
  }
}


export async function runHeadless(
  inputPrompt: string | AsyncIterable<string>,
  getAppState: GetAppState,
  setAppState: SetAppState,
  commands: import('../commands.js').Command[],
  tools: Tool[],
  agents: AgentDefinition[],
  options: HeadlessOptions,
): Promise<void> {
  setAskChannel(options.door === 'wire' ? 'sdk' : 'none')
  markSessionNonInteractive(getAppState().toolPermissionContext?.mode)
  markSessionBootRules(getAppState().toolPermissionContext)
  const shellRoadNotice = windowsShellRoadNotice()
  if (shellRoadNotice !== null) process.stderr.write(`${shellRoadNotice}\n`)
  const streamingInput = typeof inputPrompt !== 'string'
  noteHeadlessActivity(
    options.outputFormat === 'rows' && streamingInput ? 'sdk' : 'print',
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

  const io = new StructuredIO(normalizeInputPrompt(inputPrompt), text => enqueueRow(noticeRow(liveScope(), 'error', text, INPUT_REFUSED_CODE)))
  const wire = options.door === 'wire'
  let capabilities: Capabilities = { ...DEFAULT_CAPABILITIES }
  let bootSettled: () => void = () => {}
  const bootReady = new Promise<void>(resolve => {
    bootSettled = resolve
  })
  const peer: Peer | null = wire
    ? createPeer({
        input: process.stdin,
        output: process.stdout,
        side: 'runner',
        serialize: message => ndjsonSafeStringify(message),
        onWriteError: error => {
          if (isBrokenPipeError(error)) io.markStdoutPipeBroken()
          else logError(error)
        },
        onDesync: badLines => {
          process.stderr.write(`mercury runner: ${badLines} consecutive unreadable lines on stdin — the stream is out of step\n`)
          gracefulShutdownSync(1)
        },
        log: logForDebugging,
      })
    : null
  const asks: AskHost = peer !== null ? createRunnerAsks(peer, () => capabilities) : createRuleOnlyAsks()
  if (peer !== null) {
    peer.onRequest('initialize', async params => {
      checkProtocol(params)
      capabilities = params.capabilities
      await bootReady
      return initializeResultOf(awaitingSessionClaim ? null : String(getSessionId()))
    })
    bindRunnerMethods(peer, () => arms)
  }
  let turnsRun = 0
  let currentTurn: number | null = null
  let currentTurnId: string | null = null
  let sessionRowFor: string | null = null
  const liveScope = (): RowScope => ({ session_id: getSessionId(), ...(currentTurn !== null ? { turn: currentTurn } : {}) })
  const enqueueRow = (row: RowDraft): void => io.outbound.enqueue(row)
  let openFold: { trigger: CompactionRow['trigger']; landing: boolean } | null = null
  const foldRow = (fold: FoldStatusV1 | null): RowDraft | null => {
    if (fold !== null && fold.exit !== undefined) {
      if (fold.exit === 'landed') {
        openFold = { trigger: fold.trigger, landing: true }
        return null
      }
      openFold = null
      return compactionRow(liveScope(), fold)
    }
    if (openFold !== null) return fold === null || fold.stage === null ? null : compactionRow(liveScope(), fold)
    const row = compactionRow(liveScope(), fold)
    openFold = { trigger: row.trigger, landing: false }
    return row
  }
  const foldLanded = (row: OutboundLine): void => {
    if (isRowLine(row) && row.type === 'compaction' && (row as Unstamped<CompactionRow>).state === 'ended') openFold = null
  }
  const statusRowOf = (status: unknown): RowDraft | null => {
    if (status === 'compacting') return foldRow(null)
    if (status === null) {
      if (openFold === null || openFold.landing) return null
      const row = compactionClearedRow(liveScope(), openFold.trigger)
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
  if (options.outputFormat === 'rows') {
    installWireStdoutGuard()
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
        await SandboxManager.initialize(asks.createSandboxAskCallback())
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
    outputFormat: wire ? 'text' : options.outputFormat,
    sessionStartHooksPromise: options.sessionStartHooksPromise,
  })
  const messages: Message[] = loaded.messages
  let contentReplacementState = {
    ...reconstructContentReplacementState(messages, loaded.contentReplacements ?? []),
    budgetChars: Infinity,
  }

  const isConcourseWorker = flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  let awaitingSessionClaim = isConcourseWorker && !options.continue && !options.resume && options.bootSessionIdPinned !== true
  const releaseQueueUntilClaimed: (() => void) | null = peer !== null && awaitingSessionClaim ? peer.holdScope('queue') : null
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
          canUseTool: asks.createCanUseTool(() => notifySessionStateChanged('requires_action')),
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
                ...(peer !== null ? { hostHoldsAsks: true } : {}),
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
  const sessionTools: Tool[] = [...tools, ...startingMcpTools]
  const canUseTool = asks.createCanUseTool(() => notifySessionStateChanged('requires_action'))
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
  const interruptOutcomes = new Map<string, boolean>()
  let inputClosed = false
  let inFlightAbort: AbortController | null = null
  let hostAsks: HostAskLiveness | null = null
  asks.setOnControlRequestSent(() => hostAsks?.noteParked())
  asks.setOnControlRequestResolved(() => hostAsks?.noteSettled())
  let deferredModelBreadcrumb: string | null = null
  let heldSeatModel: { requestId: number; model: string } | null = null
  let heldSeatEffort: { requestId: number; effort: string } | null = null
  let deferredSpawnSwitches: Array<{ kind: 'subagents' | 'workflows'; on: boolean; requestId: number }> = []
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
        const hostResult = await asks.handleElicitation(
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
        io.outbound.enqueue({ method: 'elicitation/complete', params: { server: serverName, elicitation_id: elicitationId } })
      },
    )
  }

  const baseToolNames = new Set(getAllBaseTools().map(tool => tool.name))
  const assembleTools = (state: AppState): Tool[] => {
    const mcpPartition = filterToolsByDenyRules(
      state.mcp.tools as Tool[],
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
  armLocalWarm(() => buildSideQuestionFallbackParams({ tools: assembleTools(getAppState()), commands: activeCommands, mcpClients: getAppState().mcp.clients, messages, readFileState: getReadFileCache(), getAppState, setAppState, customSystemPrompt: options.systemPrompt, appendSystemPrompt: options.appendSystemPrompt, thinkingConfig, agents: activeAgents }), { live: () => !awaitingSessionClaim && inFlightAbort === null })

  const SDK_MODES = new Set(['default', 'implement', 'sovereign', 'flow', 'dontAsk'])
  setPermissionModeChangedListener(mode => {
    if (!SDK_MODES.has(mode)) return
    enqueueRow(modeRow(liveScope(), mode))
  })

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
  const takeMainThread = (): QueuedCommand | undefined => dequeue(isMainThreadCommand)

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
      parkedWithHost: () => asks.pendingControlRequestCount(),
      parkedAsks: () => asks.parkedAsks(),
      settleParkedAsks: cause => (capabilities.holds_asks ? 0 : asks.denyPendingPermissionRequests(cause)),
    })
    const workload = command.workload ?? options.workload
    try {
      await runWithWorkload(workload, async () => {
        const state = getAppState()
        const turnClients: MCPServerConnection[] = [
          ...state.mcp.clients,
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
          ...(peer !== null ? { hostHoldsAsks: true } : {}),
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
          partialRows: options.includePartialMessages || capabilities.partial_rows,
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
            asks.handleElicitation(
              serverName,
              params.message,
              undefined,
              elicitSignal,
              params.mode,
              params.url,
              params.elicitationId,
            ),
          agents: activeAgents,
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
        io.outbound.enqueue({ method: 'session/applied', params: { request_id: held.requestId, verb: 'set_model', model: held.model } })
      }
      if (heldSeatEffort !== null) {
        const held = heldSeatEffort
        heldSeatEffort = null
        applySeatEffort(held.effort)
        io.outbound.enqueue({ method: 'session/applied', params: { request_id: held.requestId, verb: 'set_effort', effort: held.effort } })
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
          io.outbound.enqueue({ method: 'session/applied', params: { request_id: toggle.requestId, verb: 'set_spawn_switch', switch: toggle.kind, on: toggle.on } })
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
      return capabilityHoldWords(runnerCapabilityHolds(asks))
    },
    flush: () => flushSessionStorage(),
  })
  subscribeToCommandQueue(() => {
    if (getCommandQueue().length > 0) quiescence.invalidate()
  })

  let lastOutcome: OutcomeRow | null = null
  let lastOutcomeWritten: Promise<unknown> = Promise.resolve()
  const writeLine = (message: OutboundLine): Promise<Row | null> => {
    if (peer === null) return io.write(message)
    if (io.stdoutPipeBroken) return Promise.resolve(null)
    if (isRowLine(message)) {
      const row = io.rows.stamp(message as never)
      peer.notify('row', row as never)
      return peer.flush().then(() => row)
    }
    if (message.method === 'elicitation/complete') {
      if (capabilities.elicitation) peer.notify(message.method, message.params)
    } else peer.notify(message.method, message.params)
    return peer.flush().then(() => null)
  }
  const routeOutbound = (message: OutboundLine): void => {
    foldLanded(message)
    if (options.outputFormat === 'rows') {
      const written = writeLine(message)
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
    peek: () => peek(isMainThreadCommand),
    notifyLifecycle: notifyCommandLifecycle,
    enqueueOutput: message => io.outbound.enqueue(message),
    writeDirect: async message => {
      await writeLine(message)
    },
    drainRows: () => drainRows().map(row => ({ ...row, ...(currentTurn !== null ? { turn: currentTurn } : {}) }) as RowDraft),
    beforeCycle: () => bootReady,
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
        { session_id: getSessionId(), turn: currentTurn ?? Math.max(1, turnsRun) },
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


  const modelInfos = buildModelCatalogue()

  const resolveServerConfigFromAllSources = (
    serverName: string,
  ): ScopedMcpServerConfig | null => {
    const configured = getMcpConfigByName(serverName)
    if (configured) return configured
    const fromClients = getAppState().mcp.clients.find(client => client.name === serverName)
    return fromClients?.config ?? null
  }

  const applyReconnectedClient = async (serverName: string, client: MCPServerConnection): Promise<void> => {
    const [tools, commandsForServer, resources] = await Promise.all([
      fetchToolsForClient(client),
      fetchCommandsForClient(client),
      fetchResourcesForClient(client),
    ])
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
  }

  const SEAT_VERB_AT = (held: boolean): 'now' | 'turn_end' => (held ? 'turn_end' : 'now')
  const acceptInput = async (
    input:
      | { kind: 'prompt'; content: string | ContentBlockParam[]; id?: string; priority?: 'now' | 'next' | 'later'; sentAt?: string; origin?: unknown }
      | { kind: 'shell'; command: string; id?: string; priority?: 'now' | 'next' | 'later'; sentAt?: string; origin?: unknown }
      | { kind: 'note'; to: string; content: string; id?: string },
  ): Promise<{ accepted: true } | { accepted: false; reason: 'duplicate' }> => {
    sessionInitialized = true
    const missionSync = await import('../utils/hooks/missionHook.js')
    missionSync.syncMissionFromCard(setAppState, String(getSessionId()))
    const uuid = input.id
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
        return { accepted: false, reason: 'duplicate' }
      }
      receivedUuids.add(uuid)
    }
    if (input.kind === 'note') {
      enqueue({
        value: input.content,
        mode: 'task-notification',
        agentId: input.to as never,
        priority: 'next',
        ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
      })
      return { accepted: true }
    }
    const sentAt = typeof input.sentAt === 'string' && Number.isFinite(Date.parse(input.sentAt)) ? input.sentAt : new Date().toISOString()
    enqueue({
      value: input.kind === 'shell' ? input.command : input.content,
      mode: input.kind === 'shell' ? 'bash' : 'prompt',
      sentAt,
      ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...saturnQueueStamp(input.origin),
    })
    driver.kick()
    return { accepted: true }
  }
  const promptContentOf = (content: Extract<ParamsOf<'queue/add'>, { type: 'prompt' }>['content']): string | ContentBlockParam[] => {
    if (typeof content === 'string') return content
    return (content as Array<{ type: string; text?: string; media_type?: string; data?: string }>).map(block =>
      block.type === 'image'
        ? ({ type: 'image', source: { type: 'base64', media_type: block.media_type, data: block.data } } as unknown as ContentBlockParam)
        : ({ type: 'text', text: block.text ?? '' } as ContentBlockParam),
    )
  }

  const acceptInputRow = async (row: InputRow): Promise<{ accepted: true } | { accepted: false; reason: 'duplicate' }> => {
    const empty = emptyInputRow(row)
    if (empty !== null) throw invalidParams('queue/add', [{ path: [row.type === 'shell' ? 'command' : 'content'], message: empty }])
    if (row.type === 'note') return acceptInput({ kind: 'note', to: row.to, content: row.content, ...(row.id !== undefined ? { id: row.id } : {}) })
    const stamp = {
      ...(row.id !== undefined ? { id: row.id } : {}),
      ...(row.priority !== undefined ? { priority: row.priority } : {}),
      ...(row.sent_at !== undefined ? { sentAt: row.sent_at } : {}),
      ...(row.origin !== undefined ? { origin: row.origin } : {}),
    }
    if (row.type === 'shell') return acceptInput({ kind: 'shell', command: row.command, ...stamp })
    return acceptInput({ kind: 'prompt', content: promptContentOf(row.content), ...stamp })
  }

  const arms: RunnerArms = {
    'turn/interrupt': params => {
      if (params.op_id !== undefined && interruptOutcomes.has(params.op_id)) return { interrupted: interruptOutcomes.get(params.op_id)! }
      if (params.turn_id !== undefined && currentTurnId !== null && params.turn_id !== currentTurnId) return { interrupted: false }
      const interrupted = inFlightAbort !== null
      if (params.op_id !== undefined) {
        interruptOutcomes.set(params.op_id, interrupted)
        if (interruptOutcomes.size > INTERRUPT_DEDUPE_CAP) interruptOutcomes.delete(interruptOutcomes.keys().next().value!)
      }
      inFlightAbort?.abort()
      driver.releaseHold()
      if (params.hard === true) {
        for (const task of Object.values(getAppState().tasks)) {
          if (isLocalShellTask(task) && task.status === 'running') void killTask(task.id, setAppState)
        }
      }
      return { interrupted }
    },
    'queue/add': params => acceptInputRow(params),
    'queue/withdraw': params => {
      const popped = popById(params.id)
      return popped.popped ? { withdrawn: true, text: popped.text } : { withdrawn: false, reason: popped.reason }
    },
    'session/set_mode': params => {
      const resolved = resolvePermissionModeTransition(params.mode as WirePermissionMode, getAppState().toolPermissionContext)
      if (!resolved.ok) throw refused(resolved.error, 'mode')
      const nextContext = resolved.context
      setAppState(previous => ({ ...previous, toolPermissionContext: nextContext }))
      return { mode: params.mode }
    },
    'session/set_model': async (params, ref) => {
      const requested = params.model
      const resolved =
        requested === undefined || requested === 'default'
          ? (getDefaultMainLoopModelSetting() ?? getMainLoopModel())
          : parseUserSpecifiedModel(requested)
      if (inFlightAbort !== null) {
        heldSeatModel = { requestId: ref.id, model: String(resolved) }
        holdQueuedWordsForTurnEnd(true)
        return { model: String(resolved), at: SEAT_VERB_AT(true) }
      }
      await applySeatModel(String(resolved))
      return { model: String(resolved), at: SEAT_VERB_AT(false) }
    },
    'session/claim': async params => {
      if (!awaitingSessionClaim) throw refused('claim refused — this runner already carries a session identity', 'claim')
      const sid = String(params.session_id ?? '')
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
        throw refused(`claim refused — session_id must be a UUID (got ${JSON.stringify(sid)})`, 'claim')
      }
      const claimedMode = typeof params.mode === 'string' && params.mode !== '' ? params.mode : undefined
      const claimedEffort = typeof params.effort === 'string' && params.effort !== '' ? params.effort : undefined
      let claimedContext: AppState['toolPermissionContext'] | undefined
      if (claimedMode !== undefined) {
        const transition = resolvePermissionModeTransition(
          claimedMode as WirePermissionMode,
          getAppState().toolPermissionContext,
          'claim',
        )
        if (!transition.ok) throw refused(`claim refused — ${transition.error}`, 'claim')
        claimedContext = transition.context
      }
      if (claimedEffort !== undefined && !isEffortLevel(claimedEffort)) {
        throw refused(`claim refused — effort '${claimedEffort}' is not on the shared ladder`, 'claim')
      }
      dropCredentialMemos()
      if (params.openai_catalogue !== undefined) {
        primeOpenaiCatalogue(openaiCatalogueFromWire(params.openai_catalogue) as Parameters<typeof primeOpenaiCatalogue>[0])
      }
      const claimedHome = consumeSessionHomePin()
      clearSystemPromptSections()
      if (params.resume === true) {
        const pinnedFile = claimedHome !== null ? join(claimedHome, `${sid}.jsonl`) : undefined
        let resumed: Awaited<ReturnType<typeof loadConversationForResume>> = null
        try {
          resumed = await loadConversationForResume(sid, pinnedFile !== undefined && existsSync(pinnedFile) ? pinnedFile : undefined)
        } catch (error) {
          logError(error)
        }
        if (!resumed || resumed.messages.length === 0) {
          if (claimedHome !== null) setFlagEnv('MERCURY_SESSION_HOME', claimedHome)
          throw refused(`claim refused — no conversation found for session ${sid}`, 'claim')
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
      const claimedModel = typeof params.model === 'string' && params.model !== '' ? params.model : undefined
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
      if (typeof params.restart_reason === 'string') runnerRestartReason = params.restart_reason
      if (params.resume === true) await hydrateResumedRun()
      ;(await import('../utils/crew/crewBirth.js')).birthSessionCrew(sid, setAppState)
      awaitingSessionClaim = false
      releaseQueueUntilClaimed?.()
      logForDebugging(`[session-runner] claimed: session ${sid}${claimedModel !== undefined ? ` on ${claimedModel}` : ''}`)
      if (heldNoticeWaits()) driver.kick()
      return { session_id: sid }
    },
    'session/set_effort': (params, ref) => {
      const requestedEffort = String(params.effort ?? '')
      if (!isEffortLevel(requestedEffort)) throw refused(`effort refused ('${requestedEffort}' is not on the shared ladder)`, 'effort')
      if (inFlightAbort !== null) {
        heldSeatEffort = { requestId: ref.id, effort: requestedEffort }
        holdQueuedWordsForTurnEnd(true)
        return { effort: requestedEffort, at: SEAT_VERB_AT(true) }
      }
      applySeatEffort(requestedEffort)
      return { effort: requestedEffort, at: SEAT_VERB_AT(false) }
    },
    'session/facts': async () => {
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
        mcp: mcpRosterEntriesOf(state.mcp.clients, []),
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
      return sessionFactsToWire(answer) as Record<string, unknown>
    },
    'schedule/roster': params => {
      const rows = Array.isArray(params.schedules)
        ? (params.schedules as unknown[]).flatMap(raw => {
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
      return {}
    },
    'session/rewind': async params => {
      const outcome = await handleRewindSession(params, {
        messages,
        getAppState,
        drift: getReadFileCache(),
        turnActive: inFlightAbort !== null,
      })
      return rewindOutcomeToWire(outcome) as Record<string, unknown>
    },
    'session/set_spawn_switch': (params, ref) => {
      const toggle = { kind: params.switch, on: params.on }
      if (inFlightAbort !== null) {
        deferredSpawnSwitches = [...deferredSpawnSwitches.filter(d => d.kind !== toggle.kind), { ...toggle, requestId: ref.id }]
        holdQueuedWordsForTurnEnd(true)
        return { switch: toggle.kind, on: toggle.on, at: SEAT_VERB_AT(true) }
      }
      landSpawnSwitch(toggle.kind, toggle.on)
      return { switch: toggle.kind, on: toggle.on, at: SEAT_VERB_AT(false) }
    },
    'credentials/changed': () => {
      readGlobalConfigAgain()
      resetLimitsForCredentialSwitch()
      dropCredentialMemos()
      readOpenaiAccountAgain()
      noteCrewAccountChange()
    },
    'session/set_kit': params =>
      serializeMcpChange(async () => {
        const verdict = validateSessionKit(sessionKitFromWire(params.kit))
        if (!verdict.ok) throw refused(`kit refused — ${verdict.reason}`, 'kit')
        const before = sessionKitOf()
        const set = setProcessSessionKit(verdict.kit)
        if (!set.ok) throw refused(`kit refused — ${set.reason}`, 'kit')
        const rows = getAppState().mcp.clients
        const delta = kitEditMcpDelta(
          before,
          set.kit,
          kitDialCandidates(before, set.kit, rows.map(row => row.name)),
        )
        const connected: string[] = []
        const disconnected: string[] = []
        const errors: Record<string, string> = Object.create(null) as Record<string, string>
        for (const name of delta.disconnect) {
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
              mcpNames: getAppState().mcp.clients.map(row => row.name),
              commands: activeCommands,
              extensions: getActiveSet().active.map(ext => ext.manifest.name),
            }),
          )
        }
        return { applied: true as const, connected, disconnected, errors }
      }),
    'session/pause_gate': params => {
      const changed = params.paused ? operatorPauseGate.pause() : operatorPauseGate.resume()
      return { paused: operatorPauseGate.paused(), parked: operatorPauseGate.parked().length, changed }
    },
    'shell/background': () => {
      const taken = requestShellBackground()
      if (taken > 0) return { taken }
      throw refused('no shell command is running in the main conversation', 'no-shell')
    },
    'agent/stop': async params => {
      try {
        const receipt = await stopAgentByOperator(params.agent_id, { getAppState, setAppState }, params.note === AGENT_INTERRUPT_BY_OPERATOR ? { reason: AGENT_INTERRUPT_BY_OPERATOR } : {})
        if (receipt.outcome !== 'applied') throw refused(receipt.reason, 'agent')
        return { receipt: 'applied', kind: receipt.kind, status: receipt.status }
      } finally {
        for (const row of drainRows()) enqueueRow(row)
      }
    },
    'session/quiesce': async params => {
      const answer = await quiescence.request({ subtype: 'quiesce', action: params.action, token: params.token })
      if (!answer.ok) throw refused(answer.reason, 'quiesce')
      if (answer.phase === 'committed') {
        inputClosed = true
        setTimeout(() => gracefulShutdownSync(0, 'other'), 50)
      }
      return { token: answer.token, phase: answer.phase }
    },
    'agent/resume': async params => {
      const lastParams = getLastCacheSafeParams()
      if (lastParams === null) throw refused('nothing to resume from yet — the session has not run a turn', 'nothing-to-resume')
      const target = getAppState().tasks[params.agent_id]
      if (target !== undefined && target.status === 'running') {
        const note = params.note !== undefined ? params.note.trim() : ''
        if (note === '' || !isLocalAgentTask(target)) throw refused('the agent is running — nothing to resume', 'agent')
        queueOperatorMessage(params.agent_id, note, setAppState)
        return { queued: true, agent_id: params.agent_id }
      }
      const { readAgentMetadata } = await import('../utils/sessionStorage.js')
      if (isInProcessCrewmateTask(target) || (await readAgentMetadata(asAgentId(params.agent_id)))?.crewmate !== undefined) {
        const { respawnCrewmateByOperator } = await import('../services/agents/operatorResume.js')
        try {
          const respawned = await respawnCrewmateByOperator(params.agent_id, { getAppState, toolUseContext: lastParams.toolUseContext, prompt: params.note })
          if (respawned.outcome !== 'applied') throw refused(respawned.reason, 'agent')
          return { agent_id: respawned.agentId, task_id: respawned.taskId, output_file: respawned.outputFile }
        } finally {
          for (const row of drainRows()) enqueueRow(row)
        }
      }
      const { resumeAgentBackground } = await import('../tools/AgentTool/resumeAgent.js')
      const { toolUseId: _staleToolUseId, ...lastContext } = lastParams.toolUseContext
      void _staleToolUseId
      const resumed = await resumeAgentBackground({
        agentId: params.agent_id,
        prompt: params.note !== undefined && params.note.trim() !== '' ? params.note : AGENT_RESUME_NOTE,
        replyTarget: params.note?.trim() ? 'operator' : 'parent',
        toolUseContext: { ...lastContext, abortController: new AbortController() } as typeof lastParams.toolUseContext,
        canUseTool,
      })
      const { operatorResumeWords } = await import('../services/agents/operatorResume.js')
      if (!params.note?.trim()) enqueueAgentReceiptRow({ taskId: resumed.agentId, description: resumed.description, summary: operatorResumeWords(resumed.description) + (resumed.note ?? '') })
      return {
        agent_id: resumed.agentId,
        output_file: resumed.outputFile,
        ...(resumed.cwdFallback !== undefined ? { cwd_fallback: resumed.cwdFallback } : {}),
        ...(resumed.recordedCwd !== undefined ? { recorded_cwd: resumed.recordedCwd } : {}),
        ...(resumed.note ? { note: resumed.note } : {}),
      }
    },
  }

  async function* claimGatedInput(
    source: AsyncGenerator<InputRow, void, unknown>,
  ): AsyncGenerator<InputRow, void, unknown> {
    const parked: InputRow[] = []
    for await (const row of source) {
      if (awaitingSessionClaim) {
        logForDebugging('[session-runner] an input row arrived before the claim — parked until the session identity lands')
        parked.push(row)
        continue
      }
      yield row
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
      bootSettled()
      if (peer !== null) {
        await peer.done
        return
      }
      for await (const row of claimGatedInput(io.structuredInput)) {
        await acceptInputRow(row)
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
  } else if (options.outputFormat !== 'rows') {
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
