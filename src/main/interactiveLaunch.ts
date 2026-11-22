import { getIsInteractive } from '../bootstrap/state.js'
import { armBackgroundDiscovery, registerBackgroundNode } from '../boot/launchGraph.js'
import { launchChat } from '../chatLauncher.js'
import { initializeLspServerManager } from '../services/lsp/manager.js'
import { clearBootAttempts } from '../substrate/bootBeacon.js'
import { addBootNote } from '../substrate/bootNotes.js'
import { recordInvocation } from '../substrate/invocationRecord.js'
import { markLaunchBegun } from '../substrate/launchMilestones.js'
import { markExplicitBootJourney, retractExplicitBootJourney } from '../substrate/splashHandover.js'
import { getCwd } from '../utils/cwd.js'
import { getTools } from '../tools.js'
import type { AgentDefinition } from '../types/agent.js'
import {
  exitWithError,
  getRenderContext,
  renderAndRun,
  showSetupScreens,
} from '../interactiveHelpers.js'
import { launchInvalidSettingsDialog, launchResumeChooser } from '../dialogLaunchers.js'
import { validateForceLoginOrg } from '../services/auth/oauthLifecycle.js'
import { startBackgroundHousekeeping } from '../services/backgroundHousekeeping.js'
import { getGlobalConfig, saveGlobalConfigDeferred, flushDeferredGlobalConfigSaves, binaryName, getRemoteControlAtStartup } from '../utils/config.js'
import { registerSession, updateSessionName } from '../utils/concurrentSessions.js'
import { lastCrashReportPath } from '../utils/crashReport.js'
import { logForDebugging } from '../utils/debug.js'
import { describeEffortEnvOverride, type EffortLevel } from '../utils/effort.js'
import { refreshExampleCommands } from '../utils/exampleCommands.js'
import { logError } from '../utils/log.js'
import { createUserMessage } from '../utils/messages/factories.js'
import { getEngineModel } from '../services/model/model.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { profileCheckpoint } from '../utils/startupProfiler.js'
import { resetUserCache } from '../utils/user.js'
import { getSettingsWithErrors, getInitialSettings } from '../utils/settings/settings.js'
import { lastSession, sessionAtIndex, searchSessionsByCustomTitle } from '../utils/sessionStorage.js'
import { sessionIdOfListing } from '../utils/sessionStorage/logs.js'
import { armProvisionalSessionReconcile } from '../utils/provisionalSessionReconcile.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { crashShutdown, gracefulShutdown, isShuttingDown } from '../utils/gracefulShutdown.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Props as ChatProps } from '../screens/Chat.js'
import type { UUID } from 'node:crypto'
import type { ScopedMcpServerConfig } from '../utils/mcp/types.js'
import { reconcileManagedShims, resolveLayoutRoots } from '../services/privateChannel/installLayout.js'
import type { Root } from '../ink.js'
import { typedString, writeErr, UUID_SHAPE, type RootOptions } from './cli.js'
import { startDeferredPrefetches } from './deferredPrefetches.js'
import { passedOver } from '../utils/passedOver.js'
import { startInterval, stopInterval } from '../utils/timers.js'

let abandonAnnounced = false
function announceAbandonedLaunch(): void {
  if (abandonAnnounced) return
  abandonAnnounced = true
  process.once('exit', code => {
    if (code === 0) return
    try {
      process.stderr.write(
        `Mercury did not start: a shutdown was initiated during boot (exit ${code}). Boot again with --debug and read the debug log for the initiator.\n`,
      )
    } catch (error) {
      passedOver(error)
    }
  })
}

type InteractiveLaunchArgs = {
  opts: RootOptions
  commands: import('../commands.js').Command[]
  prompt: string | undefined
  permissionMode: PermissionMode
  toolPermissionContext: AppState['toolPermissionContext']
  allowDangerousSkip: boolean
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined
  thinkingConfig: import('../utils/thinking.js').ThinkingConfig
  resolvedInitialModel: string
  userSpecifiedModel: string | undefined
  mainThreadAgentDefinition: AgentDefinition | undefined
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  sessionTitle: string | undefined
}

