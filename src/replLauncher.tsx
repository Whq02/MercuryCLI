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
type McpSeed = {
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined;
  isStrictMcpConfig: boolean;
  ideAutoConnect?: boolean;
};

const BOOT_RECOVERY_BUDGET_MS = 3_000;

export async function launchRepl(root: Root, appProps: AppWrapperProps, replProps: REPLProps, renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>, mcpSeed?: McpSeed): Promise<void> {
  const { profileCheckpoint } = await import('./utils/startupProfiler.js');
  profileCheckpoint('launch_repl_start');
  try {
    const { getProjectRoot, getSessionId } = await import('./bootstrap/state.js');
    const { runBootRecovery } = await import('./substrate/recoveryOrchestrator.js');
    const recovery = runBootRecovery({
      scope: 'session',
      sessionId: getSessionId(),
      projectDir: getProjectRoot(),
    });
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const report = await Promise.race([
      recovery,
      new Promise<null>(r => {
        budgetTimer = setTimeout(() => r(null), BOOT_RECOVERY_BUDGET_MS);
      }),
    ]);
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
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
  }
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
  }
  profileCheckpoint('launch_repl_after_recovery');
  const surfaceRoute = await import('./context/surfaceRoute.js');
  const {
    App
  } = await import('./components/App.js');
  const {
    SurfaceRouter
  } = await import('./components/SurfaceRouter.js');
  const initialSurface = await surfaceRoute.resolveInitialSurface();
  profileCheckpoint('launch_repl_after_surface_resolution');
  const {
    REPL
  } = await import('./screens/REPL.js');
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
