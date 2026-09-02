// ============================================================================
//  headless/controlHandlers — the stream-JSON control-protocol handlers
//  (core-ownership Phase 9.3 cut (c), moved verbatim from print.ts):
//  initialize · rewind-files · set-permission-mode · channel-enable (+ the
//  reconnect re-register) · orphaned-permission response · the dynamic MCP
//  plane (mcp-set-servers + reconcile). The dispatch band that ROUTES
//  control_requests stays in print.ts's streaming loop; these are the
//  handler bodies it calls.
// ============================================================================

import { errorMessage, toError } from '../../utils/errors.js'
import { type UUID } from 'crypto'
import { ask } from 'src/QueryEngine.js'
import { type ToolPermissionContext, type Tools } from 'src/Tool.js'
import { type ChannelEntry, getMainThreadAgentType,  registerHookCallbacks, setInitJsonSchema, setMainLoopModelOverride, setMainThreadAgentType } from 'src/bootstrap/state.js'
import { StructuredIO } from 'src/cli/structuredIO.js'
import { type Command, formatDescriptionWithSource, getCommandName } from 'src/commands.js'
import { type HookEvent, type McpServerConfigForProcessTransport, type ModelInfo, type PermissionResult, type RewindFilesResult } from 'src/entrypoints/agentSdkTypes.js'
import { type SDKControlInitializeRequest, type SDKControlInitializeResponse, type SDKControlMcpSetServersResponse, type SDKControlResponse, type SDKControlRewindSessionRequest, type StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { type RewindRefusalKind, type SessionRewindOutcomeV1 } from 'src/daemon/protocol.js'
import { createOperatorRewindRecordMessage } from 'src/services/compact/checkpointRewind.js'
import { type Message } from 'src/types/message.js'
import { findLastCompactBoundaryIndex } from 'src/utils/messages/systemMessages.js'
import { flushSessionStorage, recordTranscript } from 'src/utils/sessionStorage.js'
import { findChannelEntry, gateChannelServer } from 'src/services/mcp/channelNotification.js'
import { areMcpConfigsEqual, clearServerCache, connectToServer, fetchToolsForClient } from 'src/services/mcp/client.js'
import { filterMcpServersByPolicy } from 'src/services/mcp/config.js'
import { type MCPServerConnection, type McpSdkServerConfig, type ScopedMcpServerConfig } from 'src/services/mcp/types.js'
import { type AppState } from 'src/state/AppStateStore.js'
import { flagEnv } from 'src/substrate/flagRegistry.js'
import { type AgentDefinition, isBuiltInAgent, parseAgentsFromJson } from 'src/tools/AgentTool/loadAgentsDir.js'
import { type HookCallbackMatcher } from 'src/types/hooks.js'
import { type PermissionMode as InternalPermissionMode } from 'src/types/permissions.js'
import { getAccountInformation } from 'src/utils/auth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { fileHistoryCanRestore, fileHistoryEnabled, fileHistoryRestore, type RestoreDriftOracle } from 'src/utils/fileHistory.js'
import { logError } from 'src/utils/log.js'
import { enqueue } from 'src/utils/messageQueueManager.js'
import { parseUserSpecifiedModel } from 'src/utils/model/model.js'
import { isBypassPermissionsModeDisabled, transitionPermissionMode, validateModeEntry } from 'src/utils/permissions/permissionSetup.js'
import { findUnresolvedToolUse } from 'src/utils/sessionStorage.js'
import { type Stream } from 'src/utils/stream.js'

export async function handleInitializeRequest(
  request: SDKControlInitializeRequest,
  requestId: string,
  initialized: boolean,
  output: Stream<StdoutMessage>,
  commands: Command[],
  modelInfos: ModelInfo[],
  structuredIO: StructuredIO,
  enableAuthStatus: boolean,
  options: {
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    agent?: string | undefined
    userSpecifiedModel?: string | undefined
    [key: string]: unknown
  },
  agents: AgentDefinition[],
  getAppState: () => AppState,
): Promise<void> {
  if (initialized) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        error: 'Already initialized',
        request_id: requestId,
        pending_permission_requests:
          structuredIO.getPendingPermissionRequests(),
      },
    })
    return
  }

  // Large payloads (system prompts, agent definitions) ride the initialize
  // request over stdin — as argv they would blow past ARG_MAX.
  if (request.systemPrompt !== undefined) {
    options.systemPrompt = request.systemPrompt
  }
  if (request.appendSystemPrompt !== undefined) {
    options.appendSystemPrompt = request.appendSystemPrompt
  }
  if (request.promptSuggestions !== undefined) {
    options.promptSuggestions = request.promptSuggestions
  }

  if (request.agents) {
    const stdinAgents = parseAgentsFromJson(request.agents, 'flagSettings')
    agents.push(...stdinAgents)
  }

  // Re-resolve the main-thread agent now that SDK-defined agents joined the
  // list — --agent may name an agent that only exists via SDK init.
  if (options.agent) {
    // alreadyResolved: main.tsx found this agent on the filesystem and
    // already applied its systemPrompt/model/initialPrompt — a second
    // application here would double them.
    const alreadyResolved = getMainThreadAgentType() === options.agent
    const mainThreadAgent = agents.find(a => a.agentType === options.agent)
    if (mainThreadAgent && !alreadyResolved) {
      setMainThreadAgentType(mainThreadAgent.agentType)

      // The agent's own system prompt applies only when the caller didn't
      // pass one. Init-delivered agents are never built-in, so their
      // getSystemPrompt() takes no arguments.
      if (!options.systemPrompt && !isBuiltInAgent(mainThreadAgent)) {
        const agentSystemPrompt = mainThreadAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }

      // The agent's model applies only when the caller didn't pick one, and
      // 'inherit' means exactly that — no override.
      if (
        !options.userSpecifiedModel &&
        mainThreadAgent.model &&
        mainThreadAgent.model !== 'inherit'
      ) {
        const agentModel = parseUserSpecifiedModel(mainThreadAgent.model)
        setMainLoopModelOverride(agentModel)
      }

      // An init-delivered agent postdates main.tsx's lookup entirely — its
      // initialPrompt can only land here.
      if (mainThreadAgent.initialPrompt) {
        structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
      }
    } else if (mainThreadAgent?.initialPrompt) {
      // alreadyResolved arm (a filesystem-defined agent): main.tsx already
      // handled initialPrompt for a STRING inputPrompt, but an AsyncIterable
      // inputPrompt (SDK stream-json) has nothing to concatenate onto — the
      // prompt lands via prependUserMessage here instead.
      structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
    }
  }

  const accountInfo = getAccountInformation()
  if (request.hooks) {
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}
    for (const [event, matchers] of Object.entries(request.hooks)) {
      hooks[event as HookEvent] = matchers.map(matcher => {
        const callbacks = matcher.hookCallbackIds.map(callbackId => {
          return structuredIO.createHookCallback(callbackId, matcher.timeout)
        })
        return {
          ...(matcher.matcher !== undefined ? { matcher: matcher.matcher } : {}),
          hooks: callbacks,
        }
      })
    }
    registerHookCallbacks(hooks)
  }
  if (request.jsonSchema) {
    setInitJsonSchema(request.jsonSchema)
  }
  const initResponse: SDKControlInitializeResponse = {
    commands: commands
      .filter(cmd => cmd.userInvocable !== false)
      .map(cmd => ({
        name: getCommandName(cmd),
        description: formatDescriptionWithSource(cmd),
        argumentHint: cmd.argumentHint || '',
      })),
    agents: agents.map(agent => ({
      name: agent.agentType,
      description: agent.whenToUse,
      // 'inherit' is internal vocabulary — the public listing says "no model".
      model: agent.model === 'inherit' ? undefined : agent.model,
    })),
    models: modelInfos,
    account: {
      email: accountInfo?.email,
      organization: accountInfo?.organization,
      subscriptionType: accountInfo?.subscription,
      tokenSource: accountInfo?.tokenSource,
      apiKeySource: accountInfo?.apiKeySource,
      // Under a 3P provider getAccountInformation() is undefined and every
      // Contract field: consumers read this string. Always first-party —
      // the gateway estate retired.
      apiProvider: 'firstParty',
    },
    pid: process.pid,
  }

  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: initResponse,
    },
  })

  // (enableAuthStatus is accepted for protocol compatibility but has no
  // publisher — there is no cloud-gateway credential-refresh streaming.)
}

