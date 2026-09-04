import { randomUUID, type UUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { liveSkillRootsOf, pruneSkillSessionHooks } from '../utils/hooks/sessionHooks.js'
import {
  getMainLoopModelOverride,
  getSessionId,
  registerHookCallbacks,
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
  getAddedDirectories,
  isSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionId } from '../types/ids.js'
import { loadConversationForResume } from '../utils/conversationRecovery.js'
import { resetSessionFilePointer, restoreSessionMetadata } from '../utils/sessionStorage.js'
import { peekProject } from '../utils/sessionStorage/writer.js'
import type { PermissionMode as WirePermissionMode } from '../types/permissions.js'
import { consumeSessionHomePin } from '../utils/sessionStorage/sessionHomePin.js'
import { SPAWN_SWITCH_LABEL, setSpawnSwitch, spawnSwitchFacts, spawnSwitchTransitionLine } from '../services/switchboard/spawnSwitches.js'
import { declareLawfulPrefixChange } from '../services/providers/lawfulPrefixChange.js'
import { createRosterTransitionMessage } from '../utils/messages/systemMessages.js'
import { dropCredentialMemos, is1PApiCustomer } from '../utils/auth.js'
import { hasClaudeAiBillingAccess, hasConsoleBillingAccess } from '../utils/billing.js'
import { getCurrentProjectConfig, getGlobalConfig } from '../utils/config.js'
import { mcpRosterEntriesOf, skillsRosterOf } from '../services/engine-connector/rosterTerms.js'
import type { SessionFactsAnswerV1 } from '../services/engine-connector/seatProjections.js'
import { openaiObservedUsage } from '../services/providers/openai/openaiLimitState.js'
import { ask } from '../QueryEngine.js'
import { getCommands, findCommand, clearCommandMemoizationCaches, formatDescriptionWithSource } from '../commands.js'
import { collectContextData } from '../commands/context/context-noninteractive.js'
import {
  handleChannelEnable,
  handleInitializeRequest,
  handleMcpSetServers,
  handleOrphanedPermissionResponse,
  handleRewindFiles,
  handleRewindSession,
  handleSetPermissionMode,
  reconcileMcpServers,
  reregisterChannelHandlerAfterReconnect,
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
import { isBrokenPipeError, StructuredIO } from './structuredIO.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
  StdinMessage,
  StdoutMessage,
} from '../entrypoints/sdk/controlTypes.js'
import { initializeFeatureGates } from '../services/analytics/featureGates.js'
import { statusListeners, type ClaudeAILimits } from '../services/claudeAiLimits.js'
import { providerLimitWarning } from '../services/providers/limitWarning.js'
import {
  clearServerCache,
  connectToServer,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  setupSdkMcpClients,
} from '../services/mcp/client.js'
import { registerEditorCompanion } from '../services/mcp/vscodeSdkMcp.js'
import { getMcpPrefix } from '../services/mcp/mcpStringUtils.js'
import { isMcpCatalogueMember } from '../services/mcp/membership.js'
import { applyProcessSessionKitEdit, completeProcessSessionKit, sessionKitOf, setProcessSessionKit } from '../services/mcp/sessionKitPin.js'
import { kitDialCandidates, kitEditMcpDelta, dropMcpServerFromAppState } from '../services/mcp/kitDial.js'
import { validateSessionKit } from '../daemon/sessionKit.js'
import {
  latchSessionScheduleRoster,
  markScheduleSeatObserved,
  registerLocalWakeSink,
  takePendingScheduleEdits,
} from '../services/saturn/sessionScheduleBridge.js'
import { offSkillNamesOf } from '../skills/kitGovernance.js'
import { disabledMcpServerNamesIn } from '../services/mcp/disabledRecord.js'
import {
  logSuggestionSuppressed,
  tryGenerateSuggestion,
} from '../services/PromptSuggestion/promptSuggestion.js'
import {
  getMcpConfigByName,
} from '../services/mcp/config.js'
import { revokeServerTokens } from '../services/mcp/auth.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  McpSdkServerConfig,
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
import { gracefulShutdown, gracefulShutdownSync, isShuttingDown } from '../utils/gracefulShutdown.js'
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
import { flagEnv } from '../substrate/flagRegistry.js'

const DEFAULT_HEADLESS_IDLE_MINUTES = 20
import { getInMemoryErrors, logError } from '../utils/log.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { getRunSnapshot, reconcileOnResume } from '../services/run/runCoordinator.js'
import { toSDKRateLimitInfo } from '../utils/messages/mappers.js'
import type { Message } from '../types/message.js'
import type { ContentBlockParam } from '../types/wire.js'
import type { McpServerConfigForProcessTransport, ModelInfo } from '../entrypoints/agentSdkTypes.js'
import type { JSONRPCMessage } from '../services/mcp/sdk.js'
import {
  dequeue,
  enqueue,
  peek,
  remove as removeQueuedCommands,
  subscribeToCommandQueue,
  getCommandQueue,
} from '../utils/messageQueueManager.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
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
import { extractReadFilesFromMessages } from '../utils/queryHelpers.js'
import {
  cacheSessionTitle,
  doesMessageExistInSession,
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
import { getRunningTasks } from '../utils/task/framework.js'
import { AGENT_RESUME_NOTE, AGENT_STOP_BY_OPERATOR } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalWorkflowTask, killWorkflowTask } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { primeOpenaiCatalogue } from '../services/providers/openai/openaiCatalogue.js'
import { stopOrDismissAgent } from '../state/teammateViewHelpers.js'
import { markSessionNonInteractive } from '../utils/cockpit/runtimePosture.js'
import { drainSdkEvents } from '../utils/sdkEventQueue.js'
import { projectWorkRoster } from '../utils/task/workRoster.js'
import { getTaskListId as missionListId, listTasks as listMissionTasks } from '../utils/tasks.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import { createSyntheticOutputTool, isSyntheticOutputToolEnabled } from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { filterToolsByDenyRules, getAllBaseTools, getTools } from '../tools.js'
import { getTeamName, isTeammate } from '../utils/teammate.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { expandPath } from '../utils/path.js'
import { getCwd } from '../utils/cwd.js'
import { providerFamilyOfSetting } from '../utils/model/modelTransition.js'
import { streamIdleTimeoutMsForRoute } from '../services/providers/streamIdleBudget.js'
import { normalizeControlMessageKeys } from '../utils/controlMessageCompat.js'
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

const SUGGESTION_CLOSE_WAIT_MS = 5_000
const TEAM_POLL_INTERVAL_MS = 500
const CONCOURSE_INTERRUPT_PREFIX = 'concourse-interrupt-'
const INTERRUPT_DEDUPE_CAP = 200
const RECEIVED_UUID_CAP = 10_000

type HeadlessOptions = {
  continue?: boolean
  resume?: string | boolean
  resumeSessionAt?: string
  verbose?: boolean
  outputFormat?: string
  jsonSchema?: Record<string, unknown>
  permissionPromptToolName?: string
  allowedTools?: string[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  systemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  forkSession?: boolean
  rewindFiles?: string
  enableAuthStatus?: boolean
  agent?: string
  workload?: string
  setupTrigger?: 'init' | 'maintenance'
  bootSessionIdPinned?: boolean
  sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
  setSDKStatus?: unknown
  promptSuggestionEnabled?: boolean
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
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  supportsAdaptiveThinking?: boolean
  supportsAutoMode?: boolean
}

function buildModelCatalogue(): ModelCatalogueEntry[] {
  const options = getModelOptions()
  return options.map(option => {
    const resolved =
      option.value === null
        ? getMainLoopModel()
        : (parseUserSpecifiedModel(option.value) ?? option.value)
    const entry: ModelCatalogueEntry = {
      value: option.value === null ? 'default' : option.value,
      displayName: option.label,
      description: option.description,
    }
    if (modelSupportsEffort(resolved)) {
      entry.supportsEffort = true
      entry.supportedEffortLevels = [...resolveEffortTruth(resolved, undefined).selectable]
    }
    if (modelSupportsAdaptiveThinking(resolved)) entry.supportsAdaptiveThinking = true
    if (modelSupportsAutoMode(resolved)) entry.supportsAutoMode = true
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
  markSessionNonInteractive(getAppState().toolPermissionContext?.mode)
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
  void initializeFeatureGates()

  if (options.resumeSessionAt !== undefined && !options.resume) {
    process.stderr.write('--resume-session-at requires --resume\n')
    gracefulShutdownSync(1)
    return
  }
  if (options.rewindFiles !== undefined && !options.resume) {
    process.stderr.write('--rewind-files requires --resume\n')
    gracefulShutdownSync(1)
    return
  }
  if (
    options.rewindFiles !== undefined &&
    typeof inputPrompt === 'string' &&
    inputPrompt.trim().length > 0
  ) {
    process.stderr.write('--rewind-files is a standalone operation and cannot be combined with a prompt\n')
    gracefulShutdownSync(1)
    return
  }

  const io = new StructuredIO(
    normalizeInputPrompt(inputPrompt),
    options.replayUserMessages,
  )
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

  if (options.outputFormat === 'stream-json' && options.verbose) {
    registerHookEventHandler(event => {
      const subtype =
        event.type === 'started'
          ? 'hook_started'
          : event.type === 'progress'
            ? 'hook_progress'
            : 'hook_response'
      io.outbound.enqueue({
        type: 'system',
        subtype,
        hook_id: event.hookId,
        hook_name: event.hookName,
        hook_event: event.hookEvent,
        ...(event.type !== 'started'
          ? { stdout: event.stdout, stderr: event.stderr, output: event.output }
          : {}),
        ...(event.type === 'response'
          ? { exit_code: event.exitCode, outcome: event.outcome }
          : {}),
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    })
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
    restoredWorkerState: io.restoredWorkerState,
  })
  const messages: Message[] = loaded.messages

  const isConcourseWorker = flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  let awaitingSessionClaim = isConcourseWorker && !options.continue && !options.resume && options.bootSessionIdPinned !== true
  let sessionFactsHoldSpent = false
  const sessionWiringModules = (): Promise<
    [
      typeof import('../utils/hooks/wardsHook.js'),
      typeof import('../utils/hooks/tabulaFireHooks.js'),
      typeof import('../services/crew/identity.js'),
    ]
  > =>
    Promise.all([
      import('../utils/hooks/wardsHook.js'),
      import('../utils/hooks/tabulaFireHooks.js'),
      import('../services/crew/identity.js'),
    ])
  const armSessionRunnerWiring = async (sid: string): Promise<void> => {
    const [wards, tabula, crew] = await sessionWiringModules()
    wards.registerWardsHook(setAppState, sid)
    tabula.registerTabulaFireHooks(setAppState, sid)
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
    const { initializeSwarmSession } = await import('../utils/swarm/teammateInit.js')
    initializeSwarmSession(setAppState, String(getSessionId()), messages as ReadonlyArray<{ teamName?: string; agentName?: string }>)
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
      const { reconcileBackgroundLaunchesOnResume } = await import('../tasks/LocalAgentTask/launchReceipts.js')
      const settledLaunches = reconcileBackgroundLaunchesOnResume(messages, getAppState, setAppState)
      if (settledLaunches.length > 0) {
        logForDebugging(`[session-runner] resume: ${settledLaunches.length} background launch(es) without a live record — stop notices written`)
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
    if (rewindResult && rewindResult.canRewind === false) {
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
      'Error: input must be provided either through stdin or as a prompt argument when using --print',
      options.outputFormat,
    )
    gracefulShutdownSync(1)
    return
  }
  if (options.outputFormat === 'stream-json' && !options.verbose) {
    emitLoadError(
      'Error: --output-format=stream-json requires --verbose',
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
    options.permissionPromptToolName,
    io,
    () => getAppState().mcp.tools as Tool[],
    details => notifySessionStateChanged('requires_action', details),
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
  let deferredModelBreadcrumb: string | null = null
  let deferredSpawnSwitches: Array<{ kind: 'subagents' | 'workflows'; on: boolean }> = []
  const landSpawnSwitch = (kind: 'subagents' | 'workflows', on: boolean): void => {
    const landed = setSpawnSwitch(kind, on)
    if (!landed.changed) return
    messages.push(createRosterTransitionMessage(kind, on, spawnSwitchTransitionLine(kind, on)))
    declareLawfulPrefixChange(processMainOwner(), `the operator toggled ${SPAWN_SWITCH_LABEL[kind]} ${on ? 'on' : 'off'}`)
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
    const projected = toSDKRateLimitInfo(limits)
    if (projected && Object.keys(projected).length > 0) {
      io.outbound.enqueue({
        type: 'rate_limit_event',
        rate_limit_info: projected,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  }
  statusListeners.add(rateLimitListener)

  let suggestionController: AbortController | null = null
  let suggestionInFlight: Promise<void> | null = null
  let pendingSuggestion: StdoutMessage | null = null
  let lastEmittedSuggestion: { text: string; emittedAt: number } | null = null
  const suggestionsEnabled = (): boolean =>
    streamingOptions.promptSuggestionEnabled === true
  const abortSuggestion = (): void => {
    suggestionController?.abort()
    suggestionController = null
    pendingSuggestion = null
  }

  const elicitationRegistered = new Set<string>()
  const registerPerTurnHandlers = (clients: MCPServerConnection[]): void => {
    for (const client of clients) {
      if (client.type !== 'connected') continue
      if (elicitationRegistered.has(client.name)) continue
      if (client.config.type === 'sdk') continue
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
    const { ElicitRequestSchema, ElicitationCompleteNotificationSchema } = await import(
      '../services/mcp/sdk.js'
    )
    client.client.setRequestHandler(
      ElicitRequestSchema,
      async (request, extra) => {
        const params = request.params
        const mode = params.mode === 'url' ? 'url' : 'form'
        const requestedSchema = params.mode === 'url' ? undefined : params.requestedSchema
        const url = params.mode === 'url' ? params.url : undefined
        const elicitationId = params.mode === 'url' ? params.elicitationId : undefined
        const hookResult = await executeElicitationHooks({
          serverName,
          message: params.message,
          requestedSchema,
          signal: extra.signal,
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
          extra.signal,
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
      },
    )
    client.client.setNotificationHandler(
      ElicitationCompleteNotificationSchema,
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
      ...sessionTools.filter(tool => !baseToolNames.has(tool.name)),
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
    const display = modelInfos.find(info => info.value === toModel)?.displayName ?? toModel
    const breadcrumbs = createModelSwitchBreadcrumbs(toModel, display)
    for (const breadcrumb of breadcrumbs) {
      messages.push(breadcrumb)
      const content = breadcrumb.message.content
      if (typeof content === 'string' && content.includes('local-command-stdout')) {
        io.outbound.enqueue({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          session_id: getSessionId(),
          uuid: breadcrumb.uuid,
          timestamp: breadcrumb.timestamp,
          isReplay: true,
        })
      }
    }
  }

  const SDK_MODES = new Set(['default', 'implement', 'sovereign', 'strategy', 'flow', 'dontAsk'])
  setPermissionModeChangedListener(mode => {
    if (!SDK_MODES.has(mode)) return
    io.outbound.enqueue({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: mode,
      uuid: randomUUID(),
      session_id: getSessionId(),
    })
  })

  const generateSuggestionAfterTurn = (): void => {
    if (!suggestionsEnabled()) return
    suggestionController?.abort()
    const controller = new AbortController()
    suggestionController = controller
    const params = getLastCacheSafeParams()
    if (!params) {
      logSuggestionSuppressed('no params', undefined, 'sdk')
      return
    }
    const generation = (async () => {
      try {
        const generated = await tryGenerateSuggestion(
          controller,
          messages,
          getAppState,
          params,
          'sdk',
        )
        const text = generated?.suggestion
        if (!text || controller.signal.aborted) return
        const envelope: StdoutMessage = {
          type: 'prompt_suggestion',
          suggestion: text,
          uuid: randomUUID(),
          session_id: getSessionId(),
        }
        if (driver.hasHeldResult()) {
          pendingSuggestion = envelope
        } else {
          io.outbound.enqueue(envelope)
          lastEmittedSuggestion = { text, emittedAt: Date.now() }
        }
      } catch (error) {
        const name = (error as { name?: string }).name
        if (name === 'AbortError' || name === 'APIUserAbortError') {
          logForDebugging('prompt suggestion suppressed (sdk): aborted')
        } else {
          logError(error)
        }
      } finally {
        if (suggestionController === controller) suggestionInFlight = null
      }
    })()
    suggestionInFlight = generation
  }

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
      registerEditorCompanion(freshClients)
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

  const executeTurn = async (
    command: QueuedCommand,
    batchUuids: string[],
    onMessage: (message: StdoutMessage) => void,
  ): Promise<void> => {
    if (command.mode === 'task-notification' || /<task-notification>/.test(String(command.value ?? ''))) {
      const payload = typeof command.value === 'string' ? command.value : ''
      const pick = (tag: string): string | undefined => {
        const match = payload.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
        return match?.[1]?.trim()
      }
      const statusRaw = pick('status')
      if (statusRaw !== undefined) {
        const normalized = ['completed', 'failed', 'stopped', 'killed'].includes(statusRaw)
          ? statusRaw === 'killed'
            ? 'stopped'
            : statusRaw
          : 'completed'
        const totalTokens = Number(pick('total-tokens') ?? pick('total_tokens'))
        const toolUses = Number(pick('tool-uses') ?? pick('tool_uses'))
        io.outbound.enqueue({
          type: 'system',
          subtype: 'task_notification',
          task_id: pick('task-id') ?? pick('task_id') ?? '',
          ...(pick('tool-use-id') !== undefined ? { tool_use_id: pick('tool-use-id') } : {}),
          output_file: pick('output-file') ?? pick('output_file') ?? '',
          status: normalized,
          summary: pick('summary') ?? '',
          ...(Number.isFinite(totalTokens) && Number.isFinite(toolUses)
            ? {
                usage: {
                  total_tokens: totalTokens,
                  tool_uses: toolUses,
                  duration_ms: Number(pick('duration-ms') ?? pick('duration_ms')) || 0,
                },
              }
            : {}),
          uuid: randomUUID(),
          session_id: getSessionId(),
        })
      }
    }
    abortSuggestion()
    if (lastEmittedSuggestion && command.mode !== 'task-notification') {
      const value = command.value
      const text =
        typeof value === 'string'
          ? value
          : Array.isArray(value)
            ? String(
                (value.find(block => (block as { type?: string }).type === 'text') as { text?: string } | undefined)
                  ?.text ?? '',
              )
            : ''
      const { logSuggestionOutcome } = await import(
        '../services/PromptSuggestion/promptSuggestion.js'
      )
      logSuggestionOutcome(text, lastEmittedSuggestion.text, lastEmittedSuggestion.emittedAt)
      lastEmittedSuggestion = null
    }

    const turnAbort = new AbortController()
    inFlightAbort = turnAbort
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
        for await (const message of ask({
          commands: dedupedCommands,
          prompt: command.value,
          promptUuid: command.uuid,
          ...(batchUuids.length > 0 ? { batchUuids } : {}),
          isMeta: command.isMeta,
          ...(command.mode === 'bash' ? { promptMode: 'bash' as const } : {}),
          cwd: getCwd(),
          tools: assembledTools,
          verbose: options.verbose,
          mcpClients: turnClients,
          thinkingConfig,
          maxTurns: options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd,
          taskBudget: options.taskBudget,
          canUseTool,
          userSpecifiedModel: activeModel,
          fallbackModel: options.fallbackModel,
          jsonSchema: initializeJsonSchema ?? options.jsonSchema,
          mutableMessages: messages,
          getReadFileCache,
          setReadFileCache,
          customSystemPrompt: options.systemPrompt,
          appendSystemPrompt: options.appendSystemPrompt,
          getAppState,
          setAppState,
          abortController: turnAbort,
          replayUserMessages: options.replayUserMessages,
          includePartialMessages: options.includePartialMessages,
          onLiveness: () => turnWatchdog.touch(),
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
            io.outbound.enqueue({
              type: 'system',
              subtype: 'status',
              status,
              uuid: randomUUID(),
              session_id: getSessionId(),
            })
          },
        })) {
          turnWatchdog.touch()
          onMessage(message as StdoutMessage)
        }
      })
    } finally {
      turnWatchdog.cancel()
      inFlightAbort = null
      if (deferredModelBreadcrumb !== null) {
        const toModel = deferredModelBreadcrumb
        deferredModelBreadcrumb = null
        await injectModelSwitchBreadcrumbs(toModel)
      }
      if (deferredSpawnSwitches.length > 0) {
        const toggles = deferredSpawnSwitches
        deferredSpawnSwitches = []
        for (const toggle of toggles) landSpawnSwitch(toggle.kind, toggle.on)
      }
    }
    if (turnWatchdog.fired) {
      throw new DeadlineExceededError('unattended turn', turnIdleLimitMs, turnIdleLimitMs, turnWatchdog.progressCount, 'no engine event for the whole limit — the turn was aborted; MERCURY_HEADLESS_IDLE_MINUTES tunes the limit (0 disables)')
    }
  }

  function headlessTurnIdleLimitMs(): number {
    return minutesKnobToMs(flagEnv('MERCURY_HEADLESS_IDLE_MINUTES'), DEFAULT_HEADLESS_IDLE_MINUTES)
  }

  const teamShutdownPromptInjected = { value: false }
  const injectTeamShutdownPrompt = (): void => {
    if (teamShutdownPromptInjected.value) return
    teamShutdownPromptInjected.value = true
    enqueue({
      value: `<system-reminder>You are running non-interactively and your final answer is blocked until your team is gone. Ask each teammate to shut down gracefully, wait for their shutdown approvals, then run the team cleanup operation. Only after the team is fully removed may you produce your final answer.</system-reminder>\nShut the team down now and prepare your final answer.`,
      mode: 'prompt',
      uuid: randomUUID(),
    })
  }

  const settleIdle = async (): Promise<'reenter' | 'close' | 'stay'> => {
    const teamState = getAppState()
    const { isTeamLead } = await import('../utils/teammate.js')
    if (teamState.teamContext && isTeamLead(teamState.teamContext) && !isTeammate()) {
      const { readUnreadMessages, markMessagesAsRead, isShutdownApproved, resolveShutdownApprovedVictim } =
        await import('../utils/teammateMailbox.js')
      const { removeTeammateFromTeamFile } = await import('../utils/swarm/teamHelpers.js')
      const { TEAM_LEAD_NAME } = await import('../utils/swarm/constants.js')
      for (;;) {
        {
          const next = peek()
          if (next && isMainThreadCommand(next)) return 'reenter'
        }
        const current = getAppState()
        const inProcessActive = getRunningTasks(current).some(
          task => task.type === 'in_process_teammate',
        )
        const listed = Boolean(Object.keys(current.teamContext?.teammates ?? {}).length)
        if (!inProcessActive && !listed) break
        const teamName = current.teamContext?.teamName ?? ''
        const unread = await readUnreadMessages(TEAM_LEAD_NAME, teamName)
        if (unread.length > 0) {
          await markMessagesAsRead(TEAM_LEAD_NAME, teamName)
          for (const message of unread) {
            const approval = isShutdownApproved(message.text)
            if (!approval) continue
            const victim = resolveShutdownApprovedVictim(message.from, approval)
            if (!victim) continue
            const roster = current.teamContext?.teammates ?? {}
            const victimId = Object.entries(roster).find(
              ([, teammate]) => teammate.name === victim,
            )?.[0]
            removeTeammateFromTeamFile(teamName, { agentId: victimId, name: victim })
            setAppState(previous => {
              const teammates = previous.teamContext?.teammates
              if (!previous.teamContext || !teammates) return previous
              const remaining = Object.fromEntries(
                Object.entries(teammates).filter(
                  ([id, teammate]) => id !== victimId && teammate.name !== victim,
                ),
              )
              return {
                ...previous,
                teamContext: { ...previous.teamContext, teammates: remaining },
              }
            })
          }
          const formatted = unread
            .map(
              message =>
                `<teammate-message teammate_id="${message.from}"${message.color ? ` color="${message.color}"` : ''}>${message.text}</teammate-message>`,
            )
            .join('\n')
          enqueue({ value: formatted, mode: 'prompt', uuid: randomUUID() })
          return 'reenter'
        }
        if (inputClosed) {
          injectTeamShutdownPrompt()
          return 'reenter'
        }
        await new Promise(resolve => setTimeout(resolve, TEAM_POLL_INTERVAL_MS))
      }
    }
    if (inputClosed) {
      for (;;) {
        const running = getRunningTasks(getAppState()).some(
          task => task.type === 'in_process_teammate' && !task.isIdle,
        )
        if (!running) break
        await new Promise(resolve => setTimeout(resolve, TEAM_POLL_INTERVAL_MS))
      }
      const current = getAppState()
      const swarmRemains =
        Boolean(Object.keys(current.teamContext?.teammates ?? {}).length) ||
        getRunningTasks(current).some(task => task.type === 'in_process_teammate')
      if (swarmRemains) {
        injectTeamShutdownPrompt()
        return 'reenter'
      }
      return 'close'
    }
    return 'stay'
  }

  const idleTimeout = createIdleTimeoutManager(() => !driver.isRunning())

  let lastMessage: StdoutMessage | null = null
  const collected: StdoutMessage[] = []
  const EXCLUDED_LAST = new Set([
    'control_response',
    'control_request',
    'control_cancel_request',
    'stream_event',
    'keep_alive',
    'prompt_suggestion',
    'streamlined_text',
    'streamlined_tool_use_summary',
  ])
  const EXCLUDED_SYSTEM_SUBTYPES = new Set([
    'session_state_changed',
    'task_notification',
    'task_started',
    'task_progress',
    'post_turn_summary',
  ])
  let streamlinedTransformer: ((message: StdoutMessage) => StdoutMessage | null) | null = null
  void ((value: typeof streamlinedTransformer) => {
    streamlinedTransformer = value
  })

  const routeOutbound = (message: StdoutMessage): void => {
    if (streamlinedTransformer) {
      const transformed = streamlinedTransformer(message)
      if (transformed) void io.write(transformed)
    } else if (options.outputFormat === 'stream-json' && options.verbose) {
      void io.write(message)
    }
    const type = message.type
    const subtype = 'subtype' in message ? message.subtype : undefined
    if (
      !EXCLUDED_LAST.has(type) &&
      !(type === 'system' && typeof subtype === 'string' && EXCLUDED_SYSTEM_SUBTYPES.has(subtype)) &&
      type !== 'tool_progress'
    ) {
      lastMessage = message
    }
    if (options.outputFormat === 'json' && options.verbose) {
      collected.push(message)
    }
  }

  const driver: TurnDriver = createTurnDriver({
    dequeue: takeMainThread,
    peek: () => {
      const next = peek()
      return next && isMainThreadCommand(next) ? next : undefined
    },
    notifyLifecycle: notifyCommandLifecycle,
    enqueueOutput: message => io.outbound.enqueue(message),
    writeDirect: message => io.write(message),
    drainSdkEvents: () => drainSdkEvents(),
    flushInternalEvents: () => io.flushInternalEvents(),
    beforeCycle: async () => {
      await updateSdkMcp()
    },
    onTurnStart: (command, batch) => {
      if (options.replayUserMessages && batch.length > 1) {
        const surviving = command.uuid
        for (const member of batch) {
          const uuid = member.uuid
          if (uuid === undefined || uuid === surviving) continue
          io.outbound.enqueue({
            type: 'user',
            message: { role: 'user', content: member.value },
            parent_tool_use_id: null,
            session_id: getSessionId(),
            uuid,
            isReplay: true,
          })
        }
      }
    },
    executeTurn: (command, batchUuids, onMessage) =>
      executeTurn(command, batchUuids, message => {
        onMessage(message)
      }),
    onTurnSettled: () => {
      generateSuggestionAfterTurn()
      logHeadlessProfilerTurn()
      headlessProfilerStartTurn()
    },
    hasWaitableBackgroundTasks: () =>
      getRunningTasks(getAppState()).some(task => task.type !== 'in_process_teammate'),
    hasHoldableBackgroundAgents: () =>
      getRunningTasks(getAppState()).some(
        task => task.type === 'local_agent' || task.type === 'local_workflow',
      ),
    waitableBackgroundTaskCount: () =>
      getRunningTasks(getAppState()).filter(task => task.type !== 'in_process_teammate').length,
    onAgentWait: count => {
      io.outbound.enqueue({
        type: 'system',
        subtype: 'status',
        status: count > 0 ? { waitingOnAgents: count } : null,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    },
    takePendingSuggestion: () => {
      const suggestion = pendingSuggestion
      pendingSuggestion = null
      if (suggestion && suggestion.type === 'prompt_suggestion') {
        lastEmittedSuggestion = { text: suggestion.suggestion, emittedAt: Date.now() }
      }
      return suggestion
    },
    settleIdle,
    closeOutput: async () => {
      if (suggestionInFlight) {
        await Promise.race([
          suggestionInFlight,
          new Promise(resolve => setTimeout(resolve, SUGGESTION_CLOSE_WAIT_MS)),
        ])
      }
      abortSuggestion()
      const { finalizePendingAsyncHooks } = await import('../utils/hooks/AsyncHookRegistry.js')
      await finalizePendingAsyncHooks().catch(() => {})
      skillChangeDetector.dispose()
      disarmAgentFreshness()
      statusListeners.delete(rateLimitListener)
      notePrintPhase('flush_exit')
      logForDebugging(`[print-phases] ${jsonStringify(printPhaseReport(getTotalAPIDuration()))}`)
      io.outbound.done()
    },
    notifySessionState: state => notifySessionStateChanged(state),
    isShuttingDown,
    idleTimerStop: () => idleTimeout.stop?.(),
    idleTimerStart: () => idleTimeout.start?.(),
    onCycleError: error => {
      abortSuggestion()
      return {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: 0,
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: randomUUID(),
        errors: [
          errorMessage(error),
          ...getInMemoryErrors().map(entry => entry.error),
        ],
      }
    },
    shutdown: code => void gracefulShutdown(code),
    clock: { sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
  })

  subscribeToCommandQueue(() => {
    const queued = getCommandQueue()
    if (queued.some(command => command.priority === 'now')) {
      inFlightAbort?.abort()
    }
    if (!inputClosed && sessionInitialized && !driver.isRunning() && queued.some(isMainThreadCommand)) {
      driver.kick()
    }
  })

  process.on('SIGINT', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGINT' })
    inFlightAbort?.abort()
    void gracefulShutdown(0)
  })
  process.on('SIGTERM', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGTERM' })
    inFlightAbort?.abort()
    void gracefulShutdown(143)
  })
  const { registerCleanup } = await import('../utils/cleanupRegistry.js')
  registerCleanup(async () => {
    logForDiagnosticsNoPII('info', 'headless_sigterm_state', {
      cycle_running: driver.isRunning(),
      phase: driver.phase(),
      background_tasks: getRunningTasks(getAppState()).length,
    })
  })

  if (streamingInput) {
    registerLocalWakeSink((prompt: string) => {
      if (inputClosed) return
      enqueue({
        value: prompt,
        mode: 'prompt',
        uuid: randomUUID(),
        priority: 'later',
        isMeta: true,
        workload: 'cron',
      })
      driver.kick()
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
  ): Promise<void> => {
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
          for (const name of request.sdkMcpServers ?? []) {
            sdkMcp.configs[name] = { type: 'sdk', name }
          }
          await handleInitializeRequest(
            request,
            requestId,
            sessionInitialized,
            io.outbound,
            commands,
            modelInfos as ModelInfo[],
            io,
            options.enableAuthStatus ?? false,
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
          if (request.promptSuggestions) {
            streamingOptions.promptSuggestionEnabled = true
            setAppState(previous => ({ ...previous, promptSuggestionEnabled: true }))
          }
          const wantsSummaries = Boolean(
            request.agentProgressSummaries,
          )
          if (wantsSummaries) {
            setSdkAgentProgressSummariesEnabled(true)
          }
          const initSchema = request.jsonSchema
          if (initSchema) {
            initializeJsonSchema = initSchema
            setInitJsonSchema(initSchema)
          }
          const hooks = request.hooks
          if (hooks) {
            registerHookCallbacks(hooks)
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
          abortSuggestion()
          lastEmittedSuggestion = null
          respondSuccess(requestId)
          return
        }
        case 'end_session': {
          logForDebugging(
            `end_session: ${String(request.reason ?? 'unspecified')}`,
          )
          inFlightAbort?.abort()
          abortSuggestion()
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
          setAppState(previous => ({
            ...previous,
            toolPermissionContext: updatedContext,
            isUltraplanMode: request.ultraplan ?? previous.isUltraplanMode,
          }))
          return
        }
        case 'set_model': {
          const requested = request.model
          const previousModel = activeModel ?? getMainLoopModel()
          const resolved =
            requested === undefined || requested === 'default'
              ? (getDefaultMainLoopModelSetting() ?? getMainLoopModel())
              : parseUserSpecifiedModel(requested)
          activeModel = resolved ?? undefined
          setMainLoopModelOverride(resolved ?? null)
          notifySessionStateChanged('idle')
          if (inFlightAbort !== null) deferredModelBreadcrumb = String(resolved)
          else await injectModelSwitchBreadcrumbs(String(resolved))
          respondSuccess(requestId)
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
            primeOpenaiCatalogue(request.openai_catalogue as Parameters<typeof primeOpenaiCatalogue>[0])
          }
          const claimedHome = consumeSessionHomePin()
          if (request.resume === true) {
            const pinnedFile = claimedHome !== null ? join(claimedHome, `${sid}.jsonl`) : undefined
            let resumed: Awaited<ReturnType<typeof loadConversationForResume>> = null
            try {
              resumed = await loadConversationForResume(sid, pinnedFile !== undefined && existsSync(pinnedFile) ? pinnedFile : undefined)
            } catch (error) {
              logError(error)
            }
            if (!resumed || resumed.messages.length === 0) {
              if (claimedHome !== null) process.env.MERCURY_SESSION_HOME = claimedHome
              respondError(requestId, `claim refused — no conversation found for session ${sid}`)
              return
            }
            switchSession(sid as SessionId, resumed.fullPath ? dirname(resumed.fullPath) : claimedHome)
            if (!isSessionPersistenceDisabled()) await resetSessionFilePointer()
            restoreSessionStateFromLog(resumed, setAppState)
            restoreSessionMetadata(resumed)
            messages.splice(0, messages.length, ...resumed.messages)
          } else {
            switchSession(sid as SessionId, claimedHome)
          }
          const claimedModel = typeof request.model === 'string' && request.model !== '' ? request.model : undefined
          if (claimedModel !== undefined) {
            activeModel = parseUserSpecifiedModel(claimedModel)
            setMainLoopModelOverride(claimedModel)
            process.env.ANTHROPIC_MODEL = claimedModel
          }
          if (claimedEffort !== undefined) {
            process.env.MERCURY_EFFORT_LEVEL = claimedEffort
            setAppState(previous => ({ ...previous, effortValue: claimedEffort }))
          }
          if (claimedContext !== undefined) {
            const nextContext = claimedContext
            setAppState(previous => ({ ...previous, toolPermissionContext: nextContext }))
          }
          await armSessionRunnerWiring(sid)
          if (request.resume === true) await hydrateResumedRun()
          awaitingSessionClaim = false
          logForDebugging(`[session-runner] claimed: session ${sid}${claimedModel !== undefined ? ` on ${claimedModel}` : ''}`)
          respondSuccess(requestId, { session_id: sid })
          return
        }
        case 'set_effort': {
          const requestedEffort = String(request.effort ?? '')
          if (!isEffortLevel(requestedEffort)) {
            respondError(requestId, `effort refused ('${requestedEffort}' is not on the shared ladder)`)
            return
          }
          process.env.MERCURY_EFFORT_LEVEL = requestedEffort
          setAppState(previous => ({ ...previous, effortValue: requestedEffort }))
          respondSuccess(requestId, { effort: requestedEffort })
          return
        }
        case 'session_facts': {
          if (!sessionFactsHoldSpent) {
            sessionFactsHoldSpent = true
            const holdMs = Number.parseInt(flagEnv('MERCURY_SESSION_FACTS_HOLD_MS') ?? '', 10)
            if (Number.isFinite(holdMs) && holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs))
          }
          const state = getAppState()
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
            },
            identity: {
              firstPartyApi: is1PApiCustomer(),
              consoleBilling: hasConsoleBillingAccess(),
              claudeAiBilling: hasClaudeAiBillingAccess(),
              accountEmail: getGlobalConfig().oauthAccount?.emailAddress ?? null,
            },
            skills: skillsRosterOf(activeCommands, offSkillNamesOf(sessionKitOf(), activeCommands.map(c => c.name))),
            mcp: mcpRosterEntriesOf(state.mcp.clients, [...sdkMcp.clients, ...dynamicMcp.clients]),
            permissionMode: state.toolPermissionContext.mode,
            spawnSwitches: spawnSwitchFacts(),
            workspace: {
              cwd: getCwd(),
              originalCwd: getOriginalCwd(),
              projectRoot: getProjectRoot(),
              instructionRoots: getAddedDirectories(),
            },
            queue: getCommandQueue().map(command => ({
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
            mission: (await listMissionTasks(missionListId()).catch((): Awaited<ReturnType<typeof listMissionTasks>> => [])).map(task => ({
              id: task.id,
              subject: task.subject.slice(0, 120),
              ...(task.activeForm !== undefined ? { activeForm: task.activeForm.slice(0, 120) } : {}),
              status: task.status,
            })),
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
          respondSuccess(requestId, answer as unknown as Record<string, unknown>)
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
                    nextFireMs: typeof r.nextFireMs === 'number' ? r.nextFireMs : null,
                    kind,
                    ...(r.paused === true ? { paused: true as const } : {}),
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
          respondSuccess(requestId, { mcpServers: await buildServerStatusList() })
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
            respondSuccess(requestId, { ...data })
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
          if (rewind.canRewind || request.dry_run) {
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
          respondSuccess(requestId, outcome as unknown as Record<string, unknown>)
          return
        }
        case 'cancel_async_message': {
          const uuid = request.message_uuid
          const matching = getCommandQueue().filter(command => command.uuid === uuid)
          if (matching.length > 0) removeQueuedCommands(matching)
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
              (request.servers ?? {}) as Record<string, McpServerConfigForProcessTransport>,
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
                  argumentHint: command.argumentHint ?? '',
                })),
              agents: activeAgents.map(agent => ({
                name: agent.agentType,
                description: agent.whenToUse,
                model: agent.model === 'inherit' ? undefined : agent.model,
              })),
              extensions,
              mcpServers: await buildServerStatusList(),
              error_count: errorCount,
            })
          } catch (error) {
            respondError(requestId, errorMessage(error))
          }
          return
        }
        case 'mcp_reconnect': {
          const serverName = request.serverName
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
          await applyReconnectedClient(serverName, client)
          if (client.type === 'connected') {
            registerPerTurnHandlers([client])
            reregisterChannelHandlerAfterReconnect(client)
            respondSuccess(requestId)
          } else if (client.type === 'failed') {
            respondError(requestId, client.error ?? `failed to reconnect ${serverName}`)
          } else {
            respondError(requestId, `server ${serverName} is ${client.type}`)
          }
          return
        }
        case 'mcp_toggle': {
          const serverName = request.serverName
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
            deferredSpawnSwitches = [...deferredSpawnSwitches.filter(d => d.kind !== toggle.kind), toggle]
          } else {
            landSpawnSwitch(toggle.kind, toggle.on)
          }
          respondSuccess(requestId)
          return
        }
        case 'kit_edit': {
          await serializeMcpChange(async () => {
            const verdict = validateSessionKit(request.kit)
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
                  reregisterChannelHandlerAfterReconnect(client)
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
        case 'channel_enable': {
          handleChannelEnable(
            requestId,
            request.serverName,
            [...getAppState().mcp.clients, ...sdkMcp.clients, ...dynamicMcp.clients],
            io.outbound,
          )
          return
        }
        case 'mcp_authenticate': {
          const serverName = request.serverName
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
            respondSuccess(requestId, { authUrl: raced.url, requiresUserAction: true })
          } else {
            respondSuccess(requestId, { requiresUserAction: false })
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
          const serverName = request.serverName
          const entry = mcpOAuth.get(serverName)
          if (!entry?.submitter) {
            respondError(requestId, `no OAuth flow is active for ${serverName}`)
            return
          }
          const url = String(request.callbackUrl ?? '')
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
          const serverName = request.serverName
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
        case 'claude_authenticate': {
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
                loginWithClaudeAi: request.loginWithClaudeAi ?? true,
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
            authUrl: autoUrl,
            manualAuthUrl: manualUrl,
          })
          return
        }
        case 'claude_oauth_callback':
        case 'claude_oauth_wait_for_completion': {
          const service = activeOAuth.service
          const flow = activeOAuth.flow
          if (!service || !flow) {
            respondError(requestId, 'no authentication flow is active')
            return
          }
          if (request.subtype === 'claude_oauth_callback') {
            service.handleManualAuthCodeInput({
              authorizationCode: request.authorizationCode,
              state: request.state,
            })
          }
          void flow
            .then(() => {
              const account = getAccountInformation()
              respondSuccess(requestId, {
                account: {
                  email: (account as { email?: string } | null)?.email,
                  organization: (account as { organization?: string } | null)?.organization,
                  subscriptionType: (account as { subscriptionType?: string } | null)
                    ?.subscriptionType,
                  tokenSource: (account as { tokenSource?: string } | null)?.tokenSource,
                  apiKeySource: (account as { apiKeySource?: string } | null)?.apiKeySource,
                  apiProvider: 'firstParty',
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
              effortRequested: effortTruth.requested === undefined ? null : String(effortTruth.requested),
            },
          })
          return
        }
        case 'stop_task': {
          try {
            const target = getAppState().tasks[request.task_id]
            if (isLocalWorkflowTask(target)) {
              respondSuccess(requestId, { receipt: killWorkflowTask(request.task_id, setAppState) })
            } else {
              stopOrDismissAgent(request.task_id, setAppState, AGENT_STOP_BY_OPERATOR)
              respondSuccess(requestId, {})
            }
          } catch (error) {
            respondError(requestId, errorMessage(error))
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
            respondError(requestId, 'the agent is running — nothing to resume')
            return
          }
          try {
            const { resumeAgentBackground } = await import('../tools/AgentTool/resumeAgent.js')
            const { toolUseId: _staleToolUseId, ...lastContext } = params.toolUseContext
            void _staleToolUseId
            const resumed = await resumeAgentBackground({
              agentId: request.task_id,
              prompt: request.note !== undefined && request.note.trim() !== '' ? request.note : AGENT_RESUME_NOTE,
              toolUseContext: { ...lastContext, abortController: new AbortController() } as typeof params.toolUseContext,
              canUseTool,
            })
            respondSuccess(requestId, {
              agentId: resumed.agentId,
              outputFile: resumed.outputFile,
              ...(resumed.cwdFallback !== undefined ? { cwdFallback: resumed.cwdFallback } : {}),
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
        case 'remote_control': {
          const enable = request.enabled
          if (enable) {
            respondError(requestId, 'remote control is unavailable in this build')
          } else {
            respondSuccess(requestId)
          }
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
        capabilities: undefined,
      }
      if (client.type === 'connected') {
        row.serverInfo = client.serverInfo
        const tools = await fetchToolsForClient(client)
        const prefix = getMcpPrefix(name)
        row.tools = tools.map(tool => ({
          name: tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name,
          ...(tool.isReadOnly?.(undefined) ? { readOnly: true } : {}),
          ...(tool.isDestructive?.(undefined) ? { destructive: true } : {}),
          ...(tool.isOpenWorld?.(undefined) ? { openWorld: true } : {}),
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
          if (options.replayUserMessages) {
            io.outbound.enqueue(typed)
          }
          continue
        }
        if (typed.type === 'assistant' || typed.type === 'system') {
          const { toInternalMessages } = await import('../utils/messages/mappers.js')
          messages.push(...toInternalMessages([typed] as Parameters<typeof toInternalMessages>[0]))
          if (options.replayUserMessages && typed.type === 'assistant') {
            io.outbound.enqueue(typed)
          }
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
              if (options.replayUserMessages) {
                io.outbound.enqueue({
                  type: 'user',
                  message: typed.message,
                  parent_tool_use_id: null,
                  session_id: getSessionId(),
                  uuid,
                  timestamp: typed.timestamp,
                  isReplay: true,
                })
              }
              if (historical && !runtime) {
                notifyCommandLifecycle(uuid, 'completed')
              }
              continue
            }
            receivedUuids.add(uuid)
          }
          const { resolveAndPrepend } = await import('../bridge/inboundAttachments.js')
          const rawContent = (typed.message.content ?? '') as string | ContentBlockParam[]
          const content = await resolveAndPrepend(typed, rawContent)
          if (typed.mode === 'task-notification' && typeof typed.agentId === 'string' && typed.agentId !== '') {
            enqueue({
              value: content,
              mode: 'task-notification',
              agentId: typed.agentId as never,
              priority: 'next',
              ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
            })
            continue
          }
          enqueue({
            value: content,
            mode: typed.mode === 'bash' ? 'bash' : 'prompt',
            ...(uuid !== undefined ? { uuid: uuid as UUID } : {}),
            ...(typed.priority !== undefined ? { priority: typed.priority } : {}),
          })
          driver.kick()
        }
      }
    } finally {
      inputClosed = true
      if (!driver.isRunning()) {
        await driver.closeOutputOnce()
      }
    }
  })()

  for await (const outboundMessage of io.outbound) {
    if (outboundMessage.type === 'result') await peekProject()?.flush()
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
  const last = lastMessage as
    | (StdoutMessage & { type: string; subtype?: string; is_error?: boolean; result?: string; errors?: string[] })
    | null
  if (options.outputFormat === 'json') {
    if (!last || last.type !== 'result') {
      throw new Error('No messages returned')
    }
    if (options.verbose) {
      await flushWrite(process.stdout, `${jsonStringify(collected)}\n`)
    } else {
      await flushWrite(process.stdout, `${jsonStringify(last)}\n`)
    }
  } else if (options.outputFormat !== 'stream-json') {
    if (!last || last.type !== 'result') {
      throw new Error('No messages returned')
    }
    if (last.subtype === 'success') {
      const text = String(last.result ?? '')
      const terminated = text.endsWith('\n') ? text : `${text}\n`
      if (last.is_error) {
        await flushWrite(process.stderr, terminated)
      } else {
        await flushWrite(process.stdout, terminated)
      }
    } else if (last.subtype === 'error_during_execution') {
      const first = last.errors?.[0]
      await flushWrite(
        process.stderr,
        first ? `Execution error: ${first}\n` : 'Execution error\n',
      )
    } else if (last.subtype === 'error_max_turns') {
      await flushWrite(
        process.stderr,
        `Reached the maximum number of turns (${options.maxTurns ?? 'configured limit'})\n`,
      )
    } else if (last.subtype === 'error_repetition_breaker') {
      await flushWrite(
        process.stderr,
        `${last.errors?.[0] ?? 'Stopped: the model repeated the identical tool call past the harness correction'}\n`,
      )
    } else if (last.subtype === 'error_max_budget_usd') {
      await flushWrite(
        process.stderr,
        `Reached the maximum budget of $${options.maxBudgetUsd ?? 'the configured amount'}\n`,
      )
    } else if (last.subtype === 'error_max_structured_output_retries') {
      await flushWrite(
        process.stderr,
        'Valid structured output was not produced within the retry limit\n',
      )
    }
  }

  logHeadlessProfilerTurn()
  notePrintPhase('flush_exit')
  logForDebugging(`[print-phases] ${jsonStringify(printPhaseReport(getTotalAPIDuration()))}`)
  const failed = Boolean(last && last.type === 'result' && last.is_error)
  gracefulShutdownSync(failed || io.stdoutPipeBroken ? 1 : 0)
}
