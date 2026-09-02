import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from './ink.js';
import type { Props as REPLProps } from './screens/REPL.js';
import type { ScopedMcpServerConfig } from './services/mcp/types.js';
import type { AppState } from './state/AppStateStore.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};
/** The interactive MCP owner's seed: the --mcp-config servers and the
 *  strict flag, handed once at launch — the face keeps its own four props. */
type McpSeed = {
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined;
  isStrictMcpConfig: boolean;
  ideAutoConnect?: boolean;
};

/** Boot recovery must finish before the projection renders, but a wedged
 *  disk must never brick the REPL — past this budget we render anyway and
 *  the pass finishes in the background (the /run · /team status line and
 *  the doctor stay honest about it). */
const BOOT_RECOVERY_BUDGET_MS = 3_000;

export async function launchRepl(root: Root, appProps: AppWrapperProps, replProps: REPLProps, renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>, mcpSeed?: McpSeed): Promise<void> {
  // checkpoint the previously-uninstrumented launch→paint region.
  // Dynamic import keeps replLauncher's static surface react-only (the
  // boot-contract PAINT-SURFACE law); the profiler module is long since
  // evaluated by this point so the await is free.
  const { profileCheckpoint } = await import('./utils/startupProfiler.js');
  profileCheckpoint('launch_repl_start');
  // Reconcile durable state BEFORE the projection mounts (crash-consistency
  // orphan temps, the teams operation journal, dead-epoch task
  // bodies, and — on resume — the leader-team projection this session lost
  // when the previous process died. All three interactive launch paths
  // (fresh, --continue, --resume) pass through here, and by now the session
  // id is final (switchSession ran inside resume processing).
  try {
    const { getProjectRoot, getSessionId } = await import('./bootstrap/state.js');
    const { runBootRecovery } = await import('./substrate/recoveryOrchestrator.js');
    // projectDir arms the daemon-records step's scheduler-lock leg:
    // the project is DECLARED here, never guessed inside the substrate.
    const recovery = runBootRecovery({
      scope: 'session',
      sessionId: getSessionId(),
      projectDir: getProjectRoot(),
    });
    // The budget timer is CLEARED once the race settles: when recovery wins,
    // the loser would otherwise sit live for the rest of the 3s (a stray ref'd
    // timer holding the event loop on every boot). Deliberately not
    // unref'd — recovery's own pending handles may all be unref'd, and an
    // unref'd budget could let a wedged boot exit instead of rendering.
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const report = await Promise.race([
      recovery,
      new Promise<null>(r => {
        budgetTimer = setTimeout(() => r(null), BOOT_RECOVERY_BUDGET_MS);
      }),
    ]);
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    // The projection seed: a led team found on disk re-enters AppState the
    // same way TeamCreate projected it mid-session. Never overrides a
    // teamContext an earlier path (teammate identity, restored state) set.
    // A recovery that loses the race is NOT dropped: its late-settling
    // leaderProjection reaches the mounted app through the boot-recovery
    // store (recoveryOrchestrator setState → App's LateBootProjectionSeed),
    // under the same never-override guard.
    if (report?.leaderProjection && !appProps.initialState.teamContext) {
      const led = report.leaderProjection;
      appProps = {
        ...appProps,
        initialState: {
          ...appProps.initialState,
          teamContext: {
            teamName: led.teamName,
            teamFilePath: led.teamFilePath,
            leadAgentId: led.leadAgentId,
            teammates: led.teammates,
          },
        },
      };
    }
  } catch {
    // Recovery is best-effort by contract — a failure here must never stop
    // the REPL from launching (the orchestrator records its own errors).
  }
  // The run-level fold on top of the already-reconciled durable state
  // (FN-013 CRASH-02 — the print/SDK and /run roads already ran it; the
  // interactive resume was the one road that did not, so identical sidecar
  // bytes yielded weaker fidelity on the default surface). The owner is
  // keyed by the FINAL session id, so a fresh launch finds no sidecar and
  // folds nothing. Bounded by its own budget: past it the REPL renders and
  // the fold settles in the background (clobber-guarded, its notice latched
  // for the boot effect either way).
  try {
    const { foldResumedRunForBoot } = await import('./services/run/runCoordinator.js');
    const { processMainOwner } = await import('./services/run/resolveOwner.js');
    const { getCwd } = await import('./utils/cwd.js');
    let foldBudgetTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      foldResumedRunForBoot(processMainOwner(), getCwd()),
      new Promise<null>(r => {
        foldBudgetTimer = setTimeout(() => r(null), BOOT_RECOVERY_BUDGET_MS);
      }),
    ]);
    if (foldBudgetTimer !== undefined) clearTimeout(foldBudgetTimer);
  } catch {
    // The fold logs its own typed reason; the boot must never be its hostage.
  }
  profileCheckpoint('launch_repl_after_recovery');
  // resolve the initial surface BEFORE the REPL
  // paint imports — the resolver reads only the registered MERCURY_CONCOURSE
  // flag and (for Auto) the bounded supervisor records summary; with the
  // policy Off it imports nothing Concourse-shaped at all. The effective
  // route seeds the one in-process route owner the SurfaceRouter mounts
  // under (dynamic imports keep this module's static surface react-only —
  // the boot-contract PAINT-SURFACE law).
  const surfaceRoute = await import('./context/surfaceRoute.js');
  const {
    App
  } = await import('./components/App.js');
  // Registration BEFORE resolution: SurfaceRouter's module registers the
  // route surfaces as a module
  // side effect — the resolver's registered-check then answers the
  // EFFECTIVE route truthfully (resolving first downgraded a lawful
  // 'always' to repl because the registry was still empty — caught by the
  // first concourse render).
  const {
    SurfaceRouter
  } = await import('./components/SurfaceRouter.js');
  const initialSurface = await surfaceRoute.resolveInitialSurface();
  profileCheckpoint('launch_repl_after_surface_resolution');
  const {
    REPL
  } = await import('./screens/REPL.js');
  // The ONE interactive MCP owner (Law 9 restore — the fold's launch dropped
  // the seed on the floor and the manager never mounted: no interactive
  // server ever connected, the /mcp panel read a never-connected process and
  // /ide had no config door). Seeded into the one mutable config owner, then
  // mounted ABOVE the SurfaceRouter so connections survive route flips.
  const {
    SeededMCPConnectionManager
  } = await import('./services/mcp/MCPConnectionManager.js');
  const {
    seedDynamicMcpConfig
  } = await import('./services/mcp/dynamicMcpSeed.js');
  seedDynamicMcpConfig(mcpSeed?.dynamicMcpConfig, mcpSeed?.isStrictMcpConfig ?? false, { ...(mcpSeed?.ideAutoConnect !== undefined ? { ideAutoConnect: mcpSeed.ideAutoConnect } : {}) });
  surfaceRoute.initializeSurfaceRoute(initialSurface.effective);
  profileCheckpoint('launch_repl_after_paint_imports');
  await renderAndRun(root, <App {...appProps}>
      <SeededMCPConnectionManager>
        <SurfaceRouter>
          <REPL {...replProps} />
        </SurfaceRouter>
      </SeededMCPConnectionManager>
    </App>);
}
