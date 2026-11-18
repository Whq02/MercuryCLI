import { requestShellBackground } from '../tools/BashTool/backgroundRequest.js'
import { randomUUID, type UUID } from 'node:crypto'
import {
  getEngineModelOverride,
  getSessionId,
  setEngineModelOverride,
  getMainThreadAgentType,
  isSessionPersistenceDisabled,
  setAskChannel,
  setRunInputClosed,
  setSessionKind,
} from '../bootstrap/state.js'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hasConversationTurn } from '../utils/conversationRecovery.js'
import { reconstructContentReplacementState } from '../utils/toolResultStorage.js'
import { adoptResumedSessionFile, flushSessionStorage, getSessionMessages, peekProject, recordTranscript } from '../utils/sessionStorage/writer.js'
import { RunnerQuiescence } from '../daemon/runnerQuiescence.js'
import { sessionFilePath } from '../utils/sessionStorage/loading.js'
import { claimSessionWriter } from '../utils/sessionStorage/sessionWriter.js'
import { refreshBoxReading } from '../utils/boxLock.js'
import { requestDeliberateToolChange } from '../services/providers/lawfulPrefixChange.js'
import { watchLiveMcpConfig } from '../services/mcp/liveConfig.js'
import { dynamicMcpConfigSnapshot, isStrictMcpConfigSeed } from '../services/mcp/dynamicMcpSeed.js'
import { bootModelRefusalLine, resolveHeadlessModel } from './headless/model.js'
import { formatPrintsOutcomeRow, refusedOutcome } from './headless/refusalEnvelope.js'
import { createSeatReceiptMessage } from '../utils/messages/systemMessages.js'
import { DRAIN_CUT_WORDS } from '../utils/messages/turnCut.js'
import {
  scheduleEditToWire,
} from '../services/engine-connector/seatWire.js'
import { commandOutputRow, compactionClearedRow, compactionRow, heartbeatRow, missionUpdatedRow, modeRow, noticeRow, rateLimitRow, samplesUpdatedRow, waitRow, type RowDraft, type RowScope, type Unstamped } from '../rows/project.js'
import { type CompactionRow, type InputRow, type OutcomeRow, type Row } from '../rows/vocabulary.js'
import { isOutcome } from '../rows/read.js'
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
import { INPUT_REFUSED_CODE, isBrokenPipeError, isRowLine, StructuredIO, type OutboundLine } from './structuredIO.js'
import { createRuleOnlyAsks, createRunnerAsks, type AskHost } from './headless/runnerAsks.js'
import { bindRunnerMethods, checkProtocol, DEFAULT_CAPABILITIES, initializeResultOf } from './headless/runnerMethods.js'
import { createRunnerState, type HeadlessOptions, type RunnerPorts } from './headless/runnerPorts.js'
import { runnerArmsOf } from './headless/runnerArms.js'
import { finishPrintRun, pumpOutbound } from './headless/printRunEnd.js'
import { hydrateResumedRun } from './headless/resumeHydration.js'
import * as inputDoor from './headless/inputDoor.js'
import * as printTurn from './headless/printTurn.js'
import * as printDriver from './headless/printDriver.js'
import { runnerParkRefusal } from './headless/parkRefusal.js'
import { landSpawnSwitch as landSwitch } from './headless/spawnSwitchLanding.js'
import { priorTurnCount } from './headless/claimSession.js'
import { fileCheckpointsFact } from './headless/sessionFactsArm.js'
import { createPeer, type Peer } from '../runner/wire/peer.js'
import { invalidParams } from '../runner/wire/errors.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import { statusListeners, type AnthropicLimits } from '../services/anthropicLimits.js'
import {
  clearServerCache,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  reconnectMcpServerImpl,
} from '../services/mcp/client.js'
import { getMcpPrefix } from '../services/mcp/mcpStringUtils.js'
import { isMcpCatalogueMember } from '../services/mcp/membership.js'
import { dropMcpServerFromAppState } from '../services/mcp/kitDial.js'
import { subscribeSampleChanges } from '../services/samples/store.js'
import {
  registerScheduleEditDoor,
} from '../services/saturn/sessionScheduleBridge.js'
import { registerIdeToolDoor } from '../services/acp/ideToolBridge.js'
import { crewBoardNotice } from '../utils/messages/noticeRows.js'
import { type AdvisorQuiet } from '../services/advisor/index.js'
import { enqueueBoardWake, swarmSessionEnabled, swarmStore, watchSwarmBoard, watchSwarmLead, watchSwarmResumes } from '../services/crewBoard/seam.js'
import { partyFeed } from '../services/crewBoard/party.js'
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
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import { gracefulShutdown, gracefulShutdownSync, isShuttingDown, markRunModeSignalsOwned, TERMINAL_GONE_EXIT_CODE } from '../utils/gracefulShutdown.js'
import { saveCurrentSessionCosts } from '../cost-tracker.js'
import {
  headlessProfilerStartTurn,
} from '../utils/headlessProfiler.js'
import { subscribeHookExecutionEvents } from '../utils/hooks/hookEvents.js'
import { hookTaskRow } from '../utils/hooks/rows.js'
import { takeFirstPrompt } from '../utils/sessionStart.js'
import { createIdleTimeoutManager } from '../utils/idleTimeout.js'
import { flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'

const SIGNAL_SETTLE_MS = 5_000
const BUILD_BEHIND_FLOOR_MS = 60_000
const BUILD_BEHIND_THROTTLE_MS = 2_000
const BUILD_BEHIND_CONFIRM_MS = 2_000
import { logError } from '../utils/log.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import type { Message } from '../types/message.js'
import type { ContentBlockParam } from '../types/wire.js'
import {
  dequeue,
  enqueue,
  subscribeToCommandQueue,
  getCommandQueue,
} from '../utils/messageQueueManager.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { isHeldNotice, isOperatorLine } from '../input-core/command-queue.js'
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
import { noteRunPhase } from '../utils/runPhases.js'
import { getPerformance } from '../utils/profilerBase.js'
import { buildSideQuestionFallbackParams } from '../utils/queryContext.js'
import { armLocalWarm } from '../services/providers/local/localWarm.js'
import { extractReadFilesFromMessages } from '../utils/queryHelpers.js'
import {
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
import { getRunningTasks } from '../utils/task/framework.js'
import { markSessionBootRules, markSessionNonInteractive } from '../utils/cockpit/runtimePosture.js'
import { consumeSessionKindPin } from '../utils/sessionKind.js'
import { describeArtifactIdentity, runningBuildTree } from '../utils/artifactIdentity.js'
import { getTranscriptPath, isChainParticipant } from '../utils/sessionStorage/paths.js'
import { appendSessionReceipt, readSessionReceipts, settleClearModel } from '../services/switchboard/sessionReceipts.js'
import { composeBuildBehindLine } from '../tools/MonitorTool/watchReceipts.js'
import { windowsShellRoadNotice } from '../utils/shell/windowsShellRoad.js'
import { drainRows, subscribeRows } from '../utils/sdkEventQueue.js'
import { onTasksUpdated } from '../utils/tasks.js'

import { compileJsonSchema } from '../services/schema/jsonSchemaEngine.js'
import { getAllBaseTools, toolsWithheldByDeny } from '../tools.js'
import { withheldByRuleWords } from '../utils/permissions/ruleReason.js'
import { MCP_SERVER_FAILED_CODE, MCP_SERVER_SKIPPED_CODE } from '../rows/vocabulary.js'
import { mcpConfigAsWritten, mcpServerFailedWords, mcpServersFailed } from '../services/mcp/utils.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { getCwd } from '../utils/cwd.js'

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
  const ports: RunnerPorts = {
    live,
    options,
    get wire() { return wire },
    get io() { return io },
    get peer() { return peer },
    get asks() { return asks },
    get driver() { return driver },
    get messages() { return messages },
    getAppState,
    setAppState,
    get canUseTool() { return canUseTool },
    get enqueueRow() { return enqueueRow },
    get liveScope() { return liveScope },
    get acceptInputRow() { return acceptInputRow },
    get heldNoticeWaits() { return heldNoticeWaits },
    get interruptOutcomes() { return interruptOutcomes },
    get quiescence() { return quiescence },
    get relaunchContext() { return relaunchContext },
    get checkBuildBehind() { return checkBuildBehind },
    get getReadFileCache() { return getReadFileCache },
    get applySeatModel() { return applySeatModel },
    get applySeatEffort() { return applySeatEffort },
    get landSpawnSwitch() { return landSpawnSwitch },
    get settleSessionBriefs() { return settleSessionBriefs },
    get armSessionRunnerWiring() { return armSessionRunnerWiring },
    hydrateResumedRun: () => hydrateResumedRun(ports),
    get persistBootModelRefusal() { return persistBootModelRefusal },
    get settleClearBirth() { return settleClearBirth },
    get releaseQueueUntilClaimed() { return releaseQueueUntilClaimed },
    get missionGuard() { return missionGuard },
    get liveMcp() { return liveMcp },
    get mcpSignIns() { return mcpSignIns },
    get elicitationRegistered() { return elicitationRegistered },
    get permittedMcpConfig() { return permittedMcpConfig },
    get serializeMcpChange() { return serializeMcpChange },
    get reconnectLiveMcp() { return reconnectLiveMcp },
    get resolveServerConfigFromAllSources() { return resolveServerConfigFromAllSources },
    get applyReconnectedClient() { return applyReconnectedClient },
    get registerPerTurnHandlers() { return registerPerTurnHandlers },
    isLocalShellTask,
    killTask,
    requestShellBackground,
    get routeOutbound() { return routeOutbound },
    get streamingInput() { return streamingInput },
    get acceptInput() { return acceptInput },
    get receivedUuids() { return receivedUuids },
    get missionLineOf() { return missionLineOf },
    get localCommandInput() { return localCommandInput },
    get announcedNotifications() { return announcedNotifications },
    get emitTaskNotificationFrames() { return emitTaskNotificationFrames },
    get emitCommandNotifications() { return emitCommandNotifications },
    inputPrompt,
    get maxTime() { return maxTime },
    get sessionTools() { return sessionTools },
    get baseToolNames() { return baseToolNames },
    get answerSchemaOf() { return answerSchemaOf },
    get assembleTools() { return assembleTools },
    get registerElicitationHandlersForClient() { return registerElicitationHandlersForClient },
    get setReadFileCache() { return setReadFileCache },
    get statusIsProgress() { return statusIsProgress },
    get promisedWaitOf() { return promisedWaitOf },
    get statusRowOf() { return statusRowOf },
    get tellFailedMcpServers() { return tellFailedMcpServers },
    get tellSkippedProjectMcpServers() { return tellSkippedProjectMcpServers },
    get recordNoticeRows() { return recordNoticeRows },
    get recordHostNoticeRows() { return recordHostNoticeRows },
    get injectModelSwitchBreadcrumbs() { return injectModelSwitchBreadcrumbs },
    get advisorRoad() { return advisorRoad },
    get landAdvisorQuiet() { return landAdvisorQuiet },
    get party() { return party },
    get swarmLead() { return swarmLead },
    get swarmResumes() { return swarmResumes },
    get bootReady() { return bootReady },
    get isConcourseWorker() { return isConcourseWorker },
    get isMainThreadCommand() { return isMainThreadCommand },
    get takeMainThread() { return takeMainThread },
    get executeTurn() { return executeTurn },
    get settleIdle() { return settleIdle },
    get idleTimeout() { return idleTimeout },
    get writeLine() { return writeLine },
    get disarmAgentFreshness() { return disarmAgentFreshness },
    get stopDrainedNotificationFrames() { return stopDrainedNotificationFrames },
    get stopSdkDrain() { return stopSdkDrain },
    get rateLimitListener() { return rateLimitListener },
    get carriersOf() { return carriersOf },
    get retireQueuedCommands() { return retireQueuedCommands },
  }
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
  live.capabilities = { ...DEFAULT_CAPABILITIES }
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
  const asks: AskHost = peer !== null ? createRunnerAsks(peer, () => live.capabilities) : createRuleOnlyAsks()
  if (peer !== null) {
    registerScheduleEditDoor((edit, signal) => peer.request('schedule/edit', { edit: scheduleEditToWire(edit) }, { signal }))
    registerIdeToolDoor({
      capabilities: () => ({
        readTextFile: live.capabilities.fs_read_text_file === true,
        writeTextFile: live.capabilities.fs_write_text_file === true,
        terminal: live.capabilities.terminal === true,
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
      live.capabilities = params.capabilities
      if (params.file_checkpoints !== undefined) requestFileCheckpoints(params.file_checkpoints)
      await bootReady
      if (params.schema !== undefined) {
        const compiled = compileJsonSchema(params.schema)
        if (!compiled.ok) throw invalidParams('initialize', [{ path: ['schema'], message: `not a JSON schema — ${compiled.error}` }])
        live.initializeJsonSchema = params.schema
      }
      return initializeResultOf(live.awaitingSessionClaim ? null : String(getSessionId()), fileCheckpointsFact())
    })
    bindRunnerMethods(peer, () => runnerArmsOf(ports))
  }
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
  const liveScope = (): RowScope => ({ session_id: getSessionId(), ...(live.currentTurn !== null ? { turn: live.currentTurn } : {}) })
  const enqueueRow = (row: RowDraft): void => io.outbound.enqueue(row)
  const hookRowsActive = peer !== null || options.outputFormat === 'rows'
  const releaseHookRows = hookRowsActive
    ? subscribeHookExecutionEvents(event => {
        if (live.currentTurn === null) enqueueRow(hookTaskRow(liveScope(), event))
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

  if (options.continue || options.resume) await hydrateResumedRun(ports)

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
  live.thinkingConfig = options.thinkingConfig
  live.activeCommands = commands
  live.activeAgents = agents
  const receivedUuids = new BoundedUuidSet(RECEIVED_UUID_CAP)
  const interruptOutcomes = new Map<string, boolean>()
  asks.setOnControlRequestSent(() => live.hostAsks?.noteParked())
  asks.setOnControlRequestResolved(() => live.hostAsks?.noteSettled())
  const landAdvisorQuiet = (quiet: AdvisorQuiet): void => printDriver.landAdvisorQuiet(quiet, ports)
  const advisorRoad = printDriver.advisorRoadOf(ports)
  const landSpawnSwitch = (kind: 'subagents', on: boolean): void => landSwitch(kind, on, ports)

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
  const registerPerTurnHandlers = (clients: MCPServerConnection[]): void => printTurn.registerPerTurnHandlers(clients, ports)
  const registerElicitationHandlersForClient = (client: ConnectedMCPServer, serverName: string): Promise<void> => printTurn.registerElicitationHandlersForClient(client, serverName, ports)

  const baseToolNames = new Set(getAllBaseTools().map(tool => tool.name))
  const answerSchemaOf = (turnSchema: Record<string, unknown> | undefined): Record<string, unknown> | undefined => turnSchema ?? live.initializeJsonSchema ?? options.jsonSchema
  const assembleTools = (state: AppState, turnSchema?: Record<string, unknown>): Tool[] => printTurn.assembleTurnTools(state, turnSchema, ports)

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
  armLocalWarm(() => buildSideQuestionFallbackParams({ tools: assembleTools(getAppState()), commands: live.activeCommands, mcpClients: getAppState().mcp.clients, messages, readFileState: getReadFileCache(), getAppState, setAppState, customSystemPrompt: options.systemPrompt, appendSystemPrompt: options.appendSystemPrompt, thinkingConfig: live.thinkingConfig, agents: live.activeAgents }), { live: () => !live.awaitingSessionClaim && live.inFlightAbort === null })

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
    getActive: () => live.activeAgents,
    setActive: next => {
      live.activeAgents = next
    },
  })

  const isMainThreadCommand = (command: QueuedCommand): boolean =>
    command.agentId === undefined
  const takeMainThread = (): QueuedCommand | undefined => dequeue(isMainThreadCommand)

  const recordNoticeRows = async (notices: readonly QueuedCommand[], mark: { isVirtual: true } | { isMeta: true }): Promise<void> => {
    const { createUserMessage } = await import('../utils/messages/factories.js')
    const rows = notices.map(notice => createUserMessage({ content: notice.value, ...mark, origin: { kind: 'task-notification' }, ...(notice.uuid !== undefined ? { uuid: notice.uuid } : {}), ...(notice.sentAt !== undefined ? { timestamp: notice.sentAt } : {}) }))
    messages.push(...rows)
    await recordTranscript(rows, undefined, messages).catch((error: unknown) => {
      logForDebugging(`host notice: the row was not recorded — ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const recordHostNoticeRows = (notices: readonly QueuedCommand[]): Promise<void> => recordNoticeRows(notices, { isVirtual: true })
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
  const executeTurn = (command: QueuedCommand, batch: QueuedCommand[], onMessage: (message: RowDraft) => void, initialNotices?: QueuedCommand[]): Promise<void> => printTurn.runPrintTurn(command, batch, onMessage, initialNotices, ports)

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
    refusal: () => runnerParkRefusal(ports),
    flush: () => flushSessionStorage(),
  })
  subscribeToCommandQueue(() => {
    if (getCommandQueue().length > 0) quiescence.invalidate()
  })

  live.lastOutcomeWritten = Promise.resolve()
  const writeLine = (message: OutboundLine): Promise<Row | null> => {
    if (peer === null) return io.write(message)
    if (io.stdoutPipeBroken) return Promise.resolve(null)
    if (isRowLine(message)) {
      const row = io.rows.stamp(message as never)
      peer.notify('row', row as never)
      return peer.flush().then(() => row)
    }
    if (message.method === 'elicitation/complete') {
      if (live.capabilities.elicitation) peer.notify(message.method, message.params)
    } else peer.notify(message.method, message.params)
    return peer.flush().then(() => null)
  }
  const routeOutbound = (message: OutboundLine): void => {
    foldLanded(message)
    if (options.outputFormat === 'rows') {
      const written = writeLine(message)
      if (isOutcome(message as never)) {
        live.lastOutcomeWritten = written.then(line => {
          if (line !== null) live.lastOutcome = line as OutcomeRow
        })
      }
      void written.catch(error => logError(error))
      return
    }
    if (isOutcome(message as never)) live.lastOutcome = io.rows.stamp(message as never) as OutcomeRow
  }

  const emitTaskNotificationFrames = (payloads: readonly string[]): void => inputDoor.emitTaskNotificationFrames(payloads, ports)

  const announcedNotifications = new WeakSet<QueuedCommand>()
  const emitCommandNotifications = (commands: readonly QueuedCommand[]): void => inputDoor.emitCommandNotifications(commands, ports)

  const retireQueuedCommands = (commands: QueuedCommand[]): void => inputDoor.retireQueuedCommands(commands, ports)
  const stopDrainedNotificationFrames = inputDoor.watchDrainedNotifications(ports)

  const driver: TurnDriver = createTurnDriver(printDriver.printDriverPorts(ports))

  const stopSdkDrain = subscribeRows(() => {
    for (const row of drainRows()) enqueueRow({ ...row, ...(live.currentTurn !== null ? { turn: live.currentTurn } : {}) } as RowDraft)
  })
  subscribeToCommandQueue(() => {
    const queued = getCommandQueue()
    if (queued.some(command => command.priority === 'now')) {
      live.inFlightAbort?.abort()
    }
    if (!live.inputClosed && live.sessionInitialized && !driver.isRunning() && queued.some(isMainThreadCommand)) {
      driver.kick()
      if (!driver.isRunning()) emitCommandNotifications(queued.filter(isMainThreadCommand))
    }
  })

  const carriersOf = (notices: readonly NoticeRecord[]): QueuedCommand[] => printDriver.carriersOf(notices)
  const { watchHostNotices } = await import('../services/host/notices.js')
  const stopHostNotices = watchHostNotices(() => getSessionId())
  const party = partyFeed({
    store: () => (!live.awaitingSessionClaim && swarmSessionEnabled() ? swarmStore(false) : null),
    anchor: () => live.turnAnchor ?? undefined,
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
    () => live.sessionInitialized && !quiescence.committed && !isShuttingDown(),
  )
  const swarmLead = watchSwarmLead(
    () => live.sessionInitialized && !live.inputClosed && !isShuttingDown() && live.inFlightAbort === null,
    () => enqueueBoardWake('Read reference-only posts with CrewBoard.'),
    event => {
      if (party.paints(event) || messages.some(message => message.uuid === event.eventId)) return
      void recordHostNoticeRows([{ value: crewBoardNotice(event.authorName ?? event.author.agentId, event.kind, event.text), mode: 'task-notification', uuid: event.eventId as UUID, sentAt: event.createdAt }])
    },
  )
  const idleNudge = printDriver.startRunnerIdleNudge(ports)

  const settleOnSignal = async (code: number, cut?: string): Promise<void> => {
    live.signalCode = code
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
    await live.lastOutcomeWritten
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

  inputDoor.armLocalWake(ports)


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

  const acceptInput = (input: inputDoor.AcceptedInput): Promise<inputDoor.InputVerdict> => inputDoor.acceptInput(input, ports)

  const acceptInputRow = (row: InputRow): Promise<inputDoor.InputVerdict> => inputDoor.acceptInputRow(row, ports)

  const claimGatedInput = (source: AsyncGenerator<InputRow, void, unknown>): AsyncGenerator<InputRow, void, unknown> => inputDoor.claimGatedInput(source, ports)

  const heldNoticeWaits = (): boolean =>
    !live.sessionInitialized &&
    isConcourseWorker &&
    !live.awaitingSessionClaim &&
    !live.inputClosed &&
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
      live.inputClosed = true
      setRunInputClosed(true)
      if (!driver.isRunning()) {
        await stopShellsForClose()
        await driver.closeOutputOnce()
      }
    }
  })()

  const unwrittenRecord = await pumpOutbound(ports)
  await stdinLoop.catch((error: unknown) => {
    logError(error)
  })

  await finishPrintRun(unwrittenRecord, ports)
}
