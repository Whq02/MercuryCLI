// ============================================================================
//  src/QueryEngine.ts — the conversation engine for headless/SDK runs: one
//  instance per conversation, one submitMessage per turn. Owns the message
//  store, per-turn hook arming, system-prompt assembly, transcript recording
//  and the SDK result envelope. `ask` is the one-shot convenience wrapper.
// ============================================================================
import { randomUUID } from 'node:crypto'
import stripAnsi from 'strip-ansi'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from './bootstrap/state.js'
import type { Command } from './commands.js'
import { LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from './constants/xml.js'
import { armWorkerParentWatch } from './daemon/workerParentWatch.js'
import type { SDKMessage } from './entrypoints/agentSdkTypes.js'
import { MERCURY_IDENTITY_FLOOR } from './prompt/mercuryContract.js'
import { queryEvents } from './query.js'
import { legacyYieldsOf } from './run-core/project-legacy.js'
import type { QueryParams } from './run-core/turn-machine.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import { accumulateUsage, updateUsage } from './services/providers/anthropic/cacheAndUsage.js'
import { EMPTY_USAGE } from './services/api/logging.js'
import type { NonNullableUsage } from './services/api/logging.js'
import type { Tools, ToolUseContext } from './Tool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/constants.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from './types/message.js'
import type { ApiStreamEvent, ContentBlockParam } from './types/wire.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { getGlobalConfig } from './utils/config.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import { cloneFileStateCache } from './utils/fileStateCache.js'
import { fileHistoryEnabled, fileHistoryMakeSnapshot } from './utils/fileHistory.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { engageCommitGate } from './utils/hooks/commitGate.js'
import { registerForcedReadHook } from './utils/hooks/forcedReadHook.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { registerRunStopHook } from './utils/hooks/runStopHook.js'
import { registerWardsHook } from './utils/hooks/wardsHook.js'
import {
  engageImplementerHooks,
  engageScribeHooks,
} from './utils/hooks/scribeImplementerHooks.js'
import { getInMemoryErrors, logError } from './utils/log.js'
import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import { buildSystemInitMessage } from './utils/messages/systemInit.js'
import { getMainLoopModel } from './utils/model/model.js'
import { getModelUsage, getTotalAPIDuration, getTotalCostUSD } from './bootstrap/state.js'
import { notePrintPhase } from './utils/printPhases.js'
import { processUserInput } from './utils/processUserInput/processUserInput.js'
import { getSlashCommandToolSkills } from './commands.js'
import { ensureExtensionsLoaded } from './extensions/boot.js'
import { handleOrphanedPermission, isResultSuccessful, normalizeMessage } from './utils/queryHelpers.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { armImplementerTelemetryPoll } from './utils/scribe/implementerTelemetry.js'
import { assertSingleRole } from './utils/workerRole.js'
import {
  scribePinIsApplicable,
  scribeSeatEffort,
  scribeSeatModel,
} from './utils/scribe/scribeModelPin.js'
import { isScribeModeOn } from './utils/scribeMode.js'
import { flushSessionStorage, recordTranscript } from './utils/sessionStorage.js'
import { setCwd } from './utils/Shell.js'
import { flagEnv } from './substrate/flagRegistry.js'
import { getAgentName, getTeamName, isTeammate } from './utils/teammate.js'
import { isImplementerModeOn } from './utils/implementerMode.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import type { ThinkingConfig } from './utils/thinking.js'
import { shouldEnableThinkingByDefault } from './utils/thinking.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'

const DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES = 5

type CanUseTool = ToolUseContext extends never ? never : QueryParams['canUseTool']
type GetAppState = ToolUseContext['getAppState']
type SetAppState = ToolUseContext['setAppState']
type McpClients = ToolUseContext['options']['mcpClients']
type AgentDefinitions = ToolUseContext['options']['agentDefinitions']['activeAgents']

type SnipBoundaryCallback = (
  yieldedSystemMessage: Message,
  store: Message[],
) => { messages: Message[]; executed: boolean } | undefined

export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: McpClients
  agents: AgentDefinitions
  canUseTool: CanUseTool
  getAppState: GetAppState
  setAppState: SetAppState
  readFileState: FileStateCache
  initialMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean
  /** Liveness tap: called for EVERY ingested engine event (stream deltas,
   *  request starts, retractions included) before projection — the
   *  unattended-turn watchdog reads it so a long generation whose partial
   *  messages are not forwarded still counts as progress. */
  onLiveness?: () => void
  setSDKStatus?: ToolUseContext['setSDKStatus']
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
  /** Never supplied in this build — the branch stays unreachable via ask. */
  snipBoundaryCallback?: SnipBoundaryCallback
}

type SdkPermissionDenial = {
  tool_name: string
  tool_use_id: string
  tool_input: Record<string, unknown>
}

// The engine's local SDK-envelope caster — the same terminal cast the
// normalisation helpers use; the field names it carries are prover-pinned.
const asSdk = (value: Record<string, unknown>): SDKMessage =>
  value as unknown as SDKMessage

// Once per PROCESS, not per engine: a fresh engine is constructed for every
// turn, so an instance field would re-emit the boot self-check each turn.
let seatBootSelfCheckEmitted = false
// The implementer seat's own once-per-process guard (module scope, not an
// instance field, for the same per-turn-engine reason).
let implementerBootChecked = false

function emitSeatBootSelfCheck(seatRole: string, expectedTeam: string): void {
  if (seatBootSelfCheckEmitted) return
  seatBootSelfCheckEmitted = true
  const teamName = getTeamName()
  const teammate = isTeammate()
  const swarmsOn = isAgentSwarmsEnabled()
  const model = getMainLoopModel()
  const facts = `role=${seatRole} team=${teamName ?? 'none'} agent=${getAgentName() ?? 'unset'} model=${model} teammate=${teammate} swarms=${swarmsOn}`
  if (teamName === expectedTeam && teammate && swarmsOn) {
    process.stderr.write(`[${seatRole}] boot self-check OK: ${facts}\n`)
  } else {
    process.stderr.write(
      `[${seatRole}] boot self-check FAILED (expected team '${expectedTeam}'): ${facts} — the bus will NOT deliver; check the --agent-id/--agent-name/--team-name triple and the swarms env\n`,
    )
  }
}

