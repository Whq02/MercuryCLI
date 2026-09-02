
import React from 'react'
import { appendFileSync } from 'fs'
import { Box, Text } from './ink.js'
import type { Root } from './ink.js'
import type { FrameEvent } from './ink/frame.js'
import { launcherAltHoldPending, releaseLauncherAltHoldNow } from './ink/launcherAltHold.js'
import { AlternateScreen } from './ink/components/AlternateScreen.js'
import { TerminalSizeContext } from './ink/components/TerminalSizeContext.js'
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from './utils/fullscreen.js'
import { estateGroundBg } from './utils/mercuryTokens.js'
import { useMercuryTokens } from './components/mercury-ui/useMercuryTokens.js'
import { syncOutputSupportedNow } from './ink/session/capabilities.js'
import {
  TerminalProfileCard,
} from './components/TerminalProfileCard.js'
import { resolveTerminalProfile } from './ink/session/terminalProfile.js'
import { Onboarding } from './components/Onboarding.js'
import { TrustDialog } from './components/TrustDialog/TrustDialog.js'
import { MercurySetupFrame, type SetupRailStep } from './components/MercurySetupFrame.js'
import { ApproveApiKey } from './components/ApproveApiKey.js'
import { BypassPermissionsModeDialog } from './components/BypassPermissionsModeDialog.js'
import { ExternalInstructionIncludesDialog } from './components/ExternalInstructionIncludesDialog.js'
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from './state/AppState.js'
import type { Command } from './commands.js'
import { getGlobalConfig, saveGlobalConfig } from './utils/config.js'
import {
  getCustomApiKeyStatus,
} from './utils/config/derived.js'
import {
  isPathTrusted,
  recordPermissionPosture,
  setPathTrusted,
} from './utils/config/trust.js'
import { setSessionTrustAccepted } from './bootstrap/state.js'
import { setStatsStore } from './bootstrap/state.js'
import { resetFeatureGates, initializeFeatureGates } from './services/analytics/featureGates.js'
import { handleMcpjsonServerApprovals } from './services/mcpServerApproval.js'
import { getExternalInstructionIncludes, getInstructionFiles, shouldShowExternalInstructionIncludesWarning } from './services/instructions/engine.js'
import { getSettingsWithAllErrors } from './utils/settings/allErrors.js'
import { nonAnthropicBootNotice } from './services/providers/providerUsability.js'
import { addBootNote } from './substrate/bootNotes.js'
import { applySafeConfigEnvironmentVariables } from './utils/managedEnv.js'
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js'
import { updateGithubRepoPathMapping } from './utils/githubRepoPathMapping.js'
import { getCwd } from './utils/cwd.js'
import {
  hasSkipDangerousModePermissionPrompt,
} from './utils/settings/settings.js'
import { flagEnv } from './substrate/flagRegistry.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { gracefulShutdown, gracefulShutdownSync } from './utils/gracefulShutdown.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import { registerBackgroundNode } from './boot/launchGraph.js'
import { logError } from './utils/log.js'
import { logForDebugging } from './utils/debug.js'
import { createStatsStore, type StatsStore } from './context/stats.js'
import { FpsTracker, type FpsMetrics } from './utils/fpsTracker.js'
import { recordFrameTrace } from './ink/root/frame-trace.js'
import { isWarmBackgroundEnabled } from './utils/cockpit/warmBackground.js'
import type { InternalPermissionMode } from './types/permissions.js'
import { modeBypassesPermissions } from './utils/permissions/PermissionMode.js'
import { onChangeAppState as defaultOnChangeAppState } from './state/onChangeAppState.js'
import type { AppState } from './state/AppStateStore.js'


export function completeOnboarding(): void {
  const version =
    typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown'
  saveGlobalConfig(current => ({
    ...current,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: version,
  }))
}


function SetupGroundFill({ children }: { children: React.ReactNode }): React.ReactNode {
  const tokens = useMercuryTokens()
  const size = React.useContext(TerminalSizeContext)
  return (
    <Box
      flexDirection="column"
      height={size?.rows ?? 24}
      width="100%"
      backgroundColor={estateGroundBg(tokens)}
    >
      {children}
    </Box>
  )
}

