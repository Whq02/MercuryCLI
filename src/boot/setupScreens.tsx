import React from 'react'
import { appendFileSync } from 'fs'
import { Box, Text } from '../screen/themedRenderer.js'
import type { Root } from '../screen/themedRenderer.js'
import type { FrameEvent } from '../screen/renderer/frame.js'
import { launcherAltHoldPending, releaseLauncherAltHoldNow } from '../screen/renderer/launcherAltHold.js'
import { AlternateScreen } from '../screen/renderer/elements/AlternateScreen.js'
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from '../screen/fullscreen-layout/fullscreen.js'
import { GroundFill } from '../screen/widgets/GroundFill.js'
import { syncOutputSupportedNow } from '../screen/renderer/terminal-session/capabilities.js'
import {
  TerminalProfileCard,
} from './first-run/TerminalProfileCard.js'
import { resolveTerminalProfile } from '../screen/renderer/terminal-session/terminalProfile.js'
import { Onboarding } from './first-run/Onboarding.js'
import { TrustDialog } from '../screen/trust-dialog/TrustDialog.js'
import { MercurySetupFrame, type SetupRailStep } from './first-run/MercurySetupFrame.js'
import { ApproveApiKey } from '../models/sign-in/flow-cards/ApproveApiKey.js'
import { SovereignModeDialog } from './first-run/SovereignModeDialog.js'
import { ExternalInstructionIncludesDialog } from '../screen/settings/config/ExternalInstructionIncludesDialog.js'
import { KeybindingSetup } from '../screen/keys/KeybindingProviderSetup.js'
import { AppStateProvider } from '../screen/app-state/AppState.js'
import { clearCommandMemoizationCaches, getCommands, type Command } from '../commands/catalogue/commands.js'
import { getGlobalConfig, saveGlobalConfig } from '../platform/settings/config.js'
import {
  getCustomApiKeyStatus,
} from '../platform/config/derived.js'
import {
  checkHasTrustDialogAccepted,
  isPathTrusted,
  recordPermissionPosture,
  setPathTrusted,
} from '../platform/config/trust.js'
import { setSessionTrustAccepted } from './process-state/processState.js'
import { setStatsStore } from './process-state/processState.js'
import { handleProjectMcpServerApprovals } from '../screen/mcp/mcpServerApproval.js'
import { getExternalInstructionIncludes, getInstructionFiles, shouldShowExternalInstructionIncludesWarning } from '../sessions/instructions/instructionFiles.js'
import { getSettingsWithAllErrors } from '../platform/settings-faults/allErrors.js'
import { nonAnthropicBootNotice } from '../models/roads/providerUsability.js'
import { addBootNote } from '../platform/substrate/bootNotes.js'
import { applySafeConfigEnvironmentVariables } from '../platform/environment/settingsEnv.js'
import { applyConfigEnvironmentVariables } from '../platform/environment/settingsEnv.js'
import { supportedTerminalHintSuffix } from '../platform/host-os/words.js'
import { updateGithubRepoPathMapping } from './githubRepoPathMapping.js'
import { getCwd } from '../platform/files/cwd.js'
import {
  hasSkipSovereignConsentPrompt,
} from '../platform/settings/settings.js'
import { flagEnv } from '../platform/substrate/flagRegistry.js'
import { isEnvTruthy } from '../platform/environment/envUtils.js'
import { gracefulShutdown, gracefulShutdownSync } from '../platform/processes/gracefulShutdown.js'
import { profileCheckpoint } from './startupProfiler.js'
import { registerBackgroundNode } from './launchGraph.js'
import { logError } from '../platform/logs/errorLog.js'
import { logForDebugging } from '../platform/logs/debugLog.js'
import { createStatsStore, type StatsStore } from '../platform/observability/stats.js'
import { FpsTracker, type FpsMetrics } from '../screen/frame-rate/fpsTracker.js'
import { recordFrameTrace } from '../screen/renderer/root/frame-trace.js'
import type { InternalPermissionMode } from '../permissions/rules/permissions.js'
import { modeBypassesPermissions } from '../permissions/rules/permissionMode.js'
import { passedOver } from '../platform/errors/passedOver.js'
import { hostEnv } from '../platform/environment/hostEnv.js'


function completeOnboarding(): void {
  saveGlobalConfig(current => ({
    ...current,
    hasCompletedOnboarding: true,
    lastOnboardingVersion:
      typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown',
  }))
}
function keepTerminalCheckContinued(kind: string): void {
  saveGlobalConfig(current =>
    current.terminalChecksContinued?.[kind]
      ? current
      : { ...current, terminalChecksContinued: { ...current.terminalChecksContinued, [kind]: true } },
  )
}


export function SetupScreenHost({ children }: { children: React.ReactNode }): React.ReactNode {
  const [useAltScreenHost] = React.useState(
    () => launcherAltHoldPending() || isFullscreenEnvEnabled(),
  )
  if (!useAltScreenHost) return children
  return (
    <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
      <GroundFill>{children}</GroundFill>
    </AlternateScreen>
  )
}