function messageTextContent(message: Message): string | null {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  return null
}

function isLocalCommandOutputText(text: string): boolean {
  return (
    text.includes(LOCAL_COMMAND_STDOUT_TAG) || text.includes(LOCAL_COMMAND_STDERR_TAG)
  )
}

export class QueryEngine {
  readonly #config: QueryEngineConfig
  private readonly mutableMessages: Message[]
  readonly #readFileState: FileStateCache
  readonly #abortController: AbortController
  #userSpecifiedModel: string | undefined
  // Per-engine, deliberately NOT cleared per turn.
  readonly #loadedNestedMemoryPaths = new Set<string>()
  // Turn-scoped: spans both input-context builds inside one turn, no longer.
  readonly #discoveredSkillNames = new Set<string>()
  readonly #permissionDenials: SdkPermissionDenial[] = []
  #accumulatedUsage: NonNullableUsage = { ...EMPTY_USAGE }
  // Ids whose usage the stream folded at message_stop.
  readonly #streamFoldedIds = new Set<string>()
  // Per provider message id, the LAST settled assistant yield's usage — the
  // provider layer emits one message per content block and updates the final
  // block's usage when the delta arrives, so the last yield is authoritative.
  readonly #settledUsageById = new Map<string, NonNullableUsage>()
  #orphanedPermissionHandled = false
  #turnCounter = 1
  // Recording cursor into the turn-local array; O(new) tail submissions.
  #recordCursor = 0
  #recordChain: Promise<string | null> = Promise.resolve(null)
  #structuredOutput: unknown

  constructor(config: QueryEngineConfig) {
    this.#config = config
    this.mutableMessages = [...(config.initialMessages ?? [])]
    this.#readFileState = config.readFileState
    this.#abortController = config.abortController ?? new AbortController()
    this.#userSpecifiedModel = config.userSpecifiedModel
  }

  interrupt(): void {
    this.#abortController.abort()
  }

  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  getReadFileState(): FileStateCache {
    return this.#readFileState
  }

  getSessionId(): string {
    return getSessionId()
  }

  /** Updates the configured user-specified model for later turns. */
  setModel(model: string): void {
    this.#userSpecifiedModel = model
  }