/**
 * The SDK's rewind_files control and --rewind-files ride the same
 * all-or-nothing restore the operator's /rewind uses (one restore owner):
 * a drift or a missing blob refuses by name with nothing written, where the
 * per-file copy loop it replaces could leave a mixed tree.
 */
export async function handleRewindFiles(
  userMessageId: UUID,
  appState: AppState,
  _setAppState: (updater: (prev: AppState) => AppState) => void,
  dryRun: boolean,
  drift?: RestoreDriftOracle,
): Promise<RewindFilesResult> {
  if (!fileHistoryEnabled()) {
    return { canRewind: false, error: 'File rewinding is not enabled.' }
  }
  if (!fileHistoryCanRestore(appState.fileHistory, userMessageId)) {
    return {
      canRewind: false,
      error: 'No file checkpoint found for this message.',
    }
  }
  let restored: Awaited<ReturnType<typeof fileHistoryRestore>>
  try {
    restored = await fileHistoryRestore(appState.fileHistory, userMessageId, {
      dryRun,
      ownerKey: `rewind:${String(userMessageId)}`,
      ...(drift !== undefined ? { drift } : {}),
    })
  } catch (error) {
    return { canRewind: false, error: `Failed to rewind: ${errorMessage(error)}` }
  }
  if (!restored.ok) {
    return { canRewind: false, error: `Failed to rewind: ${restored.detail}` }
  }
  if (dryRun) {
    return { canRewind: true, filesChanged: restored.changed, insertions: restored.insertions, deletions: restored.deletions }
  }
  return { canRewind: true }
}

