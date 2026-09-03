// ============================================================================
//  src/cli/print.ts — the headless engine. When Mercury runs -p/--print or
//  as an SDK child over stream-json, this module is the whole session:
//  validation, session restore, the tool pool, turns against the query
//  engine, the stdout envelope stream, the stdin control protocol, MCP/
//  extension/command/agent hot reload, and the settle whose exit code reflects
//  the last turn.
//
//  Non-goals are load-bearing: no terminal UI, no boot banner, no daemon or
//  multiplayer host, and never a non-JSON byte on stdout under stream-json.
// ============================================================================
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
import { setSpawnSwitch, spawnSwitchFacts, spawnSwitchTransitionLine } from '../services/switchboard/spawnSwitches.js'
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

// The public surface stays stable: these names are re-exported from here so
// the contract inventory and the runsurface prover keep their pins.
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
  /** True when the boot argv carried `--session-id` (the cold concourse
   *  spawn). A concourse worker with NO pinned id and no resume is a WARM
   *  runner: it parks before its first turn and takes its identity from the
   *  daemon's claim_session control. */
  bootSessionIdPinned?: boolean
  sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
  /** Declared for shape parity; never read (the engine builds its own
   *  status setter). */
  setSDKStatus?: unknown
  /** Written by the initialize delegate; the suggestion pass reads it. */
  promptSuggestionEnabled?: boolean
}

type GetAppState = () => AppState
type SetAppState = (updater: (previous: AppState) => AppState) => void

/** Insertion-ordered bounded set (list + set kept in step). */
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

/** One initialize-response model row (the SDK ModelInfo projection). */
type ModelCatalogueEntry = {
  value: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  supportsAdaptiveThinking?: boolean
  supportsAutoMode?: boolean
}

/** The model catalogue handed to the initialize handler. */
function buildModelCatalogue(): ModelCatalogueEntry[] {
  const options = getModelOptions()
  return options.map(option => {
    const resolved =
      option.value === null
        ? getMainLoopModel()
        : (parseUserSpecifiedModel(option.value) ?? option.value)
    const entry: ModelCatalogueEntry = {
      value: option.value === null ? 'default' : option.value,
      // The option's label is the catalogue's display name.
      displayName: option.label,
      description: option.description,
    }
    if (modelSupportsEffort(resolved)) {
      entry.supportsEffort = true
      // The stops the one effort owner offers for THIS model — its own
      // vocabulary (a documented lane without a medium tier lists none),
      // never the ladder re-derived from the ceiling predicates, which
      // claimed medium on every lane that lacks it.
      entry.supportedEffortLevels = [...resolveEffortTruth(resolved, undefined).selectable]
    }
    if (modelSupportsAdaptiveThinking(resolved)) entry.supportsAdaptiveThinking = true
    if (modelSupportsAutoMode(resolved)) entry.supportsAutoMode = true
    return entry
  })
}

/** Normalize a one-shot prompt into the raw input stream. */
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