export async function interactiveLaunch(args: InteractiveLaunchArgs): Promise<void> {
  const { opts, commands } = args
  let inputPrompt = args.prompt

  profileCheckpoint('action_before_create_root')
  const { renderOptions, getFpsMetrics, stats } = getRenderContext(false)
  const { createRoot } = await import('../ink.js')
  const root = await createRoot(renderOptions)
  profileCheckpoint('action_after_create_root')

  const startupMeasuredAt = Date.now()
  const onboardingShown = await showSetupScreens(
    root,
    args.permissionMode,
    args.allowDangerousSkip,
    commands,
  )
  if (onboardingShown && inputPrompt?.trim().toLowerCase() === '/logins') {
    inputPrompt = undefined
  }
  if (onboardingShown) resetUserCache()
  const orgValidation = await validateForceLoginOrg()
  if (!orgValidation.valid) {
    await exitWithError(root, orgValidation.message)
    return
  }
  if (process.exitCode !== undefined && process.exitCode !== 0) {
    announceAbandonedLaunch()
    logForDebugging('graceful shutdown already initiated; abandoning interactive launch')
    return
  }
  if (isShuttingDown()) {
    announceAbandonedLaunch()
    logForDebugging('shutdown in progress; abandoning interactive launch')
    return
  }

  registerBootBackgroundNodes(args)

  const settingsErrors = getSettingsWithErrors().errors.filter(
    error => error.mcpErrorMetadata === undefined,
  )
  if (settingsErrors.length > 0) {
    await launchInvalidSettingsDialog(root, {
      settingsErrors,
      onExit: () => void gracefulShutdown(1),
    })
  }

  const effectiveContext = args.toolPermissionContext

  const config = getGlobalConfig()
  const effortLevel = (opts.effort as EffortLevel | undefined) ?? getInitialSettings().engine?.effort
  const effortEnv = describeEffortEnvOverride()
  if (effortEnv.state === 'ignored') addBootNote('warn', effortEnv.sentence)
  const initialState: AppState = {
    ...getDefaultAppState(),
    toolPermissionContext: effectiveContext,
    verbose: config.toolOutput === 'full',
    expandedView: config.showExpandedTasks ? 'tasks' : 'none',
    ...(effortLevel !== undefined ? { effortValue: effortLevel } : {}),
    agent: args.mainThreadAgentDefinition?.agentType,
    agentDefinitions: { activeAgents: args.activeAgents, allAgents: args.allAgents },
    remoteControlEnabled: getRemoteControlAtStartup() || assistantBridgeSeed(),
    promptSuggestionEnabled: false,
    ...(inputPrompt
      ? {
          initialMessage: {
            message: createUserMessage({ content: inputPrompt }),
          },
        }
      : {}),
  }

  if (inputPrompt) {
    const { addToHistory } = await import('../history.js')
    addToHistory(inputPrompt)
  }

  saveGlobalConfigDeferred(current => ({ ...current, numStartups: (current.numStartups ?? 0) + 1 }))
  clearBootAttempts()
  armProvisionalSessionReconcile()
  registerBackgroundNode('startup-records', async () => {
    await flushDeferredGlobalConfigSaves()
    try {
      recordInvocation()
    } catch (error) {
      passedOver(error)
    }
  })

  {
    const { armQuitParksAll } = await import('../services/switchboard/quitParksAll.js')
    armQuitParksAll()
  }
  if (opts.continue || opts.resume || opts.pr || inputPrompt) {
    markExplicitBootJourney()
  }
  if (opts.chat === true) {
    const { markChatBoot } = await import('../context/surfaceRoute.js')
    markChatBoot()
  }

  const appProps = {
    getFpsMetrics,
    stats,
    initialState,
  }
  const chatProps: ChatProps = {
    commands,
    initialTools: [...getTools(effectiveContext)],
    debug: Boolean(opts.debug || opts.d),
    disableSlashCommands: opts.commands === false,
  }

  if (!getIsInteractive()) return

  armBackgroundDiscovery();
  markLaunchBegun();

  try {
    if (!(await routeBootJourney({ args, opts, root, appProps, chatProps, inputPrompt, effectiveContext }))) return

    await launchChat(root, appProps, chatProps, renderAndRun, {
      dynamicMcpConfig: args.dynamicMcpConfig,
      isStrictMcpConfig: Boolean(args.opts.onlyMcp),
    })
  } catch (error) {
    logError(error)
    const detail = error instanceof Error ? error.message : String(error)
    writeErr(`Mercury exited on an error: ${detail}`)
    const crashPath = lastCrashReportPath()
    if (crashPath) writeErr(`Crash report: ${crashPath}`)
    writeErr(`Run ${binaryName()} health for diagnostics.`)
    await crashShutdown(1)
    process.exit(1)
  }

  void startupMeasuredAt
}