  // Chained so the parent hint returned by one submission is the hint the
  // next one uses — two concurrent appends against the same stale hint would
  // split the chain.
  #recordDelta(turnMessages: Message[]): Promise<string | null> {
    const pending = turnMessages.slice(this.#recordCursor)
    this.#recordCursor = turnMessages.length
    if (pending.length === 0) return this.#recordChain
    this.#recordChain = this.#recordChain.then(hint =>
      recordTranscript(
        pending,
        undefined,
        (hint ?? undefined) as Parameters<typeof recordTranscript>[2],
        turnMessages,
      ).catch((error: unknown) => {
        logError(error)
        return null
      }),
    )
    return this.#recordChain
  }

  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean; mode?: 'prompt' | 'bash' },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const config = this.#config
    // 1 — the turn-scoped skill set spans both context builds of one turn.
    this.#discoveredSkillNames.clear()
    // 2 — shell working directory.
    setCwd(config.cwd)
    // 3
    const persistenceDisabled = isSessionPersistenceDisabled()
    const turnStartedAt = Date.now()
    const eagerFlush = isEnvTruthy(process.env.MERCURY_EAGER_FLUSH)
    // Turn-scoped error watermark BY REFERENCE — the ring is bounded and an
    // index would slide out from under the turn.
    const errorWatermark = getInMemoryErrors().at(-1)

    // 4 — every non-allow outcome is captured as a denial record.
    const wrappedCanUseTool: CanUseTool = (async (
      tool: { name: string },
      input: Record<string, unknown>,
      toolUseContext: ToolUseContext,
      assistantMessage: AssistantMessage,
      toolUseID: string,
      forceDecision?: unknown,
    ) => {
      const decision = await (config.canUseTool as (...args: unknown[]) => Promise<{ behavior?: string }>)(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )
      if (decision?.behavior !== 'allow') {
        this.#permissionDenials.push({
          tool_name: tool.name,
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }
      return decision
    }) as CanUseTool

    // 5 — one snapshot: additional dirs, init permission mode.
    const appStateSnapshot = config.getAppState()

    // 6 — model: the scribe seat identity outranks --model.
    const resolvedModel =
      isScribeModeOn() && scribePinIsApplicable()
        ? scribeSeatModel()
        : (this.#userSpecifiedModel ?? getMainLoopModel())

    // 7 — thinking: explicit config wins; else adaptive unless the default
    // resolver explicitly says no.
    const thinkingConfig: ThinkingConfig =
      config.thinkingConfig ??
      (shouldEnableThinkingByDefault()
        ? ({ type: 'adaptive' } as ThinkingConfig)
        : ({ type: 'disabled' } as ThinkingConfig))

    // 8 — system-prompt parts.
    const additionalWorkingDirectories = [
      ...appStateSnapshot.toolPermissionContext.additionalWorkingDirectories.keys(),
    ]
    headlessProfilerCheckpoint('before_getSystemPrompt')
    const promptParts = await fetchSystemPromptParts({
      tools: config.tools,
      mainLoopModel: resolvedModel,
      additionalWorkingDirectories,
      mcpClients: config.mcpClients,
      customSystemPrompt: config.customSystemPrompt,
      permissionMode: appStateSnapshot.toolPermissionContext.mode,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')

    // 9 — the memory-mechanics prompt: only for callers that replaced the
    // system prompt AND explicitly wired a memory directory via the path
    // override; usage policy arrives separately via append-system-prompt.
    let memoryMechanicsPrompt: string | null = null
    if (config.customSystemPrompt !== undefined && hasAutoMemPathOverride()) {
      memoryMechanicsPrompt = await loadMemoryPrompt()
    }

    // 10 — assembly: a custom prompt replaces the default, which normally
    // carries the identity/honesty floor — so the floor is placed FIRST and
    // the custom prompt second; it still dominates while the floor survives.
    const systemPromptSections: string[] =
      config.customSystemPrompt !== undefined
        ? [MERCURY_IDENTITY_FLOOR, config.customSystemPrompt]
        : [...promptParts.defaultSystemPrompt]
    if (memoryMechanicsPrompt) systemPromptSections.push(memoryMechanicsPrompt)
    if (config.appendSystemPrompt) systemPromptSections.push(config.appendSystemPrompt)
    const systemPrompt = asSystemPrompt(systemPromptSections)

    // 11 — hook arming (idempotent per session id; each self-gates).
    const sessionId = getSessionId()
    const hasSyntheticOutputTool = config.tools.some(
      tool => tool.name === SYNTHETIC_OUTPUT_TOOL_NAME,
    )
    if (config.jsonSchema && hasSyntheticOutputTool) {
      registerStructuredOutputEnforcement(config.setAppState, sessionId)
    }
    const forcedReadList = (flagEnv('MERCURY_FORCE_READ_FILES') ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
    if (forcedReadList.length > 0) {
      registerForcedReadHook(config.setAppState, sessionId, forcedReadList)
    }
    registerWardsHook(config.setAppState, sessionId)
    // The run-evidence stop hook is normal for SDK/headless conversations
    // too — inert pass-through until a run turns substantive.
    registerRunStopHook(config.setAppState, sessionId)
    // Default off, self-gating; the executor-style gate never rides a
    // foreground Scribe.
    {
      const setAppState = config.setAppState
      if (!isScribeModeOn()) {
        engageCommitGate(setAppState, getSessionId())
      }
    }
    // Role purity before either engager (the engagers re-assert).
    assertSingleRole()
    // A worker spawned by the daemon must die with its supervising daemon;
    // self-gates on the parent-PID env the daemon stamps.
    armWorkerParentWatch()
    if (isScribeModeOn()) {
      engageScribeHooks(config.setAppState, sessionId)
      armImplementerTelemetryPoll()
      if (scribePinIsApplicable() && process.env.MERCURY_EFFORT_LEVEL === undefined) {
        const seatEffort = scribeSeatEffort()
        config.setAppState(prev => ({ ...prev, effort: seatEffort }))
      }
    }
    if (isImplementerModeOn()) {
      engageImplementerHooks(config.setAppState, sessionId)
      if (!implementerBootChecked) {
        implementerBootChecked = true
        const bootTeam = getTeamName()
        const bootFacts = `team=${bootTeam ?? 'none'} agent=${getAgentName() ?? 'unset'} model=${getMainLoopModel()} teammate=${isTeammate()} swarms=${isAgentSwarmsEnabled()}`
        if (bootTeam === 'scribe' && isTeammate() && isAgentSwarmsEnabled()) {
          process.stderr.write(`[implementer] boot OK — ${bootFacts}\n`)
        } else {
          process.stderr.write(
            `[implementer] BOOT SELF-CHECK FAILED (expected team 'scribe'): ${bootFacts} — the bus will NOT deliver; check the --agent-id/--agent-name/--team-name triple and the swarms env\n`,
          )
        }
      }
    }

    // 12 — the tool-use/input context. Debug output is suppressed: stdout
    // carries the protocol.
    const buildContext = (messages: Message[], model: string): ToolUseContext => ({
      options: {
        commands: config.commands,
        debug: false,
        verbose: config.verbose ?? false,
        mainLoopModel: model,
        thinkingConfig,
        tools: config.tools,
        mcpClients: config.mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt: config.customSystemPrompt,
        appendSystemPrompt: config.appendSystemPrompt,
        agentDefinitions: { activeAgents: config.agents ?? [], allAgents: [] },
        theme: getGlobalConfig().theme,
        maxBudgetUsd: config.maxBudgetUsd,
        querySource: 'sdk',
      },
      abortController: this.#abortController,
      readFileState: this.#readFileState,
      getAppState: config.getAppState,
      setAppState: config.setAppState,
      messages,
      setResponseLength: () => {},
      setInProgressToolUseIDs: () => {},
      updateFileHistoryState: updater => {
        config.setAppState(prev => {
          const next = updater(prev.fileHistory)
          return next === prev.fileHistory ? prev : { ...prev, fileHistory: next }
        })
      },
      updateAttributionState: updater => {
        config.setAppState(prev => {
          const next = updater(prev.attribution)
          return next === prev.attribution ? prev : { ...prev, attribution: next }
        })
      },
      handleElicitation: config.handleElicitation,
      setSDKStatus: config.setSDKStatus,
      discoveredSkillNames: this.#discoveredSkillNames,
      loadedNestedMemoryPaths: this.#loadedNestedMemoryPaths,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      dynamicSkillDirTriggers: new Set<string>(),
    })
    let toolUseContext = buildContext(this.mutableMessages, resolvedModel)

    // 13 — orphaned permission, at most once per engine lifetime.
    if (config.orphanedPermission && !this.#orphanedPermissionHandled) {
      this.#orphanedPermissionHandled = true
      yield* handleOrphanedPermission(
        config.orphanedPermission,
        config.tools,
        this.mutableMessages,
        toolUseContext as Parameters<typeof handleOrphanedPermission>[3],
      )
    }

    // Snapshot for the structured-output retry ceiling.
    const syntheticCallsBeforeTurn = this.#countSyntheticOutputCalls()

    // 14 — process the user input.
    const inputResult = await processUserInput({
      input: prompt,
      // A bash line from the focused chat's composer runs as a shell
      // command in THIS session's process (the seat's mode stamp); words
      // are prompt mode.
      mode: options?.mode ?? 'prompt',
      setToolJSX: () => {},
      // SDK-mode processing never reaches the JSX-command members
      // (querySource 'sdk' filters those commands), so the intersection
      // context is asserted rather than stubbed.
      context: toolUseContext as Parameters<typeof processUserInput>[0]['context'],
      messages: this.mutableMessages,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
      querySource: 'sdk',
      canUseTool: wrappedCanUseTool,
    })

    // 15 — append and take the turn-local working copy.
    this.mutableMessages.push(...inputResult.messages)
    let turnMessages: Message[] = [...this.mutableMessages]

    // 16 — persist the user's message(s) BEFORE the loop: recording inside
    // the loop only happens once the provider has answered, and a process
    // killed before that must still leave a resumable transcript.
    if (!persistenceDisabled && inputResult.messages.length > 0) {
      const recordPromise = this.#recordDelta(turnMessages)
      if (isBareMode()) {
        void recordPromise
      } else {
        await recordPromise
        if (eagerFlush) await flushSessionStorage()
      }
    } else {
      this.#recordCursor = turnMessages.length
    }

    // Replay-eligible set (collected only when replay was requested): user
    // messages that are not meta, carry no tool result and are user-authored,
    // plus all compact-boundary system messages — though only the user
    // entries are ever yielded from the acknowledgement site.
    const pendingReplays: Message[] = config.replayUserMessages
      ? inputResult.messages.filter(message => {
          if (message.type === 'user') {
            const userMessage = message as UserMessage & {
              isMeta?: boolean
              toolUseResult?: unknown
            }
            if (userMessage.isMeta === true) return false
            if (userMessage.toolUseResult !== undefined) return false
            const text = messageTextContent(message)
            if (text !== null && isLocalCommandOutputText(text)) return false
            return true
          }
          return (
            message.type === 'system' &&
            (message as { subtype?: string }).subtype === 'compact_boundary'
          )
        })
      : []

    // 17 — always-allow command rules from the returned allowed tools.
    if (inputResult.allowedTools && inputResult.allowedTools.length > 0) {
      config.setAppState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          alwaysAllowRules: {
            ...prev.toolPermissionContext.alwaysAllowRules,
            command: [
              ...new Set([
                ...(prev.toolPermissionContext.alwaysAllowRules.command ?? []),
                ...inputResult.allowedTools!,
              ]),
            ],
          },
        },
      }))
    }

    // 18/19 — the effective model, and the rebuilt context with an inert
    // message setter (nothing calls the setter past this point).
    const effectiveModel = inputResult.model ?? resolvedModel
    toolUseContext = buildContext(turnMessages, effectiveModel)

    // ── the shared terminal envelope ─────────────────────────────────────
    const buildResultEnvelope = (): Record<string, unknown> => {
      // Fold usage that settled WITHOUT its stream (fallback retraction /
      // retry replay) exactly once; reachable from the no-query path too.
      for (const [messageId, usage] of this.#settledUsageById) {
        if (this.#streamFoldedIds.has(messageId)) continue
        this.#streamFoldedIds.add(messageId)
        if (usage.input_tokens === 0 && usage.output_tokens === 0) continue
        this.#accumulatedUsage = accumulateUsage(this.#accumulatedUsage, usage)
      }
      notePrintPhase('settlement')
      return {
        duration_ms: Date.now() - turnStartedAt,
        duration_api_ms: getTotalAPIDuration(),
        session_id: getSessionId(),
        total_cost_usd: getTotalCostUSD(),
        usage: this.#accumulatedUsage,
        modelUsage: getModelUsage(),
        permission_denials: [...this.#permissionDenials],
        uuid: randomUUID(),
      }
    }

    // ── system init first ────────────────────────────────────────────────
    headlessProfilerCheckpoint('before_skills_extensions')
    const [skills, loaded] = await Promise.all([
      getSlashCommandToolSkills(config.cwd),
      // The active set from disk: headless startup never waits on the
      // network for extensions — an SDK caller that needs fresh source
      // reloads them explicitly.
      ensureExtensionsLoaded({ cwd: config.cwd }),
    ])
    const extensions = loaded.set.active.map(ext => ({ name: ext.manifest.name, path: ext.root, source: ext.entry.id }))
    headlessProfilerCheckpoint('after_skills_extensions')
    yield buildSystemInitMessage({
      tools: config.tools,
      mcpClients: config.mcpClients,
      model: effectiveModel,
      permissionMode: appStateSnapshot.toolPermissionContext.mode,
      commands: config.commands,
      agents: config.agents ?? [],
      skills,
      extensions,
    })
    headlessProfilerCheckpoint('system_message_yielded')
    notePrintPhase('assembly')

    // ── no-query path: replay local command output ───────────────────────
    if (!inputResult.shouldQuery) {
      for (const message of inputResult.messages) {
        if (message.type === 'user') {
          const text = messageTextContent(message)
          const isCompactSummary =
            (message as { isCompactSummary?: boolean }).isCompactSummary === true
          if ((text !== null && isLocalCommandOutputText(text)) || isCompactSummary) {
            const flags = message as { isMeta?: boolean; isVisibleInTranscriptOnly?: boolean }
            yield asSdk({
              type: 'user',
              message: {
                role: 'user',
                content: stripAnsi(text ?? ''),
              },
              parent_tool_use_id: null,
              session_id: getSessionId(),
              uuid: (message as { uuid?: string }).uuid,
              timestamp: (message as { timestamp?: string }).timestamp,
              isReplay: !isCompactSummary,
              ...(flags.isMeta === true || flags.isVisibleInTranscriptOnly === true
                ? { isSynthetic: true }
                : {}),
            })
          }
        } else if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'local_command'
        ) {
          const content = (message as { content?: unknown }).content
          if (typeof content === 'string' && isLocalCommandOutputText(content)) {
            // A synthetic assistant message, so mobile clients and session
            // ingress can parse it and remote consumers render it
            // assistant-style.
            yield localCommandOutputToSDKAssistantMessage(
              content,
              (message as { uuid?: string }).uuid as Parameters<
                typeof localCommandOutputToSDKAssistantMessage
              >[1],
            )
          }
        } else if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'compact_boundary'
        ) {
          const meta = (message as { compactMetadata?: never }).compactMetadata
          yield asSdk({
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: meta ? toSDKCompactMetadata(meta) : undefined,
            session_id: getSessionId(),
            uuid: (message as { uuid?: string }).uuid,
          })
        }
      }
      if (!persistenceDisabled) {
        await this.#recordDelta(turnMessages)
        if (eagerFlush) await flushSessionStorage()
      }
      // A typed command refusal (the unavailable family) is not a result:
      // the envelope carries is_error so the print road answers the sentence
      // on stderr with a nonzero exit — never a bare success masquerade.
      yield asSdk({
        type: 'result',
        subtype: 'success',
        is_error: inputResult.commandRefused === true || inputResult.hookBlocked === true,
        num_turns: turnMessages.length - 1,
        result: inputResult.resultText ?? '',
        stop_reason: null,
        ...buildResultEnvelope(),
      })
      return
    }

    // File-history snapshots — query path only. AWAITED: the restore point
    // must hold the pre-turn bytes before any tool of this turn can write
    // — fire-and-forget let a fast provider's first tool call land inside
    // the snapshot's own copy window, so the checkpoint captured POST-edit
    // bytes and a rewind to it restored nothing (the /rewind restore
    // drill caught it). The cost is a stat per tracked file, a copy only
    // where bytes moved.
    if (!persistenceDisabled && fileHistoryEnabled()) {
      const snapshots: Promise<void>[] = []
      for (const message of inputResult.messages) {
        if (message.type !== 'user') continue
        if ((message as { isMeta?: boolean }).isMeta === true) continue
        const uuid = (message as { uuid?: string }).uuid
        if (uuid) {
          snapshots.push(
            fileHistoryMakeSnapshot(
              toolUseContext.updateFileHistoryState,
              uuid as Parameters<typeof fileHistoryMakeSnapshot>[1],
            ).catch((error: unknown) => logError(error)),
          )
        }
      }
      await Promise.all(snapshots)
    }

    // ── the query loop ───────────────────────────────────────────────────
    let currentUsage: NonNullableUsage = { ...EMPTY_USAGE }
    let currentStreamMessageId: string | null = null
    let capturedStopReason: string | null = null
    let acknowledgedReplays = false
    let firstRecordingDone = false

    const recordDelta = async (): Promise<void> => {
      if (persistenceDisabled) return
      await this.#recordDelta(turnMessages)
    }
    const messages = this.mutableMessages

    const queryParams: QueryParams = {
      messages: turnMessages,
      systemPrompt,
      userContext: promptParts.userContext,
      systemContext: promptParts.systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext,
      fallbackModel: config.fallbackModel,
      querySource: 'sdk' as QueryParams['querySource'],
      maxTurns: config.maxTurns,
      taskBudget: config.taskBudget,
    }

    // Seed identity set: the input messages copied in before the loop are
    // never terminal candidates — a turn that streams no content must not
    // settle on its own prompt.
    const seedMessages = new Set<Message>(turnMessages)

    for await (const event of queryEvents(queryParams)) {
      notePrintPhase('first_canonical_event')
      config.onLiveness?.()
      // A provider fallback that withdraws a partially streamed assistant
      // message sends no signal to the SDK stream — only interactive
      // surfaces retract.
      if (event.kind === 'assistant_retracted') continue

      for (const projected of legacyYieldsOf(event)) {
        const kind = (projected as { type?: string }).type
        const message = projected as Message & { subtype?: string }
        // The shared record block below writes the three recorded kinds;
        // boundary handling adds the pre-flush and the post-yield splice.
        let shouldRecord = false
        let isBoundary = false

        switch (kind) {
          case 'stream_request_start':
            // Not projected — but it still reaches the per-message budget
            // check below.
            break
          case 'stream_event': {
            // Provider-wire ingestion: the projected row's event payload is
            // opaque in the SDK family; the wire union types it.
            const raw = projected as { type: 'stream_event'; event?: ApiStreamEvent }
            const streamEvent = raw.event
            if (streamEvent?.type === 'message_start') {
              currentUsage = updateUsage(EMPTY_USAGE, streamEvent.message.usage)
              currentStreamMessageId = streamEvent.message.id ?? null
            } else if (streamEvent?.type === 'message_delta') {
              currentUsage = updateUsage(currentUsage, streamEvent.usage)
              const deltaStop = streamEvent.delta.stop_reason
              if (deltaStop != null) capturedStopReason = deltaStop
            } else if (streamEvent?.type === 'message_stop') {
              this.#accumulatedUsage = accumulateUsage(this.#accumulatedUsage, currentUsage)
              if (currentStreamMessageId) this.#streamFoldedIds.add(currentStreamMessageId)
            }
            if (config.includePartialMessages) {
              yield asSdk({
                type: 'stream_event',
                event: streamEvent ?? raw,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: randomUUID(),
              })
            }
            break
          }
          case 'assistant': {
            const assistant = projected as AssistantMessage
            const stopReason = assistant.message.stop_reason
            // FC-129: a synthetic API-error message hardcodes a wire-shaped
            // stop_reason internally (settledness consumers require
            // non-null), but that value is FABRICATED — every -p run that
            // ended in an endpoint failure reported stop_sequence in its
            // machine envelope, a real wire value meaning the model matched
            // a caller's stop sequence. Error synthetics never feed the
            // envelope: an error-terminal run reports null (no model stop
            // was produced), and a run that errored after real turns keeps
            // the last REAL stop reason.
            if (stopReason != null && assistant.isApiErrorMessage !== true) {
              capturedStopReason = stopReason
            }
            const providerMessageId = assistant.message.id
            if (providerMessageId) {
              this.#settledUsageById.set(
                providerMessageId,
                updateUsage(EMPTY_USAGE, assistant.message.usage),
              )
            }
            shouldRecord = true
            break
          }
          case 'user':
            this.#turnCounter++
            shouldRecord = true
            break
          case 'progress': {
            // Recorded INLINE at the case site: written later they
            // interleave with already recorded tool results, the
            // de-duplication walk fixes the parent on the wrong message, and
            // the resumed conversation is orphaned.
            this.mutableMessages.push(message)
            turnMessages.push(message)
            void recordDelta()
            yield* normalizeMessage(message)
            break
          }
          case 'attachment': {
            // Same inline-recording law as progress (dedup-walk anchoring).
            this.mutableMessages.push(message)
            turnMessages.push(message)
            void recordDelta()
            const attachment = (projected as { attachment?: { type?: string } }).attachment
            const attachmentType = attachment?.type
            if (attachmentType === 'structured_output') {
              this.#structuredOutput = (attachment as { data?: unknown }).data
            } else if (attachmentType === 'max_turns_reached') {
              if (eagerFlush) await flushSessionStorage()
              yield asSdk({
                type: 'result',
                subtype: 'error_max_turns',
                is_error: true,
                // The attachment's own count — the engine counter lags it
                // when the cap fires mid-drain.
                num_turns:
                  (attachment as { turnCount?: number }).turnCount ?? this.#turnCounter,
                stop_reason: capturedStopReason,
                errors: [
                  `Reached the maximum number of turns (${config.maxTurns ?? ''})`.replace(' ()', ''),
                ],
                ...buildResultEnvelope(),
              })
              return
            } else if (attachmentType === 'repetition_breaker') {
              // The turn ended because the model hammered one identical
              // call past its correction — the objective is not met.
              if (eagerFlush) await flushSessionStorage()
              yield asSdk({
                type: 'result',
                subtype: 'error_repetition_breaker',
                is_error: true,
                num_turns: this.#turnCounter,
                stop_reason: capturedStopReason,
                errors: [(attachment as { cause?: string }).cause ?? 'repetition breaker'],
                ...buildResultEnvelope(),
              })
              return
            } else if (attachmentType === 'cycle_handoff') {
              // A deliberate, evidence-backed settle — success, not an error.
              const cause = (attachment as { cause?: string }).cause ?? ''
              const openItems = (attachment as { openItems?: string[] }).openItems ?? []
              const report = (attachment as { report?: string }).report ?? ''
              const openClause =
                openItems.length > 0 ? ` Unfinished: ${openItems.join('; ')}.` : ''
              yield asSdk({
                type: 'result',
                subtype: 'success',
                is_error: false,
                num_turns: turnMessages.length - 1,
                result: `HANDOFF: ${cause}${openClause}\n${report}`,
                stop_reason: capturedStopReason,
                ...buildResultEnvelope(),
              })
              return
            } else if (attachmentType === 'queued_command' && config.replayUserMessages) {
              yield asSdk({
                type: 'user',
                message: {
                  role: 'user',
                  content: (attachment as { prompt?: string }).prompt ?? '',
                },
                parent_tool_use_id: null,
                session_id: getSessionId(),
                // The queued command's origin uuid IS the replay uuid.
                uuid:
                  (attachment as { source_uuid?: string }).source_uuid ??
                  (projected as { uuid?: string }).uuid,
                isReplay: true,
              })
            }
            break
          }
          case 'system': {
            const systemMessage = message
            // The snip-boundary callback owns boundary recognition; the
            // engine holds no knowledge of that gated feature's identifiers.
            // No caller injects it in this build.
            if (config.snipBoundaryCallback) {
              const snipOutcome = config.snipBoundaryCallback(systemMessage, this.mutableMessages)
              if (snipOutcome !== undefined) {
                if (snipOutcome.executed) {
                  this.mutableMessages.length = 0
                  this.mutableMessages.push(...snipOutcome.messages)
                }
                break
              }
            }
            if (systemMessage.subtype === 'api_error') {
              this.mutableMessages.push(systemMessage)
              const apiError = systemMessage as {
                retryAttempt?: number
                maxRetries?: number
                retryInMs?: number
                errorDetail?: { status?: number | null }
                error?: { status?: number | null }
                uuid?: string
              }
              yield asSdk({
                type: 'system',
                subtype: 'api_retry',
                attempt: apiError.retryAttempt,
                max_retries: apiError.maxRetries,
                retry_delay_ms: apiError.retryInMs,
                error_status:
                  apiError.errorDetail?.status ?? apiError.error?.status ?? null,
                error: categorizeRetryableAPIError(apiError.error),
                session_id: getSessionId(),
                uuid: apiError.uuid ?? randomUUID(),
              })
              break
            }
            if (systemMessage.subtype !== 'compact_boundary') {
              // Operator-meaningful notices (a repetition stop, a model
              // switch, a stream-drop recovery — 'informational' at
              // warning/error level) are RECORDED: the cockpit paints a
              // daemon-hosted session from the transcript file, and an
              // unrecorded notice makes the harness's own intervention
              // invisible — the turn just goes quiet. Info-level stays
              // in-memory chrome, and none of them join the SDK yield
              // stream (headless consumers get the typed result instead).
              const level = (systemMessage as { level?: string }).level
              if (
                systemMessage.subtype === 'informational' &&
                (level === 'warning' || level === 'error')
              ) {
                this.mutableMessages.push(systemMessage)
                turnMessages.push(systemMessage)
                await recordDelta()
                break
              }
              // All other system subtypes are not yielded in headless mode.
              this.mutableMessages.push(systemMessage)
              // Safety copy PERSISTS (the stop-notice law): a warning- or
              // error-level informational row is the engine telling the
              // operator why a turn stopped (the repetition breaker's
              // notice). The cockpit paints a daemon-hosted session from
              // the transcript FILE — an in-memory-only push here dropped
              // the sentence between the turn machine's yield and the
              // store, so the screen never said why. Recorded inline (the
              // progress/attachment anchoring law); info-level rows stay
              // in-memory chrome.
              if (
                (systemMessage as { level?: string }).level === 'warning' ||
                (systemMessage as { level?: string }).level === 'error'
              ) {
                turnMessages.push(systemMessage)
                await recordDelta()
              }
              break
            }
            shouldRecord = true
            isBoundary = true
            break
          }
          case 'tool_use_summary': {
            const summary = projected as {
              summary?: string
              precedingToolUseIds?: string[]
              uuid?: string
            }
            yield asSdk({
              type: 'tool_use_summary',
              summary: summary.summary,
              preceding_tool_use_ids: summary.precedingToolUseIds ?? [],
              session_id: getSessionId(),
              uuid: summary.uuid ?? randomUUID(),
            })
            break
          }
          default:
            break
        }

        if (shouldRecord) {
          // Persist assistant, user, and compact-boundary messages
          // — fire-and-forget for assistant yields (awaiting suspends the
          // generator until every content block is consumed, and the write
          // queue's drain timer fires first — the deadlock), awaited for the
          // rest. The order-preserving write queue is what makes the
          // fire-and-forget safe.
          if (isBoundary && !persistenceDisabled) {
            // Flush up to and including the preserved tail DIRECTLY, outside
            // the delta chain — otherwise a restart between turns leaves the
            // tail pointing at a never-written message and resume loads the
            // full pre-compaction history.
            const boundaryMeta = (message as { compactMetadata?: { preservedSegment?: { tailUuid?: string } } }).compactMetadata
            const tailUuid = boundaryMeta?.preservedSegment?.tailUuid
            const tailIdx = tailUuid
              ? this.mutableMessages.findIndex(
                  candidate => (candidate as { uuid?: string }).uuid === tailUuid,
                )
              : -1
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1)).catch(
                (error: unknown) => logError(error),
              )
            }
          }
          messages.push(message)
          turnMessages.push(message)
          if (message.type === 'assistant') {
            void recordDelta()
          } else {
            await recordDelta()
          }
        }
        // Acknowledge initial user messages
        if (kind === 'assistant') {
          if (!firstRecordingDone) {
            firstRecordingDone = true
            if (!acknowledgedReplays) {
              acknowledgedReplays = true
              for (const replay of pendingReplays) {
                if (replay.type !== 'user') continue
                yield asSdk({
                  type: 'user',
                  message: (replay as UserMessage).message,
                  parent_tool_use_id: null,
                  session_id: getSessionId(),
                  uuid: (replay as { uuid?: string }).uuid,
                  isReplay: true,
                })
              }
            }
          }
          yield* normalizeMessage(message)
        } else if (kind === 'user') {
          yield* normalizeMessage(message)
        } else if (isBoundary) {
          // The boundary is the final element: splice everything before it
          // out of both arrays so it can be garbage-collected, and move the
          // recording cursor with the splice (it is an index).
          const boundaryMeta = 'compactMetadata' in message ? message.compactMetadata : undefined
          const boundaryIndexStore = this.mutableMessages.length - 1
          this.mutableMessages.splice(0, boundaryIndexStore)
          const boundaryIndexTurn = turnMessages.length - 1
          turnMessages.splice(0, boundaryIndexTurn)
          this.#recordCursor = Math.max(0, this.#recordCursor - boundaryIndexTurn)
          yield asSdk({
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: boundaryMeta ? toSDKCompactMetadata(boundaryMeta) : undefined,
            session_id: getSessionId(),
            uuid: (message as { uuid?: string }).uuid,
          })
        }

        // ── after each projected message ─────────────────────────────────
        if (
          config.maxBudgetUsd !== undefined &&
          getTotalCostUSD() >= config.maxBudgetUsd
        ) {
          if (eagerFlush) await flushSessionStorage()
          yield asSdk({
            type: 'result',
            subtype: 'error_max_budget_usd',
            is_error: true,
            num_turns: this.#turnCounter,
            stop_reason: capturedStopReason,
            errors: [`Reached the maximum budget ($${config.maxBudgetUsd})`],
            ...buildResultEnvelope(),
          })
          return
        }
        if (kind === 'user' && config.jsonSchema) {
          const retries =
            this.#countSyntheticOutputCalls() - syntheticCallsBeforeTurn
          const maxRetries = Number.parseInt(
            process.env.MAX_STRUCTURED_OUTPUT_RETRIES ??
              String(DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES),
            10,
          )
          if (retries >= maxRetries) {
            if (eagerFlush) await flushSessionStorage()
            yield asSdk({
              type: 'result',
              subtype: 'error_max_structured_output_retries',
              is_error: true,
              num_turns: this.#turnCounter,
              stop_reason: capturedStopReason,
              errors: [`Structured output failed after ${retries} attempts`],
              ...buildResultEnvelope(),
            })
            return
          }
        }
      }
    }

    // ── turn settlement ──────────────────────────────────────────────────
    // The terminal message is the last assistant OR user message — stop
    // hooks append progress/attachment messages after the response, and a
    // user message of tool results is a valid successful terminal state.
    // Backward index walk: same predicate, same first-from-the-end match,
    // without cloning and reversing the whole turn history.
    let terminalMessage: (typeof turnMessages)[number] | undefined
    for (let i = turnMessages.length - 1; i >= 0; i--) {
      const message = turnMessages[i]!
      if (
        (message.type === 'assistant' || message.type === 'user') &&
        !seedMessages.has(message)
      ) {
        terminalMessage = message
        break
      }
    }
    notePrintPhase('terminal')

    // Diagnostics BEFORE the success narrowing (the predicate is a type
    // guard that narrows the value away).
    const terminalType = terminalMessage?.type ?? 'undefined'
    let lastBlockType = 'n/a'
    if (terminalMessage?.type === 'assistant') {
      const content = terminalMessage.message.content
      lastBlockType = Array.isArray(content) ? (content.at(-1)?.type ?? 'none') : 'none'
    }

    if (eagerFlush) await flushSessionStorage()

    // The end-turn carve-out: a turn that streamed only a message delta
    // with an end_turn stop reason and never yielded content settles as an
    // EMPTY success, not an execution error.
    const endTurnCarveOut = !terminalMessage && capturedStopReason === 'end_turn'
    if ((!terminalMessage || !isResultSuccessful(terminalMessage)) && !endTurnCarveOut) {
      const allErrors = getInMemoryErrors()
      const watermarkIndex = errorWatermark ? allErrors.indexOf(errorWatermark) : -1
      const turnErrors = allErrors.slice(watermarkIndex + 1).map(entry => entry.error)
      yield asSdk({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: this.#turnCounter,
        stop_reason: capturedStopReason,
        errors: [
          `[ede_diagnostic] result_type=${terminalType} last_content_type=${lastBlockType} stop_reason=${capturedStopReason ?? 'null'}`,
          ...turnErrors,
        ],
        ...buildResultEnvelope(),
      })
      return
    }

    let textResult = ''
    let isApiError = false
    if (terminalMessage?.type === 'assistant') {
      const assistant = terminalMessage as AssistantMessage & {
        isApiErrorMessage?: boolean
      }
      isApiError = assistant.isApiErrorMessage === true
      const content = assistant.message.content
      if (Array.isArray(content)) {
        // The LAST TEXT block: the closing block is not always text (a
        // thinking or tool-use block can come last), and reading it would
        // report an empty result for a turn that did produce text.
        for (let index = content.length - 1; index >= 0; index--) {
          const block = content[index] as { type?: string; text?: string }
          if (block.type === 'text' && typeof block.text === 'string') {
            textResult = block.text
            break
          }
        }
      } else if (typeof content === 'string') {
        textResult = content
      }
    }

    if (isApiError) {
      // The outcome type and the error flag agree — never a success subtype
      // carrying an error flag.
      yield asSdk({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: this.#turnCounter,
        stop_reason: capturedStopReason,
        errors: [textResult],
        ...buildResultEnvelope(),
      })
      return
    }

    yield asSdk({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: this.#turnCounter,
      result: textResult,
      stop_reason: capturedStopReason,
      ...(this.#structuredOutput !== undefined
        ? { structured_output: this.#structuredOutput }
        : {}),
      ...buildResultEnvelope(),
    })
  }

  #countSyntheticOutputCalls(): number {
    let count = 0
    for (const message of this.mutableMessages) {
      if (message.type !== 'assistant') continue
      const content = (message as AssistantMessage).message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const typed = block as { type?: string; name?: string }
        if (typed.type === 'tool_use' && typed.name === SYNTHETIC_OUTPUT_TOOL_NAME) {
          count++
        }
      }
    }
    return count
  }
}