// ── the /rewind verb inside the runner (FN-015 rank 8) ─────────────────────
//  The cockpit's restore road ends HERE, in the process that captured the
//  checkpoints and owns the conversation: code = the all-or-nothing file
//  restore; conversation = the operator rewind record appended to the
//  transcript (identity preserved — same session, same file; the record is
//  what every provider-bound view and the cockpit's chat project on);
//  both = code then conversation, one receipt. Every refusal is typed.

export interface RewindSessionContext {
  /** The runner's live conversation (the array the next turn extends). */
  messages: Message[]
  getAppState: () => AppState
  /** The tools' read-state — the drift oracle. */
  drift: RestoreDriftOracle
  /** A turn is in flight (its abort controller stands). */
  turnActive: boolean
}

function refusedRewind(mode: SessionRewindOutcomeV1['mode'], refusal: RewindRefusalKind, detail: string): SessionRewindOutcomeV1 {
  return { outcome: 'refused', mode, refusal, detail }
}

function isOperatorTurn(message: Message, uuid: string): boolean {
  if (message.type !== 'user' || message.uuid !== uuid) return false
  if ((message as { isMeta?: boolean }).isMeta === true) return false
  const content = message.message.content
  if (Array.isArray(content) && content[0]?.type === 'tool_result') return false
  return true
}

