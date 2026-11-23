import { getSessionId, setHeadlessOneShot, setSessionPersistenceDisabled } from '../bootstrap/state.js'
import { sessionSeatCommandTable } from '../commands.js'
import { initializeLspServerManager, waitForInitialization } from '../services/lsp/manager.js'
import { mercuryLspEnabled } from '../services/lsp/mercuryLsp.js'
import { fetchAnthropicConnectorsIfEligible } from '../services/mcp/anthropicConnectors.js'
import {
  clearServerCache,
  connectToServer,
  fenceMcpPrefixCollisions,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  mcpLaunchBudgetMs,
  pruneStaleMcpResourceTools,
  supplementaryToolsForMcpClient,
  withMcpLaunchBudget,
} from '../services/mcp/client.js'
import { getMcpPrefix } from '../utils/mcp/mcpStringUtils.js'
import { partitionMcpConfigsByMembership } from '../services/mcp/membership.js'
import { completeProcessSessionKit, consumeSessionKitPin, noteRefusedKitOnSessionReceipt, sessionKitOf } from '../services/mcp/sessionKitPin.js'
import { doesEnterpriseMcpConfigExist, getMcpServerSignature, getMercuryMcpConfigs } from '../services/mcp/config.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getTools } from '../tools.js'
import type { AgentDefinition } from '../types/agent.js'
import { validateForceLoginOrg } from '../services/auth/oauthLifecycle.js'
import { startBackgroundHousekeeping } from '../services/backgroundHousekeeping.js'
import { getGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { describeEffortEnvOverride, type EffortLevel } from '../utils/effort.js'
import { isBareMode } from '../utils/envUtils.js'
import { runSessionStartHooks } from '../services/sessionStart.js'
import type { HookResultMessage } from '../types/message.js'
import { modeBypassesPermissions, type PermissionMode } from '../utils/permissions/PermissionMode.js'
import { profileCheckpoint } from '../utils/startupProfiler.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { getSessionProjectDir } from '../bootstrap/state.js'
import { gracefulShutdown, isShuttingDown } from '../utils/gracefulShutdown.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { createStore } from '../state/store.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { ScopedMcpServerConfig } from '../utils/mcp/types.js'
import type { Store } from '../state/store.js'
import { applyMergedConfigEnv, typedString, writeErr, type RootOptions } from './cli.js'
import { startDeferredPrefetches } from './deferredPrefetches.js'
import { passedOver } from '../utils/passedOver.js'
import { withDeadline } from '../utils/deadline.js'

async function connectMcpBatch(
  configs: Record<string, ScopedMcpServerConfig>,
  setAppState: (updater: (previous: AppState) => AppState) => void,
): Promise<void> {
  const { survivors, collided } = fenceMcpPrefixCollisions(configs)
  const { members, excluded } = partitionMcpConfigsByMembership(survivors)
  if (members.length === 0 && excluded.length === 0 && collided.length === 0) return
  setAppState(previous => ({
    ...previous,
    mcp: {
      ...previous.mcp,
      clients: [
        ...previous.mcp.clients,
        ...members.map(([name, config]) => ({ name, type: 'pending' as const, config })),
        ...excluded.map(([name, config]) => ({ name, type: 'disabled' as const, config })),
        ...collided.map(({ name, config, error }) => ({ name, type: 'failed' as const, config, error })),
      ],
    },
  }))
  await Promise.all(
    members.map(async ([name, config]) => {
      try {
        const client = await connectToServer(name, config)
        const [tools, commands, resources] = await Promise.all([
          fetchToolsForClient(client),
          fetchCommandsForClient(client),
          fetchResourcesForClient(client),
        ])
        const supplementary = supplementaryToolsForMcpClient(client)
        setAppState(previous => ({
          ...previous,
          mcp: {
            ...previous.mcp,
            clients: previous.mcp.clients.map(entry => (entry.name === name ? client : entry)),
            tools: dedupeByName([...previous.mcp.tools, ...tools, ...supplementary]),
            commands: dedupeByName([...previous.mcp.commands, ...commands]),
            resources:
              resources.length > 0
                ? { ...previous.mcp.resources, [name]: resources }
                : previous.mcp.resources,
          },
        }))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        logForDebugging(`MCP connect failed for ${name}: ${reason}`)
        setAppState(previous => ({
          ...previous,
          mcp: {
            ...previous.mcp,
            clients: previous.mcp.clients.map(entry =>
              entry.name === name ? { name, type: 'failed' as const, config, error: reason } : entry,
            ),
          },
        }))
      }
    }),
  )
}

function dedupeByName<T extends { name?: string }>(entries: T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const entry of entries) {
    const name = entry.name
    if (name !== undefined && seen.has(name)) continue
    if (name !== undefined) seen.add(name)
    result.push(entry)
  }
  return result
}