function assistantBridgeSeed(): boolean {
  return false
}

function registerBootBackgroundNodes(args: { sessionTitle: string | undefined }): void {
  registerBackgroundNode('lsp-manager', async () => {
    initializeLspServerManager()
  })
  registerBackgroundNode('example-commands', async () => {
    await refreshExampleCommands()
  })
  registerBackgroundNode('session-registry', async () => {
    await registerSession()
    if (args.sessionTitle) await updateSessionName(args.sessionTitle)
    try {
      const { readSessionWorkers } = await import('../daemon/concourseWorkers.js')
      const { sweepPrefixRecords } = await import('../services/providers/anthropic/prefixRecordStore.js')
      const liveSessionIds = Object.values(readSessionWorkers()).filter(record => record.endedAt === undefined).map(record => record.sessionId)
      await sweepPrefixRecords({ liveSessionIds })
    } catch (error) {
      logForDebugging(`preserved thinking: the prefix record sweep did not run (${String(error)})`)
    }
  })
  registerBackgroundNode('session-telemetry', async () => {
    void getEngineModel()
    const { ensureExtensionsLoaded } = await import('../extensions/boot.js')
    await ensureExtensionsLoaded().catch(passedOver)
  })
  registerBackgroundNode('shim-reconcile', async () => {
    reconcileManagedShims(resolveLayoutRoots())
  })
  registerBackgroundNode('deferred-prefetches', () => {
    startDeferredPrefetches()
    startBackgroundHousekeeping()
  })
  registerBackgroundNode('process-registry', async () => {
    const { beatCockpitRegistration, registerCockpit, recordProcessCensusAtBoot, COCKPIT_HEARTBEAT_MS } = await import('../daemon/processSweepRun.js')
    if (process.stdin.isTTY) {
      const register = () => registerCockpit({ terminal: null })
      let registration = await register()
      let beating = false
      let stopped = false
      const beat = startInterval(() => {
        if (beating || stopped) return
        beating = true
        void beatCockpitRegistration(registration, register)
          .then(next => {
            if (stopped) {
              void next?.clear()
              return
            }
            registration = next
          })
          .catch(passedOver)
          .finally(() => {
            beating = false
          })
      }, COCKPIT_HEARTBEAT_MS)
      beat.unref()
      registerCleanup(async () => {
        stopped = true
        stopInterval(beat)
        await registration?.clear()
      })
    }
    const census = await recordProcessCensusAtBoot()
    logForDebugging(`process census at boot: ${census.entries.length} Mercury process(es) read, ${census.entries.filter(entry => entry.classification === 'stale').length} stale — nothing ended at boot`)
  })
}