export async function handleRewindSession(
  request: SDKControlRewindSessionRequest,
  ctx: RewindSessionContext,
): Promise<SessionRewindOutcomeV1> {
  const { mode } = request
  const uuid = request.user_message_id
  const dryRun = request.dry_run === true
  if (ctx.turnActive) {
    return refusedRewind(mode, 'turn-active', 'a turn is running in this session — press esc to stop it, then /rewind again')
  }
  const turnIndex = ctx.messages.findIndex(m => isOperatorTurn(m, uuid))
  if (turnIndex === -1) {
    return refusedRewind(mode, 'not-found', "that point is not in this session's conversation")
  }
  const wantsCode = mode === 'code' || mode === 'both'
  const wantsConversation = mode === 'conversation' || mode === 'both'
  // The conversation half's preconditions are checked BEFORE any file is
  // written, so 'both' cannot restore the files and then refuse the turn.
  if (wantsConversation) {
    const boundary = findLastCompactBoundaryIndex(ctx.messages)
    if (boundary !== -1 && turnIndex <= boundary) {
      return refusedRewind(mode, 'before-compaction', 'that point lies before the last compaction fold — its summary cannot be unpicked; pick a later point or /clear')
    }
  }
  const receipt: SessionRewindOutcomeV1 = { outcome: 'applied', mode, ...(dryRun ? { dryRun: true } : {}) }
  if (wantsCode) {
    if (!fileHistoryEnabled()) {
      return refusedRewind(mode, 'capture-off', 'file checkpoints are off for this session (Settings › File checkpointing) — the conversation can still be restored')
    }
    const state = ctx.getAppState()
    if (!fileHistoryCanRestore(state.fileHistory, uuid as UUID)) {
      return refusedRewind(mode, 'no-checkpoint', 'no saved files at this point — the checkpoint store holds nothing for it')
    }
    let restored: Awaited<ReturnType<typeof fileHistoryRestore>>
    try {
      restored = await fileHistoryRestore(state.fileHistory, uuid as UUID, {
        dryRun,
        ownerKey: `rewind:${uuid}`,
        drift: ctx.drift,
      })
    } catch (error) {
      return refusedRewind(mode, 'restore-failed', `the restore threw before any file was written: ${errorMessage(error)}`)
    }
    if (!restored.ok) return refusedRewind(mode, restored.kind, restored.detail)
    receipt.code = { filesChanged: restored.changed, insertions: restored.insertions, deletions: restored.deletions }
    if (!wantsConversation && restored.changed.length === 0) {
      return { ...receipt, outcome: 'noop', detail: 'the files already match this point — nothing to restore' }
    }
  }
  if (wantsConversation) {
    const removed = ctx.messages.length - turnIndex
    if (dryRun) {
      receipt.conversation = { turnUuid: uuid, removed }
      return receipt
    }
    const record = createOperatorRewindRecordMessage({ turnUuid: uuid, removed })
    ctx.messages.push(record)
    try {
      await recordTranscript([record], undefined, undefined, ctx.messages)
      await flushSessionStorage()
    } catch (error) {
      // The files (if any) landed; the row did not — the receipt says
      // exactly that rather than claiming a boundary the transcript lacks.
      const landed = receipt.code !== undefined ? `the files were restored (${receipt.code.filesChanged.length}); ` : ''
      return { ...receipt, outcome: 'refused', refusal: 'restore-failed', detail: `${landed}the conversation boundary could not be written to the transcript: ${errorMessage(error)}` }
    }
    receipt.conversation = { turnUuid: uuid, removed }
  }
  return receipt
}

/**
 * The permission-mode transition DECISION, one owner for both doors: the
 * mid-session `set_permission_mode` control (below, which wires the wire
 * responses) and the warm runner's pre-turn `claim_session` (print.ts,
 * which applies the mode inside its single claim acknowledgement). A typed
 * refusal here is exactly the refusal the wire door speaks.
 */
