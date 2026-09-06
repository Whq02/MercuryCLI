
import { errorMessage, toError } from '../../utils/errors.js'
import { type UUID } from 'crypto'
import { ask } from 'src/QueryEngine.js'
import { type ToolPermissionContext, type Tools } from 'src/Tool.js'
import { getMainThreadAgentType, registerHookCallbacks, setInitJsonSchema, setMainLoopModelOverride, setMainThreadAgentType } from 'src/bootstrap/state.js'
import { StructuredIO } from 'src/cli/structuredIO.js'
import { type Command, formatDescriptionWithSource, getCommandName } from 'src/commands.js'
import { type HookEvent, type McpServerConfigForProcessTransport, type ModelInfo, type PermissionResult, type RewindFilesResult } from 'src/entrypoints/agentSdkTypes.js'
import { type SDKControlInitializeRequest, type SDKControlInitializeResponse, type SDKControlMcpSetServersResponse, type SDKControlResponse, type SDKControlRewindSessionRequest, type StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { type RewindRefusalKind, type SessionRewindOutcomeV1 } from 'src/daemon/protocol.js'
import { createOperatorRewindRecordMessage } from 'src/services/compact/checkpointRewind.js'
import { type Message } from 'src/types/message.js'
import { findLastCompactBoundaryIndex } from 'src/utils/messages/systemMessages.js'
import { flushSessionStorage, recordTranscript } from 'src/utils/sessionStorage.js'
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
import { holdModeTransition, type ModeTransitionRoad, recordModeTransition } from 'src/utils/permissions/modeTransitions.js'
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

  if (options.agent) {
    const alreadyResolved = getMainThreadAgentType() === options.agent
    const mainThreadAgent = agents.find(a => a.agentType === options.agent)
    if (mainThreadAgent && !alreadyResolved) {
      setMainThreadAgentType(mainThreadAgent.agentType)

      if (!options.systemPrompt && !isBuiltInAgent(mainThreadAgent)) {
        const agentSystemPrompt = mainThreadAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }

      if (
        !options.userSpecifiedModel &&
        mainThreadAgent.model &&
        mainThreadAgent.model !== 'inherit'
      ) {
        const agentModel = parseUserSpecifiedModel(mainThreadAgent.model)
        setMainLoopModelOverride(agentModel)
      }

      if (mainThreadAgent.initialPrompt) {
        structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
      }
    } else if (mainThreadAgent?.initialPrompt) {
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
      model: agent.model === 'inherit' ? undefined : agent.model,
    })),
    models: modelInfos,
    account: {
      email: accountInfo?.email,
      organization: accountInfo?.organization,
      subscriptionType: accountInfo?.subscription,
      tokenSource: accountInfo?.tokenSource,
      apiKeySource: accountInfo?.apiKeySource,
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

}

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


export interface RewindSessionContext {
  messages: Message[]
  getAppState: () => AppState
  drift: RestoreDriftOracle
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
      const landed = receipt.code !== undefined ? `the files were restored (${receipt.code.filesChanged.length}); ` : ''
      return { ...receipt, outcome: 'refused', refusal: 'restore-failed', detail: `${landed}the conversation boundary could not be written to the transcript: ${errorMessage(error)}` }
    }
    receipt.conversation = { turnUuid: uuid, removed }
  }
  return receipt
}

export function resolvePermissionModeTransition(
  mode: InternalPermissionMode,
  toolPermissionContext: ToolPermissionContext,
  road: ModeTransitionRoad = 'control-door',
): { ok: true; context: ToolPermissionContext } | { ok: false; error: string } {
  const verdict = decidePermissionModeTransition(mode, toolPermissionContext)
  if (toolPermissionContext.mode !== mode) {
    if (verdict.ok) recordModeTransition({ from: toolPermissionContext.mode, to: mode, road })
    else holdModeTransition({ from: toolPermissionContext.mode, to: mode, road, detail: verdict.error })
  }
  return verdict
}

function decidePermissionModeTransition(
  mode: InternalPermissionMode,
  toolPermissionContext: ToolPermissionContext,
): { ok: true; context: ToolPermissionContext } | { ok: false; error: string } {
  if (mode === 'apollo' && flagEnv('MERCURY_CONCOURSE_WORKER') !== '1') {
    return {
      ok: false,
      error:
        'Cannot set permission mode to apollo in SDK/print mode — the Apollo pre-flight interview is interactive-only; run it in the terminal UI',
    }
  }
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

function toScopedConfig(
  config: McpServerConfigForProcessTransport,
): ScopedMcpServerConfig {
  return { ...config, scope: 'dynamic' } as ScopedMcpServerConfig
}

export type SdkMcpState = {
  configs: Record<string, McpSdkServerConfig>
  clients: MCPServerConnection[]
  tools: Tools
}

export type McpSetServersResult = {
  response: SDKControlMcpSetServersResponse
  newSdkState: SdkMcpState
  newDynamicState: DynamicMcpState
  sdkServersChanged: boolean
}

export async function handleMcpSetServers(
  servers: Record<string, McpServerConfigForProcessTransport>,
  sdkState: SdkMcpState,
  dynamicState: DynamicMcpState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<McpSetServersResult> {
  const { allowed: allowedServers, blocked } = filterMcpServersByPolicy(servers)
  const policyErrors: Record<string, string> = Object.create(null) as Record<string, string>
  for (const name of blocked) {
    policyErrors[name] =
      'Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)'
  }

  const sdkServers: Record<string, McpSdkServerConfig> = Object.create(null) as Record<string, McpSdkServerConfig>
  const processServers: Record<string, McpServerConfigForProcessTransport> = Object.create(null) as Record<string, McpServerConfigForProcessTransport>

  for (const [name, config] of Object.entries(allowedServers)) {
    if (config.type === 'sdk') {
      sdkServers[name] = config
    } else {
      processServers[name] = config
    }
  }

  const currentSdkNames = new Set(Object.keys(sdkState.configs))
  const newSdkNames = new Set(Object.keys(sdkServers))
  const sdkAdded: string[] = []
  const sdkRemoved: string[] = []

  const newSdkConfigs = { ...sdkState.configs }
  let newSdkClients = [...sdkState.clients]
  let newSdkTools = [...sdkState.tools]

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
      await clearServerCache(name, config)
    }

    const prefix = `mcp__${name}__`
    newTools = newTools.filter(t => !t.name.startsWith(prefix))

    newClients = newClients.filter(c => c.name !== name)

    if (toRemove.includes(name)) {
      removed.push(name)
    }
  }

  for (const name of [...toAdd, ...toReplace]) {
    const config = desiredConfigs[name]
    if (!config) continue
    const scopedConfig = toScopedConfig(config)

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