type RunLaunchArgs = {
  opts: RootOptions
  commands: import('../commands.js').Command[]
  prompt: string | AsyncIterable<string> | undefined
  syntaxInput?: string
  permissionMode: PermissionMode
  toolPermissionContext: AppState['toolPermissionContext']
  allowDangerousSkip: boolean
  mcpConfigPromise: Promise<Record<string, ScopedMcpServerConfig>>
  thinkingConfig: import('../utils/thinking.js').ThinkingConfig
  userSpecifiedModel: string | undefined
  fallbackModel: string | undefined
  mainThreadAgentDefinition: AgentDefinition | undefined
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  customSystemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  inputFormat: string
  outputFormat: string
  includePartialMessages: boolean
  door: 'rows' | 'wire'
}

export async function runLaunch(args: RunLaunchArgs): Promise<void> {
  const { opts } = args

  setHeadlessOneShot(args.inputFormat !== 'rows')

  if (mercuryLspEnabled()) {
    initializeLspServerManager()
    await waitForInitialization()
  }

  let tools = [...getTools(args.toolPermissionContext)]
  const jsonSchemaOpt = typedString(opts.schema)
  let parsedJsonSchema: Record<string, unknown> | undefined
  if (jsonSchemaOpt) {
    const { isSyntheticOutputToolEnabled, createSyntheticOutputTool } = await import(
      '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
    )
    if (isSyntheticOutputToolEnabled({ isNonInteractiveSession: true })) {
      parsedJsonSchema = JSON.parse(jsonSchemaOpt) as Record<string, unknown>
      const synthetic = createSyntheticOutputTool(parsedJsonSchema)
      if ('tool' in synthetic) tools = [...tools, synthetic.tool]
    }
  }
  profileCheckpoint('action_tools_loaded')

  const formatted = args.outputFormat === 'rows' || args.outputFormat === 'json'
  void formatted

  applyMergedConfigEnv()

  const sessionStartHooksPromise: Promise<HookResultMessage[]> =
    !opts.continue && !opts.resume
      ? runSessionStartHooks('new')
      : Promise.resolve<HookResultMessage[]>([])
  sessionStartHooksPromise.catch(passedOver)

  profileCheckpoint('before_validateForceLoginOrg')
  const orgValidation = await validateForceLoginOrg()
  if (!orgValidation.valid) {
    writeErr(orgValidation.message)
    process.exit(1)
  }

  const sessionRunner = flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  const headlessCommands = opts.commands === false
    ? []
    : sessionRunner
      ? sessionSeatCommandTable(args.commands)
      : args.commands.filter(command => {
          if (command.type === 'prompt') {
            return command.disableNonInteractive !== true
          }
          if (command.type === 'local') {
            return command.supportsNonInteractive === true
          }
          if (command.type === 'local-jsx') {
            return (command.headlessVerbs ?? []).length > 0
          }
          return false
        })

  const config = getGlobalConfig()
  const effortEnv = describeEffortEnvOverride()
  if (effortEnv.state === 'ignored') process.stderr.write(`${effortEnv.sentence}\n`)
  const effortLevel =
    (opts.effort as EffortLevel | undefined) ??
    (effortEnv.state === 'level' ? effortEnv.override : undefined) ??
    getInitialSettings().engine?.effort
  const initialState: AppState = {
    ...getDefaultAppState(),
    toolPermissionContext: args.toolPermissionContext,
    verbose: config.toolOutput === 'full',
    ...(effortLevel !== undefined ? { effortValue: effortLevel } : {}),
  }
  const store = createStore<AppState>(initialState, ({ newState, oldState }) =>
    onChangeAppState({ newState, oldState }),
  )

  if (modeBypassesPermissions(args.permissionMode) || args.allowDangerousSkip || store.getState().toolPermissionContext.isBypassPermissionsModeAvailable === true) {
    void import('../utils/permissions/bypassPermissionsKillswitch.js')
      .then(m =>
        m.checkAndDisableSovereignIfNeeded(
          store.getState().toolPermissionContext,
          updater => store.setState(updater),
        ),
      )
      .catch(error => {
        logError(error)
        writeErr(`bypass permissions stays on: your organization's security policy could not be checked (${error instanceof Error ? error.message : String(error)})`)
      })
  }

  if (opts.ephemeral === true) {
    setSessionPersistenceDisabled(true)
  }

  if (Array.isArray(opts.providerPreview) && opts.providerPreview.length > 0) {
    const { filterAllowedSdkBetas } = await import('../utils/model/capabilities.js')
    const { setSdkBetas } = await import('../bootstrap/state.js')
    setSdkBetas(filterAllowedSdkBetas(opts.providerPreview.filter((beta): beta is string => typeof beta === 'string')))
  }

  const initializeMcp = await armRunMcp(args, opts, sessionRunner, store)

  const { runHeadless } = await import('../cli/run.js')
  const { seedDynamicMcpConfig } = await import('../services/mcp/dynamicMcpSeed.js')

  if (!isBareMode()) {
    startDeferredPrefetches()
    startBackgroundHousekeeping()
  }
  seedDynamicMcpConfig(Object.fromEntries(Object.entries(await args.mcpConfigPromise).filter(([, config]) => config.scope === 'dynamic' && config.extensionSource === undefined)), Boolean(opts.onlyMcp) || isBareMode())
  try {
    await runHeadless(
      args.prompt ?? '',
      store.getState,
      store.setState,
      headlessCommands,
      tools,
      args.activeAgents,
      {
        continue: Boolean(opts.continue),
        resume: opts.resume as string | boolean | undefined,
        outputFormat: args.outputFormat,
        syntaxInput: args.syntaxInput,
        jsonSchema: parsedJsonSchema,
        allowedTools: (opts.allowedTools as string[] | undefined) ?? [],
        thinkingConfig: args.thinkingConfig,
        maxTurns: opts.maxTurns as number | undefined,
        maxBudgetUsd: opts.budget as number | undefined,
        maxTimeMs: opts.maxTime as number | undefined,
        systemPrompt: args.customSystemPrompt,
        ...(opts.defaultBrief === true ? { defaultBrief: true } : {}),
        appendSystemPrompt: args.appendSystemPrompt,
        ...(typeof opts.hostBriefAdd === 'string' ? { hostAppendSystemPrompt: opts.hostBriefAdd } : {}),
        userSpecifiedModel: args.userSpecifiedModel ?? args.mainThreadAgentDefinition?.model ?? undefined,
        fallbackModel: args.fallbackModel,
        includePartialMessages: args.includePartialMessages,
        forkSession: Boolean(opts.fork),
        resumeSessionAt: typedString(opts.replayTo),
        rewindFiles: typedString(opts.restoreFiles),
        agent: typedString(opts.agent),
        workload: typedString(opts.meterTag),
        advise: opts.advise === true,
        bootSessionIdPinned: Boolean(typedString(opts.sessionId)),
        title: typedString(opts.title)?.trim() || undefined,
        initializeMcp,
        door: args.door,
        subscribeAppState: store.subscribe,
        sessionStartHooksPromise,
      },
    )
  } catch (error) {
    writeErr(`Error: ${error instanceof Error ? error.message : String(error)}`)
    if (!isShuttingDown()) {
      await gracefulShutdown(1)
    }
  }
}