export function resolvePermissionModeTransition(
  mode: InternalPermissionMode,
  toolPermissionContext: ToolPermissionContext,
): { ok: true; context: ToolPermissionContext } | { ok: false; error: string } {
  // Apollo is an interactive-session mode: its whole point — the pre-flight
  // interview's polls and closing review — is the interactive UI. Since the
  // one-door unification every interactive chat IS a daemon-hosted runner
  // (this process, wearing the concourse worker role stamp): its polls and
  // review card ride the seat ask stream to the operator's face, and the
  // engine threads the live mode into every prompt build — so the worker
  // role ACCEPTS apollo (the operator-sighted carousel flicker: shift+tab
  // adopted apollo on the screen, this refusal bounced it, and the next
  // facts beat snapped the chip back). A genuine SDK/print embedder still
  // refuses — no face, no interview; honest availability over an inert
  // ask-first posture wearing the Apollo name.
  if (mode === 'apollo' && flagEnv('MERCURY_CONCOURSE_WORKER') !== '1') {
    return {
      ok: false,
      error:
        'Cannot set permission mode to apollo in SDK/print mode — the Apollo pre-flight interview is interactive-only; run it in the terminal UI',
    }
  }
  // autopilot is an interactive-session mode (its whole point — the
  // SetTier tool — is interactive-only). The apollo arm's twin
  // (lead-authorized): a runner wearing the concourse worker role stamp
  // serves an operator's seat — the SetTier tool and the pack already ride
  // it — so it accepts autopilot UNDER THE FULL RUNTIME ELIGIBILITY, the
  // interactive guard's own validateModeEntry (the opt-in flag, the policy
  // kill, the bypass launch flag): one eligibility owner, so this door and
  // the interactive guard can never drift, and the consent-backdoor law
  // keeps its teeth on the wire. A genuine SDK/print embedder still
  // refuses toward sovereign, the identical permission posture.
  if (mode === 'autopilot') {
    if (flagEnv('MERCURY_CONCOURSE_WORKER') !== '1') {
      return {
        ok: false,
        error: 'Cannot set permission mode to autopilot in SDK/print mode — use sovereign (the same permission posture)',
      }
    }
    const eligibility = validateModeEntry('autopilot', toolPermissionContext)
    if (!eligibility.ok) {
      return { ok: false, error: eligibility.error }
    }
  }
  // Sovereign needs BOTH standing config permission and the launch flag.
  if (mode === 'sovereign') {
    if (isBypassPermissionsModeDisabled()) {
      return {
        ok: false,
        error: 'Cannot set permission mode to sovereign because it is disabled by settings or configuration',
      }
    }
    if (!toolPermissionContext.isBypassPermissionsModeAvailable) {
      return {
        ok: false,
        error: 'Cannot set permission mode to sovereign because the session was not launched with --dangerously-skip-permissions',
      }
    }
  }
  return {
    ok: true,
    context: {
      ...transitionPermissionMode(toolPermissionContext.mode, mode, toolPermissionContext),
      mode,
    },
  }
}

export function handleSetPermissionMode(
  request: { mode: InternalPermissionMode },
  requestId: string,
  toolPermissionContext: ToolPermissionContext,
  output: Stream<StdoutMessage>,
): ToolPermissionContext {
  const resolved = resolvePermissionModeTransition(request.mode, toolPermissionContext)
  if (!resolved.ok) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: resolved.error,
      },
    })
    return toolPermissionContext
  }

  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        mode: request.mode,
      },
    },
  })

  return resolved.context
}

/**
 * IDE-triggered channel enable — a stable control-protocol seam whose
 * FEATURE is not in this build. The request is answered with a typed error
 * response (never silently dropped) so the IDE knows exactly where it
 * stands; the signature stays request-shaped so the dispatch band in
 * print.ts routes it like every other control request.
 */
export function handleChannelEnable(
  requestId: string,
  serverName: string,
  connectionPool: readonly MCPServerConnection[],
  output: Stream<StdoutMessage>,
): void {
  const respondError = (error: string) =>
    output.enqueue({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    })

  return respondError('channels feature not available in this build')
}

/**
 * Post-reconnect channel-handler re-registration — the second half of the
 * channels seam above, and a no-op in this build for the same reason. Kept
 * so the mcp_reconnect/mcp_toggle call sites keep their shape; when the
 * channels feature lands, the re-bind belongs here (a reconnect creates a
 * NEW client object, so any handler bound to the old one dies with it).
 */
