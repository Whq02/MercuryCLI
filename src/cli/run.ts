import { requestShellBackground } from '../tools/BashTool/backgroundRequest.js'
import { randomUUID, type UUID } from 'node:crypto'
import { keepTurnLiveWhileHostAnswers, type HostAskLiveness } from './headless/hostAskLiveness.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import { readFile, stat } from 'node:fs/promises'
import { liveSkillRootsOf, pruneSkillSessionHooks } from '../utils/hooks/sessionHooks.js'
import {
  getEngineModelOverride,
  getSessionId,
  setEngineModelOverride,
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
  setRunInputClosed,
  setSessionKind,
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
import { watchLiveMcpConfig } from '../services/mcp/liveConfig.js'
import { dynamicMcpConfigSnapshot, isStrictMcpConfigSeed } from '../services/mcp/dynamicMcpSeed.js'
import { modelRefusalBeforeAnyRequest } from '../services/providers/callModelRouter.js'
import { createRosterTransitionMessage } from '../utils/messages/systemMessages.js'
import { isToolResultMessage } from '../utils/messages/merge.js'
import { isLocalCommandCaveat } from '../utils/messages/apiPlan.js'
import { dropCredentialMemos, is1PApiCustomer } from '../utils/auth.js'
import { noteCrewAccountChange } from '../utils/crew/crewAccountChange.js'
import { hasClaudeAiBillingAccess, hasConsoleBillingAccess } from '../utils/billing.js'
import { anthropicSignInEmail } from '../services/providers/providerUsage.js'
import { getCurrentProjectConfig, readGlobalConfigAgain } from '../utils/config.js'
import { mcpRosterEntriesOf, skillsRosterOf } from '../services/engine-connector/rosterTerms.js'
import type { SessionFactsAnswerV1 } from '../services/engine-connector/seatProjections.js'
import { effortSentOf } from '../services/engine-connector/seatProjections.js'
import { sessionModelSpendRows } from '../services/engine-connector/modelSpendFacts.js'
import {
  openaiCatalogueFromWire,
  rewindOutcomeToWire,
  sessionFactsToWire,
  scheduleEditToWire,
  sessionKitFromWire,
} from '../services/engine-connector/seatWire.js'
import { openaiObservedUsage } from '../services/providers/openai/openaiLimitState.js'
import { openaiWindowFact } from '../services/providers/openai/openaiWindowFact.js'
import { laneWindowFact } from '../services/providers/laneWindowFact.js'
import { jevLedgerSnapshot } from '../services/jev/jevLedger.js'
import { jevFactsOf } from '../services/jev/jevSessionFacts.js'
import { jevStatus } from '../services/jev/jevStatus.js'
import { ask, sessionFactsOf } from '../rows/turn.js'
import { closeRow, commandOutputRow, compactionClearedRow, compactionRow, heartbeatRow, missionUpdatedRow, modeRow, noticeRow, outcomeRow, rateLimitRow, samplesUpdatedRow, sessionRow, taskRow, turnStartedRow, turnWaitingRow, waitRow, type RowDraft, type RowScope, type Unstamped } from '../rows/project.js'
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
import { anthropicObservedUsage, anthropicWindowFact, resetLimitsForCredentialSwitch, statusListeners, type AnthropicLimits } from '../services/anthropicLimits.js'
import { sessionLaneWall } from '../tools/MonitorTool/laneWall.js'
import { providerLimitWarning } from '../services/providers/limitWarning.js'
import {
  clearServerCache,
  connectToServer,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  reconnectMcpServerImpl,
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
  registerScheduleEditDoor,
  takePendingScheduleEdits,
} from '../services/saturn/sessionScheduleBridge.js'
import { registerIdeToolDoor } from '../services/acp/ideToolBridge.js'
import { saturnQueueStamp } from '../utils/messages/noticeRows.js'
import { advisorFacts, advisorMainRound, advisorMainTurnSettled, createAdvisorQuietMessage, type AdvisorQuiet, type AdvisorRoad } from '../services/advisor/index.js'
import { localWakeStep, type LocalWakeFacts } from '../tools/ScheduleWakeupTool/localWake.js'
import { offSkillNamesOf } from '../skills/kitGovernance.js'
import { disabledMcpServerNamesIn } from '../services/mcp/disabledRecord.js'
import {
  getMcpConfigByName,
  getMercuryMcpConfigs,
  filterMcpServersByPolicy,
} from '../services/mcp/config.js'
import { performMCPOAuthFlow } from '../services/mcp/auth.js'
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
import { GLYPH } from '../components/mercury-ui/glyphs.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import { gracefulShutdown, gracefulShutdownSync, isShuttingDown, markRunModeSignalsOwned } from '../utils/gracefulShutdown.js'
import { exitNoteCharsKept, leaveNoteBeforeExit } from '../mneme/exitHandoff.js'
import { HANDOFF_ASK_BUDGET_MS } from '../mneme/handoffAsk.js'
import { closeLineageSession, lineageKept } from '../mneme/lineageSession.js'
import { saveCurrentSessionCosts } from '../cost-tracker.js'
import {
  headlessProfilerCheckpoint,
  headlessProfilerStartTurn,
  logHeadlessProfilerTurn,
} from '../utils/headlessProfiler.js'
import { subscribeHookExecutionEvents } from '../utils/hooks/hookEvents.js'
import { hookTaskRow } from '../utils/hooks/rows.js'
import { takeFirstPrompt, type runSessionStartHooks } from '../utils/sessionStart.js'
import { createIdleTimeoutManager } from '../utils/idleTimeout.js'
import { armInactivityDeadline, DeadlineExceededError, minutesKnobToMs } from '../utils/deadline.js'
import { flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'
import { AGENT_MESSAGE_STATUS } from '../constants/agentMessage.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'

const DEFAULT_HEADLESS_IDLE_MINUTES = 20
const SIGNAL_SETTLE_MS = 5_000
import { getInMemoryErrors, logError, withoutStackFrames } from '../utils/log.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { editOutcomeRows } from '../services/changeTransaction/editOutcomeLedger.js'
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
import { isHeldNotice, isOperatorLine, queuedWordsWaitForTurnEnd, subscribeQueueConsumption } from '../input-core/command-queue.js'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { agentRecipientState, MAIN_THREAD_AGENT, noticeDeadlineMs, nudgeWords, startIdleNudge } from '../services/notices/idleNudge.js'
import { noticeRows, type NoticeRecord } from '../services/notices/unreadLedger.js'
import { isLocalShellTask } from '../tasks/LocalShellTask/guards.js'
import { killTask } from '../tasks/LocalShellTask/killShellTasks.js'
import {
  getDefaultEngineModelSetting,
  getEngineModel,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import {
  getModelOptions,
} from '../utils/model/modelOptions.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsEffort,
} from '../utils/model/capabilities.js'
import { isEffortLevel, resolveEffortTruth } from '../utils/effort.js'
import { registerProcessOutputErrorHandlers } from '../utils/process.js'
import { noteRunPhase, runPhaseReport } from '../utils/runPhases.js'
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
  saveSessionModel,
} from '../utils/sessionStorage.js'
import { restoreAgentFromSession, restoreConversationModel, restoreSessionStateFromLog } from '../utils/sessionRestore.js'
import {
  notifySessionStateChanged,
  setPermissionModeChangedListener,
  type RequiresActionDetails,
} from '../utils/sessionState.js'
import { generateSessionTitle } from '../utils/sessionTitle.js'
import { getSettingsWithSources } from '../utils/settings/settings.js'
import { currentSettingsFaults, untoldSettingsFaults } from '../utils/settings/faultNotices.js'
import { currentHiddenCharacterLines, untoldHiddenCharacterLines } from '../utils/text/hiddenCharacterFindings.js'
import { hooksSkippedForTrustLine } from '../utils/hooks/hooksConfigSnapshot.js'
import { settingsFaultLine } from '../utils/settings/validation.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { applySettingsChange } from '../utils/settings/applySettingsChange.js'
import { getSettingsSnapshot, settingsRevision } from '../utils/settings/snapshot.js'
import { skillChangeDetector } from '../utils/skills/skillChangeDetector.js'
import { armRunnerAgentFreshness } from './agentFreshness.js'
import { installWireStdoutGuard } from '../utils/wireStdoutGuard.js'
import { getRunningTasks, POLL_INTERVAL_MS } from '../utils/task/framework.js'
import { AGENT_INTERRUPT_BY_OPERATOR, AGENT_RESUME_NOTE, enqueueAgentReceiptRow, handOverForegroundAgentsToQueuedMessage, isLocalAgentTask, queueOperatorMessage } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { stopAgentByOperator } from '../services/agents/operatorStop.js'
import { openaiCatalogueFact, primeOpenaiCatalogue, readOpenaiAccountAgain } from '../services/providers/openai/openaiCatalogue.js'
import { markSessionBootRules, markSessionNonInteractive, markSessionPermissionMode } from '../utils/cockpit/runtimePosture.js'
import { consumeSessionKindPin } from '../utils/sessionKind.js'
import { runningBuildTree } from '../utils/artifactIdentity.js'
import { deployedRuntime } from '../daemon/handover.js'
import { getProjectDir } from '../utils/sessionStorage/paths.js'
import { appendSessionReceipt, readSessionReceipts } from '../services/switchboard/sessionReceipts.js'
import { wrapInSystemReminder } from '../utils/messages/text.js'
import { createAttachmentMessage } from '../utils/attachments/orchestrator.js'
import { composeNewerBuildInstalledLine } from '../tools/MonitorTool/watchReceipts.js'
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
import { filterToolsByDenyRules, getAllBaseTools, getTools, toolsWithheldByDeny } from '../tools.js'
import { ruleSourceWords, ruleSpelling, withheldByRuleWords } from '../utils/permissions/ruleReason.js'
import { MCP_SERVER_FAILED_CODE, TOOL_WITHHELD_CODE } from '../rows/vocabulary.js'
import { mcpServerFailedWords, mcpServersFailed } from '../services/mcp/utils.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { expandPath } from '../utils/path.js'
import { getCwd } from '../utils/cwd.js'
import { providerFamilyOfSetting } from '../utils/model/modelTransition.js'
import { streamIdleTimeoutMsForRoute } from '../services/providers/streamIdleBudget.js'
import { runWithWorkload } from '../utils/workloadContext.js'
import { fitCompletionCommands } from '../services/agentResults/summaryRoom.js'
import { foldNotificationValues } from './headless/turnDriver.js'

export { joinPromptValues, canBatchWith }
export { removeInterruptedMessage }

const MAILBOX_REFUSAL_NOTICE_AFTER = 20
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
  maxTimeMs?: number
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
  bootSessionIdPinned?: boolean
  door?: 'rows' | 'wire'
  subscribeAppState?: (listener: () => void) => () => void
  sessionStartHooksPromise?: ReturnType<typeof runSessionStartHooks>
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


function priorTurnCount(messages: readonly Message[]): number {
  return messages.filter(message => message.type === 'user' && (message as { isMeta?: boolean }).isMeta !== true && !isToolResultMessage(message) && !isLocalCommandCaveat(message)).length
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
  const maxTime = options.maxTimeMs === undefined ? undefined : { limitMs: options.maxTimeMs, at: Date.now() + options.maxTimeMs }
  setAskChannel(options.door === 'wire' ? 'sdk' : 'none')
  const kindPin = consumeSessionKindPin()
  if (kindPin.kind === undefined && kindPin.raw !== undefined && kindPin.raw.trim() !== '') {
    process.stderr.write(`${GLYPH.warn} MERCURY_SESSION_KIND=${kindPin.raw} is not a session kind (the two are oculus and headless) — this run is headless\n`)
  }
  if (kindPin.kind === 'oculus' && options.door !== 'wire') {
    process.stderr.write(`${GLYPH.warn} MERCURY_SESSION_KIND=oculus names a screen, but this run has no host to carry its asks there — this run is headless\n`)
  }
  setSessionKind(kindPin.kind === 'oculus' && options.door === 'wire' ? 'oculus' : 'headless')
  markSessionNonInteractive(getAppState().toolPermissionContext?.mode)
  markSessionBootRules(getAppState().toolPermissionContext)
  const shellRoadNotice = windowsShellRoadNotice()
  if (shellRoadNotice !== null) process.stderr.write(`${shellRoadNotice}\n`)
  for (const fault of options.door === 'wire' ? currentSettingsFaults() : untoldSettingsFaults()) {
    process.stderr.write(`${GLYPH.warn} ${settingsFaultLine(fault)}\n`)
  }
  for (const line of options.door === 'wire' ? currentHiddenCharacterLines() : untoldHiddenCharacterLines()) {
    process.stderr.write(`${GLYPH.warn} ${line}\n`)
  }
  const skippedHooks = hooksSkippedForTrustLine()
  if (skippedHooks !== null && options.door !== 'wire') process.stderr.write(`${GLYPH.warn} ${skippedHooks}\n`)
  if (options.door !== 'wire') {
    for (const withheld of toolsWithheldByDeny(getAllBaseTools(), getAppState().toolPermissionContext)) {
      process.stderr.write(`${GLYPH.warn} ${withheldByRuleWords(withheld.tool, withheld.rule)}\n`)
    }
  }
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
  noteRunPhase('graph_load', getPerformance().getEntriesByName('cli_entry')[0]?.startTime)
  noteRunPhase('cli_parse')

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
  if (options.userSpecifiedModel !== undefined) {
    const refusal = await modelRefusalBeforeAnyRequest(parseUserSpecifiedModel(options.userSpecifiedModel))
    if (refusal !== null) {
      process.stderr.write(`${refusal}\n`)
      gracefulShutdownSync(1)
      return
    }
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
    registerScheduleEditDoor((edit, signal) => peer.request('schedule/edit', { edit: scheduleEditToWire(edit) }, { signal }))
    registerIdeToolDoor({
      capabilities: () => ({
        readTextFile: capabilities.fs_read_text_file === true,
        writeTextFile: capabilities.fs_write_text_file === true,
        terminal: capabilities.terminal === true,
      }),
      readTextFile: (params, signal) => peer.request('fs/read_text_file', params, signal ? { signal } : {}),
      writeTextFile: (params, signal) => peer.request('fs/write_text_file', params, signal ? { signal } : {}),
      terminalCreate: (params, signal) => peer.request('terminal/create', params, signal ? { signal } : {}),
      terminalOutput: (params, signal) => peer.request('terminal/output', params, signal ? { signal } : {}),
      terminalWaitForExit: (params, signal) => peer.request('terminal/wait_for_exit', params, { deadlineMs: null, ...(signal ? { signal } : {}) }),
      terminalKill: (params, signal) => peer.request('terminal/kill', params, signal ? { signal } : {}),
      terminalRelease: (params, signal) => peer.request('terminal/release', params, signal ? { signal } : {}),
    })
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
  let resumeOf: string | undefined
  const failedMcpTold = new Set<string>()
  const tellFailedMcpServers = (): void => {
    for (const server of mcpServersFailed(getAppState().mcp.clients)) {
      if (failedMcpTold.has(server.name)) continue
      failedMcpTold.add(server.name)
      const words = mcpServerFailedWords(server.name, server.reason)
      enqueueRow(noticeRow(liveScope(), 'warning', words, MCP_SERVER_FAILED_CODE))
      if (options.door !== 'wire') process.stderr.write(`${GLYPH.warn} ${words}\n`)
    }
  }
  const liveScope = (): RowScope => ({ session_id: getSessionId(), ...(currentTurn !== null ? { turn: currentTurn } : {}) })
  const enqueueRow = (row: RowDraft): void => io.outbound.enqueue(row)
  const hookRowsActive = peer !== null || options.outputFormat === 'rows'
  const releaseHookRows = hookRowsActive
    ? subscribeHookExecutionEvents(event => {
        if (currentTurn === null) enqueueRow(hookTaskRow(liveScope(), event))
      })
    : undefined
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
  noteRunPhase('invocation_resolution')

  const loaded = await loadInitialMessages(setAppState, {
    continue: options.continue,
    resume: typeof options.resume === 'string' ? options.resume : options.resume,
    resumeSessionAt: options.resumeSessionAt,
    forkSession: options.forkSession,
    outputFormat: wire ? 'text' : options.outputFormat,
    sessionStartHooksPromise: options.sessionStartHooksPromise,
  })
  const messages: Message[] = loaded.messages
  resumeOf = loaded.resumedSessionId
  turnsRun = priorTurnCount(messages)
  let contentReplacementState = reconstructContentReplacementState(messages, loaded.contentReplacements ?? [])

  const isConcourseWorker = flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  let awaitingSessionClaim = isConcourseWorker && !options.continue && !options.resume && options.bootSessionIdPinned !== true
  const releaseQueueUntilClaimed: (() => void) | null = peer !== null && awaitingSessionClaim ? peer.holdScope('queue') : null
  let sessionFactsHoldSpent = false
  let sessionFactsHold: Promise<void> | null = null
  let runnerRestartReason: string | undefined = flagEnv('MERCURY_RUNNER_RESTART_REASON')
  let recoveredCommandIds: string[] = []
  if (isConcourseWorker) void refreshBoxReading()
  const sessionWiringModules = (): Promise<
    [
      typeof import('../guards/wardsGuard.js'),
      typeof import('../services/crew/identity.js'),
    ]
  > =>
    Promise.all([
      import('../guards/wardsGuard.js'),
      import('../services/crew/identity.js'),
    ])
  const armSessionRunnerWiring = async (sid: string): Promise<void> => {
    const [wards, crew] = await sessionWiringModules()
    wards.registerWardsGuard(setAppState, sid)
    const mission = await import('../guards/mission.js')
    mission.rearmMissionFromCard({ cardSessionId: sid, armSessionId: sid })
    void crew.bootCrewIdentity({ sessionId: sid, worktreeRef: getCwd() }).catch(e => {
      logForDebugging(`[session-runner] crew identity boot failed (non-blocking): ${e}`)
    })
  }
  if (isConcourseWorker && !awaitingSessionClaim) {
    await armSessionRunnerWiring(String(getSessionId()))
  } else if (awaitingSessionClaim) {
    void sessionWiringModules().catch(() => {})
  }


  const hookFirstPrompt = takeFirstPrompt()
  if (hookFirstPrompt) {
    io.prependUserMessage(hookFirstPrompt)
  }

  if ((options.continue || options.resume) && !getEngineModelOverride()) {
    const recorded = restoreConversationModel({ messages, model: loaded.model })
    if (recorded && !options.userSpecifiedModel) {
      const refusal = await modelRefusalBeforeAnyRequest(recorded)
      if (refusal === null) {
        setEngineModelOverride(recorded)
      } else {
        enqueueRow(noticeRow(liveScope(), 'warning', `The resumed session's model '${recorded}' is not usable (${refusal}) — this run uses ${getEngineModel()} instead.`))
      }
    }
  }

  const hydrateResumedRun = async (): Promise<void> => {
    if (messages.length === 0 && runnerRestartReason !== 'update') return
    if (messages.length > 0) {
      try {
        const { runBootRecovery } = await import('../substrate/recoveryOrchestrator.js')
        await runBootRecovery({
          scope: 'session',
          sessionId: getSessionId(),
          projectDir: getCwd(),
        })
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
        if (carriedReason === 'crash' || carriedReason === 'stop' || carriedReason === 'update') {
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
    }
    try {
      const {
        reconcileWatchesOnResume,
        reconcileBackgroundShellsOnResume,
        composeUpdateRestartLine,
      } = await import('../tools/MonitorTool/watchReceipts.js')
      const { coerceRestartReason } = await import('../tasks/LocalAgentTask/launchReceipts.js')
      const { enqueuePendingNotification } = await import('../utils/messageQueueManager.js')
      const reason = coerceRestartReason(runnerRestartReason)
      const liveIds = new Set(Object.keys(getAppState().tasks ?? {}))
      const deadWatches = messages.length > 0 ? reconcileWatchesOnResume(messages, liveIds, reason) : []
      const deadShells = messages.length > 0 ? reconcileBackgroundShellsOnResume(messages, liveIds, reason) : []
      if (deadWatches.length > 0) {
        logForDebugging(`[session-runner] resume: ${deadWatches.length} watch(es) without a live process — dead-watch notices written`)
      }
      if (reason === 'update') {
        const build = runningBuildTree() ?? `v${MACRO.VERSION}`
        const updateLine = composeUpdateRestartLine({ build, watches: deadWatches, shells: deadShells })
        try {
          const home = flagEnv('MERCURY_SESSION_HOME') || getProjectDir(getOriginalCwd())
          const sid = String(getSessionId())
          const existing = readSessionReceipts(home, sid)
          if (!existing.some(r => r.kind === 'runner-restart' && r.summary === updateLine)) {
            appendSessionReceipt(home, sid, {
              at: new Date().toISOString(),
              by: 'daemon',
              kind: 'runner-restart',
              summary: updateLine,
              details: {
                reason: 'update',
                build,
                watches: deadWatches.map(w => ({ taskId: w.taskId, description: w.description, command: w.command, persistent: w.persistent })),
                shells: deadShells.map(s => ({ taskId: s.taskId, description: s.description, command: s.command })),
              },
            })
          }
        } catch {}
        enqueuePendingNotification({
          value: wrapInSystemReminder(updateLine),
          mode: 'task-notification',
          priority: 'next',
          ridesNextWords: true,
        })
        enqueueRow(noticeRow(liveScope(), 'warning', updateLine))
      }
    } catch (error) {
      logError(error)
    }
  }
  if (options.continue || options.resume) await hydrateResumedRun()
  else if (runnerRestartReason === 'update') await hydrateResumedRun()

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
  noteRunPhase('config_auth')

  let sessionInitialized = false
  let activeModel: string | undefined =
    options.userSpecifiedModel === undefined
      ? undefined
      : parseUserSpecifiedModel(options.userSpecifiedModel)
  saveSessionModel(activeModel ?? getEngineModel())
  let thinkingConfig: ThinkingConfig | undefined = options.thinkingConfig
  let initializeJsonSchema: Record<string, unknown> | undefined
  let activeCommands = commands
  let activeAgents: AgentDefinition[] = agents
  const receivedUuids = new BoundedUuidSet(RECEIVED_UUID_CAP)
  const interruptOutcomes = new Map<string, boolean>()
  let inputClosed = false
  let inFlightAbort: AbortController | null = null
  let leaveAbort: AbortController | null = null
  let hostAsks: HostAskLiveness | null = null
  asks.setOnControlRequestSent(() => hostAsks?.noteParked())
  asks.setOnControlRequestResolved(() => hostAsks?.noteSettled())
  let deferredModelBreadcrumb: { to: string; from: string } | null = null
  let heldSeatModel: { requestId: number; model: string; words?: string } | null = null
  let heldSeatEffort: { requestId: number; effort: string } | null = null
  let deferredSpawnSwitches: Array<{ kind: 'subagents' | 'workflows'; on: boolean; requestId: number }> = []
  let deferredAdvisorQuiet: AdvisorQuiet[] = []
  const landAdvisorQuiet = (quiet: AdvisorQuiet): void => {
    const row = createAdvisorQuietMessage(quiet)
    messages.push(row)
    void recordTranscript([row], undefined, messages).catch((error: unknown) => {
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
    declareLawfulPrefixChangeForEveryOwner(`you turned ${SPAWN_SWITCH_LABEL[kind]} ${on ? 'on' : 'off'}`)
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

  const rateLimitListener = (limits: AnthropicLimits): void => {
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
        return asks.handleElicitation(
          serverName,
          params.message,
          requestedSchema,
          ctx.mcpReq.signal,
          mode,
          url,
          elicitationId,
        )
      }),
    )
    client.client.setNotificationHandler(
      'notifications/elicitation/complete',
      async notification => {
        const elicitationId = notification.params.elicitationId
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

  const savedDefaultModel = (): string | null => {
    const stored = getSettingsWithSources().sources.find(source => source.source === 'userSettings')?.settings.engine?.model
    return stored === undefined || stored === '' ? null : parseUserSpecifiedModel(stored)
  }
  const injectModelSwitchBreadcrumbs = async (toModel: string, fromModel: string, words?: string): Promise<void> => {
    const { createModelSwitchBreadcrumbs, switchClockWords } = await import('../utils/messages/factories.js')
    const displayOf = (model: string): string => modelInfos.find(info => info.value === model)?.display_name ?? model
    const breadcrumbs = createModelSwitchBreadcrumbs(words ?? toModel, displayOf(toModel), {
      previousModel: fromModel,
      previousDisplay: displayOf(fromModel),
      savedAsDefault: savedDefaultModel() === toModel,
      model: toModel,
      ...(words === undefined ? {} : { words }),
      at: switchClockWords(new Date()),
    })
    for (const breadcrumb of breadcrumbs) {
      messages.push(breadcrumb)
      const content = breadcrumb.message.content
      if (typeof content === 'string' && content.includes('local-command-stdout')) {
        enqueueRow(commandOutputRow(liveScope(), content, '/model'))
      }
    }
    await recordTranscript(breadcrumbs, undefined, messages).catch((error: unknown) => {
      logForDebugging(`model switch: the /model rows were not recorded — ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const tellSeatEngineSwitch = async (toModel: string): Promise<void> => {
    const { createEngineSwitchNotice } = await import('../utils/messages/factories.js')
    const { ledgerClock } = await import('../mneme/ledger.js')
    const display = modelInfos.find(info => info.value === toModel)?.display_name ?? toModel
    const notice = createEngineSwitchNotice(toModel, display, ledgerClock())
    messages.push(notice)
    await recordTranscript([notice], undefined, messages).catch((error: unknown) => {
      logForDebugging(`model switch: the engine notice was not recorded — ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const applySeatModel = async (model: string, words?: string): Promise<void> => {
    const previous = activeModel ?? getEngineModel()
    activeModel = model
    setEngineModelOverride(model)
    setFlagEnv('MERCURY_MODEL', model)
    saveSessionModel(model)
    notifySessionStateChanged('idle')
    if (model !== previous) {
      await injectModelSwitchBreadcrumbs(model, previous, words)
      if (getSettingsWithSources().effective.memory?.tellEngineSwitch === true) await tellSeatEngineSwitch(model)
    }
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
    const delivery = command.mode === 'task-notification' ? fitCompletionCommands(batch.length > 0 ? batch : [command], { messages, model: activeModel ?? getEngineModel() }) : []
    const promptValue = delivery.length > 1 ? foldNotificationValues(delivery.map(member => member.value)) : delivery[0]?.value ?? command.value
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
          const withheld = toolsWithheldByDeny([...getAllBaseTools(), ...state.mcp.tools], state.toolPermissionContext)
          const facts = await sessionFactsOf(
            { cwd: getCwd(), tools: assembledTools, mcpClients: turnClients, commands: dedupedCommands, agents: activeAgents },
            activeModel ?? getEngineModel(),
            state.toolPermissionContext.mode,
            resumeOf,
            withheld.map(({ tool, rule }) => ({ tool, rule: ruleSpelling(rule.ruleValue), source: ruleSourceWords(rule.source) })),
          )
          enqueueRow(sessionRow({ session_id: getSessionId() }, facts))
          for (const entry of withheld) enqueueRow(noticeRow(liveScope(), 'warning', withheldByRuleWords(entry.tool, entry.rule), TOOL_WITHHELD_CODE))
        }
        tellFailedMcpServers()
        for await (const message of ask({
          commands: dedupedCommands,
          prompt: promptValue,
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
          maxTime,
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
        tellFailedMcpServers()
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
        await applySeatModel(held.model, held.words)
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
        const crumb = deferredModelBreadcrumb
        deferredModelBreadcrumb = null
        await injectModelSwitchBreadcrumbs(crumb.to, crumb.from)
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

  const stopShellsForClose = async (): Promise<void> => {
    const shells = getRunningTasks(getAppState()).filter(task => isLocalShellTask(task))
    if (shells.length === 0) return
    logForDebugging(`[session-runner] the input closed with ${shells.length} shell task(s) running: every watch and background shell ends with its seat`)
    await Promise.all(shells.map(task => killTask(task.id, setAppState).catch(() => undefined)))
  }

  const settleIdle = async (): Promise<'reenter' | 'close' | 'stay'> => {
    if (inputClosed) {
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
      const busy = getRunningTasks(getAppState())
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
      void written.catch(error => logError(error))
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
      return turnStartedRow({ session_id: getSessionId(), turn: currentTurn ?? turnsRun }, { turnId: currentTurnId, messageIds, model: activeModel ?? getEngineModel() })
    },
    executeTurn: (command, batch, onMessage, initialNotices) =>
      executeTurn(command, batch, message => {
        onMessage(message)
      }, initialNotices),
    onTurnSettled: command => {
      logHeadlessProfilerTurn()
      headlessProfilerStartTurn()
      void advisorMainTurnSettled(String(getSessionId()), command, messages, advisorRoad)
    },
    hasWaitableBackgroundTasks: () =>
      getRunningTasks(getAppState()).some(task => !(inputClosed && isLocalShellTask(task))),
    hasHoldableBackgroundAgents: () =>
      getRunningTasks(getAppState()).some(
        task => task.type === 'local_agent' || task.type === 'local_workflow',
      ),
    waitableBackgroundTaskCount: () =>
      getRunningTasks(getAppState()).filter(task => !(inputClosed && isLocalShellTask(task))).length,
    onAgentWait: (count, turnId) => {
      enqueueRow(turnWaitingRow({ session_id: getSessionId(), turn: turnsRun }, { turnId, agents: count }))
    },
    settleIdle,
    wakeSettle: () => {},
    beforeCloseOutput: async () => {
      const { exitNoteDue } = await import('../mneme/exitHandoff.js')
      const ranHere = exitNoteDue()
      let closeUsage: import('../services/api/emptyUsage.js').NonNullableUsage | undefined
      const outcome = await leaveNoteBeforeExit({
        budgetMs: HANDOFF_ASK_BUDGET_MS,
        onNotice: text => io.outbound.enqueue(noticeRow(liveScope(), 'warning', text)),
        onUsage: usage => { closeUsage = usage },
      })
      if (ranHere) io.outbound.enqueue(closeRow(liveScope(), { state: outcome, ...(closeUsage !== undefined ? { usage: closeUsage } : {}) }))
    },
    closeOutput: async () => {
      const { endBackgroundHooks } = await import('../utils/hooks/background.js')
      await endBackgroundHooks().catch(() => {})
      skillChangeDetector.dispose()
      disarmAgentFreshness()
      stopDrainedNotificationFrames()
      stopSdkDrain()
      statusListeners.delete(rateLimitListener)
      noteRunPhase('flush_exit')
      logForDebugging(`[run-phases] ${jsonStringify(runPhaseReport(getTotalAPIDuration()))}`)
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
          error: { message: errorMessage(error), class: 'internal', detail: getInMemoryErrors().map(entry => withoutStackFrames(entry.error)) },
        },
      ),
    shutdown: code => void gracefulShutdown(code),
    clock: { sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
    queuedMainThread: () => getCommandQueue().filter(isMainThreadCommand),
    settleWindowMs: Math.max(POLL_INTERVAL_MS, Number.parseInt(flagEnv('MERCURY_SETTLE_WINDOW_MS') ?? '', 10) || 0),
    wall: () => sessionLaneWall(),
  })

  const stopSdkDrain = subscribeRows(() => {
    for (const row of drainRows()) enqueueRow({ ...row, ...(currentTurn !== null ? { turn: currentTurn } : {}) } as RowDraft)
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
  const { watchHostNotices } = await import('../services/host/notices.js')
  const stopHostNotices = watchHostNotices(() => getSessionId())
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
        driver.endOperatorWait()
        return true
      }
      return false
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
  markRunModeSignalsOwned()
  process.on('exit', () => saveCurrentSessionCosts())
  let buildBehindTold = false
  const checkBuildBehind = (): void => {
    if (buildBehindTold || awaitingSessionClaim || inputClosed) return
    const ownTree = runningBuildTree()
    if (ownTree === null) return
    const installedTree = deployedRuntime()?.buildTree ?? null
    if (installedTree === null || installedTree === ownTree) return
    buildBehindTold = true
    const line = composeNewerBuildInstalledLine(installedTree, ownTree)
    try {
      const home = flagEnv('MERCURY_SESSION_HOME') || getProjectDir(getOriginalCwd())
      const sid = String(getSessionId())
      const existing = readSessionReceipts(home, sid)
      if (!existing.some(r => r.kind === 'build-behind' && r.summary === line)) {
        appendSessionReceipt(home, sid, {
          at: new Date().toISOString(),
          by: 'runner',
          kind: 'build-behind',
          summary: line,
          details: { installedTree, runningTree: ownTree },
        })
      }
    } catch {}
    const row = createAttachmentMessage({
      type: 'queued_command',
      prompt: wrapInSystemReminder(line),
      commandMode: 'task-notification',
    } as never)
    messages.push(row)
    void recordTranscript([row], undefined, messages)
      .then(() => peekProject()?.flush())
      .catch(() => {})
    enqueueRow(noticeRow(liveScope(), 'warning', line))
  }
  const buildBehindTimer = isConcourseWorker ? setInterval(checkBuildBehind, 400) : null
  buildBehindTimer?.unref?.()

  const { registerCleanup } = await import('../utils/cleanupRegistry.js')
  registerCleanup(async () => {
    if (buildBehindTimer !== null) clearInterval(buildBehindTimer)
    releaseHookRows?.()
    idleNudge.stop()
    stopHostNotices()
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
    if (tools.length > 0) requestDeliberateToolChange(String(processMainOwner()), tools, `the MCP server ${serverName} joined or reconnected`)
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

  const mcpSignIns = new Map<string, { controller: AbortController; authorizationUrl?: string }>()
  const permittedMcpConfig = async (name: string): Promise<ScopedMcpServerConfig | null> => {
    const dynamic = dynamicMcpConfigSnapshot() ?? {}
    const resolved = isStrictMcpConfigSeed() ? { servers: {} } : await getMercuryMcpConfigs(dynamic)
    const { allowed } = filterMcpServersByPolicy({ ...resolved.servers, ...dynamic })
    return allowed[name] ?? null
  }
  const reconnectLiveMcp = async (name: string, config: ScopedMcpServerConfig): Promise<MCPServerConnection> => {
    const result = await reconnectMcpServerImpl(name, config)
    await applyReconnectedClient(name, result.client)
    registerPerTurnHandlers([result.client])
    return result.client
  }
  const liveMcp = watchLiveMcpConfig({
    hosted: isConcourseWorker,
    initial: Object.fromEntries(getAppState().mcp.clients.map(client => [client.name, client.config])),
    ready: () => !awaitingSessionClaim,
    approve: async (name, config) => {
      const target = 'url' in config ? config.url : config.command
      const key = `mcp-project-${randomUUID()}`
      const result = await asks.askPermission({
        kind: 'tool', tool_use_id: key, tool_name: 'MCP', title: `Trust new project MCP server ${name}`,
        input: { server: name, target, scope: 'project' },
        reason: 'MCP servers may execute code or access external systems. Use this project server?',
      }, { key })
      return result.outcome === 'allow'
    },
    reconcile: (next, previous) => serializeMcpChange(async () => {
      for (const row of getAppState().mcp.clients) {
        const configuredScope = ['user', 'local', 'project', 'enterprise'].includes(row.config.scope) || row.name in previous
        if (!configuredScope || row.name in next) continue
        mcpSignIns.get(row.name)?.controller.abort()
        await clearServerCache(row.name, row.config).catch(() => {})
        elicitationRegistered.delete(row.name)
        setAppState(state => {
          const pruned = dropMcpServerFromAppState(state, row.name, row.config)
          return { ...pruned, mcp: { ...pruned.mcp, clients: pruned.mcp.clients.filter(client => client.name !== row.name) } }
        })
      }
      for (const [name, config] of Object.entries(next)) {
        if (!isMcpCatalogueMember(name)) continue
        const row = getAppState().mcp.clients.find(client => client.name === name)
        if (row && JSON.stringify(row.config) === JSON.stringify(config)) continue
        await reconnectLiveMcp(name, config)
      }
    }),
  })
  registerCleanup(async () => {
    liveMcp.stop()
    for (const flow of mcpSignIns.values()) flow.controller.abort()
  })

  const SEAT_VERB_AT = (held: boolean): 'now' | 'turn_end' => (held ? 'turn_end' : 'now')
  const acceptInput = async (
    input:
      | { kind: 'prompt'; content: string | ContentBlockParam[]; id?: string; priority?: 'now' | 'next' | 'later'; sentAt?: string; origin?: unknown }
      | { kind: 'shell'; command: string; id?: string; priority?: 'now' | 'next' | 'later'; sentAt?: string; origin?: unknown }
      | { kind: 'note'; to: string; content: string; id?: string },
  ): Promise<{ accepted: true } | { accepted: false; reason: 'duplicate' }> => {
    sessionInitialized = true
    const missionSync = await import('../guards/mission.js')
    missionSync.syncMissionFromCard(String(getSessionId()))
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
      operatorPauseGate.lift(input.to)
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
    if (input.kind === 'prompt' && !('origin' in saturnQueueStamp(input.origin))) operatorPauseGate.resume()
    enqueue({
      value: input.kind === 'shell' ? input.command : input.content,
      mode: input.kind === 'shell' ? 'bash' : 'prompt',
      sentAt,
      ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...saturnQueueStamp(input.origin),
    })
    if (input.kind === 'prompt' && input.priority !== 'later' && !('origin' in saturnQueueStamp(input.origin)) && driver.isRunning() && !queuedWordsWaitForTurnEnd()) {
      handOverForegroundAgentsToQueuedMessage(getAppState, setAppState)
    }
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
      const interrupted = inFlightAbort !== null || leaveAbort !== null
      if (params.op_id !== undefined) {
        interruptOutcomes.set(params.op_id, interrupted)
        if (interruptOutcomes.size > INTERRUPT_DEDUPE_CAP) interruptOutcomes.delete(interruptOutcomes.keys().next().value!)
      }
      inFlightAbort?.abort()
      leaveAbort?.abort(new Error('the handoff was skipped by ctrl-c'))
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
      markSessionPermissionMode(nextContext.mode)
      return { mode: params.mode }
    },
    'session/set_model': async (params, ref) => {
      const requested = params.model
      const resolved =
        requested === undefined || requested === 'default'
          ? (getDefaultEngineModelSetting() ?? getEngineModel())
          : parseUserSpecifiedModel(requested)
      const words = typeof params.words === 'string' && params.words.trim() !== '' ? params.words.trim() : undefined
      if (inFlightAbort !== null) {
        heldSeatModel = { requestId: ref.id, model: String(resolved), ...(words === undefined ? {} : { words }) }
        holdQueuedWordsForTurnEnd(true)
        return { model: String(resolved), at: SEAT_VERB_AT(true) }
      }
      await applySeatModel(String(resolved), words)
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
        resumeOf = String(resumed.sessionId ?? sid)
        if (!isSessionPersistenceDisabled()) await resetSessionFilePointer()
        await restoreSessionStateFromLog(resumed, setAppState)
        restoreSessionMetadata(resumed)
        messages.splice(0, messages.length, ...resumed.messages)
        turnsRun = priorTurnCount(messages)
        contentReplacementState = reconstructContentReplacementState(messages, resumed.contentReplacements ?? [])
      } else {
        switchSession(sid as SessionId, claimedHome)
      }
      const claimedModel = typeof params.model === 'string' && params.model !== '' ? params.model : undefined
      if (claimedModel !== undefined) {
        activeModel = parseUserSpecifiedModel(claimedModel)
        setEngineModelOverride(claimedModel)
        saveSessionModel(activeModel)
        setFlagEnv('MERCURY_MODEL', claimedModel)
      }
      if (claimedEffort !== undefined) {
        setFlagEnv('MERCURY_EFFORT_LEVEL', claimedEffort)
        setAppState(previous => ({ ...previous, effortValue: claimedEffort }))
      }
      if (claimedContext !== undefined) {
        const nextContext = claimedContext
        setAppState(previous => ({ ...previous, toolPermissionContext: nextContext }))
        markSessionPermissionMode(nextContext.mode)
      }
      await armSessionRunnerWiring(sid)
      if (typeof params.restart_reason === 'string') runnerRestartReason = params.restart_reason
      if (params.resume === true) await hydrateResumedRun()
      awaitingSessionClaim = false
      void liveMcp.refresh()
      sessionFactsHoldSpent = false
      sessionFactsHold = null
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
      checkBuildBehind()
      if (!sessionFactsHoldSpent) {
        sessionFactsHoldSpent = true
        const holdMs = Number.parseInt(flagEnv('MERCURY_SESSION_FACTS_HOLD_MS') ?? '', 10)
        if (Number.isFinite(holdMs) && holdMs > 0) sessionFactsHold = new Promise(resolve => setTimeout(resolve, holdMs))
      }
      if (sessionFactsHold !== null) await sessionFactsHold
      const state = getAppState()
      const anthropicWindow = anthropicWindowFact()
      const anthropicObserved = anthropicObservedUsage()
      const openaiWindow = openaiWindowFact()
      const geminiWindow = laneWindowFact('gemini')
      const openrouterWindow = laneWindowFact('openrouter')
      const huggingfaceWindow = laneWindowFact('huggingface')
      const openaiCatalogue = openaiCatalogueFact()
      const factsNow = Date.now()
      const answer: SessionFactsAnswerV1 = {
        model: {
          effective: activeModel ?? getEngineModel(),
          setting: getEngineModelOverride() ?? null,
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
          modelSpend: sessionModelSpendRows(),
          limitWarning: providerLimitWarning({ model: activeModel ?? getEngineModel() }),
          ...(() => {
            const observed = openaiObservedUsage()
            return observed.primary || observed.secondary ? { openaiObserved: observed } : {}
          })(),
          ...(anthropicWindow !== undefined ? { anthropicWindow } : {}),
          ...(anthropicObserved !== undefined ? { anthropicObserved } : {}),
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
        mcp: mcpRosterEntriesOf(state.mcp.clients, []).map(row => ({
          ...row,
          toolCount: state.mcp.tools.filter(tool => tool.mcpInfo?.serverName === row.name).length,
          ...(liveMcp.addedAt.has(row.name) ? { addedAt: liveMcp.addedAt.get(row.name) } : {}),
          ...(mcpSignIns.has(row.name) ? { signingIn: true, authorizationUrl: mcpSignIns.get(row.name)?.authorizationUrl } : {}),
        })),
        permissionMode: state.toolPermissionContext.mode,
        ...((): { effortSent?: string | null } => {
          const sent = effortSentOf(resolveEffortTruth(activeModel ?? getEngineModel(), state.effortValue))
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
        editOutcomes: editOutcomeRows(processMainOwner()),
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
        streamIdleTimeoutMs: streamIdleTimeoutMsForRoute(providerFamilyOfSetting(activeModel ?? getEngineModel())),
        ...(runningBuildTree() !== null ? { buildTree: runningBuildTree() } : {}),
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
    'mcp/action': async (params, _ref, signal) => {
      const { name, action } = params
      if (action === 'cancel-auth') {
        mcpSignIns.get(name)?.controller.abort()
        return { outcome: 'applied' as const }
      }
      const config = await permittedMcpConfig(name)
      if (!config || !isMcpCatalogueMember(name)) return { outcome: 'refused' as const, detail: 'the server is off, unapproved, denied by policy, or no longer configured' }
      if (action === 'authenticate' && config.type !== 'http' && config.type !== 'sse') return { outcome: 'refused' as const, detail: 'this server does not use browser sign-in' }
      if (mcpSignIns.has(name)) return { outcome: 'refused' as const, detail: 'sign-in is already in progress' }
      const controller = new AbortController()
      const cancel = (): void => controller.abort(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (action === 'authenticate') {
          const flow: { controller: AbortController; authorizationUrl?: string } = { controller }
          mcpSignIns.set(name, flow)
          enqueueRow(noticeRow(liveScope(), 'warning', `Signing in to ${name} (browser)`))
          await performMCPOAuthFlow(name, config, url => {
            flow.authorizationUrl = url
            enqueueRow(noticeRow(liveScope(), 'warning', `Sign-in ready for ${name} (browser)`))
          }, controller.signal)
        }
        const stillAllowed = await permittedMcpConfig(name)
        if (controller.signal.aborted || !stillAllowed || JSON.stringify(stillAllowed) !== JSON.stringify(config) || !isMcpCatalogueMember(name)) return { outcome: 'refused' as const, detail: 'the server configuration or permission changed during sign-in' }
        const client = await serializeMcpChange(() => reconnectLiveMcp(name, config))
        return client.type === 'connected'
          ? { outcome: 'applied' as const, detail: `${name} connected` }
          : { outcome: 'refused' as const, detail: client.type === 'failed' ? client.error ?? 'connection failed' : `${name} needs sign-in` }
      } catch (error) {
        return { outcome: 'refused' as const, detail: errorMessage(error) }
      } finally {
        signal.removeEventListener('abort', cancel)
        mcpSignIns.delete(name)
      }
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
          const config = await permittedMcpConfig(name)
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
        setRunInputClosed(true)
        setTimeout(() => gracefulShutdownSync(0, 'closed'), 50)
      }
      return { token: answer.token, phase: answer.phase }
    },
    'session/leave': async (_params, _ref, signal) => {
      if (inFlightAbort !== null || leaveAbort !== null) return { note: 'skipped', ledger: 'absent' }
      const controller = new AbortController()
      leaveAbort = controller
      const onCancel = (): void => controller.abort(signal.reason)
      signal.addEventListener('abort', onCancel, { once: true })
      try {
        const note = await leaveNoteBeforeExit({ budgetMs: HANDOFF_ASK_BUDGET_MS, signal: controller.signal, onNotice: text => io.outbound.enqueue(noticeRow(liveScope(), 'warning', text)) })
        const closed = await closeLineageSession('quit')
        const kept = note === 'stored' ? exitNoteCharsKept() : null
        return { note, ledger: closed !== null && lineageKept() ? 'closed' : 'absent', ...(kept === null ? {} : { noteChars: kept }) }
      } finally {
        signal.removeEventListener('abort', onCancel)
        if (leaveAbort === controller) leaveAbort = null
      }
    },
    'agent/resume': async params => {
      const lastParams = getLastCacheSafeParams()
      if (lastParams === null) throw refused('nothing to resume from yet — the session has not run a turn', 'nothing-to-resume')
      const target = getAppState().tasks[params.agent_id]
      if (target !== undefined && target.status === 'running') {
        const note = params.note !== undefined ? params.note.trim() : ''
        if (note === '' || !isLocalAgentTask(target)) throw refused('the crewmate is running — nothing to resume', 'agent')
        queueOperatorMessage(params.agent_id, note, setAppState)
        return { queued: true, agent_id: params.agent_id }
      }
      const { resumeAgentBackground, operatorResumeWords } = await import('../tools/AgentTool/resumeAgent.js')
      const { toolUseId: _staleToolUseId, ...lastContext } = lastParams.toolUseContext
      void _staleToolUseId
      const resumed = await resumeAgentBackground({
        agentId: params.agent_id,
        prompt: params.note !== undefined && params.note.trim() !== '' ? params.note : AGENT_RESUME_NOTE,
        replyTarget: params.note?.trim() ? 'operator' : 'parent',
        toolUseContext: { ...lastContext, abortController: new AbortController() } as typeof lastParams.toolUseContext,
        canUseTool,
      })
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
      setRunInputClosed(true)
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
      if (last.status === 'blocked' && last.answer) await flushWrite(process.stdout, last.answer.replace(/\n?$/, '\n'))
      const sentence =
        last.status === 'refused' || last.status === 'failed'
          ? (last.error?.message ?? (last.status === 'refused' ? 'The request was refused' : 'The turn failed'))
          : OUTCOME_SENTENCES[last.status]({ maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, maxTimeMs: options.maxTimeMs, message: last.error?.message })
      await flushWrite(process.stderr, `${sentence}\n`)
    }
  }

  logHeadlessProfilerTurn()
  noteRunPhase('flush_exit')
  logForDebugging(`[run-phases] ${jsonStringify(runPhaseReport(getTotalAPIDuration()))}`)
  gracefulShutdownSync(io.stdoutPipeBroken ? 1 : (signalCode ?? exitCodeOf(last.status)))
}