async function armRunMcp(args: Pick<RunLaunchArgs, 'commands' | 'mcpConfigPromise'>, opts: RootOptions, sessionRunner: boolean, store: Store<AppState>): Promise<() => Promise<void>> {
  profileCheckpoint('action_before_mcp_configs_await')
  const regularMcpConfigs = await args.mcpConfigPromise
  profileCheckpoint('action_mcp_configs_loaded')
  {
    if (consumeSessionKitPin().outcome === 'refused') {
      const receiptHome = getSessionProjectDir()
      if (receiptHome !== null) noteRefusedKitOnSessionReceipt(receiptHome, getSessionId())
    }
    const unresolved = sessionKitOf()
    if (unresolved !== undefined && unresolved.resolved === false) {
      const { completeSessionKitFromRoster } = await import('../services/mcp/kitCompletion.js')
      const { getActiveSet } = await import('../extensions/active.js')
      completeProcessSessionKit(
        completeSessionKitFromRoster(unresolved, {
          mcpNames: Object.keys(regularMcpConfigs),
          commands: args.commands,
          extensions: getActiveSet().active.map(ext => ext.manifest.name),
        }),
      )
    }
  }
  const awaitingMcpClaim = sessionRunner && !opts.continue && !opts.resume && !typedString(opts.sessionId)
  let mcpFlight: Promise<void> | undefined
  const initializeMcp = (): Promise<void> => mcpFlight ??= (async () => {
    const dynamic = Object.fromEntries(Object.entries(regularMcpConfigs).filter(([, config]) => config.scope === 'dynamic' && config.extensionSource === undefined))
    const configs = awaitingMcpClaim && !opts.onlyMcp && !isBareMode()
      ? { ...(await getMercuryMcpConfigs(dynamic)).servers, ...dynamic }
      : regularMcpConfigs
    profileCheckpoint('before_connectMcp')
    if ((await withMcpLaunchBudget(connectMcpBatch(configs, store.setState), mcpLaunchBudgetMs())) === 'timeout') {
      logForDebugging(`MCP servers were not all ready within ${mcpLaunchBudgetMs()}ms; continuing — late servers serve later calls`)
    }
    profileCheckpoint('after_connectMcp')
    await connectAnthropicConnectors(store)
    profileCheckpoint('after_connectMcp_claudeai')
  })()
  if (!awaitingMcpClaim) await initializeMcp()
  return initializeMcp
}

