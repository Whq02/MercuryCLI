// Interactive boot helpers: the dialog primitives, the ordered
// setup-screen sequence, and the render context. Under the fullscreen
// surface policy (a pending launcher hold, or the fullscreen env on) the
// dialogs are STATIONS of the one alternate-screen session — the first
// mount consumes the launcher hold, and a geometry change repaints through
// the alt clear/damage law instead of stacking frames into scrollback.
// Only when the operator chose inline (fullscreen env explicitly off, no
// hold) do dialogs render on the primary screen; exit paths that must
// leave text behind (exitWithMessage) still release any pending hold so
// the message lands on the main screen.

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

// ── onboarding completion ──────────────────────────────────────────────────

export function completeOnboarding(): void {
  const version =
    typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown'
  saveGlobalConfig(current => ({
    ...current,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: version,
  }))
}

// ── dialog primitives ──────────────────────────────────────────────────────

/** The full-viewport estate ground behind an alt-hosted station (the same
 *  law as the resume picker's fill: a grow-based wrapper leaves a
 *  default-background stripe on the last row). */
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

/** The ONE boot-station host. Fullscreen surface policy (pending launcher
 *  hold, or the fullscreen env on): the station mounts inside the alternate
 *  screen — the outermost mount consumes the hold (the atomic takeover
 *  erase), a resize repaints through the alt clear/damage law, and nothing
 *  is ever stacked into terminal scrollback. The latch is read per mount,
 *  but the host keeps ONE component identity across consecutive setup
 *  renders (same position in every dialog tree), so a multi-station walk
 *  lives inside ONE alt-screen session. Inline policy renders bare. */
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
  // Console output is swallowed by the renderer — the message goes through
  // it, on the primary screen.
  releaseLauncherAltHoldNow()
  root.render(
    <Box>
      <Text color={options?.color}>{message}</Text>
    </Box>,
  )
  root.unmount()
  await options?.beforeExit?.()
  gracefulShutdownSync(options?.exitCode ?? 1)
  // gracefulShutdownSync never returns control to this caller in practice;
  // the hang keeps the Promise<never> contract honest.
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
  // The themed terminal background is applied by the ink layer on mount
  // (interactive-only by construction — print/SDK paths never create a root).
  void isWarmBackgroundEnabled
  root.render(element)
  profileCheckpoint('render_and_run_after_render')
  await root.waitUntilExit()
  await gracefulShutdown(0)
}

// ── the setup-screen sequence ──────────────────────────────────────────────