export function reregisterChannelHandlerAfterReconnect(
  connection: MCPServerConnection,
): void {
  return
}

export async function handleOrphanedPermissionResponse({
  message,
  setAppState,
  onEnqueued,
  handledToolUseIds,
}: {
  message: SDKControlResponse
  setAppState: (f: (prev: AppState) => AppState) => void
  onEnqueued?: () => void
  handledToolUseIds: Set<string>
}): Promise<boolean> {
  if (
    message.response.subtype === 'success' &&
    message.response.response?.toolUseID &&
    typeof message.response.response.toolUseID === 'string'
  ) {
    const permissionResult = message.response.response as PermissionResult
    const { toolUseID } = permissionResult
    if (!toolUseID) {
      return false
    }

    logForDebugging(
      `handleOrphanedPermissionResponse: received orphaned control_response for toolUseID=${toolUseID} request_id=${message.response.request_id}`,
    )

    // Dedup guard: a control_response can be delivered twice (transport
    // reconnects replay). Re-processing would execute the tool again, mint
    // a duplicate tool_use id in the message array, and 400 the API — and
    // once the array is corrupted, every retry compounds it.
    if (handledToolUseIds.has(toolUseID)) {
      logForDebugging(
        `handleOrphanedPermissionResponse: skipping duplicate orphaned permission for toolUseID=${toolUseID} (already handled)`,
      )
      return false
    }

    const assistantMessage = await findUnresolvedToolUse(toolUseID)
    if (!assistantMessage) {
      logForDebugging(
        `handleOrphanedPermissionResponse: no unresolved tool_use found for toolUseID=${toolUseID} (already resolved in transcript)`,
      )
      return false
    }

    handledToolUseIds.add(toolUseID)
    logForDebugging(
      `handleOrphanedPermissionResponse: enqueuing orphaned permission for toolUseID=${toolUseID} messageID=${assistantMessage.message.id}`,
    )
    enqueue({
      mode: 'orphaned-permission' as const,
      value: [],
      orphanedPermission: {
        permissionResult,
        assistantMessage,
      },
    })

    onEnqueued?.()
    return true
  }
  return false
}

export type DynamicMcpState = {
  clients: MCPServerConnection[]
  tools: Tools
  configs: Record<string, ScopedMcpServerConfig>
}

/**
 * Stamp scope:'dynamic' onto a process-transport config. The transport shape
 * is a structural subset of McpServerConfig (it has no IDE-only transports),
 * so the scope stamp is the only difference the cast bridges.
 */
function toScopedConfig(
  config: McpServerConfigForProcessTransport,
): ScopedMcpServerConfig {
  return { ...config, scope: 'dynamic' } as ScopedMcpServerConfig
}

/** The SDK-hosted server slice: servers whose process is the SDK's, not ours. */
export type SdkMcpState = {
  configs: Record<string, McpSdkServerConfig>
  clients: MCPServerConnection[]
  tools: Tools
}

/** handleMcpSetServers' verdict: the response plus both replacement states. */
export type McpSetServersResult = {
  response: SDKControlMcpSetServersResponse
  newSdkState: SdkMcpState
  newDynamicState: DynamicMcpState
  sdkServersChanged: boolean
}

/**
 * mcp_set_servers: reconcile BOTH server planes to the requested desired
 * state — SDK-hosted servers (their process is the SDK's) and process-based
 * servers (spawned/connected by this CLI).
 *
 * Enterprise allowedMcpServers/deniedMcpServers policy applies here with the
 * same filter --mcp-config gets in main.tsx — without it, SDK V2
 * Query.setMcpServers() was a second policy bypass vector. Blocked servers
 * are reported in response.errors so the SDK consumer knows why they weren't
 * added.
 */