// Once-per-session-id fable effort floor pins (module scope: a fresh engine
// per turn must not re-pin over an operator's mid-session change).

type AskOptions = Omit<QueryEngineConfig, 'readFileState' | 'initialMessages'> & {
  prompt: string | ContentBlockParam[]
  promptUuid?: string
  isMeta?: boolean
  /** The composer mode the prompt was typed in ('bash' runs it as a shell command). */
  promptMode?: 'prompt' | 'bash'
  /** THE SESSION'S OWN ARRAY — the memory between turns: it seeds the
   *  engine AND receives the turn's frames back in the finally (the
   *  write-back contract below). A caller that keeps one array across
   *  ask() calls holds the whole conversation; a caller that passes none
   *  runs a one-shot. */
  mutableMessages?: Message[]
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
} & { snipBoundaryCallback?: never }

/** The one-shot wrapper: constructs an engine over a CLONE of the caller's
 *  file-state cache, delegates the generator, and writes the engine's cache
 *  back in a finally band — even when the generator throws or is abandoned.
 *
 *  THE SEAT'S MEMORY (the write-back contract): the engine copies its seed
 *  into a turn-local array, so before this contract the caller's
 *  `mutableMessages` never learned the turn — a host that built one ask()
 *  per prompt (the daemon-hosted seat) re-seeded every engine from the boot
 *  state and the model answered every prompt with amnesia. The finally
 *  appends the engine's NEW frames (everything past the seed it copied)
 *  onto the caller's array — append-only, so frames a host lane added
 *  meanwhile survive; a turn that restructured the seed itself (the
 *  compaction splice, the snip rewrite) writes the engine's whole settled
 *  view back instead, seed identity telling the two shapes apart. */
export async function* ask(
  options: AskOptions,
): AsyncGenerator<SDKMessage, void, unknown> {
  const {
    prompt,
    promptUuid,
    isMeta,
    promptMode,
    mutableMessages = [],
    getReadFileCache,
    setReadFileCache,
    ...engineConfig
  } = options
  const engine = new QueryEngine({
    ...engineConfig,
    initialMessages: mutableMessages,
    readFileState: cloneFileStateCache(getReadFileCache()),
  })
  const seedLength = mutableMessages.length
  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
      ...(promptMode !== undefined ? { mode: promptMode } : {}),
    })
  } finally {
    setReadFileCache(engine.getReadFileState())
    const settled = engine.getMessages()
    // Seed intact ⇒ the copied prefix still leads the engine's array (the
    // elements are the same references the spread copied) — append the tail.
    const seedIntact =
      seedLength === 0 ||
      (settled.length >= seedLength && settled[seedLength - 1] === mutableMessages[seedLength - 1])
    if (seedIntact) {
      if (settled.length > seedLength) mutableMessages.push(...settled.slice(seedLength))
    } else {
      mutableMessages.length = 0
      mutableMessages.push(...settled)
    }
  }
}