function showSetupDialog<T>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode,
): Promise<T> {
  return new Promise<T>(resolve => {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <SetupScreenHost>{renderer(resolve)}</SetupScreenHost>
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
    plainLines?: boolean
  },
): Promise<never> {
  releaseLauncherAltHoldNow()
  const { color, exitCode = 1, beforeExit, plainLines } = options ?? {}
  if (plainLines) {
    root.unmount()
    process.stdout.write(`\n${message}\n`)
  } else {
    root.render(
      <Box>
        <Text color={color}>{message}</Text>
      </Box>,
    )
    root.unmount()
  }
  if (beforeExit) {
    await beforeExit()
  }
  gracefulShutdownSync(exitCode)
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
): Promise<boolean> {
  if (process.env.NODE_ENV === 'test') return false
  if (flagEnv('MERCURY_DEMO')) return false

  let onboardingShown = false

  const resolution = resolveTerminalProfile()
  if (resolution.verdict === 'unsupported' && !getGlobalConfig().terminalChecksContinued?.[resolution.kind]) {
    const choice = await showSetupDialog<'exit' | 'continue'>(root, done => (
      <TerminalProfileCard resolution={resolution} onDone={done} />
    ))
    if (choice === 'exit') {
      const found = resolution.checks
        .filter(row => row.requirement === 'required' && !row.ok)
        .map(row => row.evidence)
        .join('; ')
      await exitWithMessage(
        root,
        `This window cannot show Mercury the way it is designed: ${found}.\n` +
          `Use a supported terminal${supportedTerminalHintSuffix()}.\n` +
          'Non-interactive use works anywhere via mercury run.',
        { exitCode: 1, plainLines: true },
      )
    }
    if (resolveTerminalProfile().verdict === 'unsupported') keepTerminalCheckContinued(resolution.kind)
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
    const trustedBefore = checkHasTrustDialogAccepted()
    const trustedThroughTheProject = !isPathTrusted(cwd) && trustedBefore
    if (trustedThroughTheProject) setPathTrusted(cwd)
    if (!trustedThroughTheProject && !isPathTrusted(cwd)) {
      const steps: SetupRailStep[] =
        onboardingShown && onboardingRail !== null
          ? [...onboardingRail, { key: 'trust', label: 'trust', state: 'current' }]
          : [{ key: 'trust', label: 'Workspace trust', state: 'current' }]
      await showSetupDialog<void>(root, done => (
        <MercurySetupFrame
          title={onboardingShown ? 'first run' : 'Workspace trust'}
          tone="trust"
          firstRunCard
          steps={steps}
          stepTag={`trust · ${steps.length}/${steps.length}`}
          footer="↑↓ move · ↵ select · esc exit"
        >
          <TrustDialog
            onDone={() => {
              setPathTrusted(getCwd())
              done()
            }}
          />
        </MercurySetupFrame>
      ))
    }
    setSessionTrustAccepted(true)
    if (!trustedBefore) {
      clearCommandMemoizationCaches()
      if (commands !== undefined) commands.splice(0, commands.length, ...await getCommands(cwd))
    }
    registerBackgroundNode('setup:prefetch-system-context', async () => {
      await import('../engine/system-prompt/systemPromptParts.js')
    })
    const { errors } = getSettingsWithAllErrors()
    if (errors.length === 0) {
      await handleProjectMcpServerApprovals(root)
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

  const apiKey = hostEnv().ANTHROPIC_API_KEY
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
  const dialogSuppressed = hasSkipSovereignConsentPrompt()
  if (bypassArmed && !dialogSuppressed) {
    await showSetupDialog<void>(root, done => (
      <SovereignModeDialog onAccept={done} />
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
  const fpsTracker = new FpsTracker()
  const stats = createStatsStore()
  setStatsStore(stats)
  const frameTimingLogPath = flagEnv('MERCURY_FRAME_TIMING_LOG')
  let lastFlickerAt = 0
  logForDebugging('render context created')

  const onFrame = (event: FrameEvent): void => {
    fpsTracker.record(event.durationMs)
    stats.observe('frame_ms', event.durationMs)
    recordFrameTrace({
      durationMs: event.durationMs,
      phases: event.phases,
      flickers: event.flickers,
    })
    if (frameTimingLogPath) {
      try {
        const line = JSON.stringify({
          durationMs: event.durationMs,
          phases: event.phases,
          rss: process.memoryUsage().rss,
          cpu: process.cpuUsage(),
        })
        appendFileSync(frameTimingLogPath, `${line}\n`)
      } catch (error) {
        passedOver(error)
      }
    }
    if (!syncOutputSupportedNow() && event.flickers.length > 0) {
      const realFlicker = event.flickers.some(f => f.reason !== 'resize')
      if (realFlicker) {
        const now = Date.now()
        if (now - lastFlickerAt >= FLICKER_GATE_MS) {
          lastFlickerAt = now
        }
      }
    }
  }

  return {
    renderOptions: {
      exitOnCtrlC,
      onFrame,
    },
    getFpsMetrics: () => fpsTracker.getMetrics(),
    stats,
  }
}