export async function showSetupScreens(
  root: Root,
  permissionMode: InternalPermissionMode,
  allowDangerouslySkipPermissions: boolean,
  commands?: Command[],
  devChannels?: unknown,
): Promise<boolean> {
  void devChannels
  // 1 · skip conditions: test builds, and demo mode — a bare PRESENCE test
  // (any non-empty value, including '0', skips).
  if (process.env.NODE_ENV === 'test') return false
  if (process.env.IS_DEMO) return false

  let onboardingShown = false

  // 2 · terminal capability gate.
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

  // 3 · provider honesty note — failures never block entry.
  try {
    const notice = nonAnthropicBootNotice()
    if (notice !== null) addBootNote('info', notice)
  } catch (error) {
    logError(error)
  }

  // 4 · onboarding. The dialog resolves with the rail the journey actually
  // walked so the trust gate below continues it.
  let onboardingRail: SetupRailStep[] | null = null
  const config = getGlobalConfig()
  if (!config.theme || !config.hasCompletedOnboarding) {
    onboardingShown = true
    onboardingRail = await showSetupDialog<SetupRailStep[]>(root, done => (
      <Onboarding onDone={done} />
    ))
    completeOnboarding()
  }

  // 5 · workspace trust — always evaluated interactively (bypass affects
  // tool execution, not workspace trust).
  {
    const cwd = getCwd()
    if (!isPathTrusted(cwd)) {
      // Arriving from onboarding, trust CONTINUES the rail the journey
      // actually walked — same title, same labels, trust flipping to
      // current. A hard-coded rail here rewrote the whole progress chrome
      // on one keypress and asserted a 'Sign in · done' step even for
      // journeys that never had one (the rail-rewritten-at-
      // trust-handoff / signin-marked-done-without-credential classes).
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
    // Post-trust: the feature-gate client re-reads auth headers.
    setSessionTrustAccepted(true)
    try {
      resetFeatureGates()
      void initializeFeatureGates()
    } catch (error) {
      logError(error)
    }
    // System-context prefetch starts in the background.
    registerBackgroundNode('setup:prefetch-system-context', async () => {
      // Module warm — a dedicated prefetch owner was not found by search
      // (receipt-noted); importing the context modules front-loads their cost.
      await import('./utils/queryContext.js')
    })
    // Project MCP-server approvals — only with a clean settings surface.
    const { errors } = getSettingsWithAllErrors()
    if (errors.length === 0) {
      await handleMcpjsonServerApprovals(root)
    }
    // One-time approval for external instruction includes. The card NAMES
    // the includes it is asking about — the boot mount used to pass none,
    // so the operator answered a permanent per-project question over an
    // empty list (TASK-017 S2, external-includes-esc-persists-no); the
    // walk is already memoized warm by the helper, so the census is free.
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

  // 6 · repo/path mapping — AFTER trust, fire-and-forget.
  registerBackgroundNode('setup:repo-path-mapping', async () => {
    try {
      await updateGithubRepoPathMapping()
    } catch (error) {
      logError(error)
    }
  })

  // 7 · environment application (may include dangerous project values —
  // only after trust).
  try {
    applyConfigEnvironmentVariables()
  } catch (error) {
    logError(error)
  }
  void applySafeConfigEnvironmentVariables

  // 8 · API-key consent.
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey && apiKey.length > 0) {
    const truncated = apiKey.slice(-20)
    if (getCustomApiKeyStatus(truncated) === 'new') {
      await showSetupDialog<boolean>(root, done => (
        <ApproveApiKey customApiKeyTruncated={truncated} onDone={done} />
      ))
    }
  }

  // 9 · bypass consent.
  const bypassArmed =
    modeBypassesPermissions(permissionMode) || allowDangerouslySkipPermissions
  const dialogSuppressed = hasSkipDangerousModePermissionPrompt()
  if (bypassArmed && !dialogSuppressed) {
    await showSetupDialog<void>(root, done => (
      <BypassPermissionsModeDialog onAccept={done} />
    ))
  }

  // 10 · posture record — failures never block boot.
  try {
    recordPermissionPosture({
      bypassArmed,
      // The registered canonical spelling (an unregistered name throws in
      // flagEnv and this record would silently vanish into the catch).
      envArmed: isEnvTruthy(flagEnv('MERCURY_SKIP_PERMISSIONS')),
      flagArmed: allowDangerouslySkipPermissions,
      dialogSuppressed,
    })
  } catch (error) {
    logError(error)
  }

  return onboardingShown
}

// ── render context ─────────────────────────────────────────────────────────

const FLICKER_GATE_MS = 1000

export function getRenderContext(exitOnCtrlC: boolean): {
  renderOptions: { exitOnCtrlC: boolean; onFrame: (event: FrameEvent) => void }
  getFpsMetrics: () => FpsMetrics | undefined
  stats: StatsStore
} {
  const tracker = new FpsTracker()
  const stats = createStatsStore()
  // Published globally too (status surfaces read it outside the tree).
  setStatsStore(stats)
  const frameLogPath = flagEnv('MERCURY_FRAME_TIMING_LOG')
  let lastFlickerSeenAt = 0

  const onFrame = (event: FrameEvent): void => {
    tracker.record(event.durationMs)
    stats.observe('frame_ms', event.durationMs)
    // Observation only — a slow paint gets attributed, never guessed at.
    recordFrameTrace({
      durationMs: event.durationMs,
      phases: event.phases,
      flickers: event.flickers,
    })
    if (frameLogPath) {
      // Bench only, synchronous SPECIFICALLY so an abrupt exit drops no
      // frames.
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
        // The bench log must never break rendering.
      }
    }
    // Flicker OBSERVATION: skipped entirely when the terminal supports
    // synchronised output — read LIVE, a boot-time probe can upgrade a
    // terminal static sniffing missed. Resize flickers are always ignored.
    // There is no reporting sink at this snapshot; the gate is bookkeeping.
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