async function routeBootJourney({ args, opts, root, appProps, chatProps, inputPrompt, effectiveContext }: {
  args: InteractiveLaunchArgs
  opts: RootOptions
  root: Root
  appProps: Parameters<typeof launchResumeChooser>[1]
  chatProps: ChatProps
  inputPrompt: string | undefined
  effectiveContext: AppState['toolPermissionContext']
}): Promise<boolean> {
  type ResumeLog = { fullPath?: string; customTitle?: string; agentName?: string }
  const resumeAtBoot = async (sessionId: string, log: ResumeLog): Promise<boolean> => {
    const { focusResumedSession } = await import('../services/switchboard/hopIntoSession.js')
    const outcome = await focusResumedSession(sessionId, log.fullPath, {
      ...(log.customTitle ?? log.agentName ? { title: (log.customTitle ?? log.agentName) as string } : {}),
      permissionMode: args.permissionMode,
      ...(typedString(opts.model) !== undefined ? { model: args.resolvedInitialModel } : {}),
      ...(typeof opts.effort === 'string' ? { effort: opts.effort } : {}),
    })
    if (outcome.ok) return true
    await exitWithError(root, `Failed to resume session ${sessionId}: ${outcome.reason}`)
    return false
  }
  {
    const facts = await import('../services/switchboard/bootBirthFacts.js')
    const { runnerArgvFromBoot } = await import('../services/switchboard/runnerArgv.js')
    facts.setBootBirthFacts({
      title: args.sessionTitle ?? null,
      model: typedString(opts.model) !== undefined && args.userSpecifiedModel !== undefined ? args.resolvedInitialModel : null,
      effort: typeof opts.effort === 'string' ? opts.effort : null,
      permissionMode: args.permissionMode,
      permissionModeTyped: typedString(opts.mode) === args.permissionMode,
      bypassConsent: effectiveContext.isBypassPermissionsModeAvailable === true,
      runnerArgv: runnerArgvFromBoot(process.argv.slice(2)),
    })
  }
  if (opts.continue) {
    const lastLog = await sessionAtIndex(0)
    const sessionId = lastLog ? sessionIdOfListing(lastLog as Parameters<typeof sessionIdOfListing>[0]) : undefined
    if (!lastLog || !sessionId) {
      await exitWithError(root, 'No conversation found to continue')
      return false
    }
    if (!(await resumeAtBoot(String(sessionId), lastLog as ResumeLog))) return false
  } else if (opts.resume || opts.pr) {
    const resumeValue = opts.resume
    const fromPr = opts.pr
    let searchTerm: string | undefined
    let resumeLog: ResumeLog | null = null
    let resumeSessionId: string | undefined
    if (typeof resumeValue === 'string' && !UUID_SHAPE.test(resumeValue)) {
      const matches = await searchSessionsByCustomTitle(resumeValue)
      if (Array.isArray(matches) && matches.length === 1) {
        resumeLog = matches[0] as ResumeLog
        resumeSessionId = sessionIdOfListing(matches[0] as Parameters<typeof sessionIdOfListing>[0])
      } else {
        searchTerm = resumeValue
      }
    } else if (typeof resumeValue === 'string') {
      let log: Awaited<ReturnType<typeof lastSession>>
      try {
        log = await lastSession(resumeValue as UUID)
      } catch (error) {
        await exitWithError(root, `Failed to resume session ${resumeValue}: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
      if (!log) {
        const { resumeMissMessage } = await import('../utils/sessionStorage/resumeMiss.js')
        await exitWithError(root, await resumeMissMessage(resumeValue))
        return false
      }
      resumeLog = log as ResumeLog
      resumeSessionId = resumeValue
    }
    if (resumeLog && resumeSessionId) {
      if (!(await resumeAtBoot(String(resumeSessionId), resumeLog))) return false
    } else {
      const { getWorktreePaths } = await import('../utils/getWorktreePaths.js')
      const worktreePathsPromise = getWorktreePaths(process.cwd()).catch((error) => { passedOver(error); return [] as string[] })
      await launchResumeChooser(root, appProps, worktreePathsPromise, {
        ...chatProps,
        initialSearchQuery: searchTerm,
        forkSession: Boolean(opts.fork),
        filterByPr: fromPr === true ? true : typeof fromPr === 'string' ? fromPr : undefined,
      })
      return false
    }
  } else {
    const promptIsWords = typeof inputPrompt === 'string' && inputPrompt.trim() !== '' && !inputPrompt.trimStart().startsWith('/')
    const { isFullscreenEnvEnabled } = await import('../utils/fullscreen.js')
    if (promptIsWords || !isFullscreenEnvEnabled()) {
      const { bornSession } = await import('../services/switchboard/bornSession.js')
      const birth = bornSession({ workspaceDir: getCwd(), model: null })
      void birth.then(async born => {
        if (born.ok) return
        logForDebugging(`[boot] the chat-forward birth was refused: ${born.reason}`)
        retractExplicitBootJourney()
        const { mintImmediateReceipt } = await import('../utils/model/seatReceipts.js')
        mintImmediateReceipt(`▲ the chat could not start — ${born.reason}`, 'warning')
      })
    }
  }
  return true
}