export function SetupScreenHost({ children }: { children: React.ReactNode }): React.ReactNode {
  const [useAltScreenHost] = React.useState(
    () => launcherAltHoldPending() || isFullscreenEnvEnabled(),
  )
  if (!useAltScreenHost) return children
  return (
    <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
      <SetupGroundFill>{children}</SetupGroundFill>
    </AlternateScreen>
  )
}

export function showDialog<T>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode,
): Promise<T> {
  return new Promise<T>(resolve => {
    root.render(<SetupScreenHost>{renderer(result => resolve(result))}</SetupScreenHost>)
  })
}

export function showSetupDialog<T>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode,
  options?: {
    onChangeAppState?: (change: { newState: AppState; oldState: AppState }) => void
  },
): Promise<T> {
  return new Promise<T>(resolve => {
    root.render(
      <AppStateProvider
        onChangeAppState={options?.onChangeAppState ?? defaultOnChangeAppState}
      >
        <KeybindingSetup>
          <SetupScreenHost>{renderer(result => resolve(result))}</SetupScreenHost>
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
}

export async function exitWithMessage(
  root: Root,
  message: string,
  options?: {
    color?: string
    exitCode?: number
    beforeExit?: () => void | Promise<void>
  },
): Promise<never> {
  releaseLauncherAltHoldNow()
  root.render(
    <Box>
      <Text color={options?.color}>{message}</Text>
    </Box>,
  )
  root.unmount()
  await options?.beforeExit?.()
  gracefulShutdownSync(options?.exitCode ?? 1)
  return new Promise<never>(() => {})
}

export function exitWithError(
  root: Root,
  message: string,
  beforeExit?: () => void | Promise<void>,
): Promise<never> {
  return exitWithMessage(root, message, {
    color: 'red',
    exitCode: 1,
    beforeExit,
  })
}

export async function renderAndRun(
  root: Root,
  element: React.ReactNode,
): Promise<void> {
  profileCheckpoint('render_and_run_start')
  void isWarmBackgroundEnabled
  root.render(element)
  profileCheckpoint('render_and_run_after_render')
  await root.waitUntilExit()
  await gracefulShutdown(0)
}


export async function showSetupScreens(
  root: Root,
  permissionMode: InternalPermissionMode,
  allowDangerouslySkipPermissions: boolean,
  commands?: Command[],
  devChannels?: unknown,
): Promise<boolean> {
  void devChannels
  if (process.env.NODE_ENV === 'test') return false
  if (process.env.IS_DEMO) return false

  let onboardingShown = false

  const resolution = resolveTerminalProfile()
  if (resolution.verdict === 'unsupported') {
    const choice = await showSetupDialog<'exit' | 'continue'>(root, done => (
      <TerminalProfileCard resolution={resolution} onDone={done} />
    ))
    if (choice === 'exit') {
      const missing = resolution.checks
        .filter(row => row.requirement === 'required' && !row.ok)
        .map(row => row.label)
        .join(', ')
      await exitWithMessage(
        root,
        `This terminal is missing required capabilities: ${missing || 'see the card above'}.\n` +
          `Use a supported terminal${process.platform === 'win32' ? ' (the stable Windows Terminal or your editor’s integrated terminal; PowerShell 7 preferred)' : ''}.\n` +
          'Non-interactive use works anywhere via --print.',
        { exitCode: 1 },
      )
    }
  }

  try {
    const notice = nonAnthropicBootNotice()
    if (notice !== null) addBootNote('info', notice)
  } catch (error) {
    logError(error)
  }

  let onboardingRail: SetupRailStep[] | null = null
  const config = getGlobalConfig()
  if (!config.theme || !config.hasCompletedOnboarding) {
    onboardingShown = true
    onboardingRail = await showSetupDialog<SetupRailStep[]>(root, done => (
      <Onboarding onDone={done} />
    ))
    completeOnboarding()
  }

  {
    const cwd = getCwd()
    if (!isPathTrusted(cwd)) {
      const steps: SetupRailStep[] =
        onboardingShown && onboardingRail !== null
          ? [...onboardingRail, { key: 'trust', label: 'trust', state: 'current' }]
          : [{ key: 'trust', label: 'Workspace trust', state: 'current' }]
      await showSetupDialog<void>(root, done => (
        <MercurySetupFrame
          title={onboardingShown ? 'first run' : 'Workspace trust'}
          tone="trust"
          steps={steps}
          stepTag={`trust · ${steps.length}/${steps.length}`}
          footer="↑↓ move · ↵ select · esc exit"
        >
          <TrustDialog
            commands={commands}
            onDone={() => {
              setPathTrusted(getCwd())
              done()
            }}
          />
        </MercurySetupFrame>
      ))
    }
    setSessionTrustAccepted(true)
    try {
      resetFeatureGates()
      void initializeFeatureGates()
    } catch (error) {
      logError(error)
    }
    registerBackgroundNode('setup:prefetch-system-context', async () => {
      await import('./utils/queryContext.js')
    })
    const { errors } = getSettingsWithAllErrors()
    if (errors.length === 0) {
      await handleMcpjsonServerApprovals(root)
    }
    try {
      if (await shouldShowExternalInstructionIncludesWarning()) {
        const includes = getExternalInstructionIncludes(await getInstructionFiles(true))
        await showSetupDialog<void>(root, done => (
          <ExternalInstructionIncludesDialog onDone={done} externalIncludes={includes} />
        ))
      }
    } catch (error) {
      logError(error)
    }
  }

  registerBackgroundNode('setup:repo-path-mapping', async () => {
    try {
      await updateGithubRepoPathMapping()
    } catch (error) {
      logError(error)
    }
  })

  try {
    applyConfigEnvironmentVariables()
  } catch (error) {
    logError(error)
  }
  void applySafeConfigEnvironmentVariables

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey && apiKey.length > 0) {
    const truncated = apiKey.slice(-20)
    if (getCustomApiKeyStatus(truncated) === 'new') {
      await showSetupDialog<boolean>(root, done => (
        <ApproveApiKey customApiKeyTruncated={truncated} onDone={done} />
      ))
    }
  }

  const bypassArmed =
    modeBypassesPermissions(permissionMode) || allowDangerouslySkipPermissions
  const dialogSuppressed = hasSkipDangerousModePermissionPrompt()
  if (bypassArmed && !dialogSuppressed) {
    await showSetupDialog<void>(root, done => (
      <BypassPermissionsModeDialog onAccept={done} />
    ))
  }

  try {
    recordPermissionPosture({
      bypassArmed,
      envArmed: isEnvTruthy(flagEnv('MERCURY_SKIP_PERMISSIONS')),
      flagArmed: allowDangerouslySkipPermissions,
      dialogSuppressed,
    })
  } catch (error) {
    logError(error)
  }

  return onboardingShown
}


const FLICKER_GATE_MS = 1000

export function getRenderContext(exitOnCtrlC: boolean): {
  renderOptions: { exitOnCtrlC: boolean; onFrame: (event: FrameEvent) => void }
  getFpsMetrics: () => FpsMetrics | undefined
  stats: StatsStore
} {
  const tracker = new FpsTracker()
  const stats = createStatsStore()
  setStatsStore(stats)
  const frameLogPath = flagEnv('MERCURY_FRAME_TIMING_LOG')
  let lastFlickerSeenAt = 0

  const onFrame = (event: FrameEvent): void => {
    tracker.record(event.durationMs)
    stats.observe('frame_ms', event.durationMs)
    recordFrameTrace({
      durationMs: event.durationMs,
      phases: event.phases,
      flickers: event.flickers,
    })
    if (frameLogPath) {
      try {
        appendFileSync(
          frameLogPath,
          `${JSON.stringify({
            durationMs: event.durationMs,
            phases: event.phases,
            rss: process.memoryUsage().rss,
            cpu: process.cpuUsage(),
          })}\n`,
        )
      } catch {
      }
    }
    if (!syncOutputSupportedNow()) {
      const real = event.flickers.filter(record => record.reason !== 'resize')
      if (real.length > 0) {
        const now = Date.now()
        if (now - lastFlickerSeenAt >= FLICKER_GATE_MS) {
          lastFlickerSeenAt = now
        }
      }
    }
  }

  logForDebugging('render context created')
  return {
    renderOptions: { exitOnCtrlC, onFrame },
    getFpsMetrics: () => tracker.getMetrics(),
    stats,
  }
}