export async function handleMcpSetServers(
  servers: Record<string, McpServerConfigForProcessTransport>,
  sdkState: SdkMcpState,
  dynamicState: DynamicMcpState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<McpSetServersResult> {
  // Enterprise MCP policy on the process-based kinds (stdio/http/sse) —
  // the SAME filter main.tsx applies to --mcp-config, because both are
  // user-controlled injection paths and a gate on one alone is a bypass on
  // the other. type:'sdk' entries are exempt: the SDK hosts them and this
  // CLI never spawns or connects for them (filterMcpServersByPolicy's
  // jsdoc). Every blocked server lands in response.errors with its reason.
  const { allowed: allowedServers, blocked } = filterMcpServersByPolicy(servers)
  // Null-prototype maps: keyed by SDK-supplied server names ('__proto__'-safe).
  const policyErrors: Record<string, string> = Object.create(null) as Record<string, string>
  for (const name of blocked) {
    policyErrors[name] =
      'Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)'
  }

  // Split the desired set by plane.
  const sdkServers: Record<string, McpSdkServerConfig> = Object.create(null) as Record<string, McpSdkServerConfig>
  const processServers: Record<string, McpServerConfigForProcessTransport> = Object.create(null) as Record<string, McpServerConfigForProcessTransport>

  for (const [name, config] of Object.entries(allowedServers)) {
    if (config.type === 'sdk') {
      sdkServers[name] = config
    } else {
      processServers[name] = config
    }
  }

  // SDK plane: diff current vs desired by name.
  const currentSdkNames = new Set(Object.keys(sdkState.configs))
  const newSdkNames = new Set(Object.keys(sdkServers))
  const sdkAdded: string[] = []
  const sdkRemoved: string[] = []

  const newSdkConfigs = { ...sdkState.configs }
  let newSdkClients = [...sdkState.clients]
  let newSdkTools = [...sdkState.tools]

  // Departures: clean up connected clients, drop their tools by prefix.
  for (const name of currentSdkNames) {
    if (!newSdkNames.has(name)) {
      const client = newSdkClients.find(c => c.name === name)
      if (client && client.type === 'connected') {
        await client.cleanup()
      }
      newSdkClients = newSdkClients.filter(c => c.name !== name)
      const prefix = `mcp__${name}__`
      newSdkTools = newSdkTools.filter(t => !t.name.startsWith(prefix))
      delete newSdkConfigs[name]
      sdkRemoved.push(name)
    }
  }

  // Arrivals join as 'pending' — updateSdkMcp() upgrades them to connected
  // on the next query.
  for (const [name, config] of Object.entries(sdkServers)) {
    if (!currentSdkNames.has(name)) {
      newSdkConfigs[name] = config
      const pendingClient: MCPServerConnection = {
        type: 'pending',
        name,
        config: { ...config, scope: 'dynamic' as const },
      }
      newSdkClients = [...newSdkClients, pendingClient]
      sdkAdded.push(name)
    }
  }

  // Process plane: the full reconcile below.
  const processResult = await reconcileMcpServers(
    processServers,
    dynamicState,
    setAppState,
  )

  return {
    response: {
      added: [...sdkAdded, ...processResult.response.added],
      removed: [...sdkRemoved, ...processResult.response.removed],
      errors: { ...policyErrors, ...processResult.response.errors },
    },
    newSdkState: {
      configs: newSdkConfigs,
      clients: newSdkClients,
      tools: newSdkTools,
    },
    newDynamicState: processResult.newState,
    sdkServersChanged: sdkAdded.length > 0 || sdkRemoved.length > 0,
  }
}

/**
 * Reconcile the process-based dynamic MCP plane to a desired state: connect
 * arrivals, tear down departures, and treat a same-name config change as
 * remove+re-add (a live client can't be re-configured in place).
 */
export async function reconcileMcpServers(
  desiredConfigs: Record<string, McpServerConfigForProcessTransport>,
  currentState: DynamicMcpState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<{
  response: SDKControlMcpSetServersResponse
  newState: DynamicMcpState
}> {
  const currentNames = new Set(Object.keys(currentState.configs))
  const desiredNames = new Set(Object.keys(desiredConfigs))

  const toRemove = [...currentNames].filter(n => !desiredNames.has(n))
  const toAdd = [...desiredNames].filter(n => !currentNames.has(n))

  // Same-name entries replace when their configs no longer compare equal.
  const toCheck = [...currentNames].filter(n => desiredNames.has(n))
  const toReplace = toCheck.filter(name => {
    const currentConfig = currentState.configs[name]
    const desiredConfigRaw = desiredConfigs[name]
    if (!currentConfig || !desiredConfigRaw) return true
    const desiredConfig = toScopedConfig(desiredConfigRaw)
    return !areMcpConfigsEqual(currentConfig, desiredConfig)
  })

  const removed: string[] = []
  const added: string[] = []
  const errors: Record<string, string> = {}

  let newClients = [...currentState.clients]
  let newTools = [...currentState.tools]

  // Tear-down half: departures plus the old side of every replacement.
  for (const name of [...toRemove, ...toReplace]) {
    const client = newClients.find(c => c.name === name)
    const config = currentState.configs[name]
    if (client && config) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (e) {
          logError(e)
        }
      }
      // Drop the connection memo so a re-add really reconnects.
      await clearServerCache(name, config)
    }

    // The server's tools all carry its mcp__<name>__ prefix.
    const prefix = `mcp__${name}__`
    newTools = newTools.filter(t => !t.name.startsWith(prefix))

    newClients = newClients.filter(c => c.name !== name)

    // The response reports only true departures; a replacement is not a removal.
    if (toRemove.includes(name)) {
      removed.push(name)
    }
  }

  // Bring-up half: arrivals plus the new side of every replacement.
  for (const name of [...toAdd, ...toReplace]) {
    const config = desiredConfigs[name]
    if (!config) continue
    const scopedConfig = toScopedConfig(config)

    // An SDK-typed entry has no process to spawn here — record it and move on.
    if (config.type === 'sdk') {
      added.push(name)
      continue
    }

    try {
      const client = await connectToServer(name, scopedConfig)
      newClients.push(client)

      if (client.type === 'connected') {
        const serverTools = await fetchToolsForClient(client)
        newTools.push(...serverTools)
      } else if (client.type === 'failed') {
        errors[name] = client.error || 'Connection failed'
      }

      added.push(name)
    } catch (e) {
      const err = toError(e)
      errors[name] = err.message
      logError(err)
    }
  }

  // The replacement config map is exactly the desired set, scoped.
  const newConfigs: Record<string, ScopedMcpServerConfig> = {}
  for (const name of desiredNames) {
    const config = desiredConfigs[name]
    if (config) {
      newConfigs[name] = toScopedConfig(config)
    }
  }

  const newState: DynamicMcpState = {
    clients: newClients,
    tools: newTools,
    configs: newConfigs,
  }

  // Project the reconciled plane into AppState: strip every tool/client
  // belonging to ANY dynamic server (old or new name set), then append the
  // reconciled ones — static (non-dynamic) servers pass through untouched.
  setAppState(prev => {
    const allDynamicServerNames = new Set([
      ...Object.keys(currentState.configs),
      ...Object.keys(newConfigs),
    ])

    const nonDynamicTools = prev.mcp.tools.filter(t => {
      for (const serverName of allDynamicServerNames) {
        if (t.name.startsWith(`mcp__${serverName}__`)) {
          return false
        }
      }
      return true
    })

    const nonDynamicClients = prev.mcp.clients.filter(c => {
      return !allDynamicServerNames.has(c.name)
    })

    return {
      ...prev,
      mcp: {
        ...prev.mcp,
        tools: [...nonDynamicTools, ...newTools],
        clients: [...nonDynamicClients, ...newClients],
      },
    }
  })

  return {
    response: { added, removed, errors },
    newState,
  }
}
