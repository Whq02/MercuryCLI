import { getIsInteractive } from '../process-state/processState.js'
import { armBackgroundDiscovery, registerBackgroundNode } from '../launchGraph.js'
import { launchChat } from '../chatLauncher.js'
import { initializeLspServerManager } from '../../integrations/lsp/serverManagerLifecycle.js'
import { clearBootAttempts } from '../../platform/substrate/bootBeacon.js'
import { addBootNote } from '../../platform/substrate/bootNotes.js'
import { recordInvocation } from '../../platform/substrate/invocationRecord.js'
import { markLaunchBegun } from '../../platform/substrate/launchMilestones.js'
import { markExplicitBootJourney, retractExplicitBootJourney } from '../../platform/substrate/splashHandover.js'
import { getCwd } from '../../platform/files/cwd.js'
import { getTools } from '../../tools/kit/toolList.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import {
  exitWithError,
  getRenderContext,
  renderAndRun,
  showSetupScreens,
} from '../setupScreens.js'
import { launchInvalidSettingsDialog, launchResumeChooser } from '../dialogLaunchers.js'
import { validateForceLoginOrg } from '../../models/sign-in/lifecycle/oauthLifecycle.js'
import { startBackgroundHousekeeping } from '../../platform/housekeeping/backgroundHousekeeping.js'
import { getGlobalConfig, saveGlobalConfigDeferred, flushDeferredGlobalConfigSaves, binaryName, getRemoteControlAtStartup } from '../../platform/settings/config.js'
import { registerSession, updateSessionName } from '../../sessions/transcripts/concurrentSessions.js'
import { lastCrashReportPath } from '../../platform/logs/crashReport.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { describeEffortEnvOverride, type EffortLevel } from '../../models/effort/effort.js'
import { refreshExampleCommands } from '../../screen/composer/exampleCommands.js'
import { logError } from '../../platform/logs/errorLog.js'
import { createUserMessage } from '../../engine/message-shapes/factories.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import type { PermissionMode } from '../../permissions/rules/permissionMode.js'
import { profileCheckpoint } from '../startupProfiler.js'
import { resetUserCache } from '../../platform/environment/user.js'
import { getSettingsWithErrors, getInitialSettings } from '../../platform/settings/settings.js'
import { lastSession, sessionAtIndex, searchSessionsByCustomTitle } from '../../sessions/transcripts/sessionStorage.js'
import { sessionIdOfListing } from '../../sessions/transcripts/sessionListings.js'
import { armProvisionalSessionReconcile } from '../../daemon/runner/provisionalSessionReconcile.js'
import { registerCleanup } from '../../platform/processes/cleanupRegistry.js'
import { crashShutdown, gracefulShutdown, isShuttingDown } from '../../platform/processes/gracefulShutdown.js'
import { getDefaultAppState } from '../../screen/app-state/AppStateStore.js'
import type { AppState } from '../../screen/app-state/AppStateStore.js'
import type { Props as ChatProps } from '../../screen/chat/Chat.js'
import type { UUID } from 'node:crypto'
import type { ScopedMcpServerConfig } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import { resolveLayoutRoots } from '../../platform/update-channel/installLayout.js'
import { reconcileManagedCommands } from '../../platform/profiles/profiles.js'
import type { Root } from '../../screen/themedRenderer.js'
import { UUID_REGEX } from '../../platform/primitives/uuid.js'
import { typedString, writeErr, type RootOptions } from './cli.js'
import { startDeferredPrefetches } from './deferredPrefetches.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { startInterval, stopInterval } from '../../platform/async/timers.js'

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
  commands: import('../../commands/catalogue/commands.js').Command[]
  prompt: string | undefined
  permissionMode: PermissionMode
  toolPermissionContext: AppState['toolPermissionContext']
  allowDangerousSkip: boolean
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined
  thinkingConfig: import('../../models/effort/thinking.js').ThinkingConfig
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
  const { createRoot } = await import('../../screen/themedRenderer.js')
  const root = await createRoot(renderOptions)
  profileCheckpoint('action_after_create_root')

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
    remoteControlEnabled: getRemoteControlAtStartup(),
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
    const { addToHistory } = await import('../../sessions/promptHistory.js')
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
    const { armQuitParksAll } = await import('../../daemon/switchboard/quitParksAll.js')
    armQuitParksAll()
  }
  if (opts.continue || opts.resume || opts.pr || inputPrompt) {
    markExplicitBootJourney()
  }
  if (opts.chat === true) {
    const { markChatBoot } = await import('../../screen/routes/surfaceRoute.js')
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
      const { readSessionWorkers } = await import('../../daemon/concourse-workers/concourseWorkers.js')
      const { sweepPrefixRecords } = await import('../../models/roads/anthropic/prefixRecordStore.js')
      const liveSessionIds = Object.values(readSessionWorkers()).filter(record => record.endedAt === undefined).map(record => record.sessionId)
      await sweepPrefixRecords({ liveSessionIds })
    } catch (error) {
      logForDebugging(`preserved thinking: the prefix record sweep did not run (${String(error)})`)
    }
  })
  registerBackgroundNode('model-and-extensions', async () => {
    void getEngineModel()
    const { ensureExtensionsLoaded } = await import('../../integrations/extensions/boot.js')
    await ensureExtensionsLoaded().catch(passedOver)
  })
  registerBackgroundNode('shim-reconcile', async () => {
    reconcileManagedCommands(resolveLayoutRoots())
  })
  registerBackgroundNode('deferred-prefetches', () => {
    startDeferredPrefetches()
    startBackgroundHousekeeping()
  })
  registerBackgroundNode('process-registry', async () => {
    const { beatCockpitRegistration, registerCockpit, recordProcessCensusAtBoot, COCKPIT_HEARTBEAT_MS } = await import('../../daemon/process-sweep/processSweepRun.js')
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
    const { focusResumedSession } = await import('../../daemon/switchboard/hopIntoSession.js')
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
    const facts = await import('../../daemon/switchboard/bootBirthFacts.js')
    const { runnerArgvFromBoot } = await import('../../daemon/switchboard/runnerArgv.js')
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
    if (typeof resumeValue === 'string' && !UUID_REGEX.test(resumeValue)) {
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
        const { resumeMissMessage } = await import('../../sessions/transcripts/resumeMiss.js')
        await exitWithError(root, await resumeMissMessage(resumeValue))
        return false
      }
      resumeLog = log as ResumeLog
      resumeSessionId = resumeValue
    }
    if (resumeLog && resumeSessionId) {
      if (!(await resumeAtBoot(String(resumeSessionId), resumeLog))) return false
    } else {
      const { getWorktreePaths } = await import('../../platform/git/worktree/worktreePaths.js')
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
    const { isFullscreenEnvEnabled } = await import('../../screen/fullscreen-layout/fullscreen.js')
    if (promptIsWords || !isFullscreenEnvEnabled()) {
      const { bornSession } = await import('../../daemon/switchboard/bornSession.js')
      const birth = bornSession({ workspaceDir: getCwd(), model: null })
      void birth.then(async born => {
        if (born.ok) return
        logForDebugging(`[boot] the chat-forward birth was refused: ${born.reason}`)
        retractExplicitBootJourney()
        const { mintImmediateReceipt } = await import('../../models/facts/seatReceipts.js')
        mintImmediateReceipt(`▲ the chat could not start — ${born.reason}`, 'warning')
      })
    }
  }
  return true
}
