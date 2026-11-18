import { requestShellBackground } from '../tools/BashTool/backgroundRequest.js'
import { randomUUID, type UUID } from 'node:crypto'
import { keepTurnLiveWhileHostAnswers, type HostAskLiveness } from './headless/hostAskLiveness.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import {
  getEngineModelOverride,
  getSessionId,
  setEngineModelOverride,
  getMainThreadAgentType,
  getTotalAPIDuration,
  isSessionPersistenceDisabled,
  setAskChannel,
  setRunInputClosed,
  setSessionKind,
} from '../bootstrap/state.js'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hasConversationTurn } from '../utils/conversationRecovery.js'
import { caretEscape } from '../utils/caretEscape.js'
import { reconstructContentReplacementState } from '../utils/toolResultStorage.js'
import { adoptResumedSessionFile, flushSessionStorage, getSessionMessages, peekProject, recordTranscript } from '../utils/sessionStorage/writer.js'
import { RunnerQuiescence } from '../daemon/runnerQuiescence.js'
import { capabilityHoldWords, runnerCapabilityHolds } from '../daemon/runnerCapabilityCensus.js'
import { sessionFilePath } from '../utils/sessionStorage/loading.js'
import { claimSessionWriter } from '../utils/sessionStorage/sessionWriter.js'
import { SPAWN_SWITCH_LABEL, setSpawnSwitch, spawnSwitchTransitionLine } from '../services/switchboard/spawnSwitches.js'
import { refreshBoxReading } from '../utils/boxLock.js'
import { declareLawfulPrefixChange, declareLawfulPrefixChangeForEveryOwner, requestDeliberateToolChange } from '../services/providers/lawfulPrefixChange.js'
import { watchLiveMcpConfig } from '../services/mcp/liveConfig.js'
import { dynamicMcpConfigSnapshot, isStrictMcpConfigSeed } from '../services/mcp/dynamicMcpSeed.js'
import { bootModelRefusalLine, resolveHeadlessModel } from './headless/model.js'
import { formatPrintsOutcomeRow, refusedOutcome } from './headless/refusalEnvelope.js'
import { createRosterTransitionMessage, createSeatReceiptMessage } from '../utils/messages/systemMessages.js'
import { DRAIN_CUT_WORDS } from '../utils/messages/turnCut.js'
import {
  scheduleEditToWire,
} from '../services/engine-connector/seatWire.js'
import { ask, sessionFactsOf } from '../rows/turn.js'
import { closeRow, commandOutputRow, compactionClearedRow, compactionRow, heartbeatRow, missionUpdatedRow, modeRow, noticeRow, outcomeRow, rateLimitRow, samplesUpdatedRow, sessionRow, taskRow, turnStartedRow, turnWaitingRow, waitRow, type RowDraft, type RowScope, type Unstamped } from '../rows/project.js'
import { exitCodeOf, OUTCOME_SENTENCES, type CompactionRow, type InputRow, type OutcomeRow, type Row } from '../rows/vocabulary.js'
import { isOutcome, turnOpened } from '../rows/read.js'
import type { FoldStatusV1 } from '../services/compact/foldStatus.js'
import type { RequestWaitV1 } from '../services/providers/streamIdleBudget.js'
import { clearCommandMemoizationCaches, findCommand, getCommands, isCommandEnabled } from '../commands.js'
import { parseSlashCommand } from '../utils/slashCommandParsing.js'
import {
  handleRewindFiles,
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
  type TurnDriver,
} from './headless/turnDriver.js'
import { emptyInputRow, INPUT_REFUSED_CODE, isBrokenPipeError, isRowLine, promptSchemaRefusal, StructuredIO, type OutboundLine } from './structuredIO.js'
import { createRuleOnlyAsks, createRunnerAsks, type AskHost } from './headless/runnerAsks.js'
import { bindRunnerMethods, checkProtocol, DEFAULT_CAPABILITIES, initializeResultOf } from './headless/runnerMethods.js'
import { createRunnerState, type HeadlessOptions, type RunnerPorts } from './headless/runnerPorts.js'
import { runnerArmsOf } from './headless/runnerArms.js'
import { priorTurnCount } from './headless/claimSession.js'
import { fileCheckpointsFact } from './headless/sessionFactsArm.js'
import { createPeer, type Peer } from '../runner/wire/peer.js'
import { invalidParams } from '../runner/wire/errors.js'
import type { Capabilities, ParamsOf } from '../runner/wire/methods.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import { statusListeners, type AnthropicLimits } from '../services/anthropicLimits.js'
import { sessionLaneWall } from '../tools/MonitorTool/laneWall.js'
import {
  clearServerCache,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  reconnectMcpServerImpl,
} from '../services/mcp/client.js'
import { withElicitationEntered } from '../services/mcp/elicitationHandler.js'
import { getMcpPrefix } from '../services/mcp/mcpStringUtils.js'
import { isMcpCatalogueMember } from '../services/mcp/membership.js'
import { dropMcpServerFromAppState } from '../services/mcp/kitDial.js'
import { subscribeSampleChanges } from '../services/samples/store.js'
import {
  registerLocalWakeSink,
  registerScheduleEditDoor,
} from '../services/saturn/sessionScheduleBridge.js'
import { registerIdeToolDoor } from '../services/acp/ideToolBridge.js'
import { crewBoardNotice, saturnQueueStamp, screenCommandQueueStamp } from '../utils/messages/noticeRows.js'
import { advisorMainRound, advisorMainTurnSettled, createAdvisorQuietMessage, type AdvisorQuiet, type AdvisorRoad } from '../services/advisor/index.js'
import { enqueueBoardWake, swarmSessionEnabled, swarmStore, watchSwarmBoard, watchSwarmLead, watchSwarmResumes } from '../services/crewBoard/seam.js'
import { partyFeed } from '../services/crewBoard/party.js'
import { localWakeStep, type LocalWakeFacts } from '../tools/ScheduleWakeupTool/localWake.js'
import {
  getMcpConfigByName,
  getMercuryMcpConfigs,
  filterMcpServersByPolicy,
  mcpServersSkippedForApprovalLines,
  mcpServersSkippedForTrustLine,
} from '../services/mcp/config.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { type Tool, type ToolUseContext } from '../Tool.js'
import { noteHeadlessActivity } from '../utils/activityLedger.js'
import { logForDebugging } from '../utils/debug.js'
import { requestFileCheckpoints } from '../utils/fileHistory.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { toError, errorMessage } from '../utils/errors.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
  type FileStateCache,
  type FileState,
} from '../utils/fileStateCache.js'
import { getLastCacheSafeParams } from '../utils/forkedAgent.js'
import { GLYPH } from '../components/mercury-ui/glyphs.js'
import { crewmateNoticeOwed } from '../tools/AgentTool/agentToolUtils.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import { gracefulShutdown, gracefulShutdownSync, isShuttingDown, markRunModeSignalsOwned, TERMINAL_GONE_EXIT_CODE } from '../utils/gracefulShutdown.js'
import { leaveNoteBeforeExit } from '../mneme/exitHandoff.js'
import { HANDOFF_ASK_BUDGET_MS } from '../mneme/handoffAsk.js'
import { saveCurrentSessionCosts } from '../cost-tracker.js'
import {
  headlessProfilerStartTurn,
  logHeadlessProfilerTurn,
} from '../utils/headlessProfiler.js'
import { subscribeHookExecutionEvents } from '../utils/hooks/hookEvents.js'
import { hookTaskRow } from '../utils/hooks/rows.js'
import { takeFirstPrompt } from '../utils/sessionStart.js'
import { createIdleTimeoutManager } from '../utils/idleTimeout.js'
import { armInactivityDeadline, DeadlineExceededError, declaredWaitEnd, holdDeadlineUntil, minutesKnobToMs } from '../utils/deadline.js'
import { LOCAL_FIRST_BYTE_CAP_MS } from '../services/providers/localLiveness.js'
import { flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'
import { AGENT_MESSAGE_STATUS } from '../constants/agentMessage.js'

const DEFAULT_HEADLESS_IDLE_MINUTES = 20
const SIGNAL_SETTLE_MS = 5_000
const BUILD_BEHIND_FLOOR_MS = 60_000
const BUILD_BEHIND_THROTTLE_MS = 2_000
const BUILD_BEHIND_CONFIRM_MS = 2_000
import { getInMemoryErrors, logError, withoutStackFrames } from '../utils/log.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { getRunSnapshot, reconcileOnResume } from '../services/run/runCoordinator.js'
import type { Message } from '../types/message.js'
import type { ContentBlockParam } from '../types/wire.js'
import {
  dequeue,
  enqueue,
  peek,
  remove as removeQueuedCommands,
  subscribeToCommandQueue,
  getCommandQueue,
  holdQueuedWordsForTurnEnd,
} from '../utils/messageQueueManager.js'
import type { BatchedPrompt, QueuedCommand } from '../types/textInputTypes.js'
import { isHeldNotice, isHostNotice, isOperatorLine, queuedWordsWaitForTurnEnd, subscribeQueueConsumption } from '../input-core/command-queue.js'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { agentRecipientState, MAIN_THREAD_AGENT, nudgeWords, startIdleNudge } from '../services/notices/idleNudge.js'
import { type NoticeRecord } from '../services/notices/unreadLedger.js'
import { isLocalShellTask } from '../tasks/LocalShellTask/guards.js'
import { killTask } from '../tasks/LocalShellTask/killShellTasks.js'
import {
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
import { buildSideQuestionFallbackParams } from '../utils/queryContext.js'
import { armLocalWarm } from '../services/providers/local/localWarm.js'
import { extractReadFilesFromMessages } from '../utils/queryHelpers.js'
import {
  doesMessageExistInSession,
  saveAdvisorSwitch,
  saveAgentSetting,
  saveSessionBrief,
  saveSessionModel,
} from '../utils/sessionStorage.js'
import { restoreAgentFromSession, restoreConversationModel } from '../utils/sessionRestore.js'
import { setPermissionModeChangedListener } from '../utils/sessionState.js'
import { getSettingsWithSources } from '../utils/settings/settings.js'
import { currentSettingsFaults, untoldSettingsFaults } from '../utils/settings/faultNotices.js'
import { currentHiddenCharacterLines, untoldHiddenCharacterLines } from '../utils/text/hiddenCharacterFindings.js'
import { hooksSkippedForTrustLine } from '../utils/hooks/hooksConfigSnapshot.js'
import { settingsFaultLine } from '../utils/settings/validation.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { applySettingsChange } from '../utils/settings/applySettingsChange.js'
import { skillChangeDetector } from '../utils/skills/skillChangeDetector.js'
import { armRunnerAgentFreshness } from './agentFreshness.js'
import { installWireStdoutGuard } from '../utils/wireStdoutGuard.js'
import { getRunningTasks, POLL_INTERVAL_MS } from '../utils/task/framework.js'
import { handOverForegroundAgentsToQueuedMessage } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { markSessionBootRules, markSessionNonInteractive } from '../utils/cockpit/runtimePosture.js'
import { consumeSessionKindPin } from '../utils/sessionKind.js'
import { describeArtifactIdentity, runningBuildTree } from '../utils/artifactIdentity.js'
import { getTranscriptPath, isChainParticipant } from '../utils/sessionStorage/paths.js'
import { appendSessionReceipt, readSessionReceipts, settleClearModel } from '../services/switchboard/sessionReceipts.js'
import { wrapInSystemReminder } from '../utils/messages/text.js'
import { composeBuildBehindLine } from '../tools/MonitorTool/watchReceipts.js'
import { windowsShellRoadNotice } from '../utils/shell/windowsShellRoad.js'
import { drainRows, subscribeRows } from '../utils/sdkEventQueue.js'
import { onTasksUpdated } from '../utils/tasks.js'
import { operatorPauseGate } from '../run-core/pauseGate.js'

import type { ThinkingConfig } from '../utils/thinking.js'
import { createSyntheticOutputTool, isSyntheticOutputToolEnabled, SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { compileJsonSchema } from '../services/schema/jsonSchemaEngine.js'
import { getAllBaseTools, getTools, mcpToolPartition, toolsWithheldByDeny } from '../tools.js'
import { ruleSourceWords, ruleSpelling, withheldByRuleWords } from '../utils/permissions/ruleReason.js'
import { MCP_SERVER_FAILED_CODE, MCP_SERVER_SKIPPED_CODE, TOOL_WITHHELD_CODE } from '../rows/vocabulary.js'
import { mcpConfigAsWritten, mcpServerFailedWords, mcpServersFailed } from '../services/mcp/utils.js'
import { clearToolRosterLatches, clearToolRosterRestore } from '../services/providers/toolEconomy.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { getCwd } from '../utils/cwd.js'
import { runWithWorkload } from '../utils/workloadContext.js'
import { fitCompletionCommands } from '../services/agentResults/summaryRoom.js'
import { foldNotifications, foldNotificationValues, spokenNotifications } from './headless/turnDriver.js'

export { joinPromptValues, canBatchWith }
export { removeInterruptedMessage }

const RECEIVED_UUID_CAP = 10_000

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


export async function runHeadless(
  inputPrompt: string | AsyncIterable<string>,
  getAppState: GetAppState,
  setAppState: SetAppState,
  commands: import('../commands.js').Command[],
  tools: Tool[],
  agents: AgentDefinition[],
  options: HeadlessOptions,
): Promise<void> {
  const live = createRunnerState()
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
  const skippedServers = mcpServersSkippedForTrustLine()
  if (skippedServers !== null && options.door !== 'wire') process.stderr.write(`${GLYPH.warn} ${skippedServers}\n`)
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
  let bootModel: string | undefined
  let bootModelRefusal: string | null = null
  if (options.userSpecifiedModel !== undefined) {
    try {
      bootModel = await resolveHeadlessModel(options.userSpecifiedModel)
      setEngineModelOverride(bootModel)
    } catch (error) {
      const message = errorMessage(error)
      if (options.door !== 'wire') {
        if (formatPrintsOutcomeRow(options.outputFormat)) process.stdout.write(jsonStringify(refusedOutcome([message])) + '\n')
        else process.stderr.write(`${message}\n`)
        gracefulShutdownSync(1)
        return
      }
      bootModel = parseUserSpecifiedModel(options.userSpecifiedModel)
      setEngineModelOverride(bootModel)
      bootModelRefusal = bootModelRefusalLine(bootModel, message)
    }
  }

  const isConcourseWorker = flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  live.awaitingSessionClaim = isConcourseWorker && !options.continue && !options.resume && options.bootSessionIdPinned !== true
  if (!live.awaitingSessionClaim && (!options.continue && !options.resume || options.forkSession) && !isSessionPersistenceDisabled()) {
    try { await claimSessionWriter(sessionFilePath(getSessionId() as UUID)) }
    catch (error) {
      emitLoadError(errorMessage(error), options.outputFormat)
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
      if (params.file_checkpoints !== undefined) requestFileCheckpoints(params.file_checkpoints)
      await bootReady
      if (params.schema !== undefined) {
        const compiled = compileJsonSchema(params.schema)
        if (!compiled.ok) throw invalidParams('initialize', [{ path: ['schema'], message: `not a JSON schema — ${compiled.error}` }])
        initializeJsonSchema = params.schema
      }
      return initializeResultOf(live.awaitingSessionClaim ? null : String(getSessionId()), fileCheckpointsFact())
    })
    bindRunnerMethods(peer, () => runnerArmsOf(ports))
  }
  let currentTurn: number | null = null
  let sessionRowFor: string | null = null
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
  const skippedMcpTold = new Set<string>()
  const tellSkippedProjectMcpServers = (): void => {
    for (const { name, line } of mcpServersSkippedForApprovalLines()) {
      if (skippedMcpTold.has(name)) continue
      skippedMcpTold.add(name)
      enqueueRow(noticeRow(liveScope(), 'warning', line, MCP_SERVER_SKIPPED_CODE))
      if (options.door !== 'wire') process.stderr.write(`${GLYPH.warn} ${line}\n`)
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
  const statusIsProgress = (status: unknown): boolean => {
    if (status === 'compacting') return true
    if (typeof status !== 'object' || status === null) return false
    if ('streamActivity' in status || 'compacting' in status) return true
    const wait = (status as { wait?: RequestWaitV1 | null }).wait
    return wait?.kind === 'first-byte' && wait.checkedMs !== undefined
  }
  const promisedWaitOf = (status: unknown): Extract<RequestWaitV1, { kind: 'first-byte' }> | null | undefined => {
    if (typeof status !== 'object' || status === null || !('wait' in status)) return undefined
    const wait = (status as { wait?: RequestWaitV1 | null }).wait
    return wait?.kind === 'first-byte' && wait.promise === true && wait.phase !== 'tokens' ? wait : null
  }
  const missionGuard = await import('../guards/mission.js')
  {
    let missionTimer: NodeJS.Timeout | null = null
    const missionMoved = (): void => {
      if (missionTimer !== null) return
      missionTimer = setTimeout(() => {
        missionTimer = null
        enqueueRow(missionUpdatedRow(liveScope()))
      }, 50)
      missionTimer.unref?.()
    }
    onTasksUpdated(missionMoved)
    missionGuard.subscribeActiveMission(missionMoved)
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
    resume: options.resume,
    resumeSessionAt: options.resumeSessionAt,
    forkSession: options.forkSession,
    outputFormat: wire ? 'text' : options.outputFormat,
    sessionStartHooksPromise: options.sessionStartHooksPromise,
  })
  const messages: Message[] = loaded.messages
  live.resumeOf = loaded.resumedSessionId
  live.turnsRun = priorTurnCount(messages)
  live.contentReplacementState = reconstructContentReplacementState(messages, loaded.contentReplacements ?? [])

  live.mcpInitialized = !live.awaitingSessionClaim
  const releaseQueueUntilClaimed: (() => void) | null = peer !== null && live.awaitingSessionClaim ? peer.holdScope('queue') : null
  live.runnerRestartReason = flagEnv('MERCURY_RUNNER_RESTART_REASON')
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
  if (isConcourseWorker && !live.awaitingSessionClaim) {
    await armSessionRunnerWiring(String(getSessionId()))
  } else if (live.awaitingSessionClaim) {
    void sessionWiringModules().catch(() => {})
  }

  const hookFirstPrompt = takeFirstPrompt()
  if (hookFirstPrompt) {
    io.prependUserMessage(hookFirstPrompt)
  }

  if ((options.continue || options.resume) && !getEngineModelOverride()) {
    const recorded = restoreConversationModel({ messages, model: loaded.model })
    if (recorded && !options.userSpecifiedModel) {
      try {
        bootModel = await resolveHeadlessModel(recorded)
        setEngineModelOverride(bootModel)
      } catch (error) {
        if (recorded.toLowerCase().startsWith('compat/')) {
          if (wire) {
            bootModel = parseUserSpecifiedModel(recorded)
            setEngineModelOverride(bootModel)
            bootModelRefusal = bootModelRefusalLine(bootModel, errorMessage(error))
          } else {
            emitLoadError(`The resumed session's model '${recorded}' is not usable: ${errorMessage(error)}`, options.outputFormat)
            gracefulShutdownSync(1)
            return
          }
        } else {
          enqueueRow(noticeRow(liveScope(), 'warning', `The resumed session's model '${recorded}' is not usable (${errorMessage(error)}) — this run uses ${getEngineModel()} instead.`))
        }
      }
    }
  }
  const persistBootModelRefusal = async (refusal: string): Promise<void> => {
    const refusalRow = createSeatReceiptMessage(refusal, 'warning')
    const persist = !isSessionPersistenceDisabled() && hasConversationTurn(messages)
    const onDisk = persist ? await getSessionMessages(getSessionId() as UUID) : null
    const leaf = onDisk === null ? undefined : messages.findLast(m => isChainParticipant(m) && onDisk.has(m.uuid as UUID))
    messages.push(refusalRow)
    if (persist) {
      adoptResumedSessionFile()
      void recordTranscript([refusalRow], leaf?.uuid as UUID | undefined, messages)
        .then(() => peekProject()?.flush())
        .catch((error: unknown) => logError(toError(error)))
    }
  }
  if (options.title && !live.awaitingSessionClaim && !isSessionPersistenceDisabled()) {
    const { saveCustomTitle } = await import('../utils/sessionStorage/logs.js')
    await saveCustomTitle(getSessionId() as UUID, options.title)
  }
  if (bootModelRefusal !== null) live.bootRefusalFact = bootModelRefusal
  if (bootModelRefusal !== null && !live.awaitingSessionClaim) await persistBootModelRefusal(bootModelRefusal)

  const relaunchContext = async (): Promise<ToolUseContext> => {
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
  }

  const hydrateResumedRun = async (): Promise<void> => {
    if (messages.length === 0) return
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
      const carriedReason = carriedReasonOf(live.runnerRestartReason)
      if (carriedReason === 'crash' || carriedReason === 'stop' || carriedReason === 'update' || carriedReason === 'ended') {
        const { carryRunnerAcrossRestart } = await import('./headless/restartCarry.js')
        const carried = await carryRunnerAcrossRestart({
          reason: carriedReason,
          messages,
          getAppState,
          setAppState,
          canUseTool: asks.createCanUseTool(),
          relaunchContext,
        })
        live.recoveredCommandIds = carried.recoveredCommandIds
        logForDebugging(`[session-runner] resume after ${carriedReason}: ${carried.requeued} line(s) re-queued, ${carried.relaunched} agent(s) relaunched, ${carried.delivered} delivered from the queue log, ${carried.stopped} stopped`)
      }
    } catch (error) {
      logError(error)
    }
    try {
      const { reconcileBackgroundLaunchesOnResume, coerceRestartReason } = await import('../tasks/LocalAgentTask/launchReceipts.js')
      const settledLaunches = reconcileBackgroundLaunchesOnResume(messages, getAppState, setAppState, Date.now(), coerceRestartReason(live.runnerRestartReason))
      if (settledLaunches.length > 0) {
        logForDebugging(`[session-runner] resume: ${settledLaunches.length} background launch(es) without a live record — stop notices written`)
      }
    } catch (error) {
      logError(error)
    }
    try {
      const { carryPausedCrewmatesOnResume } = await import('../tasks/LocalAgentTask/pauseCarry.js')
      const carried = await carryPausedCrewmatesOnResume({
        getAppState,
        setAppState,
        canUseTool: asks.createCanUseTool(),
        relaunchContext,
      })
      if (carried.length > 0) {
        logForDebugging(`[session-runner] resume: ${carried.length} paused crewmate(s) re-armed to retry at their stated reset — ${carried.join(', ')}`)
      }
    } catch (error) {
      logError(error)
    }
    try {
      const { reconcileWatchesOnResume, reconcileBackgroundShellsOnResume, composeRestartLine } = await import('../tools/MonitorTool/watchReceipts.js')
      const { coerceRestartReason } = await import('../tasks/LocalAgentTask/launchReceipts.js')
      const reason = coerceRestartReason(live.runnerRestartReason)
      const liveIds = new Set(Object.keys(getAppState().tasks ?? {}))
      const { reconcileTaskLaunchesOnResume } = await import('../tasks/taskLaunchLedger.js')
      const launches = await reconcileTaskLaunchesOnResume(String(getSessionId()), liveIds)
      if (launches.endedPids.length > 0) {
        logForDebugging(`[session-runner] resume: ${launches.endedPids.length} background process(es) had outlived the runner and were ended — pids ${launches.endedPids.join(', ')}`)
      }
      const deadWatches = reconcileWatchesOnResume(messages, liveIds, reason, launches.orphans, launches.settledTaskIds)
      const deadShells = reconcileBackgroundShellsOnResume(messages, liveIds, reason, launches.orphans, launches.settledTaskIds)
      if (deadWatches.length > 0 || deadShells.length > 0) {
        logForDebugging(`[session-runner] resume: ${deadWatches.length} watch(es) and ${deadShells.length} background shell(s) without a live process — dead notices written`)
      }
      if (reason === 'update' || reason === 'ended') {
        const build = runningBuildTree() ?? `v${MACRO.VERSION}`
        const line = composeRestartLine({ reason, build, watches: deadWatches, shells: deadShells })
        try {
          appendSessionReceipt(dirname(getTranscriptPath()), String(getSessionId()), {
            at: new Date().toISOString(),
            by: 'runner',
            kind: 'runner-restart',
            summary: line,
            details: { reason, build, watches: deadWatches.length, shells: deadShells.length },
          })
        } catch (error) {
          logError(error)
        }
        const { enqueuePendingNotification } = await import('../utils/messageQueueManager.js')
        enqueuePendingNotification({
          value: wrapInSystemReminder(line),
          mode: 'task-notification',
          priority: 'next',
          ridesNextWords: true,
        })
        enqueueRow(noticeRow(liveScope(), 'warning', line))
      }
    } catch (error) {
      logError(error)
    }
  }
  if (options.continue || options.resume) await hydrateResumedRun()

  if (!options.agent && !getMainThreadAgentType() && loaded.agentSetting) {
    const restored = restoreAgentFromSession(loaded.agentSetting, undefined, {
      activeAgents: agents,
      allAgents: agents,
    })
    if (restored.agentType && restored.agentDefinition) saveAgentSetting(restored.agentType)
  }
  const givenBrief = options.systemPrompt
  const givenBriefAdd = options.appendSystemPrompt
  const hostBriefAdd = options.hostAppendSystemPrompt
  const settleSessionBriefs = (kept: { brief?: string; briefAdd?: string }, record: boolean): void => {
    if (record && givenBrief !== undefined && givenBrief !== kept.brief) saveSessionBrief('brief', givenBrief)
    if (record && options.defaultBrief === true && kept.brief !== undefined) saveSessionBrief('brief', null)
    if (record && givenBriefAdd !== undefined && givenBriefAdd !== kept.briefAdd) saveSessionBrief('briefAdd', givenBriefAdd)
    options.systemPrompt = givenBrief ?? (options.defaultBrief === true ? undefined : kept.brief)
    options.appendSystemPrompt = [hostBriefAdd, givenBriefAdd ?? kept.briefAdd].filter(Boolean).join('\n\n') || undefined
    const mainAgent = agents.find(agent => agent.agentType === getMainThreadAgentType())
    if (mainAgent !== undefined && !isBuiltInAgent(mainAgent) && options.systemPrompt === undefined) {
      const agentPrompt = mainAgent.getSystemPrompt()
      if (agentPrompt) options.systemPrompt = agentPrompt
    }
  }
  settleSessionBriefs(loaded, !live.awaitingSessionClaim)
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
  const canUseTool = asks.createCanUseTool()
  registerProcessOutputErrorHandlers()
  noteRunPhase('config_auth')

  let sessionInitialized = false
  live.activeModel = bootModel
  saveSessionModel(live.activeModel ?? getEngineModel())
  const settleClearBirth = (): void => {
    try {
      const row = settleClearModel(dirname(getTranscriptPath()), String(getSessionId()), live.activeModel ?? getEngineModel())
      if (row !== null && !messages.some(message => message.uuid === row.uuid)) {
        messages.push(row)
        void recordTranscript([row], undefined, messages).catch((error: unknown) => logError(toError(error)))
      }
    } catch (error) {
      logError(toError(error))
    }
  }
  if (isConcourseWorker && !live.awaitingSessionClaim) settleClearBirth()
  let thinkingConfig: ThinkingConfig | undefined = options.thinkingConfig
  let initializeJsonSchema: Record<string, unknown> | undefined
  let lastAnswerSchemaKey: string | null = null
  live.activeCommands = commands
  let activeAgents: AgentDefinition[] = agents
  const receivedUuids = new BoundedUuidSet(RECEIVED_UUID_CAP)
  const interruptOutcomes = new Map<string, boolean>()
  let hostAsks: HostAskLiveness | null = null
  asks.setOnControlRequestSent(() => hostAsks?.noteParked())
  asks.setOnControlRequestResolved(() => hostAsks?.noteSettled())
  let deferredModelBreadcrumb: { to: string; from: string } | null = null
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
      if (live.inputClosed) return
      if (live.inFlightAbort !== null) deferredAdvisorQuiet.push(quiet)
      else landAdvisorQuiet(quiet)
    },
  }
  const landSpawnSwitch = (kind: 'subagents', on: boolean): void => {
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
  const answerSchemaOf = (turnSchema: Record<string, unknown> | undefined): Record<string, unknown> | undefined => turnSchema ?? initializeJsonSchema ?? options.jsonSchema
  const assembleTools = (state: AppState, turnSchema?: Record<string, unknown>): Tool[] => {
    const mcpPartition = mcpToolPartition(state.mcp.tools as Tool[], state.toolPermissionContext)
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
    const answerSchema = answerSchemaOf(turnSchema)
    if (answerSchema === undefined || !isSyntheticOutputToolEnabled({ isNonInteractiveSession: true })) return deduped
    const synthetic = createSyntheticOutputTool(answerSchema)
    if (!('tool' in synthetic)) return deduped
    const at = deduped.findIndex(tool => tool.name === SYNTHETIC_OUTPUT_TOOL_NAME)
    if (at === -1) return [...deduped, synthetic.tool]
    if (deduped[at] === synthetic.tool) return deduped
    return deduped.map((tool, index) => (index === at ? synthetic.tool : tool))
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
    const previous = live.activeModel ?? getEngineModel()
    live.activeModel = model
    setEngineModelOverride(model)
    setFlagEnv('MERCURY_MODEL', model)
    saveSessionModel(model)
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
  armLocalWarm(() => buildSideQuestionFallbackParams({ tools: assembleTools(getAppState()), commands: live.activeCommands, mcpClients: getAppState().mcp.clients, messages, readFileState: getReadFileCache(), getAppState, setAppState, customSystemPrompt: options.systemPrompt, appendSystemPrompt: options.appendSystemPrompt, thinkingConfig, agents: activeAgents }), { live: () => !live.awaitingSessionClaim && live.inFlightAbort === null })

  const SDK_MODES = new Set(['default', 'implement', 'sovereign', 'flow', 'dontAsk'])
  setPermissionModeChangedListener(mode => {
    if (!SDK_MODES.has(mode)) return
    enqueueRow(modeRow(liveScope(), mode))
  })


  skillChangeDetector.subscribe(() => {
    clearCommandMemoizationCaches()
    void getCommands(getCwd()).then(refreshed => {
      live.activeCommands = refreshed
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
    if (command.origin?.kind === 'outside-report') return []
    const texts =
      typeof command.value === 'string'
        ? [command.value]
        : Array.isArray(command.value)
          ? command.value.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
          : []
    if (command.mode !== 'task-notification' && !texts.some(text => text.includes('<task-notification>'))) return []
    return texts.flatMap(text => text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? [text])
  }

  const recordNoticeRows = async (notices: readonly QueuedCommand[], mark: { isVirtual: true } | { isMeta: true }): Promise<void> => {
    const { createUserMessage } = await import('../utils/messages/factories.js')
    const rows = notices.map(notice => createUserMessage({ content: notice.value, ...mark, origin: { kind: 'task-notification' }, ...(notice.uuid !== undefined ? { uuid: notice.uuid } : {}), ...(notice.sentAt !== undefined ? { timestamp: notice.sentAt } : {}) }))
    messages.push(...rows)
    await recordTranscript(rows, undefined, messages).catch((error: unknown) => {
      logForDebugging(`host notice: the row was not recorded — ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const recordHostNoticeRows = (notices: readonly QueuedCommand[]): Promise<void> => recordNoticeRows(notices, { isVirtual: true })
  let turnReachedModel = false
  let turnAnchor: string | null = null
  const missionLineOf = (content: string | ContentBlockParam[], cap: number): string | null => {
    const line = typeof content === 'string' ? content : content.find(block => block.type === 'text')?.text
    const parsed = line === undefined ? null : parseSlashCommand(line)
    if (parsed === null || parsed.isMcp) return null
    const found = findCommand(parsed.commandName, live.activeCommands)
    if (found === undefined || found.name !== 'mission') return null
    const words = parsed.args.trim()
    return words.length > cap ? null : words
  }
  const localCommandInput = (command: QueuedCommand): boolean => {
    if (command.mode === 'bash') return true
    if (command.skipSlashCommands === true || (command.mode !== undefined && command.mode !== 'prompt')) return false
    const value = options.syntaxInput !== undefined && command.value === inputPrompt ? options.syntaxInput : command.value
    const line = typeof value === 'string' ? value : value.find(block => block.type === 'text')?.text
    const parsed = line === undefined ? null : parseSlashCommand(line)
    if (parsed === null) return false
    const found = findCommand(parsed.commandName, [...live.activeCommands, ...getAppState().mcp.commands])
    if (found !== undefined) return found.type !== 'prompt' || !isCommandEnabled(found) || found.userInvocable === false
    return /^[a-zA-Z0-9:_-]+$/.test(parsed.commandName) && !existsSync(`/${parsed.commandName}`)
  }
  const executeTurn = async (
    command: QueuedCommand,
    batch: QueuedCommand[],
    onMessage: (message: RowDraft) => void,
    initialNotices: QueuedCommand[] = [],
  ): Promise<void> => {
    const { applyLiveBootMenuEnv } = await import('../substrate/startupMenu.js')
    applyLiveBootMenuEnv()
    const members = batch.length > 0 ? batch : [command]
    turnReachedModel = false
    if (members.some(isHostNotice) || initialNotices.some(isHostNotice)) {
      const hostNotices = [...initialNotices, ...members].filter(isHostNotice)
      emitCommandNotifications(hostNotices)
      await recordHostNoticeRows(hostNotices)
      initialNotices = initialNotices.filter(member => !isHostNotice(member))
    }
    const heard = members.filter(member => !isHostNotice(member))
    if (heard.length === 0) return
    const spoken = spokenNotifications(heard)
    if (spoken.length < heard.length) await recordNoticeRows(heard.filter(member => !spoken.includes(member)), { isMeta: true })
    if (spoken.length < members.length) {
      batch = spoken.length > 1 ? spoken : []
      command = foldNotifications(spoken)
    }
    turnReachedModel = true
    const promptUuid = command.uuid ?? randomUUID()
    const localCommand = localCommandInput(command)
    turnAnchor = localCommand ? null : promptUuid
    if (localCommand) party.blockOpen()
    const delivery = command.mode === 'task-notification' ? fitCompletionCommands(batch.length > 0 ? batch : [command], { messages, model: live.activeModel ?? getEngineModel() }) : []
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
    live.inFlightAbort = turnAbort
    live.turnsRun += 1
    currentTurn = live.turnsRun
    live.currentTurnId = null
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
    let promiseHold: { cancel(): void } | null = null
    const holdPromise = (wait: Extract<RequestWaitV1, { kind: 'first-byte' }> | null): void => {
      promiseHold?.cancel()
      promiseHold = wait === null || !turnWatchdog.armed ? null : holdDeadlineUntil(turnWatchdog, declaredWaitEnd(wait.sinceMs, wait.budgetMs, LOCAL_FIRST_BYTE_CAP_MS), turnIdleLimitMs / 2)
    }
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
        const answerSchema = answerSchemaOf(command.schema)
        const answerSchemaKey = answerSchema === undefined ? '' : JSON.stringify(answerSchema)
        if (lastAnswerSchemaKey !== null && answerSchemaKey !== lastAnswerSchemaKey) {
          const owner = String(processMainOwner())
          clearToolRosterLatches(owner)
          clearToolRosterRestore()
          declareLawfulPrefixChange(owner, answerSchema === undefined ? 'this turn asked for no structured output' : 'this turn asked for its own structured-output schema')
        }
        lastAnswerSchemaKey = answerSchemaKey
        const assembledTools = assembleTools(state, command.schema)
        const mcpCommands = state.mcp.commands
        const dedupedCommands = [
          ...live.activeCommands,
          ...mcpCommands.filter(
            mcpCommand => !live.activeCommands.some(existing => existing.name === mcpCommand.name),
          ),
        ]
        if (sessionRowFor !== String(getSessionId())) {
          sessionRowFor = String(getSessionId())
          const withheld = toolsWithheldByDeny([...getAllBaseTools(), ...state.mcp.tools], state.toolPermissionContext)
          const facts = await sessionFactsOf(
            { cwd: getCwd(), tools: assembledTools, mcpClients: turnClients, commands: dedupedCommands, agents: activeAgents },
            live.activeModel ?? getEngineModel(),
            state.toolPermissionContext.mode,
            live.resumeOf,
            withheld.map(({ tool, rule }) => ({ tool, rule: ruleSpelling(rule.ruleValue), source: ruleSourceWords(rule.source) })),
          )
          enqueueRow(sessionRow({ session_id: getSessionId() }, facts))
          for (const entry of withheld) enqueueRow(noticeRow(liveScope(), 'warning', withheldByRuleWords(entry.tool, entry.rule), TOOL_WITHHELD_CODE))
        }
        tellSkippedProjectMcpServers()
        tellFailedMcpServers()
        for await (const message of ask({
          commands: dedupedCommands,
          prompt: promptValue,
          ...(options.syntaxInput !== undefined && command.value === inputPrompt ? { syntaxInput: options.syntaxInput } : {}),
          promptUuid,
          ...(batchUuids.length > 0 ? { batchUuids } : {}),
          ...(batchTail.length > 0 ? { batchTail } : {}),
          ...(initialNotices.length > 0 ? { initialNotices } : {}),
          isMeta: command.isMeta,
          operatorPrompt: command.mode === 'prompt' && command.isMeta !== true,
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
          userSpecifiedModel: live.activeModel,
          fallbackModel: options.fallbackModel,
          jsonSchema: answerSchema,
          mutableMessages: messages,
          onTurnMessages: read => {
            live.turnMessages = read
          },
          contentReplacementState: live.contentReplacementState,
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
            if (statusIsProgress(status)) turnWatchdog.touch()
            const promised = promisedWaitOf(status)
            if (promised !== undefined) holdPromise(promised)
            else if (typeof status === 'object' && status !== null && 'streamActivity' in status) holdPromise(null)
            const row = statusRowOf(status)
            if (row !== null) enqueueRow(row)
          },
        })) {
          turnWatchdog.touch()
          if (turnOpened(message as never)) {
            live.currentTurnId = (message as unknown as { turn_id: string }).turn_id
            if (options.door !== 'wire') for (const line of untoldHiddenCharacterLines()) process.stderr.write(`${GLYPH.warn} ${line}\n`)
          }
          onMessage(message)
        }
        tellFailedMcpServers()
      })
    } finally {
      party.turnEnd()
      turnAnchor = null
      hostAsks?.stop()
      hostAsks = null
      holdPromise(null)
      turnWatchdog.cancel()
      live.inFlightAbort = null
      currentTurn = null
      if (live.heldSeatModel !== null) {
        const held = live.heldSeatModel
        live.heldSeatModel = null
        await applySeatModel(held.model, held.words)
        io.outbound.enqueue({ method: 'session/applied', params: { request_id: held.requestId, verb: 'set_model', model: held.model } })
      }
      if (live.heldSeatEffort !== null) {
        const held = live.heldSeatEffort
        live.heldSeatEffort = null
        applySeatEffort(held.effort)
        io.outbound.enqueue({ method: 'session/applied', params: { request_id: held.requestId, verb: 'set_effort', effort: held.effort } })
      }
      holdQueuedWordsForTurnEnd(false)
      if (deferredModelBreadcrumb !== null) {
        const crumb = deferredModelBreadcrumb
        deferredModelBreadcrumb = null
        await injectModelSwitchBreadcrumbs(crumb.to, crumb.from)
      }
      if (live.deferredSpawnSwitches.length > 0) {
        const toggles = live.deferredSpawnSwitches
        live.deferredSpawnSwitches = []
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
      swarmLead.check()
      swarmResumes.check()
      void checkBuildBehind(true)
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
    if (live.inputClosed) {
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
          statusRaw === AGENT_MESSAGE_STATUS || statusRaw === 'paused'
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
    enqueueOutput: message => {
      if (isOutcome(message as never) && (message as OutcomeRow).status === 'completed' && maxTime !== undefined && Date.now() >= maxTime.at) {
        io.outbound.enqueue({ ...message, status: 'time_limit', error: { class: 'time_limit', message: OUTCOME_SENTENCES.time_limit({ maxTimeMs: maxTime.limitMs }) } } as RowDraft)
      } else io.outbound.enqueue(message)
    },
    writeDirect: async message => {
      await writeLine(message)
    },
    drainRows: () => drainRows().map(row => ({ ...row, ...(currentTurn !== null ? { turn: currentTurn } : {}) }) as RowDraft),
    beforeCycle: () => bootReady,
    onTurnStart: () => {
      live.currentTurnId = null
    },
    turnIdOf: () => {
      if (live.currentTurnId === null) live.currentTurnId = randomUUID()
      return live.currentTurnId
    },
    openTurnRow: messageIds => {
      if (live.currentTurnId === null) live.currentTurnId = randomUUID()
      return turnStartedRow({ session_id: getSessionId(), turn: currentTurn ?? live.turnsRun }, { turnId: live.currentTurnId, messageIds, model: live.activeModel ?? getEngineModel() })
    },
    executeTurn: (command, batch, onMessage, initialNotices) =>
      executeTurn(command, batch, message => {
        if (message.type === 'block_start') party.blockOpen()
        else if (message.type === 'text' || message.type === 'reasoning' || message.type === 'tool_call') party.landed()
        onMessage(message)
      }, initialNotices),
    onTurnSettled: command => {
      logHeadlessProfilerTurn()
      headlessProfilerStartTurn()
      if (turnReachedModel) void advisorMainTurnSettled(String(getSessionId()), command, messages, advisorRoad)
    },
    hasWaitableBackgroundTasks: () =>
      getRunningTasks(getAppState()).some(task => !(live.inputClosed && isLocalShellTask(task))) || (live.inputClosed && (swarmResumes.hasPending() || crewmateNoticeOwed())),
    hasHoldableBackgroundAgents: () =>
      getRunningTasks(getAppState()).some(
        task => task.type === 'local_agent',
      ),
    waitableBackgroundTaskCount: () =>
      getRunningTasks(getAppState()).filter(task => !(live.inputClosed && isLocalShellTask(task))).length + (live.inputClosed ? swarmResumes.waitingSeats() : 0),
    onAgentWait: (count, turnId) => {
      enqueueRow(turnWaitingRow({ session_id: getSessionId(), turn: live.turnsRun }, { turnId, agents: count }))
    },
    settleIdle,
    wakeSettle: () => {},
    beforeCloseOutput: async () => {
      if (isConcourseWorker) return
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
    isShuttingDown,
    idleTimerStop: () => idleTimeout.stop?.(),
    idleTimerStart: () => idleTimeout.start?.(),
    onCycleError: (error, turnId) =>
      outcomeRow(
        { session_id: getSessionId(), turn: currentTurn ?? Math.max(1, live.turnsRun) },
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
      live.inFlightAbort?.abort()
    }
    if (!live.inputClosed && sessionInitialized && !driver.isRunning() && queued.some(isMainThreadCommand)) {
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
  const party = partyFeed({
    store: () => (!live.awaitingSessionClaim && swarmSessionEnabled() ? swarmStore(false) : null),
    anchor: () => turnAnchor ?? undefined,
    record: async row => {
      if (messages.some(message => message.uuid === row.uuid)) return
      if ((peekProject()?.sessionFile ?? null) === null && hasConversationTurn(messages) && !isSessionPersistenceDisabled()) adoptResumedSessionFile()
      messages.push(row)
      await recordTranscript([row], undefined, messages)
    },
  })
  const stopParty = watchSwarmBoard(party.check)
  party.check()
  const swarmResumes = watchSwarmResumes(
    () => getLastCacheSafeParams()?.toolUseContext as ToolUseContext | undefined ?? null,
    canUseTool,
    () => sessionInitialized && !quiescence.committed && !isShuttingDown(),
  )
  const swarmLead = watchSwarmLead(
    () => sessionInitialized && !live.inputClosed && !isShuttingDown() && live.inFlightAbort === null,
    () => enqueueBoardWake('Read reference-only posts with CrewBoard.'),
    event => {
      if (party.paints(event) || messages.some(message => message.uuid === event.eventId)) return
      void recordHostNoticeRows([{ value: crewBoardNotice(event.authorName ?? event.author.agentId, event.kind, event.text), mode: 'task-notification', uuid: event.eventId as UUID, sentAt: event.createdAt }])
    },
  )
  const idleNudge = startIdleNudge({
    recipient: agentId => {
      if (agentId !== MAIN_THREAD_AGENT) return agentRecipientState(getAppState().tasks, agentId)
      if (isShuttingDown()) return { state: 'gone', why: 'the session is shutting down' }
      if (live.inputClosed) return { state: 'gone', why: "the session's input closed" }
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
  const settleOnSignal = async (code: number, cut?: string): Promise<void> => {
    signalCode = code
    const running = live.inFlightAbort !== null
    live.inFlightAbort?.abort(cut)
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
  const hostCutWords = (): string | undefined => {
    if (!isConcourseWorker) return undefined
    try {
      const workers = require('../daemon/concourseWorkers.js') as typeof import('../daemon/concourseWorkers.js')
      return workers.cutAtDrainCeiling(String(getSessionId()), process.pid) ? DRAIN_CUT_WORDS : undefined
    } catch {
      return undefined
    }
  }
  process.on('SIGINT', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGINT' })
    void settleOnSignal(130)
  })
  process.on('SIGTERM', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGTERM' })
    void settleOnSignal(143, hostCutWords())
  })
  process.on('SIGHUP', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGHUP' })
    void settleOnSignal(TERMINAL_GONE_EXIT_CODE)
  })
  markRunModeSignalsOwned()
  process.on('exit', () => saveCurrentSessionCosts())
  const buildBehindToldFor = new Set<string>()
  let buildBehindSeen: string | null = null
  let buildBehindCheckedAt = 0
  let buildBehindConfirm: ReturnType<typeof setTimeout> | null = null
  const checkBuildBehind = async (now = false): Promise<void> => {
    if (!isConcourseWorker || live.awaitingSessionClaim || live.inputClosed || live.inFlightAbort !== null) return
    if (!now && Date.now() - buildBehindCheckedAt < BUILD_BEHIND_THROTTLE_MS) return
    buildBehindCheckedAt = Date.now()
    const ownTree = runningBuildTree()
    if (ownTree === null) return
    const { deployedRuntime } = await import('../daemon/handover.js')
    const installed = deployedRuntime()
    const installedTree = installed?.buildTree ?? null
    if (installed === null || installedTree === null || installedTree === ownTree || buildBehindToldFor.has(installedTree)) {
      buildBehindSeen = null
      return
    }
    if (buildBehindSeen !== installedTree) {
      buildBehindSeen = installedTree
      if (buildBehindConfirm === null) {
        buildBehindConfirm = setTimeout(() => {
          buildBehindConfirm = null
          void checkBuildBehind(true)
        }, BUILD_BEHIND_CONFIRM_MS)
        buildBehindConfirm.unref?.()
      }
      return
    }
    if (live.inFlightAbort !== null || live.inputClosed) return
    buildBehindToldFor.add(installedTree)
    const ownTime = describeArtifactIdentity('', process.argv[1] ?? null).buildTime
    const installedTime = describeArtifactIdentity('', installed.script).buildTime
    const line = composeBuildBehindLine(installedTree, ownTree, ownTime === null || installedTime === null || installedTime > ownTime)
    const home = dirname(getTranscriptPath())
    const sid = String(getSessionId())
    try {
      if (readSessionReceipts(home, sid).some(r => r.kind === 'build-behind' && (r.details?.installedTree === installedTree || r.summary === line))) return
      appendSessionReceipt(home, sid, {
        at: new Date().toISOString(),
        by: 'runner',
        kind: 'build-behind',
        summary: line,
        details: { installedTree, runningTree: ownTree },
      })
    } catch (error) {
      logError(error)
    }
    const row = createSeatReceiptMessage(line, 'warning')
    messages.push(row)
    void recordTranscript([row], undefined, messages)
      .then(() => peekProject()?.flush())
      .catch(() => {})
  }
  const buildBehindFloor = isConcourseWorker ? setInterval(() => void checkBuildBehind(true), BUILD_BEHIND_FLOOR_MS) : null
  buildBehindFloor?.unref?.()

  const { registerCleanup } = await import('../utils/cleanupRegistry.js')
  registerCleanup(async () => {
    if (buildBehindFloor !== null) clearInterval(buildBehindFloor)
    if (buildBehindConfirm !== null) clearTimeout(buildBehindConfirm)
    releaseHookRows?.()
    idleNudge.stop()
    stopHostNotices()
    stopParty()
    swarmLead.stop()
    swarmResumes.stop()
    logForDiagnosticsNoPII('info', 'headless_sigterm_state', {
      cycle_running: driver.isRunning(),
      phase: driver.phase(),
      background_tasks: getRunningTasks(getAppState()).length,
    })
  })

  if (streamingInput) {
    const deliverLocalWake = (prompt: string, facts: LocalWakeFacts | undefined, firedAt: string, heldSince: string | undefined): void => {
      if (live.inputClosed) return
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
    initial: Object.fromEntries(getAppState().mcp.clients.filter(client => ['user', 'local', 'project', 'enterprise'].includes(client.config.scope) || client.config.extensionSource !== undefined).map(client => [client.name, client.config])),
    ready: () => !live.awaitingSessionClaim && live.mcpInitialized,
    approve: async (name, config) => {
      const written = mcpConfigAsWritten(config)
      const target = written.url ?? written.command
      const key = `mcp-project-${randomUUID()}`
      const result = await asks.askPermission({
        kind: 'tool', tool_use_id: key, tool_name: 'MCP', title: `Trust new project MCP server ${name}`,
        input: { server: name, target, scope: 'project' },
        reason: 'MCP servers may execute code or access external systems. Use this project server?',
      }, { key })
      return result.outcome === 'allow' ? 'allow' : result.unanswered === true ? 'unanswered' : 'deny'
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

  const acceptInput = async (
    input:
      | { kind: 'prompt'; content: string | ContentBlockParam[]; schema?: Record<string, unknown>; id?: string; priority?: 'now' | 'next' | 'later'; sentAt?: string; origin?: unknown }
      | { kind: 'shell'; command: string; id?: string; priority?: 'now' | 'next' | 'later'; sentAt?: string; origin?: unknown }
      | { kind: 'note'; to: string; content: string; id?: string }
      | { kind: 'outside-report'; sender: string; content: string; id?: string },
  ): Promise<{ accepted: true } | { accepted: false; reason: 'duplicate' }> => {
    await options.initializeMcp?.()
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
    if (input.kind === 'outside-report') {
      enqueue({
        value: input.content,
        mode: 'task-notification',
        origin: { kind: 'outside-report', sender: input.sender, via: 'mcp-server' },
        priority: 'next',
        ridesNextWords: true,
        skipSlashCommands: true,
        ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
      })
      return { accepted: true }
    }
    if (input.kind === 'note') {
      operatorPauseGate.lift(input.to)
      enqueue({
        value: input.content,
        mode: 'task-notification',
        agentId: input.to as never,
        origin: { kind: 'human' },
        priority: 'next',
        ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
      })
      return { accepted: true }
    }
    const sentAt = typeof input.sentAt === 'string' && Number.isFinite(Date.parse(input.sentAt)) ? input.sentAt : new Date().toISOString()
    const operatorWords = input.kind === 'prompt' && !('origin' in saturnQueueStamp(input.origin))
    if (operatorWords) operatorPauseGate.resume()
    if (operatorWords && !('origin' in screenCommandQueueStamp(input.origin))) missionSync.resumeMissionOnOperatorInput(String(getSessionId()))
    const missionWords = input.kind === 'prompt' ? missionLineOf(input.content, missionSync.MISSION_CONDITION_MAX_LENGTH) : null
    if (missionWords !== null && missionSync.isMissionClearKeyword(missionWords)) {
      missionSync.clearActiveMission(String(getSessionId()))
      if (uuid !== undefined) notifyCommandLifecycle(uuid, 'completed')
      return { accepted: true }
    }
    const missionSet = missionWords !== null && missionWords !== ''
    const command: QueuedCommand = {
      value: missionSet ? missionSync.setActiveMission(missionWords, { sessionId: String(getSessionId()) }) : input.kind === 'shell' ? input.command : input.content,
      mode: input.kind === 'shell' ? 'bash' : 'prompt',
      sentAt,
      ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.kind === 'prompt' && input.schema !== undefined ? { schema: input.schema } : {}),
      ...saturnQueueStamp(input.origin),
      ...screenCommandQueueStamp(input.origin),
      ...(missionSet ? { isMeta: true } : {}),
    }
    if (localCommandInput(command)) command.localCommand = true
    enqueue(command)
    if (input.kind === 'prompt' && command.localCommand !== true && input.priority !== 'later' && !('origin' in saturnQueueStamp(input.origin)) && driver.isRunning() && !queuedWordsWaitForTurnEnd()) {
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
    const schemaRefusal = promptSchemaRefusal(row)
    if (schemaRefusal !== null) throw invalidParams('queue/add', [{ path: ['schema'], message: schemaRefusal }])
    if (row.type === 'outside-report') return acceptInput({ kind: 'outside-report', sender: row.sender, content: row.content, ...(row.id !== undefined ? { id: row.id } : {}) })
    if (row.type === 'note') return acceptInput({ kind: 'note', to: row.to, content: row.content, ...(row.id !== undefined ? { id: row.id } : {}) })
    const stamp = {
      ...(row.id !== undefined ? { id: row.id } : {}),
      ...(row.priority !== undefined ? { priority: row.priority } : {}),
      ...(row.sent_at !== undefined ? { sentAt: row.sent_at } : {}),
      ...(row.origin !== undefined ? { origin: row.origin } : {}),
    }
    if (row.type === 'shell') return acceptInput({ kind: 'shell', command: row.command, ...stamp })
    return acceptInput({ kind: 'prompt', content: promptContentOf(row.content), ...(row.schema !== undefined ? { schema: row.schema } : {}), ...stamp })
  }

  async function* claimGatedInput(
    source: AsyncGenerator<InputRow, void, unknown>,
  ): AsyncGenerator<InputRow, void, unknown> {
    const parked: InputRow[] = []
    for await (const row of source) {
      if (live.awaitingSessionClaim) {
        logForDebugging('[session-runner] an input row arrived before the claim — parked until the session identity lands')
        parked.push(row)
        continue
      }
      yield row
      while (!live.awaitingSessionClaim && parked.length > 0) {
        yield parked.shift()!
      }
    }
  }

  const heldNoticeWaits = (): boolean =>
    !sessionInitialized &&
    isConcourseWorker &&
    !live.awaitingSessionClaim &&
    !live.inputClosed &&
    !driver.isRunning() &&
    getCommandQueue().some(command => isMainThreadCommand(command) && (isHeldNotice(command) || isOperatorLine(command)))
  const ports: RunnerPorts = { live, options, wire, io, peer, asks, driver, messages, getAppState, setAppState, canUseTool, enqueueRow, liveScope, acceptInputRow, heldNoticeWaits, interruptOutcomes, quiescence, relaunchContext, checkBuildBehind, getReadFileCache, applySeatModel, applySeatEffort, landSpawnSwitch, settleSessionBriefs, armSessionRunnerWiring, hydrateResumedRun, persistBootModelRefusal, settleClearBirth, releaseQueueUntilClaimed, missionGuard, liveMcp, mcpSignIns, elicitationRegistered, permittedMcpConfig, serializeMcpChange, reconnectLiveMcp, resolveServerConfigFromAllSources, applyReconnectedClient, registerPerTurnHandlers, isLocalShellTask, killTask, requestShellBackground }
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
      live.inputClosed = true
      setRunInputClosed(true)
      if (!driver.isRunning()) {
        await stopShellsForClose()
        await driver.closeOutputOnce()
      }
    }
  })()

  const recordFlushFailure = (): Promise<string | null> => Promise.resolve(peekProject()?.flush()).then(() => null, (error: unknown) => errorMessage(error))
  let unwrittenRecord: string | null = null
  for await (const outboundMessage of io.outbound) {
    if (isOutcome(outboundMessage as never)) {
      unwrittenRecord = await recordFlushFailure()
      if (unwrittenRecord !== null) {
        const ended = outboundMessage as Unstamped<OutcomeRow>
        const unwritten = { level: 'error' as const, text: unwrittenRecord }
        const told: Unstamped<OutcomeRow> = { ...ended, notices: [...(ended.notices ?? []), unwritten] }
        routeOutbound(noticeRow({ session_id: ended.session_id, turn: ended.turn }, unwritten.level, unwritten.text))
        routeOutbound(told)
        continue
      }
    }
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
        { session_id: getSessionId(), turn: Math.max(1, live.turnsRun) },
        {
          turnId: live.currentTurnId ?? randomUUID(),
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
    await flushWrite(process.stdout, `${ndjsonSafeStringify(last)}\n`)
  } else if (options.outputFormat !== 'rows') {
    if (last.status === 'completed') {
      const text = caretEscape(last.answer ?? '')
      await flushWrite(process.stdout, text.endsWith('\n') ? text : `${text}\n`)
    } else {
      if ((last.status === 'blocked' || last.status === 'turn_limit') && last.answer) await flushWrite(process.stdout, caretEscape(last.answer).replace(/\n?$/, '\n'))
      const sentence =
        last.status === 'refused' || last.status === 'failed'
          ? (last.error?.message ?? (last.status === 'refused' ? 'The request was refused' : 'The turn failed'))
          : OUTCOME_SENTENCES[last.status]({ maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, maxTimeMs: options.maxTimeMs, message: last.error?.message })
      await flushWrite(process.stderr, `${sentence}\n`)
    }
  }

  if (unwrittenRecord !== null) unwrittenRecord = await recordFlushFailure()
  if (unwrittenRecord !== null) await flushWrite(process.stderr, `Error: ${unwrittenRecord}\n`)

  logHeadlessProfilerTurn()
  noteRunPhase('flush_exit')
  logForDebugging(`[run-phases] ${jsonStringify(runPhaseReport(getTotalAPIDuration()))}`)
  gracefulShutdownSync(io.stdoutPipeBroken ? 1 : (signalCode ?? (unwrittenRecord !== null ? 1 : exitCodeOf(last.status))))
}