async function connectAnthropicConnectors(store: {
  getState: () => AppState
  setState: (updater: (previous: AppState) => AppState) => void
}): Promise<void> {
  const strictOrBare = isBareMode()
  if (strictOrBare || doesEnterpriseMcpConfigExist()) return
  const work = (async () => {
    const connectors = await fetchAnthropicConnectorsIfEligible()
    if (!connectors || Object.keys(connectors).length === 0) return
    const connectorEntries = connectors
    const state = store.getState()
    const connectorSignatures = new Set(
      Object.values(connectorEntries).map(config => getMcpServerSignature(config)),
    )
    const suppressed: string[] = []
    for (const client of state.mcp.clients) {
      if (!client.name.startsWith('ext:')) continue
      const signature = getMcpServerSignature(client.config)
      if (!connectorSignatures.has(signature)) continue
      suppressed.push(client.name)
      if (client.type === 'connected') {
        try {
          const cleared = await clearServerCache(client.name, client.config)
          if (cleared.cleanupError !== undefined) {
            writeErr(`the duplicate MCP server ${client.name} could not be closed (${cleared.cleanupError}) and may still be running`)
          }
        } catch (error) {
          passedOver(error)
          writeErr(`the duplicate MCP server ${client.name} could not be closed (${error instanceof Error ? error.message : String(error)}) and may still be running`)
        }
      }
    }
    const manualSignatures = new Set(
      store
        .getState()
        .mcp.clients.filter(
          client => !client.name.startsWith('ext:') && !suppressed.includes(client.name),
        )
        .map(client => getMcpServerSignature(client.config)),
    )
    const surviving: Record<string, ScopedMcpServerConfig> = Object.create(null) as Record<string, ScopedMcpServerConfig>
    for (const [name, connectorConfig] of Object.entries(connectorEntries)) {
      if (manualSignatures.has(getMcpServerSignature(connectorConfig))) continue
      surviving[name] = connectorConfig
    }
    if (suppressed.length > 0) {
      const suppressedPrefixes = suppressed.map(name => getMcpPrefix(name))
      store.setState(previous => {
        const nextClients = previous.mcp.clients.filter(client => !suppressed.includes(client.name))
        return {
          ...previous,
          mcp: {
            ...previous.mcp,
            clients: nextClients,
            tools: pruneStaleMcpResourceTools(
              nextClients,
              previous.mcp.tools.filter(
                tool => !suppressed.includes(tool.mcpInfo?.serverName ?? ''),
              ),
            ),
            commands: previous.mcp.commands.filter(
              command => !suppressedPrefixes.some(prefix => command.name.startsWith(prefix)),
            ),
            resources: Object.fromEntries(
              Object.entries(previous.mcp.resources ?? {}).filter(([serverName]) => !suppressed.includes(serverName)),
            ),
          },
        }
      })
    }
    await connectMcpBatch(surviving, store.setState)
  })()
  const raced = await withDeadline(work, 5000, () => 'timeout' as const)
  if (raced === 'timeout') {
    logForDebugging('claude.ai connectors were not ready within 5s; continuing')
  }
}