// ── the headless entry ─────────────────────────────────────────────────────

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
  // ── ordered preflight ────────────────────────────────────────────────
  // 1 — the runtime-posture stamp precedes any system-prompt composition.
  markSessionNonInteractive(getAppState().toolPermissionContext?.mode)
  // 2 — durable activity, classified once at entry. (The one-shot posture that
  // gates the scheduling tools out of the pool is recorded earlier, in
  // main.tsx, BEFORE the tool pool is assembled.)
  const streamingInput = typeof inputPrompt !== 'string'
  noteHeadlessActivity(
    options.outputFormat === 'stream-json' && streamingInput ? 'sdk' : 'print',
  )
  // 3 — settings subscription (no React tree to run the usual hook).
  settingsChangeDetector.subscribe(source => {
    applySettingsChange(source, setAppState)
  })
  // 4 — Bun: a 1-second unref'd full-GC interval.
  if (process.versions.bun) {
    const bunGc = (globalThis as { Bun?: { gc?: (full: boolean) => void } }).Bun
    setInterval(() => bunGc?.gc?.(true), 1000).unref?.()
  }
  // 5 — the turn profiler + the first phase stamps.
  headlessProfilerStartTurn()
  notePrintPhase('graph_load', getPerformance().getEntriesByName('cli_entry')[0]?.startTime)
  notePrintPhase('cli_parse')
  // 6 — the gate initializer is a memoized async no-op in this build; the
  // call is kept because the surface may be re-pointed.
  void initializeFeatureGates()

  // ── early argument refusals ──────────────────────────────────────────
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

  // ── the stdio object ─────────────────────────────────────────────────
  const io = new StructuredIO(
    normalizeInputPrompt(inputPrompt),
    options.replayUserMessages,
  )
  if (options.outputFormat === 'stream-json') {
    // Installed before any structured write: buffers to line boundaries,
    // forwards JSON lines, diverts everything else to stderr with a marker.
    installStreamJsonStdoutGuard()
  }
  notePrintPhase('invocation_resolution')

  // ── sandbox ──────────────────────────────────────────────────────────
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
        // The two settle-1 sandbox paths differ in this tag alone.
        gracefulShutdownSync(1, 'other')
        return
      }
    }
  }

  // ── hook event mirroring (stream-json + verbose only) ────────────────
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

  // ── setup hooks ──────────────────────────────────────────────────────
  // The WRAPPER, never the raw generator — awaiting a generator object
  // runs nothing (the FW-C3 class).
  if (options.setupTrigger) {
    await processSetupHooks(options.setupTrigger, { forceSyncExecution: true })
  }

  // ── session load + restore ────────────────────────────────────
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

  // ── the session's own wiring (the concourse worker role) ────────────
  // A session inside the concourse is a full Mercury instance: the project
  // wards hook, the notepad's fire observers, the crew-directory identity
  // and the session room boot HERE, exactly as an interactive boot registers
  // them — parity 1:1 with a separately launched Mercury. A plain -p run
  // keeps none of them (the notepad doctrine: a headless run never fires a
  // note; a crew row and a room belong to a session an operator sits at).
  const isConcourseWorker = flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  // A WARM runner: the concourse role booted with NO identity (no
  // --session-id, no --resume) — the whole init above ran, and the id-keyed
  // wiring below waits for the claim control so nothing is ever created
  // under the eager placeholder id (looking still creates nothing).
  let awaitingSessionClaim = isConcourseWorker && !options.continue && !options.resume && options.bootSessionIdPinned !== true
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
    void crew.bootCrewIdentity({ sessionId: sid, worktreeRef: getCwd() }).catch(e => {
      logForDebugging(`[session-runner] crew identity boot failed (non-blocking): ${e}`)
    })
  }
  if (isConcourseWorker && !awaitingSessionClaim) {
    await armSessionRunnerWiring(String(getSessionId()))
  } else if (awaitingSessionClaim) {
    // The warm runner loads the wiring modules NOW — warmth means the claim
    // only registers under the claimed id, paying no import on the clock.
    void sessionWiringModules().catch(() => {})
  }

  // Teammate-session bootstrap (Law 9 restore — the old screen's mount owned
  // this and no runner path picked it up: a teammate session lost its team
  // allowed-path session rules and the Stop observer). Both shapes — fresh
  // spawn from the ambient identity, resumed teammate from the transcript's
  // first message; self-gated on the swarm flag and the names.
  try {
    const { initializeSwarmSession } = await import('../utils/swarm/teammateInit.js')
    initializeSwarmSession(setAppState, String(getSessionId()), messages as ReadonlyArray<{ teamName?: string; agentName?: string }>)
  } catch (error) {
    logForDebugging(`[session-runner] swarm init failed (non-blocking): ${error}`)
  }

  // Hook-provided first turn: prepended so an orchestrator session whose
  // stdin carries nothing still has a genuine first turn to answer.
  const hookInitialMessage = takeInitialUserMessage()
  if (hookInitialMessage) {
    io.prependUserMessage(hookInitialMessage)
  }

  // Conversation-model retention: self-guarded against any live override.
  if ((options.continue || options.resume) && !getMainLoopModelOverride()) {
    const recorded = restoreConversationModelFromMessages(messages)
    if (recorded && !options.userSpecifiedModel) {
      setMainLoopModelOverride(recorded)
    }
  }

  // Run reconciliation: awaited so the first turn observes the hydrated
  // run rather than racing it; failure never breaks boot. ONE closure for
  // both resume roads — the boot's --continue/--resume here, and the warm
  // claim's `resume` (the reactivate door's warm road) below, which loads
  // the same transcript the same way after this boot already ran.
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
    // Boot-time run reconciliation (the print/SDK family of the REPL boot
    // owner's law): a resumed headless session must observe its durable run
    // BEFORE the first turn can mint a fresh run and clobber the non-terminal
    // sidecar with a regressed write sequence. Awaited, so the first turn sees
    // the hydrated run; observation never breaks the boot.
    try {
      const owner = processMainOwner()
      if (getRunSnapshot(owner) === null) {
        await reconcileOnResume(owner, getCwd())
      }
    } catch (error) {
      logError(error)
    }
  }
  if (options.continue || options.resume) await hydrateResumedRun()

  // Agent restoration.
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
      // Re-persist so future resumes keep the agent.
      saveAgentSetting(restored.agentType)
    }
  }

  // Early bail while the process winds down.
  if (messages.length === 0 && process.exitCode !== undefined && process.exitCode !== 0) {
    return
  }

  // Rewind-files as a standalone operation.
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
    // The target uuid was just matched against a loaded user message, so the
    // branded-UUID assertion states a checked fact.
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

  // ── late argument refusals — ordering is observable ───────────
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

  // ── post-load assembly ───────────────────────────────────────────────
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

  // ── engine feature state ─────────────────────────────────────────────
  const streamingOptions = options
  let sessionInitialized = false
  // Through the ONE resolver (FC-073): this slot short-circuits every
  // `activeModel ?? getMainLoopModel()` read, so a raw flag value here
  // skipped the alias/catalogue fold the saved-setting road gets at
  // getMainLoopModel — a picker label the interactive road accepts was
  // refused non-interactively as an id no family declares.
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
  // A model switch that lands while a turn is open (the daemon's cap
  // released the seat past twenty minutes while the turn still ran) defers
  // its /model breadcrumb rows to the turn boundary: pushing them into a
  // conversation the turn is reading persisted them BEFORE the prompt that
  // was already running, and every later request replayed that order
  // (FN-015 rank 69). The newest requested model wins the boundary.
  let deferredModelBreadcrumb: string | null = null
  // THE SPAWN-SWITCH TOGGLE's landing (services/switchboard/spawnSwitches
  // — the daemon's spawn_switch verb): the switch moves, and a
  // roster-transition row marks the lawful prefix change (the Agent or
  // Workflow tool leaves or rejoins the roster from the next request; the
  // preserved-thinking reading names the toggle instead of a client-side
  // edit). A toggle that still arrives mid-turn (the daemon parks them,
  // but a release can race a turn's start) defers to the turn's end the
  // way the /model breadcrumb does: a spawn already running finishes.
  let deferredSpawnSwitches: Array<{ kind: 'subagents' | 'workflows'; on: boolean }> = []
  const landSpawnSwitch = (kind: 'subagents' | 'workflows', on: boolean): void => {
    const landed = setSpawnSwitch(kind, on)
    if (!landed.changed) return
    messages.push(createRosterTransitionMessage(kind, on, spawnSwitchTransitionLine(kind, on)))
  }

  const dynamicMcp: DynamicMcpState = {
    configs: {},
    clients: [],
    tools: [],
  }
  const sdkMcp: SdkMcpState = {
    // Null-prototype: later initialize requests bracket-assign SDK-supplied
    // server names into this map ('__proto__'-safe).
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

  // ── read-file cache ───────────────────────────────────────────
  const pendingSeeds = new Map<string, FileState>()
  // Transcript-extracted reads seed the cache: content the model already saw
  // counts as read, so a resumed session can edit files from prior turns
  // (the read-before-edit gate would otherwise refuse). Client seeds
  // (seed_read_state) fill gaps; a transcript entry wins a tie — the
  // getReadFileCache merge below gives the live side the tie.
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
      // The live cache wins ties: an actual read in this session is never
      // displaced by a client's claim about one.
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

  // ── ambient emitters ──────────────────────────────────────────
  // (enableAuthStatus is accepted for protocol compatibility but has no
  // publisher — there is no cloud-gateway credential-refresh streaming.)
  const rateLimitListener = (limits: ClaudeAILimits): void => {
    const projected = toSDKRateLimitInfo(limits)
    if (projected && Object.keys(projected).length > 0) {
      // EVERY status is emitted, including the permissive one — consumers
      // need the clear-the-warning transition.
      io.outbound.enqueue({
        type: 'rate_limit_event',
        // The wire member is rate_limit_info (the SDK schema's spelling).
        rate_limit_info: projected,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  }
  statusListeners.add(rateLimitListener)

  // ── suggestions ──────────────────────────────────────────────
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

  // ── elicitation/channel registration ──────────────────────────
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
        // Declaring a handler throws when the client lacks the elicitation
        // capability; swallowed — only a successful registration records.
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
        // The url-mode branch of the request union carries the hand-off
        // fields; the form branch carries the answer schema.
        const mode = params.mode === 'url' ? 'url' : 'form'
        const requestedSchema = params.mode === 'url' ? undefined : params.requestedSchema
        const url = params.mode === 'url' ? params.url : undefined
        const elicitationId = params.mode === 'url' ? params.elicitationId : undefined
        // The elicitation hook chain answers first when it produces a
        // response.
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
        // Nothing else mints this envelope subtype.
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

  // ── per-turn tool assembly ────────────────────────────────────
  // The BASE table re-derives per turn over the CURRENT permission
  // context: a launch-gated tool (Workflow, Agent — the workflows-allowed
  // tag the concourse grants to a LIVE session) or a deny rule that landed
  // after boot applies to the next turn. The boot table froze the gate's
  // spawn-time answer, so a granted session's model was told "delegation
  // tools are available" and got "No such tool available: Workflow". The
  // boot table's non-base extras (the synthetic output tool, the starting
  // MCP tools) ride along unchanged.
  const baseToolNames = new Set(getAllBaseTools().map(tool => tool.name))
  const assembleTools = (state: AppState): Tool[] => {
    // The MCP partitions ride the permission-aware assembler's own law
    // (FC-026): deny rules filter them and the blocked ceiling holds — this
    // path had NO other enforcement site, so a denied mcp__ tool and a
    // blocked-ceiling server rode straight into the headless pool. The
    // partition order and the builtin prefix stay byte-identical.
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
          // A schema that cannot convert is silently ignored here.
        }
      }
    }
    return deduped
  }

  // ── the model-switch breadcrumbs ─────────────────────────────────────
  const injectModelSwitchBreadcrumbs = async (toModel: string): Promise<void> => {
    const { createModelSwitchBreadcrumbs } = await import('../utils/messages/factories.js')
    // The factory replicates the /model transcript: the command argument and
    // the resolved display label (the previous model never appears in it).
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

  // ── permission-mode broadcast ────────────────────────────────────────
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

  // ── suggestion generation ────────────────────────────────────
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
          // Never ahead of the result envelope it follows.
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
        // Only the still-current generation self-clears.
        if (suggestionController === controller) suggestionInFlight = null
      }
    })()
    suggestionInFlight = generation
  }

  // ── SDK MCP refresh + extension state ─────────────────────────
  const updateSdkMcp = async (): Promise<void> => {
    await serializeMcpChange(async () => {
      const configuredNames = new Set(Object.keys(sdkMcp.configs))
      const clients = sdkMcp.clients
      const connectedNames = new Set(clients.map(client => client.name))
      // Four triggers: a new name, a removed name, any pending client, any
      // FAILED client — the failed condition is what makes a transient
      // handshake failure recoverable.
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
      // The editor companion (an SDK host's injected client) binds out of
      // every fresh list: a list without one clears the binding.
      registerEditorCompanion(freshClients)
      sdkMcp.tools = freshTools
      // Remove stale tools for BOTH the old and the new name sets, matched
      // by the MCP tool-name prefix, then write the fresh SDK tools in.
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
    // SDK-provided agents carry the flag-settings source tag and cannot be
    // reloaded from disk — the tag alone identifies them. A set-difference
    // against the fresh list would readmit policy-blocked extension agents.
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

  // THE SEAMLESS LAW: a live session must see an agent
  // created after its boot — the Boot face's create, /agents in another
  // terminal, an editor write. The agents watch is per-process (the store's
  // self-write ring lives with the writer), so a cockpit save is honestly
  // FOREIGN here: the runner arms its own watch and swaps the roster; the
  // NEXT turn's context carries it (executeTurn reads `activeAgents` live;
  // in-flight turns keep their spawn-pinned snapshot — the landed law).
  const disarmAgentFreshness = armRunnerAgentFreshness({
    cwd: () => getCwd(),
    getActive: () => activeAgents,
    setActive: next => {
      activeAgents = next
    },
  })


  // ── the turn driver ports ─────────────────────────────────────
  const isMainThreadCommand = (command: QueuedCommand): boolean =>
    command.agentId === undefined
  const takeMainThread = (): QueuedCommand | undefined => {
    const next = peek()
    if (next && isMainThreadCommand(next)) return dequeue()
    return undefined
  }

  const executeTurn = async (
    command: QueuedCommand,
    onMessage: (message: StdoutMessage) => void,
  ): Promise<void> => {
    // Task notifications: parse, maybe emit, then FALL THROUGH to a model
    // turn so the model sees the agent result.
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
    // Suggestion bookkeeping at prompt turns.
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
    // The unattended-turn watchdog (sweep #2, B6.4): a headless turn
    // with no engine event for the limit is wedged past every inner bound
    // (transport budgets, MCP idle, agent idle) and settles as a typed
    // error envelope with a non-zero exit — never a process that sits
    // forever with nobody to press Esc. Disarmed between turns: an idle
    // stream-json host deciding when to send the next frame is not silence.
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
          isMeta: command.isMeta,
          // A bash line runs as a shell command in this process: the mode
          // rides to the engine's input processing, under the SAME turn
          // abort the interrupt frame fires — the shell is killed and the
          // interrupted receipt lands like a model turn's.
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
          // The context contract is (serverName, params, signal); the driver
          // method is positional — adapt, projecting the url-elicitation members.
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
          // Boundary assertion: the engine yields the zod-inferred SDKMessage
          // family; the transport models the same wire union with narrowed
          // consumer fields (controlTypes). One family, two modellings.
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
      // The abort path has already emitted the interruption marker and the
      // synthetic settlements; the thrown deadline becomes the error
      // envelope the cycle writes directly before shutting down with 1.
      throw new DeadlineExceededError('unattended turn', turnIdleLimitMs, turnIdleLimitMs, turnWatchdog.progressCount, 'no engine event for the whole limit — the turn was aborted; MERCURY_HEADLESS_IDLE_MINUTES tunes the limit (0 disables)')
    }
  }

  /** The registered MERCURY_HEADLESS_IDLE_MINUTES knob (default 20 — above
   *  the agent watchdog's 15 so the inner bound always speaks first; 0
   *  disables). */
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
    // Team-lead inbox polling.
    const teamState = getAppState()
    const { isTeamLead } = await import('../utils/teammate.js')
    if (teamState.teamContext && isTeamLead(teamState.teamContext) && !isTeammate()) {
      const { readUnreadMessages, markMessagesAsRead, isShutdownApproved, resolveShutdownApprovedVictim } =
        await import('../utils/teammateMailbox.js')
      const { removeTeammateFromTeamFile } = await import('../utils/swarm/teamHelpers.js')
      const { TEAM_LEAD_NAME } = await import('../utils/swarm/constants.js')
      for (;;) {
        // A command that arrived while this loop polls (its kick no-oped
        // against the driver's 'settling_idle' mutex) must not wait on
        // unrelated mailbox traffic — the settle-instant delivery law.
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
            // The victim resolves from the VERIFIED envelope sender only —
            // a teammate may approve its own shutdown, never spoof another.
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
      // Wait for working in-process teammates, then decide.
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
  // The streamlined transformer is always absent in this build; the branch
  // shape is kept because the ordering between the two write paths is
  // observable if it is ever restored.
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
        // One acknowledgement per sent message: the engine acks only the
        // uuid representing the merged batch.
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
    // The outbound PUMP is the single stdout writer (it drains io.outbound
    // through routeOutbound). A direct routeOutbound call here double-wrote
    // every turn envelope — assistant frames and results each landed twice
    // on the wire (doubled ACP message chunks, doubled SDK frames) and the
    // result write bypassed the driver's hold-back rule (LANE ACP find).
    executeTurn: (command, onMessage) =>
      executeTurn(command, message => {
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

  // Queue interaction: a `now`-priority arrival aborts the in-flight turn.
  subscribeToCommandQueue(() => {
    const queued = getCommandQueue()
    if (queued.some(command => command.priority === 'now')) {
      inFlightAbort?.abort()
    }
  })

  // ── signals ──────────────────────────────────────────────────────────
  process.on('SIGINT', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGINT' })
    inFlightAbort?.abort()
    // Recorded inconsistency: stdin end propagates the last turn's error
    // status; SIGINT always settles 0.
    void gracefulShutdown(0)
  })
  process.on('SIGTERM', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGTERM' })
    // Abort before shutting down so the turn settles honestly: the
    // interruption marker and the synthetic results for still-running tools
    // land in the transcript ahead of the writer flush. The exit code stays
    // the signal's own 143 (the global handler defers to this one).
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

  // ── cron ──────────────────────────────────────────────────────
  // SATURN's process-local wake sink (the seatless self-pacing arm): the
  // run's own queue door, registered whenever streaming input exists —
  // independent of the legacy engine's kill switch below.
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
  // (The legacy in-process task engine died with the old scheduler estate:
  // SATURN's daemon fires session schedules into this runner through the
  // dispatch road, and the local-wake sink above is the seatless arm.)

  // (There is no auto-resume of an interrupted turn: a resumed
  // session surfaces the interrupted prompt without re-running it.)

  // ── orphaned permission responses ───────────────────────────
  const handledOrphans = new Set<string>()
  io.setUnexpectedResponseCallback(async response => {
    // The transport surfaces the inner response union; the handler reads the
    // full envelope.
    const enqueued = await handleOrphanedPermissionResponse({
      message: { type: 'control_response', response },
      setAppState,
      handledToolUseIds: handledOrphans,
    })
    if (enqueued) driver.kick()
  })

  // ── the stdin control loop ────────────────────────────────────
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
    // The connection object carries no discovery payload; the per-client
    // fetchers (capability-guarded, no-op for non-connected states) own it.
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
            // The runtime effort ladder carries 'xhigh'; the SDK wire enum
            // models four levels. Passed through unchanged (base behaviour).
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
              // The id is the caller's durable operation identifier; a
              // repeat is a retry of a delivery that already took effect.
              respondSuccess(requestId)
              return
            }
            seenInterruptIds.add(requestId)
          }
          inFlightAbort?.abort()
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
              : parseUserSpecifiedModel(requested) // the one resolver (FC-073)
          activeModel = resolved ?? undefined
          setMainLoopModelOverride(resolved ?? null)
          notifySessionStateChanged('idle')
          if (inFlightAbort !== null) deferredModelBreadcrumb = String(resolved)
          else await injectModelSwitchBreadcrumbs(String(resolved))
          respondSuccess(requestId)
          return
        }
        case 'claim_session': {
          // THE WARM CLAIM (daemon/warmRunner.ts): the daemon hands this
          // identityless warm runner its durable session BEFORE the first
          // words. One atomic control applies the id, model, posture and
          // effort exactly the way the equivalent boot argv does
          // (--session-id + the home pin, --model's override,
          // --permission-mode's context, the effort env stamp) — so a
          // claimed runner is indistinguishable from a cold-spawned one. No
          // /model breadcrumbs and no broadcast: before the first turn
          // there is no conversation to annotate (the blank chat's own
          // pre-session model pick writes none either).
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
          // Validate EVERYTHING before mutating anything — a refused claim
          // leaves the runner unclaimed and warm for the next one.
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
          // CREDENTIAL PRESENCE IS LIVE AT THE CLAIM: this runner booted
          // before the operator's sign-in may have landed, and its
          // credential reads are process-lifetime memos — drop them here so
          // the claimed session's first turn reads the disk's truth (the
          // sign-in the screen just stored), never the warm boot's null or
          // its stale header set. Cheap (memos only, no network), once per
          // claim.
          dropCredentialMemos()
          // The id and the transcript home — the setup.ts --session-id
          // seam, deferred to this moment (the home pin is consumed HERE,
          // before any tool child could inherit it).
          const claimedHome = consumeSessionHomePin()
          if (request.resume === true) {
            // THE REACTIVATE ON THE WARM ROAD: the claim hands this runner a
            // PARKED session — its transcript loads here exactly as a cold
            // `--resume` boot loads it (the same loader, the same restore
            // steps, the same run hydration below), BEFORE the ack, so a
            // claimed runner is indistinguishable from a cold --resume
            // spawn. A missing or empty transcript refuses the claim and
            // hands the home pin back; the daemon then serves the session
            // on its cold road.
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
            // activeModel bypasses the parse-at-read the override/env slots
            // get, so it folds here (FC-073); the slots keep the raw claim —
            // byte-identical to the equivalent cold boot's argv state.
            activeModel = parseUserSpecifiedModel(claimedModel)
            setMainLoopModelOverride(claimedModel)
            // The spawn stamps this env for a cold boot; the claim lands the
            // identical state so every later read agrees.
            process.env.ANTHROPIC_MODEL = claimedModel
          }
          if (claimedEffort !== undefined) {
            // The one effort authority: the env pin outranks every other
            // source on every provider (getEffortEnvOverride) — exactly
            // where the cold spawn's MERCURY_EFFORT_LEVEL stamp lands.
            process.env.MERCURY_EFFORT_LEVEL = claimedEffort
            setAppState(previous => ({ ...previous, effortValue: claimedEffort }))
          }
          if (claimedContext !== undefined) {
            const nextContext = claimedContext
            setAppState(previous => ({ ...previous, toolPermissionContext: nextContext }))
          }
          // The id-keyed session wiring (wards, notepad fire, crew
          // identity, the room) arms NOW, under the claimed id.
          await armSessionRunnerWiring(sid)
          // A resumed conversation observes its durable run before the
          // first turn (the boot's own step, run here for the claim).
          if (request.resume === true) await hydrateResumedRun()
          awaitingSessionClaim = false
          logForDebugging(`[session-runner] claimed: session ${sid}${claimedModel !== undefined ? ` on ${claimedModel}` : ''}`)
          respondSuccess(requestId, { session_id: sid })
          return
        }
        case 'set_effort': {
          // The mid-session effort verb — the missing sibling of set_model
          // and set_permission_mode. The env pin is the one authority every
          // effort resolution reads, so the next API call runs at the new
          // value; nothing bounces, nothing respawns.
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
          // The session answers ITS OWN facts — the same ledgers and tables
          // the screen's readouts read through its connector, so a
          // hopped-into session shows its own numbers, model, skills,
          // servers and queue (parity 1:1).
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
              // The turns this ledger could not price — additive, so a
              // cost readout on the screen says "unpriced" for them.
              unpricedTurns: getTotalUnpricedTurns(),
              // The approaching-limit line for the provider THIS session
              // runs on, from the feeders only this process observes (the
              // response headers, the x-codex bands, the probe refreshes
              // its own dispatch fires) — the focused screen paints it
              // ahead of its own derivation. Additive on the payload: an
              // older screen ignores it, an older runner omits it.
              limitWarning: providerLimitWarning({ model: activeModel ?? getMainLoopModel() }),
              // The OpenAI lane's observed usage bands ride the same law:
              // only THIS process sees the x-codex headers (no polled
              // endpoint exists), so a screen on the daemon road would
              // otherwise paint an eternally-empty GPT meter beside a
              // just-answered gpt chat. Additive; omitted when nothing was
              // ever stated (absent ≠ zero).
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
            // The off rows ride the projection (KIT-DIALS): the dial screen
            // needs both directions; the table stays the model-facing truth.
            skills: skillsRosterOf(activeCommands, offSkillNamesOf(sessionKitOf(), activeCommands.map(c => c.name))),
            mcp: mcpRosterEntriesOf(state.mcp.clients, [...sdkMcp.clients, ...dynamicMcp.clients]),
            permissionMode: state.toolPermissionContext.mode,
            // The session's own spawn switches (the daemon's publish stamps
            // the record's view over them — one durable truth).
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
            // The session's own work — its task store projected (workflows,
            // agents, teammates, shells), so the focused chat's work views
            // render THIS session's rows and never a screen-global store.
            work: projectWorkRoster(state.tasks),
            // Its mission ledger the same way: the list keyed by THIS
            // session (the /tasks mission board keyed on the screen's own
            // process session and read "no mission tasks" over a resumed
            // session's seeded ledger).
            mission: (await listMissionTasks(missionListId()).catch((): Awaited<ReturnType<typeof listMissionTasks>> => [])).map(task => ({
              id: task.id,
              subject: task.subject.slice(0, 120),
              ...(task.activeForm !== undefined ? { activeForm: task.activeForm.slice(0, 120) } : {}),
              status: task.status,
            })),
            // The process's kit (the consumed-once latch; KIT-RUNNER):
            // resolved after the completion — the daemon stamps an
            // unresolved record from this answer, the only road from
            // provisional to resolved. Absent for an un-kitted process.
            ...(sessionKitOf() !== undefined ? { kit: sessionKitOf() } : {}),
            // SATURN's facts-borne tool road: the schedule edits this
            // session's own tools queued since the last answer —
            // SEND-AND-CLEAR (each edit rides exactly one answer; the seat
            // applies through the record's one writer). Absent when none.
            ...((): Record<string, unknown> => {
              const edits = takePendingScheduleEdits()
              return edits.length > 0 ? { pendingScheduleEdits: edits } : {}
            })(),
            // The /rewind facts: whether THIS process captures checkpoints
            // and which turns carry a saved point — the cockpit offers a
            // code restore only where one exists (FN-015 rank 8).
            // LIVENESS: the stream idle budget THIS process's watchdog
            // aborts at, for the session's route — the focused chat's
            // status row says "stuck" only against this number.
            streamIdleTimeoutMs: streamIdleTimeoutMsForRoute(providerFamilyOfSetting(activeModel ?? getMainLoopModel())),
            fileCheckpoints: {
              capture: fileHistoryEnabled(),
              restorable: state.fileHistory.snapshots.map(snapshot => String(snapshot.messageId)),
            },
          }
          // A facts ask proves a daemon seat listens — the schedule tools'
          // seat road arms on the first one.
          markScheduleSeatObserved()
          respondSuccess(requestId, answer as unknown as Record<string, unknown>)
          return
        }
        case 'schedule_roster': {
          // SATURN's roster push (the kit_edit family, daemon → child): the
          // post-apply schedule roster — the list/remove tools speak these
          // ids. Shape-narrowed here (the mcp_set_servers convention).
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
            // Opaque relay: the schema leaves the JSON-RPC frame unvalidated;
            // the transport contract types it.
            client.client.transport.onmessage(request.message as JSONRPCMessage)
          }
          respondSuccess(requestId)
          return
        }
        case 'rewind_files': {
          // The id arrives schema-validated as a plain string; the owner
          // takes the branded UUID.
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
          // The /rewind verb (FN-015 rank 8): the daemon relays the
          // cockpit's ask and awaits THIS answer — always a success frame
          // carrying the typed receipt (a refusal is a receipt too; the
          // error frame is reserved for an older runner's unknown subtype).
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
            // A newer disk mtime skips the seed so the edit tool demands a
            // fresh read instead of diffing current content against itself.
          } catch {
            // Missing file / permissions: skip the seed, still succeed.
          }
          respondSuccess(requestId)
          return
        }
        case 'mcp_set_servers': {
          await serializeMcpChange(async () => {
            // The wire schema leaves per-server configs unvalidated (the SDK
            // caller is trusted); the handler types the shaped record.
            const result = await handleMcpSetServers(
              (request.servers ?? {}) as Record<string, McpServerConfigForProcessTransport>,
              sdkMcp,
              dynamicMcp,
              setAppState,
            )
            respondSuccess(requestId, { ...result })
            // Connect SDK servers only after responding (connecting first
            // deadlocks).
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
          // The membership consult, wire parity with the screen registry:
          // its manual reconnect refuses a disabled server (the slot marks
          // disabled instead of dialing) — the control wire refuses typed
          // instead of connecting past the record.
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
          // THE SESSION DIAL on the SDK child wire (KIT-DIALS; ledger
          // L24(3)): a toggle here is THIS session's own dial — it edits the
          // PROCESS KIT (materialize-then-edit where no kit was pinned,
          // through the one edit road) and never the shared project config
          // (the old setMcpServerEnabled write was the exact isolation
          // violation: a session dial editing what sibling sessions read).
          // No record write either: this wire's callers host the child
          // themselves — the process IS the session on that plane; the
          // daemon's own forward is the kit_edit arm below.
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
          // THE DAEMON'S SPAWN-SWITCH FORWARD (the kit_edit family): the
          // seat landed the operator's toggle on the record and forwards
          // it; this process's switch moves at a turn boundary — now when
          // idle, at this turn's end otherwise. The runner answers as soon
          // as the toggle is held.
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
          // THE DAEMON'S KIT FORWARD (KIT-DIALS; ledger L24(3); the
          // set_effort child-verb family): the record's one writer applied
          // the dial (sessionControl 'set-kit') and forwards the POST-EDIT
          // kit whole; this arm makes the process agree — RUNNER's recipe
          // verbatim: flip the latch (the setter beside
          // completeProcessSessionKit) → reconcile the catalogue MCP plane
          // to the new membership (the delta only — never a full-state
          // heal) → clearCommandMemoizationCaches (the tri-state overlay
          // re-derives from the latch by construction; the per-cwd
          // model-list memo clears with it). The sdk/dynamic planes are not
          // the kit's estate (the sdk plane has no disable arm; dynamic
          // servers ride mcp_set_servers) — a kit name colliding with one
          // reports typed instead of dialing. Serialized with the other MCP
          // mutations.
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
            // A skill the dial turned off takes its frontmatter hooks with it
            // (FN-015 rank 62): the registration used to outlive the skill.
            pruneSkillSessionHooks(setAppState, getSessionId(), liveSkillRootsOf(activeCommands))
            // A pre-kit session's first dial arrives UNRESOLVED (the writer
            // materialized it). With the post-dial roster in hand this is
            // the step-12 completion replayed at the dial beat — the latch
            // resolves through the ONE road (completeProcessSessionKit) and
            // the next session_facts answer lets the daemon resolve the
            // record (the landed only-road; sessionSeat's facts arm).
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
              // The flow hands the manual-paste submitter once its listener
              // is up; the callback-url arm feeds it.
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
            // A code-less URL makes the submitter a no-op, and awaiting the
            // auth promise would then park the serial loop indefinitely.
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
          // Attached BEFORE any await: a flow that fails on start must not
          // reject with nobody listening.
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
            // Synchronously, in stdin message order — a deferred injection
            // could deliver the code to a later flow.
            service.handleManualAuthCodeInput({
              authorizationCode: request.authorizationCode,
              state: request.state,
            })
          }
          // Detached: the flow may only resolve via a future message on this
          // same serial loop.
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
                  // Contract field — always first-party (gateway estate
                  // retired).
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
          // JSON has no undefined: null means "clear this key", over the
          // MERGED object, or schema validation rejects the whole record.
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
          // The APPLIED tier is the one effort owner's answer — what the
          // next request carries: absent when the model has no effort
          // control, null when the wire carries no key (the provider
          // default applies), else the tier word; the raw session request
          // rides beside it. The old row echoed the request as "applied".
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
            stopOrDismissAgent(request.task_id, setAppState)
            respondSuccess(requestId, {})
          } catch (error) {
            respondError(requestId, errorMessage(error))
          }
          return
        }
        case 'generate_session_title': {
          // Fire and forget: the small-model round trip must not delay
          // subsequent messages and interrupts.
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
                // A turn that ended in an interrupt leaves an aborted
                // controller behind; the fork must not inherit it. The
                // controller rides the tool-use context, not the cache key.
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
        // The capabilities key is unconditionally absent-valued in this
        // build; consumers that test key presence will see it.
        capabilities: undefined,
      }
      if (client.type === 'connected') {
        row.serverInfo = client.serverInfo
        // Discovery payload comes from the per-client fetcher (memoized), not
        // the connection object; capability hints come from the built tool's
        // own predicates.
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

  // The pre-claim gate (warm runners only): the daemon never delivers words
  // before the claim acknowledges — this wrapper is the belt that keeps a
  // misordered user frame from opening a turn under the placeholder id. The
  // frame parks; the claim control flows through; parked frames replay in
  // order the moment the claim lands. On every non-warm boot the gate is a
  // pass-through.
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

  // ── run the serial stdin loop + the pump concurrently ────────────────
  const stdinLoop = (async (): Promise<void> => {
    try {
      for await (const typed of claimGatedInput(io.structuredInput)) {
        // Synchronously handled messages close their lifecycle immediately.
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
          // The transport family and the zod-inferred family model the same
          // wire union (the engine-yield boundary's mirror).
          messages.push(...toInternalMessages([typed] as Parameters<typeof toInternalMessages>[0]))
          if (options.replayUserMessages && typed.type === 'assistant') {
            io.outbound.enqueue(typed)
          }
          continue
        }
        if (typed.type === 'user') {
          sessionInitialized = true
          const uuid = typed.uuid
          if (uuid) {
            // The wire uuid is a plain string; the session store keys on the
            // branded form.
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
                // The uuid in the transcript means an earlier process ran
                // the turn but died before reporting completion.
                notifyCommandLifecycle(uuid, 'completed')
              }
              continue
            }
            receivedUuids.add(uuid)
          }
          const { resolveAndPrepend } = await import('../bridge/inboundAttachments.js')
          // Wire user content is the API message-content shape.
          const rawContent = (typed.message.content ?? '') as string | ContentBlockParam[]
          const content = await resolveAndPrepend(typed, rawContent)
          if (typed.mode === 'task-notification' && typeof typed.agentId === 'string' && typed.agentId !== '') {
            // The delivery door's ADDRESSED form: the note enqueues scoped
            // to its agent at 'next' — the agent's own drain
            // (attachment-drain scope law) folds it into that agent's next
            // turn, exactly once, under the frame's own identity. Never a
            // main-thread turn: the driver's dequeue is main-thread-scoped,
            // so no kick.
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
            // A bash line from the focused chat's composer runs as a shell
            // command here, in the session's own process.
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

  // If the auto-resume pre-enqueued a command before initialize, the
  // initialize handler kicks; a plain -p prompt arrives via stdin instead.
  // ── the message pump: the drain loop for the single outbound queue ───
  for await (const outboundMessage of io.outbound) {
    // THE TURN-BOUNDARY FLUSH (§TRANSCRIPT-DEBOUNCE-SIGKILL): a result frame
    // is the completion a caller may act on — read the transcript, kill the
    // process — and the engine has already recorded the turn by the time it
    // yields one, but the writer lands queued lines on a 100 ms timer. The
    // flush here puts the turn on disk BEFORE the frame (and the final text
    // it becomes) can reach the wire, so a kill at first sight of the
    // completion never leaves a young session without its transcript. A
    // peek, not a get: a run that recorded nothing has nothing to flush.
    if (outboundMessage.type === 'result') await peekProject()?.flush()
    routeOutbound(outboundMessage)
  }
  await stdinLoop.catch((error: unknown) => {
    logError(error)
  })

  // ── final output by format ────────────────────────────────────
  const flushWrite = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
    new Promise((resolve, reject) => {
      stream.write(text, error => {
        if (error) {
          // One broken-pipe outcome across formats (FC-077): the consumer
          // left — the named line and exit 1, never a raw libuv crash.
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
      // stdout is the requested-result channel only.
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

  // ── settle ───────────────────────────────────────────────────────────
  logHeadlessProfilerTurn()
  notePrintPhase('flush_exit')
  logForDebugging(`[print-phases] ${jsonStringify(printPhaseReport(getTotalAPIDuration()))}`)
  const failed = Boolean(last && last.type === 'result' && last.is_error)
  // The broken-pipe latch outranks a clean turn (FC-077): output the caller
  // never received is not a success.
  gracefulShutdownSync(failed || io.stdoutPipeBroken ? 1 : 0)
}
